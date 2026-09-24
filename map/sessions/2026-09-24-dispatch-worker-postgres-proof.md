---
id: dispatch-worker-postgres-proof-2026-09-24
type: session
title: Run synthetic dispatch worker against PostgreSQL
universe: live
status: verified
updated: 2026-09-24
revision: dispatch-worker-postgres-proof-2026-09-24
---

# Run synthetic dispatch worker against PostgreSQL

## Request and result

Run the existing synthetic messaging worker, repository adapter, provider and
callback handler against migrations 0014 and 0017 while leaving production roles
ungranted and dispatch creation policy-blocked. The proof
[runner](../../deploy/proof-database/prove-messaging-dispatch.mjs) prepares two
real SQL dispatch snapshots that both default to `blocked_policy`, advances one
row through an explicitly synthetic authorization update, then drives lost
acceptance, durable uncertain listing, provider reconciliation, verified
callback and duplicate-event handling through the real database repository and
messaging code. All fixture work runs on one checked-out PostgreSQL client and is
rolled back. The second outbox and parent dispatch remain blocked. See
[evidence 39](../../docs/evidence/39-uncertain-dispatch-listing.md).

No runtime delivery role, schedule, Send route, provider credential, real
provider or recipient grant was added.

## Verification

- Local PostgreSQL 15.13 applied all migrations 0001–0017 and the established
  synthetic Ready Report fixture; the SQL/messaging proof passed, then removed
  the temporary database and roles.
- Database and messaging package builds passed before execution. Repository
  tests passed 6/6; database typecheck passed.
- The disposable PostgreSQL 18 proof runner now invokes this harness after
  applying migration fixtures. Docker proof was not run.

The single rolled-back transaction proves API/SQL compatibility and the tested
state sequence. It does not prove committed intent survives process restart,
cross-worker concurrency, or operation under a restricted delivery role. The
local PostgreSQL version is 15.13; PostgreSQL 18 connected verification remains
open.

## Map review and next step

Updated the [delivery boundary](../objects/delivery-boundary.md),
[database owner](../../libs/database/CONTEXT.md), and P6.3 plan evidence. The
runtime delivery surface remains ghost/stub. When Docker storage is recoverable,
run the integrated PostgreSQL 18 proof, then add separate crash/restart and
concurrency acceptance without granting a deployed role.
