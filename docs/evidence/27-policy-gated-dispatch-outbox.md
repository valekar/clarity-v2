# Policy-gated dispatch and outbox foundation

Date: 2026-09-23. This synthetic-only increment creates immutable dispatch
snapshots and an outbox state machine. It does not close P6.1–P6.4 or select a
recipient verification policy.

## Database contract

Migration `0014_dispatch_outbox.sql` adds Report/revision-bound dispatch rows,
immutable patient/doctor recipient snapshots, durable per-recipient outbox rows,
and append-only callback receipts. Dispatch creation checks the current active
staff membership, Report version and Ready state, sealed current manifest proof,
and selected doctor version. A stable actor/idempotency-key retry returns the
original dispatch; changed request content under that key conflicts. The intent
retains an FK to its exact manifest revision.

Every created outbox row starts `blocked_policy` with NULL authorization
reference and NULL message. The claim query only selects explicitly authorized,
nonempty queued work. No UI, web runtime, device role or PUBLIC grant can create,
authorize, read or claim dispatch records. The dispatch row remains
`blocked_policy`; a later policy migration may activate an individual outbox
row. No link, share token, message payload or real delivery was produced.

Unknown provider acceptance becomes `uncertain`. An empty reconciliation result
leaves it uncertain and cannot make it claimable again. A positive provider
receipt reconciles to `submitted`; callbacks deduplicate by event ID, match the
provider message and update state transactionally. Expired in-flight claims are
reconciled in batches of at most 100 and become uncertain. Callback signature
verification must occur before the database function; the current parser is
bounded HMAC validation for synthetic tests, not an HTTP callback endpoint.

## Evidence and checks

- `pnpm --filter @clarity/database proof` passed against disposable PostgreSQL
  18.6: migrations 0001–0014, dispatch snapshot/idempotency/CAS/role-denial and
  blocked-claim assertions, existing staff/manifest/concurrency assertions,
  and the late-instance lifecycle proof: a revision-1 dispatch retained its
  exact member/recipient scope while a newly admitted SOP sealed in revision 2
  and the Report returned to Ready only after that file was indexed. Explicitly
  incomplete inventory was denied sealing. The proof then remigrated and
  cleaned its container/anonymous volume. The dispatch authorization and
  provider transition fixture ran inside a transaction and was rolled back.
- `pnpm --filter @clarity/database build` and `pnpm --filter @clarity/database
typecheck` passed.
- `pnpm --filter @clarity/messaging test` passed 7/7 Node tests for accepted
  delivery/callback, uncertain outcome and reconciliation, stale-claim denial,
  HMAC callback validation, stale signatures and oversized/malformed bodies.
  `pnpm --filter @clarity/messaging typecheck` passed.
- The database package exposes separate preparation and delivery repository
  interfaces/pools. They are not wired to a web route or runtime role; the SQL
  functions have no grants to either role.

## Remaining gates

OI-06 recipient verification is unresolved. There is no activation/authorization
function, recipient identity challenge, link issuance, QR/copy link, Send
endpoint, real provider/template approval or live credentials. Provider
callback HTTP transport, production secret rotation, real worker scheduling,
operational retries/alerts, and end-to-end real delivery remain unimplemented.
The synthetic tests do not establish provider behavior or clinical suitability.
