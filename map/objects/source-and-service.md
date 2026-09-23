---
id: source-and-service
type: object
title: Private source and synchronization service
universe: ghost
status: stub
updated: 2026-09-23
revision: scaffold-0.1.0
---

# Private source and synchronization service

## Purpose

Proposed independently managed OS service reads local Orthanc and transfers new
study data outbound; the Electron window is its configuration/status surface.

## Why this shape

An ordinary window/process cannot satisfy quit/logout continuity. The machine
credential is independent of human Hanko login; no public local API is required.

## Shape

The [compiled entry](../../apps/sync-service/src/main.ts) exists and explicitly
exits without synchronization. Durable SQLite checkpoints/queue/spool, bounded
transfer and source-bound machine enrollment remain planned. See the canonical
[lifecycle](../../docs/01-final-clarity-v2-plan.md#33-desktop-and-independent-service-lifecycle),
[discovery](../../docs/01-final-clarity-v2-plan.md#34-orthanc-discovery-and-payload-normalization)
and [transfer](../../docs/01-final-clarity-v2-plan.md#35-transfer-object-storage-and-ready-state) contracts.

## Connected to

Creates [Report packages](report-package.md); admin pairing depends on
[staff permissions](staff-identity.md). Staff logout does not revoke device pairing.

## If you change this

**Hits:** discovery adapters, local queue, ingestion APIs, installer lifecycle tests.

**Does not hit:** Hanko's staff-session lifetime or source Orthanc retention policy.

## Surfaces

Current: a nonoperational service entry. Planned: OS service, admin settings and
cloud intake worker. No Orthanc reads or cloud transfers exist yet.

## See

[Plan phases P0/P3/P5](../../docs/01-final-clarity-v2-plan.md#4-implementation-checklist).
