# Audited staff access database foundation

Date: 2026-09-23. The ordered
[migration 0003](../../libs/database/migrations/0003_staff_access.sql) adds a
seeded access-control row, append-only audit, pending Hanko identity enrollment,
operator-only first-admin bootstrap, and narrow admin changes to membership
role/status and user active state. Successful Hanko registration creates no
Clarity membership. Exact issuer/subject retries resolve to one canonical user
without email-based linking.

The [disposable PostgreSQL 18.6 proof](../../deploy/proof-database/prove-staff-access.sh)
applied migrations 0001–0003 and exercised concurrent enrollment and bootstrap,
version checks, disabled/stale actor rejection, direct runtime write denial,
last-effective-admin protection and append-only audit. Opposing access changes
under pre-established REPEATABLE READ snapshots produced one commit and a
`40001` loser; one effective admin remained. The proof asserts exact SQLSTATEs:
`23514` for repeat bootstrap and last-admin violations, `42501` for runtime
privilege/disabled-actor denial, and `22023` for NULL version arguments. Rejected
mutations left user, membership and audit facts unchanged. Migration rerun passed;
the disposable container and anonymous volume were removed.

The isolated [full cloud stack proof](07-cloud-stack.md) was rerun with all three
Clarity migrations. Hanko/Orthanc readiness, synthetic DICOMweb bytes, container
replacement and backup restore to new PostgreSQL/MinIO volumes passed, followed
by cleanup. Frozen install, `pnpm check`, root build/tests and compiled export
probe passed; lint reported one existing unused-type warning and zero errors.

These functions recheck the **supplied** actor UUID against current database
facts; the database cannot prove which human supplied it. A trusted server route
must derive actor identity from the validated Hanko session on every action.
No application repository, protected route, two provider-issued identities or
browser/Electron acceptance is included in this database proof. P2.1 and P2.2
remain open.
