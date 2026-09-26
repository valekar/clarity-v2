# Compiled sync-service crash recovery proof

Date: 2026-09-23. Scope: a connected synthetic P3.2 source-discovery crash
boundary using a generated DICOM and the normal compiled sync-service entry,
including recovery after the cloud upload and Orthanc import have completed.
The harness is part of
[`prove-compiled-sync-service.mjs`](../../deploy/cloud/scripts/prove-compiled-sync-service.mjs),
which the existing `CLARITY_COMPILED_SYNC_PROOF=1` cloud proof invokes.

The harness waits for the compiled process to persist a private spool row for
the generated source SOP, immediately SIGKILLs that Node child, and then inspects
the same SQLite database/spool directory and disposable PostgreSQL. It records
the actual crash-time upload boundary: either the local spool exists before any
cloud upload row, or one matching cloud admission exists with the same durable
local upload ID. Any inconsistent or duplicate state fails the proof. The
service then restarts with the same source, database and spool paths. Once the
upload is completed, the local checkpoint is received, and Orthanc readback
matches the exact source bytes, the harness SIGKILLs the compiled entry again.
It verifies the completed cloud row, local receipt, and imported Orthanc
instance survive another restart without duplicate Reports, uploads or SOPs.
After the second SIGKILL is confirmed, the proof snapshots the local source
checkpoint timestamp and requires it to advance before accepting the restarted
entry's cloud Ready state. This prevents an already-Ready Report from being
mistaken for completed restart work.
Acceptance
requires cloud Ready, one Report, one cloud upload, and exactly one cloud
Orthanc SOP whose returned bytes match the generated DICOM's size and SHA-256.

## Local cloud-admission response-loss recovery

On 2026-09-24 the local compiled service-process proof was extended to commit a
synthetic upload admission in its cloud fixture, hold and drop the first
response, and SIGKILL the service before SQLite records an upload ID. The test
reopens the same database and spool directory, then verifies the compiled
service retries with the same stable admission key, maps it to the same single
cloud upload ID, completes one signed PUT, and upserts the same logical Study.
The interrupted SQLite row remains `spooled` with no upload ID before restart.

This exercise exposed a local queue lease left behind by SIGKILL. Startup now
clears only the configured source's local queue lease after acquiring the
exclusive service lock. A competing compiled instance was started while the
owner held that lock; it exited before state recovery, and a synthetic active
queue lease remained held for its original owner. No spool bytes or cloud
lease/fence state are cleared by this recovery.

Verification: `pnpm --filter @clarity/sync-service build`,
`pnpm exec tsc -p apps/sync-service/tsconfig.test.json`, and
`node --test --test-name-pattern='compiled production service discovers' apps/sync-service/test-dist/test/compiled-service-process.test.js`
passed; the focused compiled process proof was 1/1. This is a local synthetic
loopback proof and does not replace the pending connected Docker crash proof or
native installed-service restart acceptance.

## Verification

Previously captured local checks for the initial source-spool boundary passed:

- `pnpm --filter @clarity/sync-service build`
- `pnpm exec tsc -p apps/sync-service/tsconfig.test.json`
- `node --test apps/sync-service/test-dist/test/compiled-service-process.test.js` — 1/1
- `node --check deploy/cloud/scripts/prove-compiled-sync-service.mjs`
- `pnpm exec prettier --check deploy/cloud/scripts/prove-compiled-sync-service.mjs`
- `pnpm run check:source-policy`
- `git diff --check`

For the post-import harness expansion, `node --check`, Prettier check,
`pnpm run check:source-policy`, `git diff --check`, and the local compiled
service process test (1/1) passed. That local process test does not execute the
connected proof script's new assertions. The fresh source-poll assertion also
remains connected harness coverage only. These static checks and the local
process test were rerun for the fresh source-poll gate and passed. The expanded post-import assertions
have not been exercised against connected services. Docker BuildKit/overlay
I/O errors still block disposable integration runs, so this is harness coverage
until the opt-in connected proof completes and its result JSON is captured.

A connected invocation was started, and its disposable Compose resources were
stopped, but its final exit status/result JSON was not captured. A subsequent
viewer proof encountered a Docker BuildKit `metadata_v2.db` input/output error
and overlay storage deletion errors. The Docker daemon is therefore considered
unhealthy pending operator recovery. No connected crash-recovery pass is claimed
by this record; rerun the opt-in proof after Docker is healthy and capture its
exit status and JSON result. The harness covers the pre-import source-spool
boundary and asserts a post-import completed-upload restart boundary; both
connected behaviors remain unverified until that run passes.

## Connected rerun, 24 September

After Docker recovered, `CLARITY_COMPILED_SYNC_PROOF=1 bash
deploy/cloud/scripts/proof.sh` exited 0. The first attempt exposed a harness
startup race: it queried `local_instance_upload` before the compiled service
created that table. The harness now waits for the table's presence through
`sqlite_master`. The rerun logged `cloudState=ready|sealed|completed`,
`crashSignal=SIGKILL`, `postImportCrashSignal=SIGKILL`,
`postImportRestartPolledSource=true`,
`postImportRestartPreservedUploadAndInstance=true`, `uploadCountAfterRestart=1`
and `processStartedAndStopped=true`. The same run passed container replacement
persistence and restore into fresh PostgreSQL/MinIO volumes, then removed its
disposable resources. Log:
`/tmp/clarity-v2-compiled-proof-rerun-20260924.log` on the test host.

This proves a bounded separate synthetic source and compiled-service restart
path. It does not prove installed OS service lifecycle, local settings, source
version breadth or real patient data handling.
