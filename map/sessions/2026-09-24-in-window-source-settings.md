---
id: in-window-source-settings-session-2026-09-24
type: session
title: Replace the Orthanc settings pop-up with an in-app page
universe: live
status: verified
updated: 2026-09-24
revision: in-window-source-settings-session-2026-09-24
---

# Replace the Orthanc settings pop-up with an in-app page

## Request and result

The user showed the separate Orthanc source settings window and asked for the
form to remain inside the existing Electron app and Settings flow. The durable
[decision](../decisions/2026-09-24-in-window-source-settings.md) supersedes the
pop-up design. [Plan v1.4](../../docs/01-final-clarity-v2-plan.md) adds BR-10
and TR-15. The hosted Settings panel now requests in-window navigation. Electron
loads the bundled source form in its existing BrowserWindow after a fresh admin
check, and the form shows Studies/Doctors/Settings navigation plus Back to
Settings. Source read, test and save remain limited to that bundled main frame.

## Verification

The desktop build and 18 focused tests passed, including fixed hosted Settings
origin/path and fixed in-app return destinations. The web typecheck and Docker
web build passed. A browser layout preview showed the form, sidebar and back
button together without a pop-up. Native Electron then signed in as the
preapproved synthetic administrator, opened the bundled page from Settings in
the **same standard window**, showed the saved five-minute configuration, and
returned to hosted Settings. The in-window Test succeeded. Saving the unchanged
source updated the mode-`0600` config and restarted the independent demo service;
the save toast was not observed because the app subsequently navigated to
Studies. See [evidence 42](../../docs/evidence/42-in-window-source-settings.md).

## Map review and next step

Updated [planning workspace](../objects/planning-workspace.md),
[source/service](../objects/source-and-service.md) and
[staff identity](../objects/staff-identity.md). The native synthetic round trip
is verified. Packaged macOS/Windows and installed-service acceptance remain
before closing P3.5.
