# V2 PostgreSQL schema

Input: trusted V2 migration credentials and additive SQL migrations. Output:
constrained one-centre identity, source, Report, file, ingestion manifest,
admission and DICOM UID ownership tables. `migrate` requires `PGDATABASE` to start
with `clarity_v2_`, applies checksummed migrations through `psql`, and never selects
a database or V1 schema on the caller's behalf. Runtime and migration roles,
production deployment, object storage and API authorization are still deployment
and service owners' work.

The intended migration owner is a dedicated `clarity_v2_migrator` role. The
application runtime must not own schema objects or receive direct `UPDATE` access
to `reports.state`; provisioning must grant only required table operations and
explicit `EXECUTE` on reviewed functions. `acquire_source_lease`,
`advance_source_generation`, `seal_report_revision` and
`reconcile_ingestion_upload_status` revoke the default PUBLIC execute grant.
`reconcile_ingestion_upload_status` is deliberately unavailable to runtime roles:
only the fenced worker completion path may mark a received upload completed after
cloud indexing and file reconciliation. Public schema CREATE is revoked before
privileged functions are installed. The disposable proof exercises the role
boundary, but production role creation and grants remain deployment work.

Migration `0003_staff_access.sql` adds pending Hanko identity enrollment, the
operator-only one-time first-admin bootstrap, serialized membership and user
active-status changes, and append-only access audit. Create
`clarity_v2_runtime`, `clarity_v2_migrator`, and
`clarity_v2_bootstrap_operator` before applying it to receive the conditional
runtime/operator grants. The database functions recheck the supplied actor's
current effective-admin rows, serialize through a versioned singleton row, use
optimistic membership versions, and preserve at least one effective admin.

The database cannot authenticate the `p_actor_user_id` argument passed by the
server runtime. Every route must derive that id by mapping issuer and subject
from a validated Hanko session; never accept it from request data. The pending
enrollment function likewise may only be called after server-side provider
validation. It idempotently maps an exact `(provider, issuer, subject)` retry to
the existing canonical user, creates no membership, and does not link by email.
Bootstrap records the operator's database login in the audit row, but is not a
replacement for validated Hanko identity enrollment. Do not expose these SQL
functions as unauthenticated endpoints.

The trusted ingestion service must establish fresh stable and complete source
inventory evidence before calling the seal function. It supplies the canonical
manifest digest; the database enforces nonempty membership, file/hash references,
immutable sealed members and CAS, but does not independently recompute the digest
or establish source inventory completeness. Migration `0013_ingestion_race_recovery.sql`
reconciles Ready at seal time when all exact members were already indexed, and
serializes same-source/idempotency-key upload admission before lease validation.
Source observations preserve generation-specific Orthanc locator history while
logical Report and file IDs stay fixed across source resets. The disposable
database proof covers this migration; production role grants still require the
cloud provisioning path.

Migration `0015_manifest_admission_cutoff.sql` durably marks a Report's manifest
dirty when device admission introduces a file outside its current sealed member
set. Worker completion may index that file, but readiness remains processing
until a fresh complete manifest seal atomically clears the marker and reconciles
all members. The read and dispatch boundaries continue to require Report state
`ready`; a dirty Report cannot satisfy the database Ready check. Historic files
may be excluded by a fresh manifest, so readiness is scoped to exact current
members rather than every file ever observed.

Migration `0016_source_health.sql` stores one bounded operational report per
source. The device-auth function locks the source and device, checks the current
paired device, active lease, generation and fence, then writes server receipt
time. The staff read function rechecks active membership and joins only a report
matching the current live lease. The web API computes staleness from server time;
see the [source-health session](../../map/sessions/2026-09-24-source-health.md).

Migration `0017_dispatch_uncertain_listing.sql` adds an indexed reconciliation
attempt timestamp and a bounded `list_uncertain_dispatch_outbox` function. It
rotates uncertain rows with `FOR UPDATE SKIP LOCKED`; PUBLIC and application
roles receive no execute grant. The dispatch repository exposes that function
through `listUncertain` and a narrow worker adapter. A synthetic PostgreSQL 15
proof invokes that adapter with the worker/provider/callback and exercises the
SQL state path in one rolled-back transaction; it does not prove crash/restart
durability, cross-worker concurrency or restricted delivery-role execution.
See [evidence 39](../../docs/evidence/39-uncertain-dispatch-listing.md).
