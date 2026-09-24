#!/usr/bin/env python3
"""Capture safe Chromium evidence for a synthetic Ready study and OHIF frame."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright
from ohif_browser_inspection import ProofError, inspect_pixel_pattern, inspect_viewer_text_signals, safe_error_category


diagnostic_stage = "startup"


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


def dicomweb_route_class(path: str) -> str:
    if path == "/dicom-web/studies":
        return "qido_studies"
    if re.fullmatch(r"/dicom-web/studies/[^/]+/series", path):
        return "qido_series"
    if re.fullmatch(r"/dicom-web/studies/[^/]+/series/[^/]+/instances", path):
        return "qido_instances"
    if re.fullmatch(r"/dicom-web/studies/[^/]+/series/[^/]+/instances/[^/]+", path):
        return "wado_instance"
    if re.fullmatch(r"/dicom-web/studies/[^/]+/series/[^/]+/instances/[^/]+/frames/[^/]+(?:/bulk/[^/]+)?", path):
        return "wado_frame_or_bulk"
    if path.startswith("/dicom-web/"):
        return "other_dicomweb"
    return "other"


def wado_subresource(path: str) -> str:
    if re.search(r"/frames/[0-9]+$", path):
        return "frame"
    if "/bulk/" in path:
        return "bulk_data"
    if re.search(r"/instances/[^/]+$", path):
        return "instance"
    return "other"


def safe_qido_contract(url: str) -> dict[str, object]:
    parsed = urlsplit(url)
    if len(parsed.query) > 4096:
        return {"routeClass": dicomweb_route_class(parsed.path), "queryShape": "oversize"}
    try:
        values_by_key = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=50)
    except ValueError:
        return {"routeClass": dicomweb_route_class(parsed.path), "queryShape": "too_many_fields"}
    parameter_shapes: dict[str, list[str]] = {}
    allowed_names = {
        "studyinstanceuid": "studyinstanceuid",
        "includefield": "includefield",
        "includefields": "includefields",
        "limit": "limit",
        "offset": "offset",
        "fuzzymatching": "fuzzymatching",
    }
    for key, values in sorted(values_by_key.items()):
        safe_key = allowed_names.get(key.lower(), "other_key")
        shapes = []
        for value in values[:100]:
            if value == "all":
                shape = "all"
            elif re.fullmatch(r"[0-9A-Fa-f]{8}(?:,[0-9A-Fa-f]{8}){1,99}", value):
                shape = "dicom_tag_list_8_hex"
            elif re.fullmatch(r"[0-9A-Fa-f]{8}", value):
                shape = "dicom_tag_8_hex"
            elif re.fullmatch(r"[0-9]+", value):
                shape = "integer"
            elif value in ("true", "false"):
                shape = "boolean"
            elif re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))+", value):
                shape = "uid"
            else:
                shape = "other"
            shapes.append(shape)
        parameter_shapes[safe_key] = parameter_shapes.get(safe_key, []) + shapes
    return {
        "routeClass": dicomweb_route_class(parsed.path),
        "parameterShapes": parameter_shapes,
    }


def inspect_viewer_document(frame) -> dict[str, object]:
    return frame.evaluate(
        """() => ({
          documentReadyState: document.readyState,
          bodyPresent: Boolean(document.body),
          bodyChildCount: Math.min(document.body?.children.length ?? 0, 100),
          appRootPresent: Boolean(document.querySelector('#root, #app, [data-cy="viewer"]')),
          canvasCount: Math.min(document.querySelectorAll('canvas').length, 20),
          canvases: Array.from(document.querySelectorAll('canvas')).slice(0,20).map(c => {
            const r = c.getBoundingClientRect();
            return {width:c.width,height:c.height,cssWidth:Math.round(r.width),cssHeight:Math.round(r.height)};
          }),
          viewportCount: Math.min(document.querySelectorAll('.viewport, [data-testid*="viewport"]').length, 20),
          loadingIndicatorPresent: Boolean(document.querySelector('[aria-busy="true"], [role="progressbar"]'))
        })"""
    )


def wait_for_ohif_frame(page, web_origin: str, timeout_ms: int = 30_000):
    started = time.monotonic()
    frame = None
    document = None
    transient_errors = 0
    while (time.monotonic() - started) * 1000 < timeout_ms:
        frame = next((candidate for candidate in page.frames if candidate != page.main_frame), None)
        if frame is not None and frame.url.startswith(web_origin + "/ohif/"):
            try:
                document = inspect_viewer_document(frame)
                if (
                    document.get("documentReadyState") == "complete"
                    and document.get("bodyPresent")
                    and document.get("appRootPresent")
                ):
                    return frame, "loaded", document, round((time.monotonic() - started) * 1000), transient_errors
            except PlaywrightError:
                transient_errors += 1
        elif frame is not None and frame.url.startswith("chrome-error:"):
            return frame, "chrome_blocked", None, round((time.monotonic() - started) * 1000), transient_errors
        page.wait_for_timeout(250)
    state = "load_timeout" if frame is not None and frame.url.startswith(web_origin + "/ohif/") else "unavailable"
    return frame, state, document, round((time.monotonic() - started) * 1000), transient_errors


def wait_for_large_viewer_canvas(page, frame, timeout_ms: int = 15_000) -> tuple[bool, int, int]:
    started = time.monotonic()
    transient_errors = 0
    while (time.monotonic() - started) * 1000 < timeout_ms:
        try:
            has_canvas = frame.evaluate(
                """() => Array.from(document.querySelectorAll('canvas'))
                    .some(canvas => canvas.width >= 64 && canvas.height >= 64)"""
            )
            if has_canvas:
                return True, round((time.monotonic() - started) * 1000), transient_errors
        except PlaywrightError:
            transient_errors += 1
        page.wait_for_timeout(250)
    return False, round((time.monotonic() - started) * 1000), transient_errors


def dicomweb_summary(responses: list[dict[str, str]]) -> dict[str, object]:
    statuses: dict[str, int] = {}
    routes: dict[str, int] = {}
    for record in responses:
        status = record["status"]
        route = record["routeClass"]
        statuses[status] = statuses.get(status, 0) + 1
        routes[route] = routes.get(route, 0) + 1
    return {"responseCount": len(responses), "statusCounts": statuses, "routeCounts": routes}


def no_horizontal_overflow(page) -> bool:
    return bool(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))


def clear_ohif_first_run_overlays(frame) -> dict[str, bool]:
    dismissed_tour = dismissed_notice = clicked_thumbnail = False
    skip = frame.get_by_text("Skip all", exact=True)
    if skip.count() and skip.first.is_visible():
        skip.first.click(timeout=2_000)
        dismissed_tour = True
        frame.page.wait_for_timeout(250)
    confirm = frame.get_by_role("button", name=re.compile(r"^Confirm and", re.IGNORECASE))
    if confirm.count() and confirm.first.is_visible():
        confirm.first.click(timeout=2_000)
        dismissed_notice = True
        frame.page.wait_for_timeout(500)
    thumbnails = frame.locator('[class*="thumbnail" i], [data-cy*="thumbnail" i]')
    if thumbnails.count() and thumbnails.first.is_visible():
        thumbnails.first.click(timeout=2_000)
        clicked_thumbnail = True
        frame.page.wait_for_timeout(500)
    return {
        "guidedTourSkipClicked": dismissed_tour,
        "investigationalNoticeConfirmed": dismissed_notice,
        "seriesThumbnailClicked": clicked_thumbnail,
    }


def main() -> None:
    global diagnostic_stage
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
    dicomweb_responses: list[dict[str, object]] = []
    qido_request_contracts: list[dict[str, object]] = []
    failed_dicomweb_requests: list[dict[str, object]] = []
    cdp_loading_failures: list[dict[str, object]] = []
    browser_errors: list[dict[str, str]] = []
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

            def on_page_error(error) -> None:
                if len(browser_errors) < 80:
                    browser_errors.append({"source": "pageerror", "category": safe_error_category(error.message)})

            def on_console(message) -> None:
                if message.type == "error" and len(browser_errors) < 80:
                    browser_errors.append({"source": "console_error", "category": safe_error_category(message.text)})

            page.on("pageerror", on_page_error)
            page.on("console", on_console)

            def instrument_cdp(target_page) -> None:
                devtools = context.new_cdp_session(target_page)
                devtools.send("Network.enable")
                requests: dict[str, dict[str, str]] = {}

                def on_request(event: dict) -> None:
                    request = event.get("request", {})
                    parsed = urlsplit(request.get("url", ""))
                    request_id = event.get("requestId")
                    is_ohif = parsed.path.startswith("/ohif/")
                    is_dicomweb = parsed.path.startswith("/dicom-web/")
                    if (
                        isinstance(request.get("url"), str)
                        and parsed.netloc == origin.netloc
                        and dicomweb_route_class(parsed.path).startswith("qido_")
                        and len(qido_request_contracts) < 40
                    ):
                        qido_request_contracts.append(safe_qido_contract(request["url"]))
                    if isinstance(request_id, str) and parsed.netloc == origin.netloc and (is_ohif or is_dicomweb) and len(requests) < 200:
                        requests[request_id] = {
                            "path": parsed.path if is_ohif else dicomweb_route_class(parsed.path),
                            "route": "ohif" if is_ohif else "dicomweb",
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
                    error_text = str(event.get("errorText", ""))
                    safe_error = error_text if re.fullmatch(r"net::ERR_[A-Z0-9_]{1,60}", error_text) else enum_value(error_text)
                    cdp_loading_failures.append({
                        **info,
                        "blockedReason": enum_value(event.get("blockedReason")),
                        "corsError": enum_value(cors_error),
                        "error": safe_error,
                        "canceled": bool(event.get("canceled", False)),
                    })

                devtools.on("Network.requestWillBeSent", on_request)
                devtools.on("Network.loadingFailed", on_loading_failed)

            instrument_cdp(page)

            def on_response(response) -> None:
                record = response_record(response, web_origin)
                if record is not None and len(ohif_responses) < 80:
                    ohif_responses.append(record)
                parsed = urlsplit(response.url)
                if (
                    parsed.scheme in ("http", "https")
                    and parsed.netloc == origin.netloc
                    and parsed.path.startswith("/dicom-web/")
                    and len(dicomweb_responses) < 200
                ):
                    response_info: dict[str, object] = {
                        "routeClass": dicomweb_route_class(parsed.path),
                        "subresource": wado_subresource(parsed.path),
                        "status": str(response.status),
                        "resourceType": response.request.resource_type,
                        "contentType": response.headers.get("content-type", "unknown").split(";", 1)[0][:80],
                        "bodyShape": "unavailable",
                    }
                    if dicomweb_route_class(parsed.path).startswith("qido_"):
                        try:
                            body = response.body()
                            payload = json.loads(body) if len(body) <= 64 * 1024 else None
                            response_info["bodyShape"] = (
                                f"array_{min(len(payload), 100)}" if isinstance(payload, list)
                                else "object" if isinstance(payload, dict)
                                else "other"
                            )
                        except (PlaywrightError, ValueError):
                            pass
                    dicomweb_responses.append(response_info)

            def on_request_failed(request) -> None:
                parsed = urlsplit(request.url)
                if (
                    parsed.netloc == origin.netloc
                    and parsed.path.startswith("/ohif/")
                    and len(failed_assets) < 80
                ):
                    failed_assets.append({"path": parsed.path, "resourceType": request.resource_type})
                if (
                    parsed.netloc == origin.netloc
                    and parsed.path.startswith("/dicom-web/")
                    and len(failed_dicomweb_requests) < 80
                ):
                    failed_dicomweb_requests.append({
                        "routeClass": dicomweb_route_class(parsed.path),
                        "subresource": wado_subresource(parsed.path),
                        "resourceType": request.resource_type,
                    })

            page.on("response", on_response)
            page.on("requestfailed", on_request_failed)
            diagnostic_stage = "dashboard_navigation"
            dashboard_response = page.goto(
                f"{web_origin}/staff", wait_until="domcontentloaded", timeout=15_000
            )
            if dashboard_response is None or dashboard_response.status != 200:
                raise ProofError("Authenticated browser did not load the staff dashboard.")
            diagnostic_stage = "dashboard_heading"
            page.get_by_role("heading", name="Studies").wait_for(state="visible", timeout=8_000)
            nav = page.get_by_role("navigation", name="Staff sections")
            mobile_nav_visible = all(
                nav.get_by_role("link", name=name).is_visible()
                for name in ("Studies", "Doctors", "Settings")
            )
            diagnostic_stage = "study_search"
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
            diagnostic_stage = "study_client_navigation"
            study_link.click()
            page.wait_for_url(f"{web_origin}{expected_path}", timeout=10_000)
            diagnostic_stage = "study_full_reload"
            report_response = page.reload(wait_until="domcontentloaded", timeout=15_000)
            if report_response is None:
                raise ProofError("The Ready Report reload returned no browser response.")
            if report_response.status != 200:
                raise ProofError("The Ready Report page did not load successfully.")
            diagnostic_stage = "study_heading"
            page.get_by_text("VERIFIED CLOUD STUDY").wait_for(state="visible", timeout=8_000)
            page.wait_for_function(
                """() => Array.from(document.querySelectorAll('[role="status"]'))
                    .some((item) => !item.innerText.includes('Checking verified study image compatibility'))""",
                timeout=15_000,
            )
            compatibility_notice_text = page.locator('[role="status"]').inner_text(timeout=2_000)
            if not compatibility_notice_text.strip():
                raise ProofError("The staff viewer compatibility notice was empty.")
            mobile_viewer_nav_visible = all(
                page.get_by_role("navigation", name="Staff sections")
                .get_by_role("link", name=name)
                .is_visible()
                for name in ("Studies", "Doctors", "Settings")
            )
            iframe = page.locator('iframe[title="DICOM study viewer"]')
            diagnostic_stage = "viewer_iframe"
            iframe.wait_for(state="attached", timeout=5_000)
            iframe_src = iframe.get_attribute("src") or ""
            iframe_path = urlsplit(iframe_src).path
            if iframe_path != "/ohif/viewer":
                raise ProofError("The study page did not use the same-origin OHIF route.")
            study_page_no_overflow = no_horizontal_overflow(page)
            mobile_viewport = page.evaluate("({width:window.innerWidth,height:window.innerHeight})")
            page.set_viewport_size({"width": 1280, "height": 900})
            diagnostic_stage = "desktop_viewer_reload"
            desktop_report_response = page.reload(wait_until="domcontentloaded", timeout=15_000)
            if desktop_report_response is None or desktop_report_response.status != 200:
                raise ProofError("The wide-viewport Ready Report reload did not succeed.")
            page.get_by_text("VERIFIED CLOUD STUDY").wait_for(state="visible", timeout=8_000)
            iframe = page.locator('iframe[title="DICOM study viewer"]')
            iframe.wait_for(state="attached", timeout=5_000)
            iframe_src = iframe.get_attribute("src") or ""
            iframe_path = urlsplit(iframe_src).path
            if iframe_path != "/ohif/viewer":
                raise ProofError("The wide study page did not use the same-origin OHIF route.")
            desktop_viewport = page.evaluate("({width:window.innerWidth,height:window.innerHeight})")
            desktop_study_no_overflow = no_horizontal_overflow(page)
            diagnostic_stage = "ohif_frame_ready"
            frame, frame_state, iframe_initial_document, iframe_load_wait_ms, iframe_transient_errors = (
                wait_for_ohif_frame(page, web_origin)
            )
            iframe_settled_document = None
            iframe_pixel_pattern = {"passed": False, "reason": "viewer_unavailable"}
            iframe_text_signals = {}
            failure_screenshot = None
            onboarding_actions = {}
            canvas_ready = False
            canvas_wait_ms = 0
            canvas_transient_errors = 0
            if frame is not None and frame_state == "loaded":
                try:
                    onboarding_actions = clear_ohif_first_run_overlays(frame)
                    canvas_ready, canvas_wait_ms, canvas_transient_errors = wait_for_large_viewer_canvas(
                        page, frame
                    )
                    iframe_settled_document = inspect_viewer_document(frame)
                    iframe_pixel_pattern = inspect_pixel_pattern(frame)
                    iframe_text_signals = inspect_viewer_text_signals(frame)
                    if not iframe_pixel_pattern.get("passed"):
                        screenshot = tempfile.NamedTemporaryFile(
                            prefix="clarity-v2-ohif-", suffix=".png", dir="/tmp", delete=False
                        )
                        failure_screenshot = screenshot.name
                        screenshot.close()
                        page.screenshot(path=failure_screenshot, timeout=3_000)
                except PlaywrightError:
                    iframe_settled_document = {"inspection": "unavailable"}
                    iframe_pixel_pattern = {"passed": False, "reason": "canvas_screenshot_unavailable"}

            top_level = context.new_page()
            top_level.on("pageerror", on_page_error)
            top_level.on("console", on_console)
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
            top_level_document = None
            if top_level_frame_state == "loaded":
                try:
                    top_level_document = inspect_viewer_document(top_level)
                except PlaywrightError:
                    top_level_document = {"inspection": "unavailable"}

            negative_path = "/staff/studies/00000000-0000-4000-8000-000000000099"
            diagnostic_stage = "negative_report"
            error_response = page.goto(
                f"{web_origin}{negative_path}", wait_until="domcontentloaded", timeout=15_000
            )
            not_ready_state = page.get_by_role(
                "heading", name="Study is not ready to view"
            ).is_visible()
            qido_success_count = sum(
                1
                for item in dicomweb_responses
                if item["routeClass"].startswith("qido_") and item["status"] == "200"
            )
            iframe_has_content = bool(
                iframe_settled_document
                and iframe_settled_document.get("appRootPresent")
                and (
                    iframe_settled_document.get("canvasCount", 0)
                    or iframe_settled_document.get("viewportCount", 0)
                )
            )
            top_level_has_content = bool(
                top_level_document
                and top_level_document.get("appRootPresent")
                and (
                    top_level_document.get("canvasCount", 0)
                    or top_level_document.get("viewportCount", 0)
                )
            )
            print(json.dumps({
                "viewport": {"mobileWidth": mobile_viewport["width"], "mobileHeight": mobile_viewport["height"],
                             "viewerWidth": desktop_viewport["width"], "viewerHeight": desktop_viewport["height"],
                             "dashboardNoHorizontalOverflow": dashboard_no_overflow,
                             "studyPageNoHorizontalOverflow": study_page_no_overflow,
                             "wideStudyPageNoHorizontalOverflow": desktop_study_no_overflow,
                             "dashboardNavigationVisible": mobile_nav_visible,
                             "studyPageNavigationVisible": mobile_viewer_nav_visible},
                "navigation": {"dashboardStatus": dashboard_response.status,
                               "readySearchMatched": True,
                               "studyPageStatus": report_response.status,
                               "studyRoute": "matched_private_fixture",
                               "compatibilityNotice": compatibility_notice_text[:700]},
                "iframe": {"path": iframe_path, "state": frame_state,
                           "appReadyWaitMilliseconds": iframe_load_wait_ms,
                           "transientInspectionErrors": iframe_transient_errors,
                           "initialDocument": iframe_initial_document,
                           "settledDocument": iframe_settled_document,
                           "largeCanvasReady": canvas_ready,
                           "canvasWaitMilliseconds": canvas_wait_ms,
                           "canvasTransientInspectionErrors": canvas_transient_errors,
                           "syntheticPixelPattern": iframe_pixel_pattern,
                           "visibleTextSignals": iframe_text_signals,
                           "onboardingActions": onboarding_actions,
                           "failureScreenshot": failure_screenshot,
                           "observationWindowSeconds": 8},
                "topLevelViewer": {"status": top_level_status,
                                   "state": top_level_frame_state,
                                   "navigationErrorType": top_level_navigation_error,
                                   "document": top_level_document},
                "ohifResponses": ohif_responses,
                "failedOhifAssets": failed_assets,
                "dicomweb": dicomweb_summary(dicomweb_responses),
                "wadoResponses": [
                    {key: item.get(key) for key in ("routeClass", "subresource", "status", "contentType", "resourceType", "bodyShape")}
                    for item in dicomweb_responses if str(item.get("routeClass", "")).startswith("wado_")
                ],
                "qidoRequestContracts": qido_request_contracts,
                "authorizedQidoSuccessCount": qido_success_count,
                "viewerContentSignal": iframe_has_content or top_level_has_content,
                "failedDicomwebRequests": failed_dicomweb_requests,
                "cdpLoadingFailures": cdp_loading_failures,
                "browserErrorCategories": browser_errors,
                "negativeReport": {"httpStatus": error_response.status if error_response else None,
                                   "notReadyMessageVisible": not_ready_state},
            }, sort_keys=True))
            diagnostic_stage = "browser_acceptance_assertions"
            if qido_success_count == 0:
                raise ProofError("The browser did not complete an authorized QIDO request.")
            if not (iframe_has_content or top_level_has_content):
                raise ProofError("OHIF loaded without creating a viewer viewport or canvas.")
            if not iframe_pixel_pattern.get("passed"):
                raise ProofError("OHIF canvas did not show the synthetic four-level grayscale pattern.")
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except (ProofError, KeyError, TypeError, ValueError, OSError, PlaywrightTimeoutError) as error:
        print(
            f"Synthetic OHIF browser diagnostic failed at {diagnostic_stage}: {type(error).__name__}.",
            file=sys.stderr,
        )
        raise SystemExit(1)
