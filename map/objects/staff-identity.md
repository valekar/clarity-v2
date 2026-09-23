---
id: staff-identity
type: object
title: Hanko identity and staff access
universe: live
status: verified
updated: 2026-09-23
revision: device-admin-pairing-proof-2026-09-23
---

# Hanko identity and staff access

## Purpose

Hanko identity links identify people; Clarity membership controls actions.

## Why this shape

Registration is not centre authorization. Persistent synchronization must not
depend on a human session, and email/phone text cannot be the user primary key.

## Shape

The [fresh PostgreSQL schema](../../libs/database/CONTEXT.md) now has stable app
user UUIDs, trusted issuer/subject identity links and admin/staff memberships,
tested only in a [disposable database](../../docs/evidence/06-database-foundation.md).
The [disposable cloud proof](../../docs/evidence/07-cloud-stack.md) applied
Hanko migrations and checked readiness. A separate
[synthetic protocol proof](../../docs/evidence/09-hanko-protocol.md) registered a
temporary Hanko user, completed Mailpit passcode login and revoked a session.
It did not grant application access. The Hanko adapter and application
authorization are separate boundaries. The
[server-only adapter](../../libs/server/src/auth/hanko-session.ts) validates
sessions with [focused synthetic tests](../../docs/evidence/10-hanko-session-adapter.md).
The [typed repository](../../libs/database/src/staff-repository.ts) and
[access guard](../../libs/server/src/auth/require-staff-access.ts) now re-read
active membership for each check. A [disposable PostgreSQL integration proof](../../docs/evidence/13-staff-access-guard.md)
combines that database with synthetic Hanko HTTP responses. The
[protected web routes](../../apps/web/src/app/api/staff/access/route.ts) and
[two-identity provider proof](../../docs/evidence/16-staff-web-hanko.md) now
connect real disposable Hanko-issued sessions to pending enrollment, explicit
admin grant, current-role checks, disable and logout denial.
The [audited staff access migration](../../libs/database/migrations/0003_staff_access.sql)
and [disposable concurrency proof](../../docs/evidence/12-staff-access-database.md)
now enforce one effective administrator in the database. The trusted web route
derives the actor UUID from the current Hanko session and membership; the SQL
function independently rechecks the supplied actor's active admin state.
The [synthetic device pairing proof](../../docs/evidence/21-device-pairing.md)
exercises admin code creation, restricted device enrollment, revocation and
source lease fencing. It is distinct from staff authentication and has not
been run in a packaged desktop/service installation.
The [auth contract](../../docs/01-final-clarity-v2-plan.md#32-hanko-identity-and-session-integration)
and [research](../../docs/research/hanko.md) own the detailed choices.

## Connected to

Authorizes staff use of [Reports](report-package.md) and admin pairing of
[service installations](source-and-service.md). Recipient verification is a
separate unresolved release gate, not automatically supplied by staff login.

## If you change this

**Hits:** session adapter, protected APIs, staff onboarding, desktop auth acceptance.

**Does not hit:** DICOM study identity, machine token format or entered patient phone.

## Surfaces

Current: [Next.js shell](../../apps/web/src/app/page.tsx), Hanko sign-in,
no-access page, protected staff dashboard and admin settings with grant/disable.
The two-account proof forwarded provider-issued cookies over HTTP. A later
[Chromium proof](../../docs/evidence/16-staff-web-hanko.md) verified a Secure
HttpOnly session across localhost Hanko/web ports and pending-staff denial.
Hanko Elements screen flow, Electron packaging and a hosted V2 identity service
remain unproven. No approved production V2 staff user exists yet.

## See

[Hanko research and V1 impact](../../docs/research/hanko.md).
