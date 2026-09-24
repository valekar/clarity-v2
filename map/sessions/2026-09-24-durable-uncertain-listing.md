---
id: durable-uncertain-listing-2026-09-24
type: session
title: Add durable uncertain dispatch listing
universe: live
status: verified
updated: 2026-09-24
revision: dispatch-uncertain-listing-0017-2026-09-24
---

# Add durable uncertain dispatch listing

## Request and result

Advance synthetic-only P6.3 by connecting the existing worker contract to a
durable uncertain-row listing while keeping recipient policy and database
grants closed. Added additive migration
[0017](../../libs/database/migrations/0017_dispatch_uncertain_listing.sql)
with bounded `list_uncertain_dispatch_outbox`, persistent attempt timestamps and
rotating `FOR UPDATE SKIP LOCKED` selection. The database delivery repository
now implements `listUncertain`; its narrow worker adapter validates the worker's
smaller state contract. The parent manager owns `libs/messaging/src/worker.ts`
and will wire the adapter in the synthetic proof. See [evidence 39](../../docs/evidence/39-uncertain-dispatch-listing.md).

No roles received grants. Dispatches remain `blocked_policy` until a separate
recipient authorization decision. No scheduler, provider, Send path, callback
HTTP route, QR, link grant or real delivery was added.

## Verification

- Local PostgreSQL 15.13 minimal-schema proof applied migration 0017 and passed
  bounded validation, blocked-policy exclusion, multi-row fair rotation,
  attempt timestamp persistence, and PUBLIC/runtime/worker/device-auth/future
  delivery-role execute denial.
- `node --experimental-strip-types --test
libs/database/tests/dispatch-repository.test.ts` passed 6/6.
- `pnpm --filter @clarity/database typecheck` passed.

This does not prove the complete migration chain or PostgreSQL 18 dispatch
proof. Docker integration was not run. No actual SQL repository was wired into
the worker runtime during this change.

## Map review and next step

Updated the [delivery boundary](../objects/delivery-boundary.md) and
[database owner](../../libs/database/CONTEXT.md); both keep runtime status
unreleased and grants absent. Next, wire the synthetic worker adapter in the
parent-owned messaging proof, then run the full PostgreSQL 18 proof when Docker
storage is available. OI-06 and provider readiness remain release gates.
