---
id: delivery-boundary
type: object
title: Recipient delivery and verification boundary
universe: ghost
status: stub
updated: 2026-09-24
revision: synthetic-dispatch-tick-callback-proof-2026-09-24
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
acceptance and lost-reply reconciliation without network effects. Migration
[0014](../../libs/database/migrations/0014_dispatch_outbox.sql) adds immutable
Report/revision-bound recipient snapshots and per-recipient outbox rows. Initial
rows are `blocked_policy`, with no authorization reference or message body; the
claim function selects only later authorized rows. Separate database
preparation/delivery interfaces have no web-runtime or device-role grants. The
synthetic SQL and transition assertions are in
[evidence 27](../../docs/evidence/27-policy-gated-dispatch-outbox.md). An
injected bounded worker tick and verified callback handler now have focused
synthetic tests in [evidence 36](../../docs/evidence/36-synthetic-dispatch-tick-and-callback.md).
Neither is wired to a scheduler, network endpoint or database delivery role.
OI-06 recipient verification remains open; no share link or message can be
released.

## Connected to

Dispatch will freeze [Report package](report-package.md) files. Staff identity
authorizes Send through [staff access](staff-identity.md); recipient access is
a separate policy.

## If you change this

**Hits:** dispatch snapshot, provider outbox, callback verification, recipient
grants, expiry and every recipient content route.

**Does not hit:** source Orthanc retention; link expiry cannot delete images.

## Surfaces

Current: synthetic provider/worker/callback tests and a disposable PostgreSQL
proof of blocked, immutable dispatch snapshots, bounded claims and uncertain
reconciliation. Planned: staff-authorized dispatch activation, provider worker
runtime, recipient session
and phone-browser access only after OI-06 and provider approval.
