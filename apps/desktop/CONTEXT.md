# Electron desktop shell

Electron opens the hosted Clarity staff sign-in page when `CLARITY_DASHBOARD_ORIGIN`
and `CLARITY_HANKO_ORIGIN` are supplied. The origins must be HTTPS, except for
explicitly enabled loopback HTTP in the synthetic demo. Without environment values,
the first-run bundled page accepts the public dashboard and Hanko origins and stores
them as a private `server.json` in Electron's user data directory. If the hosted sign-in
page cannot be reached, the app returns to that page with a retry or edit path.

The hosted dashboard remains the sign-in and staff workflow. It is constrained to the
configured dashboard/Hanko origins, with Node integration off, context isolation,
sandboxing and narrow preload IPC. Pairing/revocation IPC performs authorization on
the server. The hosted Settings page can ask Electron to show a bundled local
Orthanc page in the same main window. That page preserves the Settings sidebar
and can return to hosted Settings without a pop-up. It checks the active
Hanko-linked Clarity admin on every operation, tests the Orthanc `/system`
endpoint, and never returns saved
credentials to the hosted renderer. Source URL/auth and the 5–60 minute poll interval are
written through the sync-service private-config writer; the synthetic demo watches that
file and restarts only its own sync child. A source URL change is blocked until a new
pairing and reconciliation path exists.

The main BrowserWindow uses Electron's standard operating-system frame and native
window buttons. macOS provides its close, minimize and zoom/full-screen traffic
lights; Windows uses its normal caption buttons. There are no in-page window
actions or preload IPC for window management.

For synthetic development, build the desktop package, then launch it with the dashboard,
Hanko and synthetic sync settings from the disposable demo launcher. The launcher
exports `CLARITY_ALLOW_LOOPBACK_HTTP=true`, `CLARITY_SYNC_CONFIG_PATH`,
`CLARITY_SYNC_CONFIG_WRITER`, `CLARITY_NODE_EXECUTABLE`,
`CLARITY_SYNTHETIC_DEMO=true` and `CLARITY_DESKTOP_PROFILE_DIR`. The profile override
must be an absolute, private directory named `electron-profile`; Electron applies it
as `userData` and uses its private `session-data` child for Chromium session cookies
before app readiness. The launcher should place it at
`<synthetic-demo-state>/electron-profile`. Local Orthanc credentials are saved in the
private sync config. Do not run this demo with real patient data.

This is a working Electron development shell, not a packaged or signed macOS/Windows
installer. Real OS service installation, protected credential vault integration,
upgrade/rollback and unattended startup remain unverified.
