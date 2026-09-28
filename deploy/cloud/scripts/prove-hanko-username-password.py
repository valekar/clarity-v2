#!/usr/bin/env python3
"""Prove username/password registration, login, session and logout against local Hanko."""

from __future__ import annotations

import http.client
import json
import sys
from http.cookies import SimpleCookie
from urllib.parse import urlsplit, urljoin


class ProofError(RuntimeError):
    pass


def request(url: str, method: str = "GET", payload: dict | None = None,
            cookie: str | None = None) -> tuple[int, dict[str, str], bytes]:
    parsed = urlsplit(url)
    if parsed.scheme != "http" or not parsed.hostname:
        raise ProofError("Endpoints must be local HTTP URLs.")
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=5)
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if cookie:
        headers["Cookie"] = cookie
    try:
        connection.request(method, parsed.path + ("?" + parsed.query if parsed.query else ""),
                           body=body, headers=headers)
        response = connection.getresponse()
        data = response.read(2 *  1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ProofError("Hanko response exceeded the proof size limit.")
        result_headers = {key.lower(): value for key, value in response.getheaders()
                          if key.lower() != "set-cookie"}
        cookies = [value for key, value in response.getheaders()
                   if key.lower() == "set-cookie"]
        if cookies:
            result_headers["set-cookie"] = "\n".join(cookies)
        return response.status, result_headers, data
    finally:
        connection.close()


def body_object(data: bytes) -> dict:
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ProofError("Expected a Hanko object response.")
    return value


class Flow:
    def __init__(self, origin: str, password: str):
        self.origin = origin.rstrip("/")
        self.password = password

    def start(self, name: str) -> dict:
        status, _, data = request(f"{self.origin}/{name}", "POST", {})
        if status != 200:
            raise ProofError(f"{name} flow started with HTTP {status}.")
        return body_object(data)

    def action(self, state: dict, name: str, username: str) -> tuple[dict, str | None]:
        action = state.get("actions", {}).get(name)
        if not isinstance(action, dict) or not isinstance(action.get("href"), str):
            raise ProofError(f"Missing expected action {name!r}.")
        href = urljoin(self.origin + "/", action["href"])
        if urlsplit(href).netloc != urlsplit(self.origin).netloc:
            raise ProofError("Hanko action escaped the local service origin.")
        inputs = action.get("inputs", {})
        values = {}
        for key in inputs:
            if name == "register_client_capabilities":
                values[key] = False
            elif key in ("username", "identifier"):
                values[key] = username
            elif key in ("password", "new_password", "password_confirmation",
                         "password_confirm", "new_password_repeat"):
                values[key] = self.password
            elif key == "remember_me":
                values[key] = False
            elif key == "csrf_token":
                continue
            else:
                raise ProofError(f"Unsupported {name} input {key!r}; refusing implicit credential data.")
        status, headers, data = request(href, "POST", {
            "csrf_token": state["csrf_token"], "input_data": values,
        })
        next_state = body_object(data)
        if status < 200 or status >= 300 or next_state.get("name") == "error":
            fields = sorted(inputs)
            raise ProofError(f"Action {name!r} failed with HTTP {status}; fields={fields}, state={next_state.get('name')}.")
        return next_state, headers.get("set-cookie")

    def run(self, flow_name: str, username: str) -> tuple[dict, list[str], str | None, str | None]:
        state = self.start(flow_name)
        observed = []
        cookie = None
        cookie_domain = None
        for _ in range(12):
            if state.get("name") == "success":
                return state, observed, cookie, cookie_domain
            actions = state.get("actions", {})
            if not actions:
                raise ProofError(f"Unexpected {flow_name} state {state.get('name')!r}.")
            # Accept only the supported state machine inputs above; action order
            # follows Hanko's advertised first applicable action.
            priorities = (
                "register_client_capabilities", "register_login_identifier",
                "continue_with_login_identifier", "set_password",
                "register_password", "verify_password", "password_login", "remember_me",
            )
            name = next((candidate for candidate in priorities if candidate in actions), "")
            if not name:
                raise ProofError(
                    f"Unsupported {flow_name} state {state.get('name')!r}; "
                    f"available actions={list(actions)}."
                )
            observed.append(name)
            state, set_cookie = self.action(state, name, username)
            if set_cookie:
                observed.append("session-cookie-issued")
                parsed = SimpleCookie()
                parsed.load(set_cookie.splitlines()[0])
                if "hanko" in parsed:
                    if parsed["hanko"]["domain"] not in (".localhost", "localhost"):
                        raise ProofError(
                            "Hanko emitted cookie domain "
                            f"{parsed['hanko']['domain']!r} for configured .localhost."
                        )
                    cookie = f"hanko={parsed['hanko'].value}"
                    cookie_domain = parsed["hanko"]["domain"]
        raise ProofError(f"{flow_name} did not complete within twelve Hanko actions.")


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: prove-hanko-username-password.py HANKO_URL USERNAME PASSWORD_FILE")
    origin = sys.argv[1].rstrip("/")
    username = sys.argv[2]
    with open(sys.argv[3], encoding="utf-8") as password_file:
        password = password_file.read().rstrip("\r\n")
    flow = Flow(origin, password)
    signup_status, _, signup_data = request(f"{origin}/registration", "POST", {})
    signup_state = body_object(signup_data) if signup_status < 400 else {}
    if signup_status >= 400:
        raise ProofError(f"Public registration flow returned HTTP {signup_status}.")
    if signup_state.get("actions", {}).get("register_login_identifier"):
        raise ProofError("Public signup offered account creation despite allow_signup=false.")
    _, first_login_steps, cookie, cookie_domain = flow.run("login", username)
    if not cookie:
        raise ProofError("Administrator-provisioned user did not receive a Hanko login cookie.")
    status, _, data = request(f"{origin}/sessions/validate", cookie=cookie)
    if status != 200 or body_object(data).get("is_valid") is not True:
        raise ProofError("Username/password session did not validate.")
    claims = body_object(data).get("claims", {})
    subject, old_id = claims.get("subject"), claims.get("session_id")
    if not subject or not old_id:
        raise ProofError("Validated session omitted subject or session ID.")
    status, headers, _ = request(f"{origin}/logout", "POST", cookie=cookie)
    if status != 204 or "set-cookie" not in headers:
        raise ProofError(f"Logout did not clear session (HTTP {status}).")
    if body_object(request(f"{origin}/sessions/validate", cookie=cookie)[2]).get("is_valid") is not False:
        raise ProofError("Logged-out session remained valid.")
    _, fresh_login_steps, fresh_cookie, _ = flow.run("login", username)
    if not fresh_cookie:
        raise ProofError("Fresh login after logout did not issue a cookie.")
    fresh_status, _, fresh_data = request(f"{origin}/sessions/validate", cookie=fresh_cookie)
    fresh_claims = body_object(fresh_data).get("claims", {})
    if fresh_status != 200 or fresh_claims.get("subject") != subject \
            or fresh_claims.get("session_id") == old_id:
        raise ProofError("Post-logout login did not issue a fresh session for the same account.")
    print("Hanko v3.0.4 public signup denial and administrator-provisioned username/password flow passed. "
          f"Login actions: {first_login_steps}; post-logout login: {fresh_login_steps}; "
          f"session validation and logout replay denial passed; claim_keys={sorted(claims)}; "
          f"email_claim_present={'email' in claims}; cookie_domain={cookie_domain!r}; "
          "credentials omitted.")

if __name__ == "__main__":
    try:
        main()
    except (ProofError, KeyError, TypeError, ValueError) as error:
        print(f"Hanko username/password proof failed: {error}", file=sys.stderr)
        raise SystemExit(1)
