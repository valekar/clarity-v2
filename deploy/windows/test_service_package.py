import hashlib
import json
import unittest
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).parent


class WindowsServiceScaffoldTests(unittest.TestCase):
    def test_service_xml_starts_at_boot_under_least_privilege(self):
        root = ET.parse(ROOT / "ClaritySyncService.xml").getroot()
        self.assertEqual(root.findtext("id"), "ClarityV2Sync")
        self.assertEqual(root.findtext("startmode"), "Automatic")
        self.assertEqual(root.findtext("serviceaccount/domain"), "NT AUTHORITY")
        self.assertEqual(root.findtext("serviceaccount/user"), "LocalService")
        self.assertEqual(root.findtext("executable"), r"%BASE%\runtime\node.exe")
        self.assertIn(r"%BASE%\app\dist\main.js", root.findtext("arguments", ""))
        self.assertIn(r"%ProgramData%\ClarityV2\config\sync-service.json", root.findtext("arguments", ""))
        self.assertIn("--config", root.findtext("arguments", ""))
        failures = root.findall("onfailure")
        self.assertEqual([item.get("action") for item in failures], ["restart", "restart", "none"])
        self.assertEqual([item.get("delay") for item in failures], ["30 sec", "120 sec", None])
        self.assertFalse(any(item.get("action") == "reboot" for item in failures))
        self.assertEqual(root.find("log").get("mode"), "roll")

    def test_platform_templates_use_the_compiled_release_entry(self):
        import re

        mac_template = (ROOT.parent / "installers/macos/templates/org.clarity-v2.sync-service.plist.in").read_text()
        self.assertIn("/current/app/dist/main.js", mac_template)
        self.assertIn("/current/runtime/bin/node", mac_template)
        self.assertRegex(mac_template, r"<string>--config</string>")

        xml = (ROOT / "ClaritySyncService.xml").read_text()
        self.assertIn(r"%BASE%\app\dist\main.js", xml)
        self.assertIn(r"%BASE%\runtime\node.exe", xml)
        self.assertRegex(xml, r"--config\s+\"%ProgramData%\\ClarityV2\\config\\sync-service\.json\"")

    def test_built_release_contains_runtime_and_compiled_workspace_dependencies(self):
        import os
        import subprocess

        release_dir = os.environ.get("CLARITY_RELEASE_DIR")
        if not release_dir:
            self.skipTest("CI may supply a compiled release directory for an end-to-end layout check")
        release = Path(release_dir)
        self.assertTrue((release / "runtime/node.exe").is_file())
        self.assertTrue((release / "app/dist/main.js").is_file())
        self.assertTrue((release / "app/package.json").is_file())
        self.assertTrue((release / "app/node_modules/@clarity/contracts/dist/index.js").is_file())
        self.assertTrue((release / "ClaritySyncService.exe").is_file())
        self.assertTrue((release / "ClaritySyncService.xml").is_file())
        self.assertTrue((release / "WinSW.lock.json").is_file())
        self.assertEqual(
            (release / "ClaritySyncService.xml").read_bytes(),
            (ROOT / "ClaritySyncService.xml").read_bytes(),
        )
        self.assertFalse((release / "app/src").exists())
        self.assertFalse((release / "app/.turbo").exists())
        self.assertFalse((release / "app/lifecycle-probe").exists())
        run = subprocess.run(
            [str(release / "runtime/node.exe"), str(release / "app/dist/main.js"), "--config", str(release / "missing-config.json")],
            capture_output=True,
            check=False,
        )
        self.assertEqual(run.returncode, 78, run.stderr.decode(errors="replace"))

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
