---
id: staff-only-login-session-2026-09-27
type: session
title: Restrict sign-in to administrator-provisioned staff
universe: live
status: verified
updated: 2026-09-27
revision: staff-only-login-session-2026-09-27
---

# Restrict sign-in to administrator-provisioned staff

## Request and result

The user clarified that staff must use administrator-set usernames and passwords
stored in the backend database. The staff app must have no public signup or mail
integration. [Plan v1.8](../../docs/01-final-clarity-v2-plan.md) replaces the
email-passcode and open-registration assumptions. Hanko owns password verifiers;
Clarity owns identity links and active roles. The
[staff guard](../../libs/server/src/auth/require-staff-access.ts) now denies
unknown identities without creating a row. The
[database migration](../../libs/database/migrations/0018_staff_operator_provisioning.sql)
removes runtime enrollment privilege and permits private operator enrollment.

## Verification

Focused server tests passed 33/33 after the guard change. The
[database proof](../../docs/evidence/48-staff-only-login.md) applied all 18
migrations and checked runtime denial, operator enrollment and unknown identity
denial. The [closed-signup Hanko proof](../../docs/evidence/46-hanko-username-password.md)
passed administrator-created credentials, repeat preservation, login and logout
in disposable containers. Database and web TypeScript builds passed. Installed
Electron login and hosted browser behavior require separate evidence; no Coolify
deployment occurred.

## Map review and next step

Updated [identity](../objects/staff-identity.md) and
[planning](../objects/planning-workspace.md). The source ingestion and recipient
boundaries are unaffected. Run the private staff account command and bootstrap
on the actual Coolify test stack, then run hosted synthetic acceptance when the
Coolify host and test resources are available.
