---
id: delivery-boundary
type: object
title: Recipient delivery and verification boundary
universe: ghost
status: stub
updated: 2026-09-23
revision: synthetic-provider-proof-2026-09-23
---

# Recipient delivery and verification boundary

## Purpose

Proposed sharing release freezes a Ready Report, binds each grant to an intended
recipient and queues provider delivery only after explicit staff Send.

## Why this shape

Hanko authenticates staff, not patient or doctor phone ownership. OI-06 still
needs a recipient verification decision. A provider timeout may follow accepted
delivery, so retry must reconcile first.

## Shape

The [plan](../../docs/01-final-clarity-v2-plan.md#37-sharing-viewing-and-release-restraint)
owns the policy and release gates. A [doctor directory](../../docs/evidence/23-doctor-directory.md)
and pure [dispatch decision](../../libs/domain/src/dispatch.ts) exist for
staff-side groundwork. The [synthetic provider](../../libs/messaging/src/synthetic-provider.ts)
and [test](../../docs/evidence/24-synthetic-messaging.md) prove idempotent
acceptance and lost-reply reconciliation without network effects. No V2 outbox,
real provider, recipient session, public content route or message send exists.

## Connected to

Dispatch will freeze [Report package](report-package.md) files. Staff identity
authorizes Send through [staff access](staff-identity.md); recipient access is
a separate policy.

## If you change this

**Hits:** dispatch snapshot, provider outbox, callback verification, recipient
grants, expiry and every recipient content route.

**Does not hit:** source Orthanc retention; link expiry cannot delete images.

## Surfaces

Current: local synthetic provider test only. Planned: staff sharing screen,
transactional Send, provider worker and phone-browser access after OI-06.
