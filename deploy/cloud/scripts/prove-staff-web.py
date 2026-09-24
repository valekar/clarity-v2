#!/usr/bin/env python3
"""Check protected staff routes against two real disposable Hanko sessions."""

from __future__ import annotations

import http.client
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit


class ProofError(RuntimeError):
    pass


def get_identity(path: str) -> dict[str, str]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not all(
        isinstance(value.get(key), str) for key in ("subject", "email", "cookie")
    ):
        raise ProofError("Private synthetic identity fixture is malformed.")
    return value


def request(origin: str, path: str, cookie: str, method: str = "GET",
            payload: dict | None = None, request_origin: str | None = None,
            content_type: str = "application/json") -> tuple[int, dict]:
    parsed = urlsplit(origin)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Cookie": cookie}
    if request_origin is not None:
        headers["Origin"] = request_origin
    if body is not None:
        headers["Content-Type"] = content_type
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read(8193)
        if len(data) > 8192:
            raise ProofError("Staff API response exceeded the proof limit.")
        if not data:
            return response.status, {}
        try:
            value = json.loads(data)
        except json.JSONDecodeError as exc:
            raise ProofError("Staff API did not return a JSON response.") from exc
        if not isinstance(value, dict):
            raise ProofError("Staff API returned an unexpected JSON shape.")
        return response.status, value
    finally:
        connection.close()


def request_bytes(origin: str, path: str, cookie: str, accept: str,
                  maximum: int = 16 * 1024 * 1024) -> tuple[int, dict[str, str], bytes]:
    parsed = urlsplit(origin)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=10)
    try:
        connection.request("GET", path, headers={"Cookie": cookie, "Accept": accept})
        response = connection.getresponse()
        body = response.read(maximum + 1)
        if len(body) > maximum:
            raise ProofError("Viewer response exceeded the proof byte limit.")
        headers = {name.lower(): value for name, value in response.getheaders()}
        return response.status, headers, body
    finally:
        connection.close()


def prove_viewer(web_origin: str, cookie: str, fixture_path: str) -> None:
    fixture = json.loads(Path(fixture_path).read_text(encoding="utf-8"))
    required = ("reportId", "studyInstanceUid", "seriesInstanceUid", "sopInstanceUid")
    if not isinstance(fixture, dict) or not all(
        isinstance(fixture.get(key), str) and fixture[key]
        for key in required
    ):
        raise ProofError("Connected synthetic viewer fixture is malformed.")
    report_id, study_uid, series_uid, sop_uid = (fixture[key] for key in required)
    if fixture.get("reportState") != "ready" or fixture.get("sourceOffline") is not True:
        raise ProofError("Viewer fixture must be Ready and source-offline for cloud readback.")

    status, page = request(
        web_origin, f"/api/studies?q={study_uid}", cookie
    )
    expect_status(status, 200, "Authenticated study search")
    entries = page.get("items")
    match = next(
        (item for item in entries if item.get("reportId") == report_id),
        None,
    ) if isinstance(entries, list) else None
    if not match or match.get("canView") is not True or match.get("sourceStatus") != "disabled":
        raise ProofError("The source-offline Ready Report was not searchable as a verified cloud copy.")

    qido_path = f"/dicom-web/studies?StudyInstanceUID={study_uid}"
    status, headers, body = request_bytes(
        web_origin, qido_path, cookie, "application/dicom+json", maximum=4 * 1024 * 1024
    )
    expect_status(status, 200, "Authenticated Study QIDO")
    if "no-store" not in headers.get("cache-control", ""):
        raise ProofError("Viewer metadata response did not disable caching.")
    try:
        studies = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ProofError("Study metadata was not valid DICOM JSON.") from exc
    if not isinstance(studies, list) or not any(
        isinstance(item, dict)
        and item.get("0020000D", {}).get("Value", [None])[0] == study_uid
        for item in studies
    ):
        raise ProofError("Study QIDO did not return the exact Ready Study UID.")

    instance_metadata_path = (
        f"/dicom-web/studies/{study_uid}/series/{series_uid}/instances"
    )
    status, _, metadata_body = request_bytes(
        web_origin, instance_metadata_path, cookie, "application/dicom+json",
        maximum=4 * 1024 * 1024,
    )
    expect_status(status, 200, "Authenticated instance QIDO")
    try:
        instances = json.loads(metadata_body)
    except json.JSONDecodeError as exc:
        raise ProofError("Instance metadata was not valid DICOM JSON.") from exc
    late = fixture.get("lateArrival")
    expected_sops = {sop_uid}
    if isinstance(late, dict):
        late_sop = late.get("sopInstanceUid")
        if not isinstance(late_sop, str) or not late_sop or late_sop == sop_uid:
            raise ProofError("Late-arrival fixture has no distinct SOP Instance UID.")
        if late.get("resealedRevision") != 2:
            raise ProofError("Late-arrival fixture did not reach revision 2.")
        expected_sops.add(late_sop)
    if not isinstance(instances, list) or len(instances) != len(expected_sops):
        raise ProofError("Instance QIDO exposed a non-exact manifest membership set.")
    returned_sops = {
        item.get("00080018", {}).get("Value", [None])[0]
        for item in instances if isinstance(item, dict)
    }
    if returned_sops != expected_sops:
        raise ProofError("Instance QIDO returned a non-exact SOP Instance UID set.")
    item = next(item for item in instances if item["00080018"]["Value"][0] == sop_uid)
    pixel = item.get("7FE00010", {})
    if isinstance(pixel, dict) and isinstance(pixel.get("BulkDataURI"), str):
        bulk_uri = pixel["BulkDataURI"]
        if not bulk_uri.startswith(web_origin + "/dicom-web/") or "orthanc" in bulk_uri.lower():
            raise ProofError("BulkDataURI escaped the staff same-origin gateway.")
        bulk_path = urlsplit(bulk_uri).path
        status, bulk_headers, bulk_body = request_bytes(
            web_origin, bulk_path, cookie, "application/octet-stream"
        )
        expect_status(status, 200, "Authorized bulk-data read")
        if not bulk_body or "no-store" not in bulk_headers.get("cache-control", ""):
            raise ProofError("Bulk-data response was empty or cacheable.")

    for expected_sop in expected_sops:
        instance_path = (
            f"/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{expected_sop}"
        )
        status, instance_headers, instance_body = request_bytes(
            web_origin, instance_path, cookie, 'multipart/related; type="application/dicom"'
        )
        expect_status(status, 200, "Authenticated WADO instance read")
        if not instance_body or "no-store" not in instance_headers.get("cache-control", ""):
            raise ProofError("WADO response was empty or cacheable.")

    unrelated_uid = "1.2.826.0.1.3680043.10.987.999"
    status, _, _ = request_bytes(
        web_origin, f"/dicom-web/studies?StudyInstanceUID={unrelated_uid}",
        cookie, "application/dicom+json",
    )
    expect_status(status, 404, "Unrelated Study UID denial")

    status, ohif_headers, ohif_body = request_bytes(
        web_origin,
        f"/ohif/viewer?StudyInstanceUIDs={study_uid}",
        cookie,
        "text/html",
        maximum=4 * 1024 * 1024,
    )
    expect_status(status, 200, "Authenticated OHIF viewer route")
    if "text/html" not in ohif_headers.get("content-type", "") or not ohif_body:
        raise ProofError("OHIF viewer route did not return its configured application page.")

    print("Synthetic viewer proof: source-offline Ready search, exact Study/instance QIDO, authorized WADO/bulk data, unrelated UID denial, and authenticated OHIF HTML route passed.")


def expect_status(actual: int, expected: int, label: str) -> None:
    if actual != expected:
        raise ProofError(f"{label} returned HTTP {actual}, expected {expected}.")


def main() -> None:
    args = sys.argv[1:]
    mode = "verify"
    if args and args[0] in ("enroll", "verify"):
        mode = args.pop(0)
    if len(args) not in (4, 5):
        raise SystemExit("usage: prove-staff-web.py [enroll|verify] WEB_ORIGIN HANKO_URL ADMIN_IDENTITY_JSON STAFF_IDENTITY_JSON [VIEWER_FIXTURE_JSON]")
    web_origin, hanko_origin, admin_path, staff_path = args[:4]
    viewer_path = args[4] if len(args) == 5 else None
    admin = get_identity(admin_path)
    staff = get_identity(staff_path)
    if admin["subject"] == staff["subject"] or admin["email"] == staff["email"]:
        raise ProofError("The two provider-issued test identities must be distinct.")

    if mode == "enroll":
        for identity in (admin, staff):
            status, body = request(web_origin, "/api/staff/access", identity["cookie"])
            expect_status(status, 403, "First access for pending identity")
            if body.get("error") != "forbidden":
                raise ProofError("Unapproved provider identity was not denied as pending.")
        print("Two provider-issued Hanko identities were enrolled as pending and denied access.")
        return

    status, admin_access = request(web_origin, "/api/staff/access", admin["cookie"])
    expect_status(status, 200, "Bootstrapped administrator access")
    if admin_access.get("principal", {}).get("role") != "admin":
        raise ProofError("Bootstrapped Hanko identity did not resolve to administrator access.")

    for request_origin, content_type in (
        ("https://attacker.invalid", "application/json"),
        (None, "application/json"),
        (web_origin, "text/plain"),
    ):
        status, _ = request(
            web_origin, "/api/staff", admin["cookie"], "POST",
            {"targetUserId": "00000000-0000-4000-8000-000000000001", "role": "admin"},
            request_origin, content_type,
        )
        expect_status(status, 403, "Cross-origin or non-JSON mutation")

    status, page = request(web_origin, "/api/staff?limit=1", admin["cookie"])
    expect_status(status, 200, "Bounded administrator directory page")
    entries = page.get("entries")
    if not isinstance(entries, list) or len(entries) != 1 or not page.get("nextCursor"):
        raise ProofError("Staff directory did not return a bounded page and cursor.")
    status, next_page = request(
        web_origin,
        "/api/staff?limit=1&after=" + str(page["nextCursor"]),
        admin["cookie"],
    )
    expect_status(status, 200, "Next administrator directory page")
    entries.extend(next_page.get("entries", []))
    if len(entries) != 2:
        raise ProofError("Two distinct provider accounts were not independently enrolled.")
    staff_entry = next((entry for entry in entries if entry.get("displayName") == staff["email"]), None)
    admin_entry = next((entry for entry in entries if entry.get("displayName") == admin["email"]), None)
    if not staff_entry or not admin_entry or staff_entry["staffUserId"] == admin_entry["staffUserId"]:
        raise ProofError("Verified provider emails did not identify separate pending accounts for review.")
    if staff_entry.get("membership") is not None or admin_entry.get("membership") is None:
        raise ProofError("Pending review and bootstrapped administrator state did not match.")

    status, _ = request(
        web_origin, "/api/staff", admin["cookie"], "POST",
        {"targetUserId": staff_entry["staffUserId"], "role": "staff"}, web_origin,
    )
    expect_status(status, 201, "Explicit staff access grant")
    status, staff_access = request(web_origin, "/api/staff/access", staff["cookie"])
    expect_status(status, 200, "Granted staff access")
    if staff_access.get("principal", {}).get("role") != "staff":
        raise ProofError("Granting one pending Hanko identity affected another account's role.")

    if viewer_path:
        prove_viewer(web_origin, staff["cookie"], viewer_path)

    status, _ = request(
        web_origin, f"/api/staff/{staff_entry['staffUserId']}", staff["cookie"], "PATCH",
        {"expectedVersion": "1"}, web_origin,
    )
    expect_status(status, 403, "Staff attempt to disable account")

    status, _ = request(
        web_origin, f"/api/staff/{staff_entry['staffUserId']}", admin["cookie"], "PATCH",
        {"expectedVersion": "1"}, web_origin,
    )
    expect_status(status, 200, "Administrator disables staff membership")
    status, body = request(web_origin, "/api/staff/access", staff["cookie"])
    expect_status(status, 403, "Next request after membership disable")
    if body.get("error") != "forbidden":
        raise ProofError("Disabled membership remained usable.")
    if viewer_path:
        fixture = json.loads(Path(viewer_path).read_text(encoding="utf-8"))
        study_uid = str(fixture["studyInstanceUid"])
        for path in (
            f"/api/studies?q={study_uid}",
            f"/dicom-web/studies?StudyInstanceUID={study_uid}",
            f"/ohif/viewer?StudyInstanceUIDs={study_uid}",
        ):
            status, _, _ = request_bytes(web_origin, path, staff["cookie"], "application/dicom+json")
            expect_status(status, 403, "Viewer request after membership revocation")

    status, _ = request(
        web_origin, f"/api/staff/{staff_entry['staffUserId']}", admin["cookie"], "PATCH",
        {"expectedVersion": "1"}, web_origin,
    )
    expect_status(status, 409, "Stale membership version")
    status, _ = request(
        web_origin, f"/api/staff/{admin_entry['staffUserId']}", admin["cookie"], "PATCH",
        {"expectedVersion": "1"}, web_origin,
    )
    expect_status(status, 409, "Last administrator protection")
    status, _ = request(web_origin, "/api/staff/access", admin["cookie"])
    expect_status(status, 200, "Administrator access after rejected last-admin change")

    parsed = urlsplit(hanko_origin)
    logout_connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
    try:
        logout_connection.request("POST", "/logout", headers={"Cookie": staff["cookie"]})
        logout = logout_connection.getresponse()
        logout.read(8192)
        expect_status(logout.status, 204, "Hanko v3 logout")
    finally:
        logout_connection.close()
    status, _ = request(web_origin, "/api/staff/access", staff["cookie"])
    expect_status(status, 401, "API replay after Hanko logout")
    if viewer_path:
        fixture = json.loads(Path(viewer_path).read_text(encoding="utf-8"))
        study_uid = str(fixture["studyInstanceUid"])
        status, _, _ = request_bytes(
            web_origin,
            f"/ohif/viewer?StudyInstanceUIDs={study_uid}",
            staff["cookie"],
            "text/html",
        )
        expect_status(status, 401, "OHIF viewer after Hanko session revocation")
    print("Two real Hanko-issued identities passed pending review, admin grant, Origin/CSRF rejection, current-membership checks, role denial, stale-version and last-admin conflicts, disable-on-next-request, and logout replay denial; tokens omitted.")


if __name__ == "__main__":
    try:
        main()
    except (ProofError, KeyError, TypeError, ValueError) as error:
        print(f"Synthetic staff web proof failed: {error}", file=sys.stderr)
        raise SystemExit(1)
