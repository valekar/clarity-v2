---
id: source-and-service
type: object
title: Private source and synchronization service
universe: ghost
status: stub
updated: 2026-09-23
revision: connected-synthetic-ingestion-2026-09-23
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
exits without synchronization. A [private Orthanc change adapter](../../apps/sync-service/src/orthanc/change-feed.ts)
and [SQLite checkpoint/queue](../../apps/sync-service/src/persistence/checkpoint-store.ts)
have synthetic tests, including crash rollback and reset replay. The
[inventory coordinator](../../apps/sync-service/src/discovery/inventory-coordinator.ts)
and [global Orthanc instance client](../../apps/sync-service/src/orthanc/discovery-client.ts)
now support resumable initial scans, change replay and callable periodic
reconciliation. A [compiled synthetic-only process](../../apps/sync-service/src/synthetic-main.ts)
exercises the coordinator against a loopback fixture and durable SQLite file;
the normal service entry does not schedule it. A separate
[injected sync loop](../../apps/sync-service/src/runtime/sync-loop.ts) now joins
inventory, changes, bounded private spooling and a typed cloud upload client.
The [47-test local proof](../../docs/evidence/19-local-spool-and-loop.md) covers
capacity, changed bytes, lost upload responses, restart receipts and old local
generation handling against a private loopback fixture. Its later regressions
preserve PatientID issuer and clear missing patient fields on a new source
snapshot. A [scoped S3 admission helper](../../libs/storage/src/upload-admission.ts)
and [disposable MinIO proof](../../docs/evidence/22-upload-admission.md) now
cover short-lived signed PUT, resumed multipart parts, completion, HEAD and
streaming GET. Cloud lease, study/upload admission and manifest routes now
connect to a worker-created Ready Report in the one-object synthetic
[device-to-viewer proof](../../docs/evidence/26-connected-ingestion.md), with
fence takeover/revocation, Orthanc byte/UID and DICOMweb readback, and offline
snapshot checks. The normal sync-service entry still does not activate its
injected loop or use these routes; local credential storage and OS service
acceptance remain open. See the canonical
[lifecycle](../../docs/01-final-clarity-v2-plan.md#33-desktop-and-independent-service-lifecycle),
[discovery](../../docs/01-final-clarity-v2-plan.md#34-orthanc-discovery-and-payload-normalization)
and [transfer](../../docs/01-final-clarity-v2-plan.md#35-transfer-object-storage-and-ready-state) contracts.
An isolated [synthetic path benchmark](../../docs/evidence/03-ingestion-proof.md)
verified 769 generated instances across three file-size profiles, cloud readback,
late-instance signal and source-volume reset. It selected private intake → worker
→ cloud Orthanc, but did not execute this service entry or establish clinic-scale
behaviour.
The [local discovery evidence](../../docs/evidence/04-local-discovery.md) and
[anchored process proof](../../docs/evidence/14-anchored-inventory.md) cover
fenced queue processing, reset/replay, deletion-induced page repair and direct
known-row revalidation. Three independently reviewed crash/resume and
generation-restart defects were corrected with focused regressions. Running
clinical source admission remains unaccepted.
A [disposable macOS lifecycle probe](../../docs/evidence/11-macos-lifecycle-probe.md)
now exercises a compiled standalone process, SQLite heartbeat recovery and a
generated but unregistered launchd plist. It does not install the service or
establish logout/boot continuity.
A separate [macOS package scaffold](../../docs/evidence/20-macos-installer-scaffold.md)
packages an inert launchd template and tests temporary-root release switching,
rollback and data-preserving uninstall. It has not installed, signed or run an
actual bundled service; Windows work remains open.
The [fresh database schema](../../libs/database/CONTEXT.md) also records source
generations, device fences, upload admissions and locator observations; its
[disposable proof](../../docs/evidence/06-database-foundation.md) does not pair or
run an installed device service.
The [pairing proof](../../docs/evidence/21-device-pairing.md) now exercises
one-time admin enrollment, a device-only credential, lease generation and
revocation fences against disposable PostgreSQL. The normal service entry
has not yet used those routes or stored the credential in an OS vault.

## Connected to

Creates [Report packages](report-package.md); admin pairing depends on
[staff permissions](staff-identity.md). Staff logout does not revoke device pairing.

## If you change this

**Hits:** discovery adapters, local queue, ingestion APIs, installer lifecycle tests.

**Does not hit:** Hanko's staff-session lifetime or source Orthanc retention policy.

## Surfaces

Current: a nonoperational normal service entry, synthetic local discovery
process, injected sync loop and private loopback upload tests, plus connected
synthetic device-to-Ready cloud APIs and worker, with
[bounded evidence](../../docs/evidence/19-local-spool-and-loop.md) and
[connected proof](../../docs/evidence/26-connected-ingestion.md).
Planned: activate the local loop through protected device credentials and
complete OS service acceptance. No clinic Orthanc reads or production cloud
transfers exist.

## See

[Plan phases P0/P3/P5](../../docs/01-final-clarity-v2-plan.md#4-implementation-checklist).
