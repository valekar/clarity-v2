---
id: blocked-dispatch-outbox-2026-09-23
type: session
title: Add policy-gated durable sharing outbox groundwork
universe: live
status: verified
updated: 2026-09-23
revision: evidence-27-0014
---

# Add policy-gated durable sharing outbox groundwork

## Request and result

The requested P6 groundwork was to add transactional dispatch/outbox state
without selecting unresolved recipient verification policy OI-06 or enabling
real delivery. Migration [0014](../../libs/database/migrations/0014_dispatch_outbox.sql)
adds immutable report/revision and recipient snapshots, stable idempotency,
blocked initial outbox rows, claim/outcome/reconciliation functions and callback
receipts. All dispatch rows remain `blocked_policy`; there is no activation,
link-minting or message-send grant. Separate preparation and delivery repository
interfaces and pure delivery-state/callback contracts are in
[`@clarity/database`](../../libs/database/src/dispatch-repository.ts) and
[`@clarity/messaging`](../../libs/messaging/CONTEXT.md). The delivery boundary
card and [evidence 27](../../docs/evidence/27-policy-gated-dispatch-outbox.md)
record current limits.

## Verification

The disposable `pnpm --filter @clarity/database proof` passed all fourteen
migrations, dispatch snapshots/idempotency/CAS/role-denial/blocked-claim and
synthetic uncertainty/callback assertions, prior staff/manifest/concurrency
proofs, remigration and container/anonymous-volume cleanup. Dispatch fixture
authorization and provider transitions were rolled back. Database package
build/typecheck and messaging package build/typecheck plus seven Node tests
passed. The messaging exports also imported from a temporary external directory.
No real provider or messaging service was used.

## Map review and next step

Updated the [delivery boundary](../objects/delivery-boundary.md); other
relationships are unchanged. The product remains ghost/stub. OI-06, dispatch
activation grants, recipient verification, link issuance, approved provider and
live sending remain open. Evidence does not establish delivery, patient access,
or clinical suitability.
