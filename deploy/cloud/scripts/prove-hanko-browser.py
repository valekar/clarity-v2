#!/usr/bin/env python3
"""Prove a real Chromium cookie crosses the local Hanko/web port boundary."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import sync_playwright


class ProofError(RuntimeError):
    pass


def action(page, hanko_origin: str, state: dict, name: str, inputs: dict) -> dict:
    result = page.evaluate(
        """async ({origin, state, name, inputs}) => {
          const href = state.actions?.[name]?.href;
          if (!href) throw new Error(`Missing Hanko action: ${name}`);
          const url = new URL(href, `${origin}/`);
          if (url.origin !== origin) throw new Error('Hanko action changed origin');
          const response = await fetch(url.href, {
            method: 'POST', credentials: 'include',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({csrf_token: state.csrf_token, input_data: inputs}),
          });
          return {status: response.status, state: await response.json()};
        }""",
        {"origin": hanko_origin, "state": state, "name": name, "inputs": inputs},
    )
    if result["status"] != 200:
        raise ProofError(f"Hanko {name} returned HTTP {result['status']}.")
    return result["state"]


def start(page, hanko_origin: str, flow: str) -> dict:
    result = page.evaluate(
        """async ({origin, flow}) => {
          const response = await fetch(`${origin}/${flow}`, {
            method: 'POST', credentials: 'include',
            headers: {'Content-Type': 'application/json'}, body: '{}',
          });
          return {status: response.status, state: await response.json()};
        }""",
        {"origin": hanko_origin, "flow": flow},
    )
    if result["status"] != 200:
        raise ProofError(f"Browser {flow} initialization failed.")
    return result["state"]


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(
            "usage: prove-hanko-browser.py WEB_ORIGIN HANKO_ORIGIN MAILPIT_ORIGIN"
        )
    web_origin, hanko_origin, mailpit_origin = (arg.rstrip("/") for arg in sys.argv[1:])
    helpers = runpy.run_path(str(Path(__file__).with_name("prove-hanko-flow.py")))
    email = f"browser-{uuid4().hex}@clarity.invalid"
    chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if not chrome.is_file():
        raise ProofError("Local Chromium proof needs Google Chrome at its macOS path.")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(chrome))
        try:
            context = browser.new_context()
            page = context.new_page()
            blocked_cookie_reasons: list[str] = []
            set_cookie_responses: list[str] = []
            devtools = context.new_cdp_session(page)
            devtools.send("Network.enable")
            def inspect_response(event: dict) -> None:
                blocked_cookie_reasons.extend(
                    reason for cookie in event.get("blockedCookies", [])
                    for reason in cookie.get("blockedReasons", [])
                )
                if any(key.lower() == "set-cookie" for key in event.get("headers", {})):
                    set_cookie_responses.append("present")
            devtools.on("Network.responseReceivedExtraInfo", inspect_response)
            page.goto(web_origin, wait_until="domcontentloaded")
            unauthenticated = page.goto(
                f"{web_origin}/api/staff/access", wait_until="domcontentloaded"
            )
            if unauthenticated is None or unauthenticated.status != 401:
                raise ProofError("Unauthenticated browser access was not denied with 401.")
            page.goto(web_origin, wait_until="domcontentloaded")
            known_messages = helpers["latest_message_ids"](mailpit_origin)
            state = start(page, hanko_origin, "registration")
            capabilities = {
                key: False
                for key in state["actions"]["register_client_capabilities"]["inputs"]
            }
            state = action(
                page, hanko_origin, state, "register_client_capabilities", capabilities
            )
            state = action(
                page, hanko_origin, state, "register_login_identifier", {"email": email}
            )
            if "verify_passcode" not in state.get("actions", {}):
                raise ProofError("Hanko did not request browser passcode verification.")
            passcode = helpers["mailpit_passcode"](
                mailpit_origin, email, known_messages
            )
            code_field = next(
                (key for key in ("passcode", "code")
                 if key in state["actions"]["verify_passcode"]["inputs"]),
                None,
            )
            if code_field is None:
                raise ProofError("Hanko passcode input was absent.")
            state = action(
                page, hanko_origin, state, "verify_passcode", {code_field: passcode}
            )
            if state.get("name") != "success":
                raise ProofError("Hanko did not finish browser registration.")
            if not context.cookies([hanko_origin, web_origin]):
                known_messages = helpers["latest_message_ids"](mailpit_origin)
                state = start(page, hanko_origin, "login")
                for _ in range(8):
                    actions = state.get("actions", {})
                    if "continue_with_login_identifier" in actions:
                        break
                    if "register_client_capabilities" in actions:
                        inputs = {key: False for key in actions[
                            "register_client_capabilities"
                        ]["inputs"]}
                        state = action(page, hanko_origin, state,
                                       "register_client_capabilities", inputs)
                    elif "remember_me" in actions:
                        state = action(page, hanko_origin, state, "remember_me",
                                       {"remember_me": False})
                    else:
                        raise ProofError("Browser login did not expose email entry.")
                fields = state["actions"]["continue_with_login_identifier"]["inputs"]
                field = "email" if "email" in fields else "identifier"
                state = action(page, hanko_origin, state,
                               "continue_with_login_identifier", {field: email})
                for _ in range(8):
                    actions = state.get("actions", {})
                    if "verify_passcode" in actions:
                        break
                    if "remember_me" in actions:
                        state = action(page, hanko_origin, state, "remember_me",
                                       {"remember_me": False})
                    else:
                        raise ProofError("Browser login did not request a passcode.")
                login_code = helpers["mailpit_passcode"](
                    mailpit_origin, email, known_messages
                )
                code_field = next(
                    (key for key in ("passcode", "code")
                     if key in state["actions"]["verify_passcode"]["inputs"]),
                    None,
                )
                if code_field is None:
                    raise ProofError("Browser login passcode input was absent.")
                state = action(page, hanko_origin, state,
                               "verify_passcode", {code_field: login_code})
                if state.get("name") != "success":
                    raise ProofError("Hanko did not finish browser login.")
            cookies = context.cookies([hanko_origin, web_origin])
            session = next((cookie for cookie in cookies if cookie["name"] == "hanko"), None)
            if session is None or not session["secure"] or not session["httpOnly"]:
                properties = [
                    {"name": cookie["name"], "secure": cookie["secure"],
                     "httpOnly": cookie["httpOnly"], "domain": cookie["domain"]}
                    for cookie in cookies
                ]
                raise ProofError(
                    "Chromium did not store the secure HttpOnly session: "
                    f"{properties}; set-cookie responses: {len(set_cookie_responses)}; "
                    f"blocked reasons: {blocked_cookie_reasons}"
                )
            if session["domain"] != "localhost":
                raise ProofError("Browser session domain does not cover the web origin.")
            pending = page.goto(
                f"{web_origin}/api/staff/access", wait_until="domcontentloaded"
            )
            if pending is None or pending.status != 403:
                raise ProofError("New browser identity was not denied as pending staff.")
            print(
                "Chromium accepted Hanko's secure HttpOnly cookie across local ports; "
                "the protected web route changed from 401 to pending 403. "
                "No cookie or passcode was printed."
            )
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except (ProofError, KeyError, TypeError, ValueError) as error:
        print(f"Synthetic browser cookie proof failed: {error}", file=sys.stderr)
        raise SystemExit(1)
