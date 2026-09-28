# Staff-only username/password preparation

**Date:** 2026-09-27. **Scope:** synthetic Coolify staff authentication and
private account provisioning. No hosted deployment or real staff account was
created.

## Change

The [Coolify Hanko config](../../deploy/cloud/coolify-test/prepare.sh) disables
email, email delivery, public signup, self-service deletion and recovery. Its
Admin API is bound to container loopback; Coolify exposes only the public API.
The [sign-in page](../../apps/web/src/app/sign-in/HankoAuth.tsx) mounts Hanko's
login-only element. The [Clarity guard](../../libs/server/src/auth/require-staff-access.ts)
rejects unknown identities without creating a pending staff user. Additive
[migration 0018](../../libs/database/migrations/0018_staff_operator_provisioning.sql)
revokes pending-enrollment execution from the web runtime and grants it to the
private operator role. Staff password verifiers remain in Hanko's database;
Clarity stores an exact issuer/subject link and separately approved membership.

## Verification

- `pnpm --filter @clarity/server test` passed 33 of 33 focused tests after the
  guard change.
- `pnpm --filter @clarity/database proof` applied migrations 0001–0018 to a
  disposable PostgreSQL container. Runtime enrollment failed with SQLSTATE
  42501, private operator enrollment and first-admin bootstrap passed, and a
  validated unknown Hanko identity was denied without creating a Clarity row.
- Web TypeScript and database builds passed.
- The [focused Hanko proof](46-hanko-username-password.md) passed public
  registration-action denial, private account creation, repeat preservation of
  the original password, login, session validation and logout. Its disposable
  containers and volumes were removed.

## Remaining acceptance

The Coolify operator scripts and browser rendering of the login-only element
have not run on a hosted deployment. Hosted HTTPS login, staff creation on
Coolify, password reset policy and packaged Electron tests remain open.
