#!/usr/bin/env python3
"""Upload one synthetic-only DICOM instance to the local interactive demo Orthanc."""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DEMO_DIR = Path(os.environ.get("CLARITY_SYNTHETIC_DEMO_DIR", Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "clarity-v2/synthetic-demo"))
DEFAULT_MANIFEST = DEFAULT_DEMO_DIR / "demo.json"
GENERATOR = ROOT / "deploy/cloud/scripts/make-synthetic-dicom.py"


def main() -> None:
    if len(sys.argv) > 4:
        raise SystemExit("usage: upload-synthetic-dicom.py [PRIVATE_DEMO_MANIFEST] [ct|mr|sr|pdf] [SYNTHETIC_LABEL]")
    manifest_path = Path(sys.argv[1]).expanduser() if len(sys.argv) >= 2 else DEFAULT_MANIFEST
    profile = sys.argv[2] if len(sys.argv) >= 3 else "ct"
    label = sys.argv[3].upper() if len(sys.argv) == 4 else "PROOF"
    if profile not in {"ct", "mr", "sr", "pdf"}:
        raise SystemExit("profile must be ct, mr, sr or pdf")
    if not re.fullmatch(r"[A-Z0-9_-]{1,24}", label):
        raise SystemExit("synthetic label must use 1-24 letters, digits, hyphen or underscore; it is always prefixed SYNTHETIC^")
    metadata = os.lstat(manifest_path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_mode & 0o077:
        raise SystemExit("demo manifest must be a regular private file with mode 0600")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("syntheticDataOnly") is not True:
        raise SystemExit("refusing to upload: manifest is not marked synthetic-only")
    source = manifest.get("sourceOrthanc", {})
    config_path = Path(manifest.get("syncConfigPath", ""))
    url = source.get("url")
    username = source.get("username")
    password = source.get("password")
    parsed = urlsplit(url or "")
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or not parsed.port:
        raise SystemExit("source Orthanc must be an explicit loopback HTTP endpoint")
    if not isinstance(username, str) or not isinstance(password, str) or not username or not password:
        raise SystemExit("private manifest does not contain synthetic Orthanc credentials")

    uid_suffix = str(secrets.randbelow(10**19 - 1) + 1)
    with tempfile.TemporaryDirectory(prefix="clarity-v2-synthetic-dicom-") as temporary:
        path = Path(temporary) / "synthetic.dcm"
        generated = subprocess.run(
            ["python3", str(GENERATOR), str(path), uid_suffix, "1", profile, label],
            check=True,
            capture_output=True,
            text=True,
        )
        study_uid, series_uid, sop_uid = generated.stdout.strip().split("\t")
        authorization = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
        request = Request(
            url.rstrip("/") + "/instances",
            data=path.read_bytes(),
            headers={"Authorization": f"Basic {authorization}", "Content-Type": "application/dicom"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=15) as response:
                result = json.loads(response.read(64 * 1024))
        except (HTTPError, URLError, TimeoutError) as error:
            raise SystemExit(f"synthetic source upload failed: {error}") from error
        if result.get("Status") != "Success":
            raise SystemExit("synthetic source Orthanc did not accept the DICOM instance")
        print(f"Uploaded synthetic {profile.upper()} instance with patient label SYNTHETIC^{label}.")
        print(f"Study Instance UID: {study_uid}")
        print(f"Series Instance UID: {series_uid}")
        print(f"SOP Instance UID: {sop_uid}")
        interval = 5
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
            interval = int(config.get("CLARITY_SYNC_POLL_INTERVAL_MINUTES", "5"))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
        print(f"The saved {interval}-minute sync interval controls when it appears in the staff dashboard.")


if __name__ == "__main__":
    main()
