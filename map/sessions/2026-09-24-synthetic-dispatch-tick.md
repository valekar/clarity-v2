---
id: synthetic-dispatch-tick-2026-09-24
type: session
title: Add bounded synthetic dispatch tick and callback handler
universe: live
status: verified
updated: 2026-09-24
revision: synthetic-dispatch-tick-callback-proof-2026-09-24
---

# Add bounded synthetic dispatch tick and callback handler

## Request and result

Implement the policy-independent P6.3 messaging machinery while preserving the
current SQL gate. Added an injected single-flight worker tick with a configurable
maximum of 100 total operations, uncertain receipt reconciliation, and injected
claim-token generation. Reconciliation cannot starve queued work: one-item ticks
alternate between reconciliation and claims, and larger budgets reserve a claim
slot. Failed provider lookups preserve uncertainty while allowing the tick to
claim other work. Added a callback handler that verifies bounded HMAC
input and passes a payload digest to the repository for transactional event
deduplication. No scheduler, database adapter wiring, HTTP route or provider
runtime was added. See [evidence 36](../../docs/evidence/36-synthetic-dispatch-tick-and-callback.md)
and the [delivery boundary](../objects/delivery-boundary.md).

Dispatch rows remain `blocked_policy` under migration 0014. No Send, recipient
link grant, real provider, delivery-role grants or message delivery were added.

## Verification

- `pnpm --filter @clarity/messaging test`: passed 13/13 Node tests, including
  lost acceptance and recreated worker reconciliation, bounded/single-flight
  ticks, permanent-uncertainty fairness, and callback signature-before-persistence
  plus event replay.
- `pnpm --filter @clarity/messaging typecheck`: passed.
- The worker tests use a synthetic provider and in-memory store model. They do
  not verify real PostgreSQL delivery grants or provider behavior.

## Map review and next step

Updated the [delivery boundary](../objects/delivery-boundary.md) to describe the
new test-backed machinery and retain the ghost/stub runtime status. No other
relationship changed. Current SQL has no delivery grants and creates only
blocked-policy dispatch rows; next work still requires the named recipient
verification and delivery policy inputs.
