---
id: 2026-09-23-worker-fence-effect-gap
type: session
title: Test worker fence change across Orthanc effect gap
universe: live
status: verified
updated: 2026-09-23
revision: worker-fence-effect-gap-test-2026-09-23
---

# Test worker fence change across Orthanc effect gap

## Request and result

Exercise the race where a source fence changes after the worker's last
authorization query succeeds and before its Orthanc POST. Extended the worker
recovery test to switch the authorized upload at that exact callback boundary.
The old upload's POST occurs, its fenced DB completion fails, and intake stays
present. A newly authorized same-SOP/same-hash upload reads back and adopts the
exact Orthanc object without another POST, then completes and cleans intake.
Existing coverage rejects a conflicting digest during this adoption path.

## Verification

`pnpm --filter @clarity/worker test` passed 20 assertions. Prettier check passed
for the changed test. No Compose proof was run.

PostgreSQL and Orthanc do not share an atomic transaction. The test confirms
that the DB fence prevents stale Ready completion and that a later owner can
reconcile an exact-byte effect. The stale Orthanc object may exist temporarily
between the provider POST and later authorized adoption/quarantine. This does
not prove an integrated live-fence race against running services.

## Map review and next step

Updated [connected ingestion evidence](../../docs/evidence/26-connected-ingestion.md).
The [Report package](../objects/report-package.md) already describes this
cross-system atomicity limit; no map relationship changed. Next: retain
connected/centre race acceptance as an open P4.1 limit.
