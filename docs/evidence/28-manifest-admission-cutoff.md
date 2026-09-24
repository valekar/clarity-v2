# Reverse-order late-admission readiness guard

Date: 2026-09-23. This synthetic-only PostgreSQL proof adds a durable dirty
marker for the interval between admission of a novel instance and a fresh
complete manifest seal. It addresses the ordering where the worker finishes an
admitted upload before the device has sealed a revision containing it.

Migration [`0015_manifest_admission_cutoff.sql`](../../libs/database/migrations/0015_manifest_admission_cutoff.sql)
sets `reports.manifest_dirty` when admission introduces a file outside the
current sealed member set. The Ready guard allows the worker to commit indexing
and upload completion while keeping the Report in `processing`. A fresh valid
seal clears the marker under the Report lock and reconciles readiness against
that exact revision. Read and dispatch checks continue to require `ready`, and
the database check prevents a dirty Report from being stored as Ready. Historic
files excluded by a later complete manifest are not required forever. Each new
admission key outside the current scope also advances the Report version,
including while already dirty, so an inventory attempt begun before another
admission cannot seal a stale scope. An exact same-key retry stays stable.

The same migration revokes `reconcile_ingestion_upload_status` from PUBLIC and
the runtime role. The cloud runtime grant and isolated proof grant were removed;
the fenced worker completion function remains the supported completion path.

## Verification

- `pnpm install --frozen-lockfile` passed with no lockfile changes.
- `pnpm --filter @clarity/database proof` passed on disposable PostgreSQL 18.6.
  It applied migrations 0001–0015; passed existing schema, CAS, dispatch,
  manifest, staff and admission-race checks; then passed
  [`late-admission-before-seal.sql`](../../deploy/proof-database/late-admission-before-seal.sql).
- The new regression began with a Ready revision-1 Report and frozen dispatch,
  admitted and received a second synthetic file, confirmed the runtime's
  attempted `received`→`completed` reconciliation failed with SQLSTATE 42501
  without changing upload/file state, and let the worker index the file. The
  Report stayed non-Ready with `manifest_dirty=true`; new dispatch creation was
  rejected. After a fresh exact revision-2 seal, the Report became Ready and the
  original dispatch remained bound to revision 1. The fresh revision excluded
  an older file marked `needs_attention`, which did not block Ready outside the
  exact current member set.
- A second ordering regression admitted one new file, began/paged revision 3,
  then admitted another new file while the Report was already dirty. The second
  admission advanced the Report CAS; an idempotent retry did not. Sealing the
  pre-second-admission inventory returned false and left revision 2 current.
  Re-admitting an existing SOP excluded from revision 2 with a fresh key also
  advanced the CAS while the Report was already dirty.
- The database package built; the full proof reran migrations idempotently and
  ended with “Disposable PostgreSQL container and anonymous volume removed.”
  The first attempt stopped at package build because `tsc` was absent before
  `pnpm install --frozen-lockfile`; no SQL assertion failed on that attempt.

This proves the database state and role boundary in a disposable SQL harness. It
does not prove a live centre discovers every late instance, that quiet means a
complete inventory, or recovery through process restarts. P4.2 remains open for
connected and centre acceptance. No clinic data, provider delivery or persistent
V2 resources were used.
