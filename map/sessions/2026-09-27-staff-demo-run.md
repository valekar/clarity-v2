---
id: staff-demo-run-2026-09-27
type: session
title: Run staff-only synthetic Electron demo
universe: live
status: verified
updated: 2026-09-27
revision: staff-demo-run-2026-09-27
---

# Run staff-only synthetic Electron demo

## Request and result

The user asked to run the app and see the result after selecting staff-only
username/password sign-in. The [disposable launcher](../../deploy/cloud/scripts/run-synthetic-demo.sh)
now provisions a generated Hanko username/password with public signup and
email disabled, enrolls and bootstraps one Clarity administrator, then opens
Electron. The [live run](../../docs/evidence/41-interactive-synthetic-desktop-demo.md)
signed in, saved a separate loopback Orthanc connection in the same Electron
window, and showed one automatically synced synthetic CT as **READY**.

## Verification

The fresh web/API/worker stack passed the launcher's migration, Hanko and
Orthanc readiness, anonymous staff denial, web health and worker startup
checks. Electron visibly showed native macOS window controls, username and
password sign-in, Studies/Doctors/Settings navigation, and one active staff
administrator. The local Orthanc test succeeded; its source contained one
generated study. The compiled sync service advanced SQLite's source cursor
from 0 to 7, recorded one report/upload, and the staff queue showed 1/1 images
verified and **READY**. The study page opened the OHIF canvas with a transfer
syntax compatibility warning. The saved schedule was restored to five minutes
after a temporary loopback-only fast synthetic poll. Image builds encountered
package-registry timeouts, so this run reused a freshly built web image and a
prior unchanged worker image, with Hanko bound to the web image's build-time
loopback port. The no-email Hanko profile remained healthy after its obsolete
Compose Mailpit dependency was removed and the disposable Mailpit container
stopped. This is local synthetic evidence only.

## Map review and next step

Updated [staff identity](../objects/staff-identity.md) and
[private source/service](../objects/source-and-service.md) evidence links.
Installed macOS/Windows service and packaged Hanko acceptance, hosted Coolify
smoke, real centre Orthanc, and clinical viewer compatibility remain open.
