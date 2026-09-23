# Synthetic cloud worker import foundation

Date: 2026-09-23. Scope: a P4.1 component and disposable-stack proof using only
generated DICOM. The [worker](../../apps/worker/src/main.ts),
[import/reconciliation logic](../../apps/worker/src/import-instance.ts),
[object adapter](../../libs/storage/src/intake-objects.ts),
[Orthanc adapter](../../apps/worker/src/orthanc-client.ts),
[migration 0004](../../libs/database/migrations/0004_worker_completion.sql) and
[adapter proof](../../deploy/cloud/scripts/prove-worker-adapters.mjs) own it.

- Worker typecheck/build and 12 focused tests passed. The tests cover a lost
  database reply after Orthanc accepts bytes, duplicate import reconciliation,
  cleanup failure and restart, transient object-store failure, digest mismatch,
  size bounds, unsupported DICOM headers, an object changed after staging and
  early DICOM-header stream cancellation.
- `pnpm --filter @clarity/database proof` passed with four migrations. It checked
  trusted completion after device-lease takeover, idempotent completion,
  durable cleanup marking, web-runtime denial of worker completion, worker
  denial of staff identity reads and preservation of a separate file's
  `needs_attention` state.
- `bash deploy/cloud/scripts/proof.sh` passed on a fresh isolated stack and
  fresh-volume restore. The worker adapter proof read/deleted a nested-key
  synthetic MinIO object using signed requests, rejected invalid credentials,
  re-posted the generated DICOM with Orthanc `AlreadyStored`, and verified tags,
  byte count and SHA-256 on readback. Disposable containers, networks and
  volumes were removed.

The worker streams one instance at a time, checks its size, SHA-256, required
UIDs and global UID reservations, verifies the cloud Orthanc index and stored
bytes, then uses a narrow worker-only database function to commit the indexed
reference and upload completion together. `intake_cleaned_at` records cleanup
separately so a post-commit delete failure is retried. The web runtime role
cannot execute worker completion functions; the worker role cannot directly
update Reports or read staff identities.

The initial adapter proof used disposable MinIO root credentials; the later
running proof below uses a scoped worker identity. Production object-store
policy/provider and real capacity remain OI-03. This parser currently accepts
implicit or explicit little-endian Part 10 headers only. No broad
transfer-syntax, codec, CT/MR, nonimage or clinical acceptance is claimed.

## Running worker and crash proof

The later [disposable running-worker harness](../../deploy/proof-worker/run-proof.sh)
passed with a fresh PostgreSQL database, private MinIO intake and scoped worker
Get/Delete credentials, and pinned disposable Orthanc. It seeded one durable
`received` upload from generated DICOM, launched the compiled worker poller,
and verified UID, SHA-256 and byte readback after import. A SIGKILL while its
completion SQL transaction was held left the file/upload at `received`; the
restarted worker found the already indexed Orthanc SOP, checked bytes and
committed one final reference. A second SIGKILL held the post-commit intake
DELETE after the Report became Ready; the next restart deleted only that
temporary object and recorded cleanup without a duplicate Orthanc instance.
The named proof containers, volumes and generated secrets were removed.
The same running process/crash harness passed again after applying manifest
migration 0005. The harness now launches the worker with `exec`, so SIGKILL
targets the actual Node process rather than leaving a child behind; its proof
lease is bounded below the planned five-minute maximum.

The worker now hashes, parses and imports one bounded private staging snapshot
of each intake object, so an object changed between separate GETs cannot change
the bytes sent to Orthanc. Its DICOM parser cancels the source stream after an
early UID result. The focused tests cover a changed underlying object, lost
provider/database replies, transient intake errors and cleanup retry. These
component and process boundaries meet P4.1 for the selected synthetic intake
path. Production object storage, supported transfer syntax breadth, centre
capacity and clinical content validation remain later gates.
