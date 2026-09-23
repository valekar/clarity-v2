---
id: staff-identity
type: object
title: Hanko identity and staff access
universe: ghost
status: stub
updated: 2026-09-23
revision: scaffold-0.1.0
---

# Hanko identity and staff access

## Purpose

Proposed Hanko identity links identify people; Clarity membership controls actions.

## Why this shape

Registration is not centre authorization. Persistent synchronization must not
depend on a human session, and email/phone text cannot be the user primary key.

## Shape

Planned `libs/server/src/auth/` and `libs/database/`: stable app user UUID,
trusted issuer/subject identity link and active admin/staff membership.
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

Current: [static Next.js shell](../../apps/web/src/app/page.tsx) without login.
Planned: hosted dashboard in browser/Electron and private Hanko admin setup.
No Hanko instance or enrolled V2 user exists yet.

## See

[Hanko research and V1 impact](../../docs/research/hanko.md).
