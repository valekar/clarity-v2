---
id: 2026-09-23-manifest-admission-cutoff
type: session
title: Reverse-order manifest admission readiness guard
universe: live
status: verified
updated: 2026-09-23
revision: manifest-admission-cutoff-proof-2026-09-23
---

# Reverse-order manifest admission readiness guard

## Request and result

Add migration 0015 and a focused PostgreSQL regression for the case where a
late file is admitted and worker-completed before a fresh manifest revision is
sealed. Added a durable `reports.manifest_dirty` cutoff, guarded Ready
transitions, and made the seal wrapper clear the cutoff only after a successful
fresh seal. Removed the unsafe runtime grant for
`reconcile_ingestion_upload_status` from the cloud bootstrap and isolated proof
role setup. The [new proof](../../docs/evidence/28-manifest-admission-cutoff.md)
also checks that a frozen revision-1 dispatch remains unchanged.
The Astra rereview found that a second novel admission while the Report was
already dirty did not invalidate an in-flight manifest attempt. The migration
now advances the Report version for every new admission key outside the current
scope, including an existing SOP previously excluded from a later manifest,
and leaves exact same-key retries stable.

## Verification

`pnpm install --frozen-lockfile` passed. `pnpm --filter @clarity/database proof`
passed against disposable PostgreSQL 18.6 after the install; migrations
0001–0015 applied, the reverse-order regression passed, package builds and
existing role/CAS/concurrency assertions passed, and remigration was clean. The
proof removed its container and anonymous volume. The fixture also excluded an
older `needs_attention` file from the fresh exact revision; it did not block
Ready. A second ordering fixture verified that an admission between page upload
and seal rejects the stale seal, even if the Report was dirty before that
admission. Re-admitting an excluded existing SOP with a fresh key also advanced
the Report CAS. The first run stopped only because the workspace TypeScript binary
was not installed yet; the frozen install and repeat proof passed. A later
first attempt at the added regression needed an explicit JSONB/UUID cast; the
corrected full proof passed.

## Map review and next step

Updated the [Report package](../objects/report-package.md) and linked
[admission cutoff evidence](../../docs/evidence/28-manifest-admission-cutoff.md).
No product-level readiness policy or recipient policy was selected. P4.2
remains open for connected device/restart behavior and evidence that source
inventory completeness is established correctly.
