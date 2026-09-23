#!/usr/bin/env python3
"""Capture safe Chromium evidence for a synthetic Ready study and OHIF frame."""

from __future__ import annotations

import json
import os
import re
import sys
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright


class ProofError(RuntimeError):
    pass


def read_object(path: str) -> dict:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ProofError("A private browser-proof fixture is malformed.")
    return value


def read_cookie(identity_path: str) -> tuple[str, str]:
    identity = read_object(identity_path)
    header = identity.get("cookie")
    cookie_name = os.environ.get("HANKO_COOKIE_NAME", "hanko")
    if not isinstance(header, str) or "\r" in header or "\n" in header:
        raise ProofError("The private Hanko identity fixture has no valid cookie.")
    parsed = SimpleCookie()
    parsed.load(header)
    if len(parsed) != 1 or cookie_name not in parsed:
        raise ProofError("The private Hanko identity cookie name did not match configuration.")
    value = parsed[cookie_name].value
    if not value or ";" in value or "\r" in value or "\n" in value:
        raise ProofError("The private Hanko identity cookie value is malformed.")
    return cookie_name, value


def read_study(fixture_path: str) -> dict[str, str]:
    fixture = read_object(fixture_path)
    required = ("reportId", "studyInstanceUid", "reportState", "sourceOffline")
    if any(key not in fixture for key in required):
        raise ProofError("The connected viewer fixture is incomplete.")
    if fixture["reportState"] != "ready" or fixture["sourceOffline"] is not True:
        raise ProofError("The browser fixture must be a source-offline Ready Report.")
    if not all(isinstance(fixture[key], str) and fixture[key] for key in required[:2]):
        raise ProofError("The connected viewer fixture has invalid identifiers.")
    return {key: fixture[key] for key in required[:2]}


def response_record(response, web_origin: str) -> dict[str, object] | None:
    parsed = urlsplit(response.url)
    if parsed.scheme not in ("http", "https") or parsed.netloc != urlsplit(web_origin).netloc:
        return None
    if not parsed.path.startswith("/ohif/"):
        return None
    headers = response.headers
    location_path = None
    location = headers.get("location")
    if location:
        target = urlsplit(location)
        location_path = target.path if not target.netloc or target.netloc == parsed.netloc else "external"
    policy = headers.get("content-security-policy")
    if policy:
        policy = re.sub(r"nonce-[A-Za-z0-9+/_=-]+", "nonce-[redacted]", policy)
    return {
        "path": parsed.path,
        "status": response.status,
        "contentType": headers.get("content-type"),
        "locationPath": location_path,
        "contentSecurityPolicy": policy,
        "xFrameOptions": headers.get("x-frame-options"),
    }


def no_horizontal_overflow(page) -> bool:
    return bool(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(
            "usage: prove-ohif-browser.py WEB_ORIGIN ADMIN_IDENTITY_JSON CONNECTED_FIXTURE_JSON"
        )
    web_origin = sys.argv[1].rstrip("/")
    origin = urlsplit(web_origin)
    if origin.scheme != "http" or origin.hostname != "localhost" or origin.port is None:
        raise ProofError("The browser diagnostic only accepts the disposable localhost origin.")
    identity_path, fixture_path = sys.argv[2:]
    cookie_name, cookie_value = read_cookie(identity_path)
    study = read_study(fixture_path)
    chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if not chrome.is_file():
        raise ProofError("Local Chromium diagnostic needs Google Chrome at its macOS path.")

    ohif_responses: list[dict[str, object]] = []
    failed_assets: list[dict[str, str]] = []
    cdp_loading_failures: list[dict[str, str]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(chrome))
        try:
            context = browser.new_context(viewport={"width": 375, "height": 812})
            context.add_cookies([
                {
                    "name": cookie_name,
                    "value": cookie_value,
                    "domain": "localhost",
                    "path": "/",
                    "secure": True,
                    "httpOnly": True,
                    "sameSite": "Strict",
                }
            ])
            page = context.new_page()

            def instrument_cdp(target_page) -> None:
                devtools = context.new_cdp_session(target_page)
                devtools.send("Network.enable")
                requests: dict[str, dict[str, str]] = {}

                def on_request(event: dict) -> None:
                    request = event.get("request", {})
                    parsed = urlsplit(request.get("url", ""))
                    request_id = event.get("requestId")
                    if (
                        isinstance(request_id, str)
                        and parsed.netloc == origin.netloc
                        and parsed.path.startswith("/ohif/")
                        and len(requests) < 100
                    ):
                        requests[request_id] = {
                            "path": parsed.path,
                            "resourceType": str(event.get("type", "unknown")),
                        }

                def enum_value(value: object) -> str:
                    if value is None:
                        return "none"
                    candidate = str(value or "")
                    return candidate if re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,79}", candidate) else "other"

                def on_loading_failed(event: dict) -> None:
                    request_id = event.get("requestId")
                    info = requests.pop(request_id, None) if isinstance(request_id, str) else None
                    if not info or len(cdp_loading_failures) >= 80:
                        return
                    cors = event.get("corsErrorStatus")
                    cors_error = cors.get("corsError") if isinstance(cors, dict) else None
                    cdp_loading_failures.append({
                        **info,
                        "blockedReason": enum_value(event.get("blockedReason")),
                        "corsError": enum_value(cors_error),
                    })

                devtools.on("Network.requestWillBeSent", on_request)
                devtools.on("Network.loadingFailed", on_loading_failed)

            instrument_cdp(page)

            def on_response(response) -> None:
                record = response_record(response, web_origin)
                if record is not None and len(ohif_responses) < 80:
                    ohif_responses.append(record)

            def on_request_failed(request) -> None:
                parsed = urlsplit(request.url)
                if (
                    parsed.netloc == origin.netloc
                    and parsed.path.startswith("/ohif/")
                    and len(failed_assets) < 80
                ):
                    failed_assets.append({"path": parsed.path, "resourceType": request.resource_type})

            page.on("response", on_response)
            page.on("requestfailed", on_request_failed)
            dashboard_response = page.goto(
                f"{web_origin}/staff", wait_until="domcontentloaded", timeout=15_000
            )
            if dashboard_response is None or dashboard_response.status != 200:
                raise ProofError("Authenticated browser did not load the staff dashboard.")
            page.get_by_role("heading", name="Studies").wait_for(state="visible", timeout=8_000)
            nav = page.get_by_role("navigation", name="Staff sections")
            mobile_nav_visible = all(
                nav.get_by_role("link", name=name).is_visible()
                for name in ("Studies", "Doctors", "Settings")
            )
            search = page.get_by_label("Search by patient, study or accession")
            search.fill(study["studyInstanceUid"])
            page.get_by_role("button", name="Search").click()
            page.wait_for_load_state("domcontentloaded", timeout=8_000)
            page.get_by_role("link", name="Open study").wait_for(state="visible", timeout=8_000)
            if not page.get_by_text("Source unavailable; cloud copy status shown").is_visible():
                raise ProofError("The source-offline status was absent from the Ready search result.")
            dashboard_no_overflow = no_horizontal_overflow(page)
            study_link = page.get_by_role("link", name="Open study")
            report_path = urlsplit(study_link.get_attribute("href") or "").path
            expected_path = f"/staff/studies/{study['reportId']}"
            if report_path != expected_path:
                raise ProofError("The Ready search link did not point to its Report page.")
            study_page_response = page.expect_response(
                lambda response: (
                    urlsplit(response.url).path == expected_path
                    and response.request.is_navigation_request()
                ),
                timeout=10_000,
            )
            with study_page_response as response_info:
                study_link.click()
                report_response = response_info.value
            if report_response.status != 200:
                raise ProofError("The Ready Report page did not load successfully.")
            page.get_by_text("VERIFIED CLOUD STUDY").wait_for(state="visible", timeout=8_000)
            mobile_viewer_nav_visible = all(
                page.get_by_role("navigation", name="Staff sections")
                .get_by_role("link", name=name)
                .is_visible()
                for name in ("Studies", "Doctors", "Settings")
            )
            iframe = page.locator('iframe[title="DICOM study viewer"]')
            iframe.wait_for(state="attached", timeout=5_000)
            iframe_src = iframe.get_attribute("src") or ""
            iframe_path = urlsplit(iframe_src).path
            if iframe_path != "/ohif/viewer":
                raise ProofError("The study page did not use the same-origin OHIF route.")
            study_page_no_overflow = no_horizontal_overflow(page)
            try:
                page.wait_for_timeout(2500)
            except PlaywrightTimeoutError:
                pass
            frame = next((candidate for candidate in page.frames if candidate != page.main_frame), None)
            frame_url = frame.url if frame is not None else ""
            frame_state = (
                "chrome_blocked" if frame_url.startswith("chrome-error:")
                else "loaded" if frame_url.startswith(web_origin + "/ohif/")
                else "unavailable"
            )

            top_level = context.new_page()
            instrument_cdp(top_level)
            top_level.on("response", on_response)
            top_level.on("requestfailed", on_request_failed)
            viewer_url = (
                f"{web_origin}/ohif/viewer?StudyInstanceUIDs="
                f"{study['studyInstanceUid']}"
            )
            top_level_navigation_error = None
            try:
                top_response = top_level.goto(
                    viewer_url, wait_until="domcontentloaded", timeout=15_000
                )
            except PlaywrightError as error:
                top_response = None
                top_level_navigation_error = type(error).__name__
            top_level_status = top_response.status if top_response is not None else None
            top_level_frame_state = (
                "chrome_blocked" if top_level.url.startswith("chrome-error:")
                else "loaded" if top_level.url.startswith(web_origin + "/ohif/")
                else "navigation_failed" if top_level_navigation_error
                else "no_response"
            )

            negative_path = "/staff/studies/00000000-0000-4000-8000-000000000099"
            error_response = page.goto(
                f"{web_origin}{negative_path}", wait_until="domcontentloaded", timeout=15_000
            )
            not_ready_state = page.get_by_role(
                "heading", name="Study is not ready to view"
            ).is_visible()
            print(json.dumps({
                "viewport": {"width": 375, "height": 812,
                             "dashboardNoHorizontalOverflow": dashboard_no_overflow,
                             "studyPageNoHorizontalOverflow": study_page_no_overflow,
                             "dashboardNavigationVisible": mobile_nav_visible,
                             "studyPageNavigationVisible": mobile_viewer_nav_visible},
                "navigation": {"dashboardStatus": dashboard_response.status,
                               "readySearchMatched": True,
                               "studyPageStatus": report_response.status,
                               "studyRoute": "matched_private_fixture"},
                "iframe": {"path": iframe_path, "state": frame_state},
                "topLevelViewer": {"status": top_level_status,
                                   "state": top_level_frame_state,
                                   "navigationErrorType": top_level_navigation_error},
                "ohifResponses": ohif_responses,
                "failedOhifAssets": failed_assets,
                "cdpLoadingFailures": cdp_loading_failures,
                "negativeReport": {"httpStatus": error_response.status if error_response else None,
                                   "notReadyMessageVisible": not_ready_state},
            }, sort_keys=True))
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except (ProofError, KeyError, TypeError, ValueError, OSError, PlaywrightTimeoutError) as error:
        print(f"Synthetic OHIF browser diagnostic failed: {type(error).__name__}.", file=sys.stderr)
        raise SystemExit(1)
