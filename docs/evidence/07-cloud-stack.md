# Isolated synthetic cloud stack proof

Date: 2026-09-23. Command: `bash deploy/cloud/scripts/proof.sh` from the V2
repository; exit code 0 on macOS arm64 with Docker Compose v2. The script used
fresh random credentials, localhost-bound proof ports, two disposable Compose
project names and generated synthetic DICOM. It did not connect to V1, a clinic
source, a deployed cloud account or a real email recipient.

## Stack and observed checks

The [Compose file](../../deploy/cloud/compose.yaml) pins PostgreSQL 18.6,
Hanko v3.0.4, `orthancteam/orthanc:26.8.2`, Mailpit and MinIO by image digest.
PostgreSQL has distinct Clarity, Hanko and Orthanc databases/roles. The cloud
proof uses MinIO only as a synthetic S3-compatible emulator; its pinned image is
not a selected production object store. The [migration job](../../deploy/cloud/Dockerfile.clarity-migrate)
applied the V2 SQL migrations and the Hanko migration job applied 55 Hanko
migrations before services started. The latest 23 September application-overlay
rerun applied Clarity migrations 0001–0015; the migrator observed all fifteen
before readiness, DICOMweb, replacement and fresh-volume restore checks passed.
The proof includes the device-auth role, fenced worker grants, guarded doctor
directory and ingestion API functions. A prior restore failure from extension-owner comments was
resolved by restoring without comments; the clean rerun passed.

- Hanko public `isready` and HTTP readiness passed. Its effective live config
  reported `HttpOnly=true`, `Secure=true`, `SameSite=strict` and
  `enable_auth_token_header=false`.
- The Clarity runtime role could read its staff table but could not read schema
  migration history, directly update `reports.state`, or create a table in the public schema.
  A separate worker role could execute its fenced import-completion function
  but could not directly update Reports or read staff identities; the web
  runtime could not execute worker import completion or the obsolete
  `reconcile_ingestion_upload_status` shortcut.
- Web, worker and device-auth roles could not execute dispatch creation or
  outbox claiming, or read the dispatch outbox. Policy-blocked sharing rows
  remain inaccessible until a recipient-authentication decision is implemented.
- Cloud Orthanc reported PostgreSQLIndex, AwsS3Storage and DicomWeb plugins.
  It accepted a generated DICOM instance, returned the same SHA-256 bytes from
  `/instances/{id}/file`, and QIDO-RS returned its exact StudyInstanceUID.
  The S3 emulator contained stored objects. The synthetic Orthanc config also
  loaded the OHIF plugin; clinical rendering remains a separate P4.3 gate.
- The [worker adapter proof](15-worker-foundation.md) signed a nested-key
  MinIO read/delete, rejected incorrect credentials, retried a raw DICOM POST
  to Orthanc as `AlreadyStored`, and verified indexed tags and byte readback.
- Force-recreating Orthanc and PostgreSQL containers preserved access to the
  same instance; Hanko remained ready.
- The script exported all three PostgreSQL databases plus an object-store mirror,
  restored them into a second Compose project with fresh volumes, restarted
  migrations/services and retrieved the same DICOM SHA-256 bytes.
- The proof removed its disposable containers, networks and volumes. Post-run
  Docker container/volume filters for its project names returned empty.
- With `CLARITY_APP_PROOF=1`, the web and worker images built from frozen pnpm
  installs. The web build now compiles its workspace dependencies first. The
  application overlay initialized separate scoped intake users, served the web
  health route, denied anonymous staff API access and kept the worker running
  without restart. The later `CLARITY_VIEWER_PROOF=1` run completed connected
  synthetic device-to-Ready ingestion, authenticated source-offline
  QIDO/WADO/bulk-data access, and the same fresh-volume restore. See the
  [connected ingestion](26-connected-ingestion.md) and
  [viewer](25-viewer-and-sharing-ui.md) evidence for their exact scope.

The isolated PostgreSQL proof passed through migration 0014: late-seal Ready,
same-key concurrent admission, study seal-state responses and blocked dispatch
snapshots/outbox assertions. The worker unit proof covers authorized adoption
of exact same-SOP/same-hash Orthanc bytes after a prior fence is lost. The
combined `CLARITY_VIEWER_BROWSER_DIAGNOSTIC=1 CLARITY_COMPILED_SYNC_PROOF=1`
run then passed with all fourteen migrations. Its separate disposable source
Orthanc fed the compiled local service, which discovered a fresh synthetic
Study, uploaded its instance, sealed the manifest and reached cloud Ready;
cloud Orthanc returned the exact bytes. The service exited cleanly after
SIGTERM. The 375px Chromium diagnostic loaded the authenticated OHIF iframe
and top-level route with HTTP 200, though clinical rendering is still open.

After migration 0015 and the late-admission CAS fix,
`CLARITY_VIEWER_BROWSER_DIAGNOSTIC=1 CLARITY_MULTIPART_RECOVERY_PROOF=1 bash deploy/cloud/scripts/proof.sh`
exited 0. The fifteen-migration run repeated device-to-Ready ingestion,
authenticated source-offline viewer routes, the narrow OHIF canvas diagnostic,
three-part 64 MiB + 1 byte upload recovery after a lost accepted response and
SQLite reopen, replacement persistence, and fresh-volume PostgreSQL/MinIO
restore with exact DICOM byte readback. The generated project containers,
networks and named volumes were removed. A following
`CLARITY_COMPILED_SYNC_PROOF=1 bash deploy/cloud/scripts/proof.sh` also exited 0
on the final fifteen-migration schema and updated service entry: a separate
synthetic Orthanc source was discovered by the compiled service, uploaded,
sealed, indexed to Ready and read back with matching bytes from cloud Orthanc.
It stopped after SIGTERM; the backup restore and disposable cleanup passed.
The [admission cutoff proof](28-manifest-admission-cutoff.md)
records the isolated reverse-order and double-admission SQL cases.

## Limits and follow-up

The Compose bridge permits container egress; only proof endpoints are published
to `127.0.0.1`. This is an isolated disposable integration proof, not a
production network isolation design. The separate
[Hanko protocol proof](09-hanko-protocol.md) exercises registration,
passcode, login, cookie and logout. The initial full-stack run had no explicit session
issuer/audience; its script now sets both, and the standalone protocol proof
verified the resulting claims. The full restore sequence also passed after
that config edit and fifteen Clarity migrations. Separate
[web](../../deploy/cloud/Dockerfile.web) and
[worker](../../deploy/cloud/Dockerfile.worker) runtime images then built on
the pinned Node 22 base from frozen pnpm installs. The web standalone image
returned HTTP 200 for its synthetic shell and HTTP 401 for an anonymous
protected API; the worker production-closure image exited 78 with a generic
diagnostic when required configuration was absent. These smoke checks did
not deploy a clinical API. The later combined run exercised a device upload
and worker import against disposable dependencies. A separate
[Chromium Hanko proof](16-staff-web-hanko.md) later verified local cross-port
Secure cookie storage and protected-route use; Hanko Elements and production
HTTPS remain open.
Backup restore tested synthetic data using the original generated Hanko key
config; it did not prove independent key custody, session continuity, recovery
times, offsite retention or production storage. P1.3 remains open until these
acceptance gaps and final application service topology are closed.
