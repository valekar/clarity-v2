# Synthetic dispatch tick and callback handler

Date: 2026-09-24. [`@clarity/messaging`](../../libs/messaging/CONTEXT.md) now
exports an injected single-flight worker tick. Each tick handles at most 100
total uncertain reconciliations and fresh claims. Provider exceptions are
persisted as uncertain; a missing receipt leaves the item uncertain. Recreated
worker instances reconcile through the stable provider idempotency key before
claiming fresh work. The synthetic tests cover lost acceptance, worker
recreation, bounded work, and overlapping tick suppression.

The callback handler verifies bounded HMAC input before invoking its injected
repository. The repository must atomically persist and deduplicate event IDs;
the test covers invalid-signature rejection before persistence and repeat event
handling. This does not implement an HTTP endpoint or prove PostgreSQL adapter
transactions.

Verification: `pnpm --filter @clarity/messaging test` passed 11/11 Node tests;
`pnpm --filter @clarity/messaging typecheck` passed. These tests use the
synthetic provider and an in-memory durable-store model. Migration 0014 still
creates only `blocked_policy` intents, and its delivery/callback SQL functions
have no grants. No runtime worker, scheduler, delivery role, link grant, Send,
real provider, credential or message delivery is enabled.
