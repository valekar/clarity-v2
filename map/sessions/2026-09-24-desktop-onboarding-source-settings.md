---
id: desktop-onboarding-source-settings-2026-09-24
type: session
title: Desktop sign-in and local Orthanc connection clarification
universe: live
status: verified
updated: 2026-09-24
revision: desktop-onboarding-source-settings-2026-09-24
---

# Desktop sign-in and local Orthanc connection clarification

## Request and result

The user showed an Electron foundation screen and an inactive web preview, then
clarified the desired installed flow: Hanko sign-in or account creation for
preapproved staff, left Settings navigation, a saved local Orthanc REST
connection and configurable five/ten-minute automatic discovery. The earlier
choice of Hanko only and synthetic integration still applies. "Authank" in
context refers to Orthanc as the local DICOM REST source, distinct from Hanko
staff identity.

[Plan version 1.3](../../docs/01-final-clarity-v2-plan.md) adds requirements
BR-08/09 and TR-13/14, explicit P2.4/P3.5 acceptance, a local configuration
sequence and source-identity safeguards. The inert [web root](../../apps/web/src/app/page.tsx)
now routes to sign-in. Protected staff pages have a left navigation; the
[Settings entry](../../apps/web/src/app/staff/settings/SourceConnectionPanel.tsx)
requests a bundled Electron settings window so the hosted renderer need not
hold Orthanc credentials. A [fresh admin authorization route](../../apps/web/src/app/api/device-admin/authorize/route.ts)
checks current Hanko session and active Clarity administrator membership.
No browser registration auto-grants a membership or adds a second password
store to Clarity.

## Verification

The web root returned HTTP 307 with `location: /sign-in` on the running local
web process. `pnpm --filter @clarity/web typecheck` and
`pnpm --filter @clarity/web test` passed, with 12 web tests. The separate-source
compiled-service [Docker rerun](../../docs/evidence/33-compiled-sync-crash-recovery.md)
exited 0 after a proof-harness startup race was fixed; it reached Ready,
recovered from two SIGKILL points, preserved one upload and passed fresh-volume
restore. This is synthetic evidence, not an installed-service or clinic proof.

The [interactive synthetic desktop run](../../docs/evidence/41-interactive-synthetic-desktop-demo.md)
then opened an isolated Electron profile at Hanko sign-in. A preapproved
synthetic administrator signed in, saw the left Studies/Doctors/Settings
navigation, opened the bundled local settings window, tested the separate
Orthanc `/system` endpoint and saved its credential and five-minute interval
into the private service config. The compiled service admitted the generated
`SYNTHETIC^DEMO-SEP24` CT, which appeared READY with one verified image. The
source status became HEALTHY after correcting a numeric-versus-string
generation mismatch in the health route. The service stayed alive after the
isolated Electron process exited; a second synthetic CT was submitted and
appeared READY at the next five-minute health report. Desktop tests passed
16/16, web tests 12/12 and
sync tests 83/83. Successful polls now honor the configured interval instead
of an accidental one-minute cap. Between polls, the service refreshes health
and its cloud lease each minute without fetching Orthanc inventory; saving a
regular interval also removes any synthetic five-second override.
In the live Docker run, `reported_at` advanced from 12:15:09 to 12:16:09 UTC
while `last_successful_sync_at` stayed at 12:15:09 UTC; one independent service
process remained active.

## Map review and next step

[Planning workspace](../objects/planning-workspace.md),
[staff identity](../objects/staff-identity.md) and
[source/service](../objects/source-and-service.md) were updated for the new
routing and plan. Validate installed service persistence on both OS families.
Native installers,
protected OS credential custody, real source compatibility and clinical
release gates remain open.
