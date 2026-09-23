#!/usr/bin/env python3
"""Exercise Hanko v3 registration, passcode login and HttpOnly sessions."""

from __future__ import annotations

import http.client
import json
import os
import re
import signal
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.cookies import SimpleCookie
from urllib.parse import urljoin, urlsplit
from uuid import UUID


MAX_RESPONSE = 2 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 5
MAILPIT_TIMEOUT_SECONDS = 45
ISSUER = "https://clarity-v2-synthetic.invalid"
AUDIENCE = "clarity-v2-synthetic-client"


class ProofError(RuntimeError):
    pass


def request(url: str, method: str = "GET", payload: dict | None = None,
            headers: dict[str, object] | None = None) -> tuple[int, dict[str, object], bytes]:
    parsed = urlsplit(url)
    if parsed.scheme != "http" or not parsed.hostname:
        raise ProofError("Proof endpoints must use local HTTP.")
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80,
                                            timeout=REQUEST_TIMEOUT_SECONDS)
    body = json.dumps(payload).encode() if payload is not None else None
    request_headers = dict(headers or {})
    if body is not None:
        request_headers.setdefault("Content-Type", "application/json")
    def total_timeout(_signum: int, _frame: object) -> None:
        raise ProofError("HTTP request exceeded its total time limit.")

    previous_handler = signal.signal(signal.SIGALRM, total_timeout)
    signal.setitimer(signal.ITIMER_REAL, REQUEST_TIMEOUT_SECONDS)
    try:
        connection.request(method, parsed.path + ("?" + parsed.query if parsed.query else ""),
                           body=body, headers=request_headers)
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            raise ProofError("Hanko or Mailpit response exceeded the proof limit.")
        response_headers: dict[str, object] = {}
        set_cookies = []
        for key, value in response.getheaders():
            if key.lower() == "set-cookie":
                set_cookies.append(value)
            else:
                response_headers[key.lower()] = value
        if set_cookies:
            response_headers["set-cookie"] = set_cookies
        response_headers["__status__"] = response.status
        return response.status, response_headers, data
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        connection.close()


def json_body(data: bytes) -> dict:
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProofError("Expected a JSON response from Hanko/Mailpit.") from exc
    if not isinstance(value, dict):
        raise ProofError("Expected an object response from Hanko/Mailpit.")
    return value


class HankoClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.origin = urlsplit(self.base_url).netloc

    def post_action(self, flow: str, state: dict, action_name: str,
                    input_data: dict, allow_error: bool = False) -> tuple[dict, dict[str, object]]:
        action = state.get("actions", {}).get(action_name)
        if not isinstance(action, dict) or not isinstance(action.get("href"), str):
            raise ProofError(f"Expected Hanko action {action_name!r} was absent.")
        href = urljoin(self.base_url + "/", action["href"])
        parsed = urlsplit(href)
        if parsed.scheme != "http" or parsed.netloc != self.origin:
            raise ProofError("Hanko action URL escaped the proof service origin.")
        status, headers, data = request(
            href,
            "POST",
            {"csrf_token": state["csrf_token"], "input_data": input_data},
        )
        if (status < 200 or status >= 300) and not allow_error:
            error_body = json_body(data)
            error_code = error_body.get("error", {}).get("code", "unknown")
            returned_inputs = error_body.get("actions", {}).get(action_name, {}).get("inputs", {})
            input_errors = {
                name: value.get("error", {}).get("code", "invalid")
                for name, value in returned_inputs.items()
                if isinstance(value, dict) and isinstance(value.get("error"), dict)
            }
            raise ProofError(
                f"Hanko action {action_name!r} returned HTTP {status} ({error_code}); "
                f"state={state.get('name')}, fields={sorted(input_data)}, errors={input_errors}, "
                f"response_fields={sorted(returned_inputs)}."
            )
        next_state = json_body(data)
        if next_state.get("name") == "error" and not allow_error:
            raise ProofError(f"Hanko action {action_name!r} returned an error state.")
        return next_state, headers

    def start(self, flow: str) -> dict:
        status, _, data = request(f"{self.base_url}/{flow}", "POST", {})
        if status != 200:
            raise ProofError(f"Hanko {flow} initialization returned HTTP {status}.")
        return json_body(data)


def capabilities(state: dict) -> dict:
    action = state["actions"]["register_client_capabilities"]
    return {name: False for name in action.get("inputs", {})}


def call_if_available(client: HankoClient, flow: str, state: dict,
                      action_name: str, values: dict) -> tuple[dict, dict[str, object]]:
    headers: dict[str, object] = {}
    while action_name in state.get("actions", {}):
        state, response_headers = client.post_action(flow, state, action_name, values)
        headers.update(response_headers)
        return state, headers
    return state, headers


def action_input(state: dict, action_name: str, email: str,
                 passcode: str | None = None) -> dict:
    fields = state.get("actions", {}).get(action_name, {}).get("inputs", {})
    if action_name == "register_client_capabilities":
        return {name: False for name in fields}
    if action_name == "register_login_identifier":
        return {"email": email}
    if action_name == "continue_with_login_identifier":
        # In v3.0.4 this action dynamically exposes the configured identifier
        # field; with email-only identity it is named `email`.
        fields = state.get("actions", {}).get(action_name, {}).get("inputs", {})
        return {"email": email} if "email" in fields else {"identifier": email}
    if action_name == "remember_me":
        return {"remember_me": False}
    if action_name == "verify_passcode" and passcode is not None:
        return {name: passcode for name in fields if name in ("passcode", "code")}
    raise ProofError(f"Unsupported Hanko flow action: {action_name}")


def advance_to_action(client: HankoClient, flow: str, state: dict,
                      wanted: str, email: str) -> tuple[dict, dict[str, object]]:
    response_headers: dict[str, object] = {}
    for _ in range(8):
        if wanted in state.get("actions", {}):
            return state, response_headers
        if state.get("name") == "success":
            return state, response_headers
        actions = state.get("actions", {})
        if "register_client_capabilities" in actions:
            chosen = "register_client_capabilities"
        elif flow == "registration" and "register_login_identifier" in actions:
            chosen = "register_login_identifier"
        elif flow == "login" and "continue_with_login_identifier" in actions:
            chosen = "continue_with_login_identifier"
        elif "remember_me" in actions:
            chosen = "remember_me"
        else:
            raise ProofError(f"Unexpected Hanko {flow} state: {state.get('name')}")
        state, headers = client.post_action(
            flow, state, chosen, action_input(state, chosen, email)
        )
        response_headers.update(headers)
    raise ProofError(f"Hanko {flow} flow did not reach {wanted!r} within eight actions.")


def mailpit_passcode(base_url: str, email: str, after_id: set[str]) -> str:
    deadline = time.monotonic() + MAILPIT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        status, _, data = request(f"{base_url.rstrip('/')}/api/v1/messages?limit=50")
        if status != 200:
            raise ProofError(f"Mailpit message list returned HTTP {status}.")
        response = json_body(data)
        messages = response.get("messages", [])
        for summary in messages[:5]:
            if time.monotonic() >= deadline:
                break
            if not isinstance(summary, dict):
                continue
            message_id = str(summary.get("ID") or summary.get("id") or "")
            if not message_id or message_id in after_id:
                continue
            recipients = summary.get("To", summary.get("to", []))
            if not any(
                isinstance(recipient, dict)
                and str(recipient.get("Address", recipient.get("address", ""))).lower() == email.lower()
                for recipient in recipients
            ):
                continue
            status, _, detail_data = request(
                f"{base_url.rstrip('/')}/api/v1/message/{message_id}"
            )
            if status != 200:
                continue
            detail = json_body(detail_data)
            text = "\n".join(str(detail.get(key, "")) for key in ("Text", "HTML", "text", "html"))
            match = re.search(r"(?<!\d)(\d{6})(?!\d)", text)
            if match:
                return match.group(1)
        time.sleep(1)
    raise ProofError("Timed out waiting for a matching synthetic passcode in Mailpit.")


def latest_message_ids(mailpit_url: str) -> set[str]:
    status, _, data = request(f"{mailpit_url.rstrip('/')}/api/v1/messages?limit=50")
    if status != 200:
        raise ProofError(f"Mailpit message list returned HTTP {status}.")
    messages = json_body(data).get("messages", [])
    return {
        str(message.get("ID") or message.get("id"))
        for message in messages
        if isinstance(message, dict) and (message.get("ID") or message.get("id"))
    }


def run_login(client: HankoClient, mailpit_url: str, email: str,
              wrong_passcode: bool = False) -> tuple[str, dict, dict[str, object]]:
    known_ids = latest_message_ids(mailpit_url)
    state = client.start("login")
    state, headers = advance_to_action(client, "login", state,
                                       "continue_with_login_identifier", email)
    state, interim_headers = client.post_action(
        "login", state, "continue_with_login_identifier",
        action_input(state, "continue_with_login_identifier", email),
    )
    headers.update(interim_headers)
    if "verify_passcode" not in state.get("actions", {}):
        state, more_headers = advance_to_action(client, "login", state, "verify_passcode", email)
        headers.update(more_headers)
    passcode = mailpit_passcode(mailpit_url, email, known_ids)
    wrong_code = f"{(int(passcode) + 1) % 1_000_000:06d}"
    attempt = wrong_code if wrong_passcode else passcode
    state, response_headers = client.post_action(
        "login", state, "verify_passcode", action_input(state, "verify_passcode", email, attempt),
        allow_error=wrong_passcode,
    )
    headers.update(response_headers)
    return passcode, state, headers


def set_cookie(headers: dict[str, object]) -> tuple[str, SimpleCookie.Morsel, str]:
    raw_values = headers.get("set-cookie")
    if not raw_values:
        raise ProofError("Hanko success response did not set a session cookie.")
    cookie_headers = raw_values if isinstance(raw_values, list) else [str(raw_values)]
    parsed_cookies = []
    for raw_cookie in cookie_headers:
        parsed = SimpleCookie()
        parsed.load(raw_cookie)
        parsed_cookies.extend((morsel, raw_cookie) for morsel in parsed.values())
    matching = [(morsel, raw) for morsel, raw in parsed_cookies if morsel.key == "hanko"]
    if len(matching) != 1:
        raise ProofError("Hanko did not set exactly one configured `hanko` session cookie.")
    morsel, raw = matching[0]
    cookie = f"{morsel.key}={morsel.value}"
    return cookie, morsel, raw


def assert_session_cookie(morsel: SimpleCookie.Morsel, raw: str) -> None:
    if not morsel["httponly"] or not morsel["secure"] \
            or morsel["samesite"].lower() != "strict" \
            or morsel["domain"].lower() != "localhost" or morsel["path"] != "/":
        raise ProofError("Hanko cookie scope or HttpOnly/Secure/SameSite flags differed from proof config.")


def validate(base_url: str, cookie_header: str) -> dict:
    status, _, data = request(
        f"{base_url.rstrip('/')}/sessions/validate",
        headers={"Cookie": cookie_header},
    )
    if status != 200:
        raise ProofError(f"Hanko session validation returned HTTP {status}.")
    return json_body(data)


def main() -> None:
    if len(sys.argv) not in (4, 5):
        raise SystemExit("usage: prove-hanko-flow.py HANKO_URL MAILPIT_URL SYNTHETIC_NONCE [PRIVATE_IDENTITY_FILE]")
    hanko_url, mailpit_url, nonce = sys.argv[1:4]
    identity_output = sys.argv[4] if len(sys.argv) == 5 else None
    email = f"proof-{nonce}@example.invalid"
    client = HankoClient(hanko_url)

    registration = client.start("registration")
    registration, _ = advance_to_action(client, "registration", registration,
                                        "register_login_identifier", email)
    registration, _ = client.post_action(
        "registration", registration, "register_login_identifier",
        action_input(registration, "register_login_identifier", email),
    )
    if "verify_passcode" not in registration.get("actions", {}):
        registration, _ = advance_to_action(client, "registration", registration,
                                            "verify_passcode", email)
    code = mailpit_passcode(mailpit_url, email, set())
    registration, registration_headers = client.post_action(
        "registration", registration, "verify_passcode",
        action_input(registration, "verify_passcode", email, code),
    )
    if registration.get("name") != "success":
        registration, extra_headers = advance_to_action(
            client, "registration", registration, "__success__", email
        )
        registration_headers.update(extra_headers)
    if registration.get("name") != "success":
        raise ProofError("Synthetic registration did not complete successfully.")

    # Account registration may create a session. If it does, test it; if not,
    # immediately use the same synthetic account's login flow.
    try:
        cookie, cookie_morsel, cookie_header = set_cookie(registration_headers)
        session_headers = registration_headers
    except ProofError:
        _, login_state, login_headers = run_login(client, mailpit_url, email)
        if login_state.get("name") != "success":
            raise ProofError("Post-registration login did not complete successfully.")
        cookie, cookie_morsel, cookie_header = set_cookie(login_headers)
        session_headers = login_headers

    assert_session_cookie(cookie_morsel, cookie_header)
    if "x-auth-token" in session_headers:
        raise ProofError("Hanko emitted the disabled X-Auth-Token header.")
    claims = validate(hanko_url, cookie)
    if claims.get("is_valid") is not True:
        raise ProofError("Hanko did not validate the new session cookie.")
    token_claims = claims.get("claims", {})
    if token_claims.get("issuer") != ISSUER or AUDIENCE not in token_claims.get("audience", []):
        raise ProofError("Session issuer or audience did not match explicit proof config.")
    if token_claims.get("email", {}).get("address", "").lower() != email.lower() \
            or token_claims.get("email", {}).get("is_verified") is not True:
        raise ProofError("Verified synthetic account claims were absent from the session.")
    subject = token_claims.get("subject")
    old_session_id = token_claims.get("session_id")
    expiry = token_claims.get("expiration")
    if not subject or not old_session_id or not expiry:
        raise ProofError("Session response omitted subject, session ID or expiry.")
    try:
        subject_uuid = UUID(subject)
        session_uuid = UUID(old_session_id)
        expires_at = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError) as exc:
        raise ProofError("Session subject, ID or expiry had an invalid format.") from exc
    if subject_uuid.int == 0 or session_uuid.int == 0 or expires_at.tzinfo is None \
            or expires_at <= datetime.now(timezone.utc):
        raise ProofError("Session subject/ID must be nonzero UUIDs with a future RFC3339 expiry.")

    logout_status, logout_headers, _ = request(
        f"{hanko_url.rstrip('/')}/logout", "POST", headers={"Cookie": cookie}
    )
    if logout_status != 204:
        raise ProofError(f"Hanko logout returned HTTP {logout_status}.")
    deletion_values = logout_headers.get("set-cookie", [])
    deletion_headers = deletion_values if isinstance(deletion_values, list) else [str(deletion_values)]
    deletion_cookie = None
    for deletion_header in deletion_headers:
        parsed = SimpleCookie()
        parsed.load(deletion_header)
        if "hanko" in parsed:
            deletion_cookie = parsed["hanko"]
            break
    if deletion_cookie is None or deletion_cookie["domain"].lower() != cookie_morsel["domain"].lower() \
            or deletion_cookie["path"] != cookie_morsel["path"]:
        raise ProofError("Logout did not clear the same cookie name, domain and path.")
    expired_by_age = deletion_cookie["max-age"] == "0"
    try:
        expired_by_date = bool(deletion_cookie["expires"]) and parsedate_to_datetime(
            deletion_cookie["expires"]
        ) <= datetime.now(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        expired_by_date = False
    if not expired_by_age and not expired_by_date:
        raise ProofError("Logout cookie did not expire the session cookie.")
    if validate(hanko_url, cookie).get("is_valid") is not False:
        raise ProofError("The logged-out cookie still validated.")

    # Verify malformed cookie rejection, then log in again and require a fresh
    # session for the same user after logout.
    malformed_status, _, malformed_data = request(
        f"{hanko_url.rstrip('/')}/sessions/validate",
        headers={"Cookie": "hanko=not-a-valid-session"},
    )
    if malformed_status == 200 and json_body(malformed_data).get("is_valid") is not False:
        raise ProofError("Malformed cookie was accepted by Hanko.")
    if malformed_status not in (200, 400, 401):
        raise ProofError(f"Malformed cookie returned unexpected HTTP {malformed_status}.")

    _, wrong_state, wrong_headers = run_login(client, mailpit_url, email, wrong_passcode=True)
    wrong_fields = wrong_state.get("actions", {}).get("verify_passcode", {}).get("inputs", {})
    code_error = wrong_fields.get("code", {}).get("error", {}).get("code")
    if wrong_headers.get("__status__") != 400 or wrong_state.get("name") != "passcode_confirmation" \
            or wrong_state.get("error", {}).get("code") != "form_data_invalid_error" \
            or code_error != "passcode_invalid" or "set-cookie" in wrong_headers:
        raise ProofError("Wrong passcode created an authenticated session.")

    _, login_state, login_headers = run_login(client, mailpit_url, email)
    if login_state.get("name") != "success":
        raise ProofError("Fresh synthetic login did not complete successfully.")
    fresh_cookie, fresh_cookie_morsel, fresh_cookie_header = set_cookie(login_headers)
    assert_session_cookie(fresh_cookie_morsel, fresh_cookie_header)
    if "x-auth-token" in login_headers:
        raise ProofError("Fresh login emitted the disabled X-Auth-Token header.")
    fresh = validate(hanko_url, fresh_cookie)
    fresh_claims = fresh.get("claims", {})
    if fresh.get("is_valid") is not True or fresh_claims.get("subject") != subject \
            or fresh_claims.get("session_id") == old_session_id:
        raise ProofError("Fresh login did not create a distinct session for the same subject.")
    try:
        fresh_session_uuid = UUID(fresh_claims["session_id"])
        fresh_expiry = datetime.fromisoformat(fresh_claims["expiration"].replace("Z", "+00:00"))
    except (KeyError, AttributeError, TypeError, ValueError) as exc:
        raise ProofError("Fresh session ID or expiry had an invalid format.") from exc
    if fresh_session_uuid.int == 0 or fresh_expiry.tzinfo is None \
            or fresh_expiry <= datetime.now(timezone.utc):
        raise ProofError("Fresh session must have a nonzero UUID and future RFC3339 expiry.")

    if identity_output:
        identity = {
            "subject": subject,
            "email": email,
            "cookie": fresh_cookie,
        }
        descriptor = os.open(identity_output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(identity, output)
            output.write("\n")

    print("Hanko v3 synthetic registration, Mailpit passcode, cookie, session claims, logout/replay denial, malformed-cookie denial and fresh login passed; secrets and passcodes omitted.")


if __name__ == "__main__":
    try:
        main()
    except (ProofError, KeyError, TypeError, ValueError) as error:
        print(f"Hanko v3 auth proof failed: {error}", file=sys.stderr)
        raise SystemExit(1)
