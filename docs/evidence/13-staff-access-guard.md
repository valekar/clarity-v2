# Database-backed staff access guard proof

Date: 2026-09-23. Scope: a disposable PostgreSQL proof of the server-side
Hanko-session-to-staff-authorization boundary. The [typed repository](../../libs/database/src/staff-repository.ts),
[guard](../../libs/server/src/auth/require-staff-access.ts),
[integration test](../../libs/server/tests/staff-access.postgres.ts) and
[disposable runner](../../deploy/proof-database/run-proof.sh) own this increment.

The runner applied migrations 0001–0003 to a fresh PostgreSQL 18.6 container,
seeded two synthetic identity links through the audited staff SQL, and ran the
guard against that real database and a local synthetic Hanko HTTP responder.
The command was `pnpm --filter @clarity/database proof`, which invokes the
disposable database runner and `node --experimental-strip-types --test
libs/server/tests/staff-access.postgres.ts`.
The guard obtained issuer and subject only from a successfully validated session,
looked up active membership on each call, and kept an unknown valid identity
pending without assigning a role. A Hanko-verified email is retained only as
its display name for administrator review; issuer/subject, never email, is
the authentication link.

The integration cases passed: current admin/staff read and admin decisions;
pending identity no-access; immediate denial after membership disablement;
revoked, wrong-issuer and wrong-audience session denial (401); malformed/outage
Hanko responses (503); and PostgreSQL outage denial (503). The runner also
executed the SQL concurrency/SQLSTATE proof, reran migrations as an idempotence
check, and removed its named container and anonymous volume.

The Hanko HTTP responder and identity subjects in this proof are synthetic
fixtures. The separate [Hanko protocol proof](09-hanko-protocol.md) exercises a
real disposable Hanko service, but does not yet bind two provider-issued
identities through these protected application routes. P2.1 and P2.2 remain
unchecked at this proof point. The later
[two-identity web proof](16-staff-web-hanko.md) completes the application
integration; browser behaviour remains a separate gate.
