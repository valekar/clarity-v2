# Sharing outbox boundary

`@clarity/messaging/outbox` defines delivery-state transitions for durable
outbox rows. `@clarity/messaging/worker` provides an injected, single-flight
scheduler tick bounded to 100 total reconcile/claim operations. Unknown
acceptance remains `uncertain`; an absent reconciliation receipt never
authorizes a resend. `@clarity/messaging/callback-handler` verifies bounded
HMAC input before handing it to a repository that must durably deduplicate and
apply the event atomically. It is a handler, not a network endpoint.

`synthetic-provider` has no external network effect and exists to test
idempotency and uncertain outcomes. Worker and callback adapters are not wired
to the database delivery repository or a scheduler/runtime. Migration 0014 stores immutable dispatch
and recipient snapshots, but all new provider intents start `blocked_policy`
without an authorization reference or message body. No UI, web runtime or
device role can create or claim them. Recipient verification (OI-06), link
issuance, dispatch authorization, an approved real provider/template, secret
management and end-to-end delivery remain open. No live credentials, real
messages or patient content belong here.
