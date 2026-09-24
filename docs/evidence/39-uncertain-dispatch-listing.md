# Synthetic uncertain dispatch listing

Date: 2026-09-24. This increment adds durable, bounded discovery of uncertain
outbox rows for the existing synthetic messaging worker contract. It does not
activate dispatch rows or close P6.1–P6.4.

## Implementation

Additive migration `0017_dispatch_uncertain_listing.sql` adds nullable
`last_reconcile_attempt_at` and a partial index for uncertain rows. Its
`list_uncertain_dispatch_outbox(limit)` function accepts 1–100 rows, locks with
`FOR UPDATE SKIP LOCKED`, orders never/least recently reconciled rows first,
updates reconciliation attempt time atomically, and returns only idempotency
keys. It cannot return `blocked_policy` work, message text, or destination data.
PUBLIC, runtime, worker, device-auth, and recognized future delivery roles have
no function grant. No grants were added.

The database delivery repository now exposes `listUncertain(limit)`. A narrow
`createDispatchWorkerStore` adapter forwards the worker-shaped methods and
fails closed if the broader repository returns `failed` or `delivered` where
the current synthetic worker accepts only `submitted` and `uncertain`.

## Verification

- A throwaway local PostgreSQL 15.13 database applied the full migration chain
  0001–0017 and the existing synthetic Ready Report fixture. The new
  [proof runner](../../deploy/proof-database/prove-messaging-dispatch.mjs)
  invoked the actual `createDispatchWorker(createDispatchWorkerStore(createDispatchDeliveryRepository(client)))`
  path with `SyntheticMessageProvider` and `handleProviderCallback` on one
  explicitly acquired PostgreSQL client and rolled back its fixture transaction.
- The run proved preparation defaults to `blocked_policy`; only one explicitly
  authorized synthetic outbox row was changed to queued inside the rolled-back
  fixture. The provider accepted it but lost the reply, SQL persisted `uncertain`,
  the durable listing returned it, the next worker tick reconciled the provider
  receipt and persisted `submitted`, and the signed callback handler delivered
  it. Replaying the same signed event left one callback row. A second outbox row
  and the parent dispatch remained `blocked_policy`; the second row kept NULL
  authorization/message and zero attempts.
- The same transaction checked that PUBLIC, runtime, worker and device-auth roles
  cannot execute the claim function. Migration 0017 also revokes the uncertain
  listing from recognized future delivery roles. No grants were added. The
  throwaway database and temporary roles were removed.
- `node --experimental-strip-types --test
libs/database/tests/dispatch-repository.test.ts` passed 6/6;
  `pnpm --filter @clarity/database typecheck` passed. Database and messaging
  package builds passed before the proof. `pnpm --filter @clarity/messaging
test` passed 13/13 and messaging typecheck passed. `run-proof.sh` now invokes
  the same synthetic worker proof after applying migrations and seeding the
  report.

The connected PostgreSQL 18 Docker proof was not run. This is a local synthetic
proof inside one transaction that is rolled back. It demonstrates the SQL and
messaging transitions on one connection, but does not prove committed intent
survives process restart, cross-worker concurrency, or operation under a
restricted delivery database role. The role assertion covers the claim function
used by this proof; the existing [dispatch SQL proof](27-policy-gated-dispatch-outbox.md)
contains the broader runtime table/function denial assertions. This is not worker
runtime/scheduler wiring. There is no granted delivery role, callback HTTP
endpoint, real provider or recipient verification. OI-06 remains open; Send,
QR, link grants and real delivery remain blocked.
