# Interactive synthetic desktop demo

## Status

The persistent launcher and connected synthetic desktop flow ran on 24 September
2026. An isolated Electron profile signed in as the Hanko-backed Clarity
administrator; its local Settings window tested and saved a separate Orthanc
source. The compiled sync service started from the private config and the first
synthetic CT reached **READY**. The service's source-health report showed
**HEALTHY** after the API generation type was corrected. A second CT uploaded
after Electron closed reached **READY** on the next five-minute poll.
This is disposable local evidence for [the active plan](../ACTIVE.md), not
installed-service or real-centre acceptance.
The separate local window used in this run was subsequently replaced by the
[in-window Settings revision](42-in-window-source-settings.md); this run does
not verify that revised navigation.

## Observed run

- Command: `bash deploy/cloud/scripts/run-synthetic-demo.sh`.
- Disposable Docker project: `clarity-v2-proof-17570`; source Orthanc 1.13.0
  reported API version 31. Dashboard/Hanko/Mailpit and source ports were bound
  to loopback; the launcher remains active until Ctrl-C.
- The generated Hanko administrator signed in through the web and isolated
  Electron sessions. Studies, Doctors and Settings appeared in the left
  navigation. Browser Settings directed the administrator to the desktop app;
  desktop Settings opened the bundled private connection window. A fresh
  administrator check guarded its read, test and save operations.
- The local Orthanc `/system` probe succeeded with the synthetic source's
  custom name. Saving the five-minute interval wrote a mode-`0600` service
  config, started the independent service, and left the credentials out of
  the hosted renderer.
- The uploader created patient ID `SYNTHETIC-ONLY`, label
  `SYNTHETIC^DEMO-SEP24`, Study Instance UID
  `1.2.826.0.1.3680043.10.987.6965443551566770721`. Staff Studies showed
  one verified image and **READY**. The centre panel changed from STALE to
  HEALTHY after the web endpoint accepted numeric source generations, matching
  the shared lease contract. The service process stayed alive when the isolated
  Electron process exited.
- The isolated Electron process exited while the compiled sync-service process
  continued with the saved private config. A second CT with label
  `SYNTHETIC^AFTER-QUIT` and Study Instance UID
  `1.2.826.0.1.3680043.10.987.82882314275354100` was uploaded after that
  exit. The next service health report was at **11:57:11 → 12:02:11 UTC**, five
  minutes apart. Staff Studies then showed **2 studies**, each with one
  verified image and **READY**; the new after-quit CT was first in the queue.
- After rebuilding the compiled service with the idle heartbeat, the live
  database report advanced from **12:15:09** to **12:16:09 UTC** while
  `last_successful_sync_at` stayed at **12:15:09 UTC**. This shows the one-minute
  health/lease report did not trigger another Orthanc inventory poll. One
  independent sync-service process remained active after Electron exited.

The initial attempt stopped before the interactive phase because an older
connected-ingestion fixture returned `409 manifest_unavailable` at manifest
seal. The interactive launcher now runs its own source-to-Ready path after
Hanko enrollment and administrator bootstrap; the separate compiled crash
proof remains in [evidence 33](33-compiled-sync-crash-recovery.md).

The live run also found two contract defects: the health route expected a
string source generation while the shared lease contract supplies a number,
and the sync loop capped even successful configured polls at one minute.
The route now accepts the contract's number; the loop honors five/ten-minute
success intervals and bounds failed backoff at one hour. The endpoint returned
202 from the rebuilt web container and the centre panel showed HEALTHY.
Focused sync tests cover the schedule calculation, the idle health heartbeat,
and removal of the synthetic five-second override when a normal interval is
saved. Verification commands passed: desktop tests **16/16**, web tests
**12/12**, sync tests **83/83**, web/sync
typechecks, and `pnpm run check:docs`. The plan's P2.4/P3.5 checkboxes remain
open for packaged two-OS and installed-service acceptance.

## Start

The launcher now uses the staff-only username/password profile (updated
2026-09-27): Hanko public signup and email delivery are disabled, and one
synthetic administrator is provisioned through Hanko's local Admin API and
bootstrapped in Clarity before Electron starts. The launcher prints the
synthetic username/password. It stores them in `demo.json` and
`admin-password.txt` in the mode-`0700` demo state directory, both mode `0600`.
The observed run above predates this profile update and records the earlier
passcode flow; use these current instructions for a new run.

### Staff-only live rerun, 27 September 2026

A fresh disposable local run opened Electron with native macOS close, minimize
and full-screen controls. The bundled Hanko form showed **Username** then
**Password**, with no signup or email step. The administrator-provisioned
synthetic account signed in to Studies; Settings listed one active synthetic
administrator. The in-window Orthanc form tested a separate loopback source,
saved its private credentials and five-minute schedule, and started the
independent sync process. One generated CT with patient ID `SYNTHETIC-ONLY`
reached **READY** with 1/1 images verified; source health became **HEALTHY**.
The study page opened the OHIF image canvas. Its compatibility panel warned
that this object's transfer syntax could not be confirmed, so this run does
not claim clinical viewer acceptance.

The run used a web image built from the new username/password code and a
previously built unchanged worker image because the package registry timed out
during a fresh image rebuild. The web image had a build-time Hanko port, so
the rerun bound Hanko to that same loopback port with
`CLARITY_INTERACTIVE_DEMO_HANKO_PORT`. The launcher now forwards the generated
password to its private Hanko helper and sends enrollment SQL through psql
standard input. The base Compose dependency that started Mailpit for this
no-email profile was removed; Hanko and the web remained healthy after the
disposable Mailpit container was stopped. The source had one study; local SQLite advanced its change
cursor to 7 and recorded one report and one received upload. A temporary
loopback-only five-second synthetic poll expedited the UI proof; it was removed
afterward, leaving the saved five-minute interval. The Electron window and
disposable services were left running for review. No Coolify deployment,
installed-service lifecycle or real centre source was tested.

Run from the V2 repository:

```sh
bash deploy/cloud/scripts/run-synthetic-demo.sh
```

The script uses Docker Compose to build a disposable local Hanko, PostgreSQL, MinIO, cloud Orthanc, web and worker stack. It also starts a separate source Orthanc bound only to a random `127.0.0.1` port. It completes the synthetic Hanko enrollment and administrator bootstrap before opening the Electron app. The command remains active until Ctrl-C. Ctrl-C stops only this demo's sync process, source container and Compose project, including its demo volumes.

If registry downloads block a rebuild, the interactive launcher accepts a
paired `CLARITY_INTERACTIVE_DEMO_WEB_IMAGE` and
`CLARITY_INTERACTIVE_DEMO_WORKER_IMAGE` pointing to existing local images.
The web image's `NEXT_PUBLIC_HANKO_API_URL` is compiled in; set
`CLARITY_INTERACTIVE_DEMO_HANKO_PORT` to its loopback port so the generated
Hanko endpoint matches. This override is for disposable local reuse only.

The launch output shows dashboard, Hanko and source Orthanc URLs, the synthetic administrator username/password, and the private manifest and service-config paths. Sign in to Electron with the printed username/password. Mailpit is not started. The source URL and its `proof` login are in the private manifest. The service config is mode `0600`; it has the paired device and cloud credentials but leaves the Orthanc URL and authorization unset until the Settings form saves them.

In Electron, open **Settings → Source connection**, enter the printed source Orthanc URL and the `proof` credentials from the manifest, test the connection, choose the polling interval, and save. The launcher watches the configured private file and gracefully restarts only the sync-service process it started. The saved interval applies on that restart. The default is five minutes.

## Add a synthetic study

After saving the source connection, run the helper with the manifest path printed at startup:

```sh
python3 deploy/cloud/scripts/upload-synthetic-dicom.py /absolute/path/printed/for/demo.json ct DEMO-001
```

The helper creates a tiny synthetic DICOM with a fixed `SYNTHETIC-ONLY` patient ID and a caller-selected label that is always prefixed with `SYNTHETIC^`. The label accepts only ASCII letters, digits, hyphen and underscore (maximum 24 characters); it cannot enter a real patient name. It uploads only to the localhost source Orthanc. It prints the generated DICOM UIDs. The study appears after the saved polling interval and successful cloud ingestion. Optional profiles are `mr`, `sr` and `pdf`; an example label is `DEMO-001`.

## Limits

This is a synthetic local demonstration, not centre installation or production deployment. All service ports are bound to loopback. It uses temporary randomly generated cloud credentials and an administrator-provisioned synthetic Hanko account. No real patient data should be entered. Local sync configuration, credentials and checkpoint/spool files remain under the per-user demo state directory after Ctrl-C; the Docker data and generated source Orthanc are removed.
