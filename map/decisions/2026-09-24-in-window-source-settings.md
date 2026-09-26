---
id: in-window-source-settings-2026-09-24
type: decision
title: Keep Orthanc setup inside Electron Settings
universe: live
status: verified
updated: 2026-09-24
revision: in-window-source-settings-2026-09-24
---

# Keep Orthanc setup inside Electron Settings

## Approved direction

On 24 September the user rejected the separate Orthanc settings pop-up shown in
the desktop screenshot. Source connection belongs inside the existing Electron
window as another Settings page. The left navigation and a clear return path
should keep the staff workflow recognizable. This supersedes the separate
local-window presentation in plan v1.3; it does not change Hanko staff identity,
the private Orthanc source, or the independent sync-service schedule.

## Proposed choices

The [plan v1.4](../../docs/01-final-clarity-v2-plan.md) retains the existing
trust boundary: hosted Settings makes only a named navigation request, while
the bundled `file:` page in the same BrowserWindow receives source input through
narrow validated IPC. Backend admin membership is checked afresh before opening
and on every read, test and save. A fixed return destination restores hosted
Settings. The hosted renderer does not receive saved Orthanc credentials.

## Open inputs

The native synthetic clickthrough, return and same-source connection test passed.
Packaged macOS/Windows and installed-service proof remain open.

## Impact and source

Affected: [desktop shell](../../apps/desktop/CONTEXT.md),
[staff UI](../../apps/web/CONTEXT.md),
[source/service](../objects/source-and-service.md) and
[staff identity](../objects/staff-identity.md). See
[in-window revision evidence](../../docs/evidence/42-in-window-source-settings.md).
