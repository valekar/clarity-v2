# Synthetic provider uncertainty proof

Date: 2026-09-23. The new [messaging workspace](../../libs/messaging/CONTEXT.md)
contains an in-memory [synthetic provider](../../libs/messaging/src/synthetic-provider.ts)
with no network effect. It accepts a stable idempotency key, destination E.164
number and bounded message text, returning the same receipt on exact retry and
rejecting changed content under one key. A test injects lost acknowledgement
after acceptance, reconciles the accepted receipt, then confirms that a repeat
send is idempotent. `pnpm --filter @clarity/messaging test` passed 1/1; the
workspace source-policy check also passed.

This is only the provider boundary test double. Database outbox/attempts,
bounded worker retry, approved real provider, signed callbacks, recipient
verification and any real message delivery remain open under P6.1–P6.4.
