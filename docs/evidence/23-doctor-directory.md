# Synthetic doctor directory proof

Date: 2026-09-23. [Migration 0011](../../libs/database/migrations/0011_doctor_directory.sql)
adds a one-centre doctor directory with E.164 numbers, a unique name/phone
identity, active flag, version and creating staff reference. A narrow
`SECURITY DEFINER` function verifies and locks current active staff membership
within the create transaction. A second guarded function performs the insert;
the runtime role has SELECT on doctors and execute permission on these functions,
without direct doctor or staff table mutation.
The [repository](../../libs/database/src/doctor-repository.ts) serializes
creation by phone so two new names cannot bypass shared-phone confirmation.
The [staff API](../../apps/web/src/app/api/doctors/route.ts) requires an active
Hanko staff session and same-origin JSON for writes.

`bash deploy/proof-database/prove-doctors.sh` passed in disposable pinned
PostgreSQL with synthetic names/numbers. It proved exact-name retry reuse,
shared-phone confirmation, search, concurrent first insert (one created and
one prompted), and denial after membership was disabled in the fixture.
`pnpm --filter @clarity/web typecheck`, `pnpm run check:source-policy` and
`bash deploy/cloud/scripts/prove-upload-admission.sh` also passed after this
change. The proof cleanup removed the temporary container and anonymous volume.

The directory is a P6.2 prerequisite. Recipient verification, dispatch snapshot,
outbox, provider delivery and phone-browser access are still open. No real
recipient or message was used.
