---
id: storage-and-doctors-2026-09-23
type: session
title: Prove synthetic upload admission and doctor directory
universe: live
status: verified
updated: 2026-09-23
revision: application-overlay-proof-2026-09-23
---

# Prove synthetic upload admission and doctor directory

## Request and result

The user asked to continue all plan phases with synthetic integration for now.
Added a scoped [S3 admission helper](../../libs/storage/src/upload-admission.ts)
for short-lived single and multipart URLs, stored multipart resume, server-side
HEAD/streaming GET/completion/abort, and a disposable
[protocol proof](../../docs/evidence/22-upload-admission.md). The local service
and cloud routes are still being connected, so P3.3 remains open.

Added a one-centre [doctor directory](../../libs/database/migrations/0011_doctor_directory.sql),
[repository](../../libs/database/src/doctor-repository.ts) and active-staff
[API](../../apps/web/src/app/api/doctors/route.ts). Shared-phone confirmation
serializes concurrent first inserts. Its [PostgreSQL proof](../../docs/evidence/23-doctor-directory.md)
passed; final Send and recipient access remain gated by OI-06, so P6.2 remains
open. No real recipient or provider effect occurred.
An [in-memory synthetic messaging adapter](../../docs/evidence/24-synthetic-messaging.md)
then proved lost-acknowledgement reconciliation and exact idempotent retry
without external delivery; the durable outbox/provider gate is still open.

## Verification

`bash deploy/cloud/scripts/prove-upload-admission.sh`,
`bash deploy/proof-database/prove-doctors.sh`,
`pnpm --filter @clarity/web typecheck` and `pnpm run check:source-policy`
passed with disposable synthetic data. The relevant [source/service](../objects/source-and-service.md)
and [Report package](../objects/report-package.md) relationships were reviewed.
The full [cloud proof](../../docs/evidence/07-cloud-stack.md) subsequently
passed twelve migrations, isolated roles, Hanko/Orthanc readiness, replacement,
running web/worker application startup and fresh-volume backup restore. The
web image now builds shared workspace dependencies before Next.js. The proof's
legacy worker-grant assertion was updated to the active fenced completion
function. `pnpm run typecheck`, domain and messaging tests, and the disposable
S3 protocol proof passed. Disposable Compose resources were removed.

## Next step

Connect device upload routes and local service entry, then prove the complete
study-to-Ready path. Resolve OI-06 before exposing recipient grants and delivery.
