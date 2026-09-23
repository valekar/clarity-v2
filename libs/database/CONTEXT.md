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
`reconcile_ingestion_upload_status` revoke the default PUBLIC execute grant. The
narrow recovery function is `SECURITY DEFINER`, pins `search_path`, and is intended
to be owned by the non-login migration role; provisioning may grant its EXECUTE
privilege only to the authenticated server runtime. Public schema CREATE is
revoked before this function is installed. The disposable proof exercises that
role split, but production role creation and grants remain deployment work.

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
