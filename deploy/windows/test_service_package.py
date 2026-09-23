import hashlib
import json
import unittest
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).parent


class WindowsServiceScaffoldTests(unittest.TestCase):
    def test_service_xml_is_static_manual_and_least_privilege(self):
        root = ET.parse(ROOT / "ClaritySyncService.xml").getroot()
        self.assertEqual(root.findtext("id"), "ClarityV2Sync")
        self.assertEqual(root.findtext("startmode"), "Manual")
        self.assertEqual(root.findtext("serviceaccount/domain"), "NT AUTHORITY")
        self.assertEqual(root.findtext("serviceaccount/user"), "LocalService")
        self.assertEqual(root.findtext("executable"), r"%BASE%\runtime\node.exe")
        self.assertIn(r"%BASE%\app\dist\main.js", root.findtext("arguments", ""))
        self.assertIn(r"%ProgramData%\ClarityV2\config\sync-service.json", root.findtext("arguments", ""))
        failures = root.findall("onfailure")
        self.assertEqual([item.get("action") for item in failures], ["restart", "restart", "none"])
        self.assertEqual([item.get("delay") for item in failures], ["30 sec", "120 sec", None])
        self.assertFalse(any(item.get("action") == "reboot" for item in failures))
        self.assertEqual(root.find("log").get("mode"), "roll")

    def test_wrapper_lock_pins_official_release_asset_and_digest(self):
        lock = json.loads((ROOT / "WinSW.lock.json").read_text())
        self.assertEqual(lock["version"], "2.12.0")
        self.assertEqual(lock["license"], "MIT")
        self.assertEqual(lock["artifact"], "WinSW-x64.exe")
        self.assertEqual(
            lock["url"],
            "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe",
        )
        self.assertRegex(lock["sha256"], r"^[0-9a-f]{64}$")

    def test_optional_download_matches_pinned_wrapper_hash_without_executing_it(self):
        """Set WINSW_LOCAL_ARTIFACT in CI after a checksum-verified download."""
        import os

        artifact = os.environ.get("WINSW_LOCAL_ARTIFACT")
        if not artifact:
            self.skipTest("no wrapper binary supplied; this test never installs or runs it")
        lock = json.loads((ROOT / "WinSW.lock.json").read_text())
        digest = hashlib.sha256(Path(artifact).read_bytes()).hexdigest()
        self.assertEqual(digest, lock["sha256"])


if __name__ == "__main__":
    unittest.main()
