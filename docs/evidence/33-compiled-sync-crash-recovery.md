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
Acceptance
requires cloud Ready, one Report, one cloud upload, and exactly one cloud
Orthanc SOP whose returned bytes match the generated DICOM's size and SHA-256.

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
connected proof script's new assertions. The expanded post-import assertions
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
