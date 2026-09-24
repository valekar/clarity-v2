---
id: 2026-09-23-late-manifest-dispatch-scope
type: session
title: Late manifest and frozen dispatch scope proof
universe: live
status: verified
updated: 2026-09-23
revision: late-manifest-dispatch-scope-proof-2026-09-23
---

# Late manifest and frozen dispatch scope proof

## Request and result

Add a focused P4.2 database proof for a late instance arriving after a dispatch
was created, and verify that the earlier dispatch remains fixed to its sealed
manifest revision. Added
[`late-manifest-dispatch-scope.sql`](../../deploy/proof-database/late-manifest-dispatch-scope.sql)
to the disposable database proof. The fixture seals an initial manifest and
creates a revision-1 dispatch, admits a second SOP, seals revision 2, then
indexes the late file and confirms the Report returns to Ready. The existing
dispatch still references revision 1 with its original member and recipient
counts. A seal attempt with `inventory_complete=false` is rejected.

## Verification

Root ran `pnpm --filter @clarity/database proof`; the full disposable run exited
0 with migrations 0001–0014. The added assertions passed and the transaction
rolled back fixture state. The recorded log is
`/tmp/clarity-v2-db-late-proof-2.log` in the proof environment.

This proves database transitions and frozen dispatch membership under the
trusted SQL interface. It does not test an active device discovering a late
instance, process restart during that connected flow, or the source-side
algorithm that decides a quiet study is complete. No real clinical data,
recipient delivery or clinic Orthanc was used. P4.2 remains open for connected
and centre breadth acceptance.

## Map review and next step

Updated [Report package](../objects/report-package.md),
[manifest persistence evidence](../../docs/evidence/18-manifest-persistence.md),
and [dispatch evidence](../../docs/evidence/27-policy-gated-dispatch-outbox.md).
No durable decision or schema relationship changed. Next: exercise late
arrival and incomplete inventory through the connected source/service flow.
