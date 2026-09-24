# Synthetic provider uncertainty proof

Date: 2026-09-23. The new [messaging workspace](../../libs/messaging/CONTEXT.md)
contains an in-memory [synthetic provider](../../libs/messaging/src/synthetic-provider.ts)
with no network effect. It accepts a stable idempotency key, destination E.164
number and bounded message text, returning the same receipt on exact retry and
rejecting changed content under one key. A test injects lost acknowledgement
after acceptance, reconciles the accepted receipt, then confirms that a repeat
send is idempotent. `pnpm --filter @clarity/messaging test` passed 1/1; the
workspace source-policy check also passed.

This is only the provider boundary test double. The policy-gated durable outbox
schema and callback state contract were added later; see [evidence 27](27-policy-gated-dispatch-outbox.md).
Outbox authorization, recipient verification, a scheduled delivery worker,
approved real provider, production callback endpoint/secret management and any
real message delivery remain open under P6.1–P6.4.
