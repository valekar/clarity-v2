---
id: report-package
type: object
title: Report and verified imaging package
universe: ghost
status: stub
updated: 2026-09-23
revision: connected-synthetic-ready-viewer-proof-2026-09-23
---

# Report and verified imaging package

## Purpose

Proposed Report tracks a source study, its observed revision and verified cloud files.

## Why this shape

Metadata can arrive before bytes. A quiet study is not guaranteed complete, and
late instances must not silently broaden an already-issued recipient grant.

## Shape

The fresh [PostgreSQL migrations](../../libs/database/CONTEXT.md) now contain
Reports, files, manifests, source observations and DICOM UID reservations, with a
[disposable constraint proof](../../docs/evidence/06-database-foundation.md).
A [disposable cloud proof](../../docs/evidence/07-cloud-stack.md) loaded one
synthetic DICOM into an Orthanc PostgreSQL index and S3-compatible object store,
then restored the index and bytes into fresh volumes. Object references and
cloud Orthanc indexing are now wired in a [worker foundation](../../apps/worker/src/import-instance.ts)
with a [transactional completion migration](../../libs/database/migrations/0004_worker_completion.sql).
The [running-worker crash proof](../../docs/evidence/15-worker-foundation.md)
now consumes a durable synthetic `received` upload across PostgreSQL, private
intake and Orthanc. It proves readback and restart reconciliation after a kill
during DB completion and after commit before intake cleanup. Connected
device-authenticated study/upload admission, manifest seal, worker import and
Ready recomputation now pass in the one-object synthetic
[end-to-end proof](../../docs/evidence/26-connected-ingestion.md). The same
worker-created source-offline Ready Report passed authenticated QIDO/WADO/bulk
and OHIF web checks. Restart across the integrated route/worker path, quiet but
incomplete inventory behavior and frozen dispatch scope remain acceptance work.
[Persistence](../../docs/01-final-clarity-v2-plan.md#36-proposed-persistence-and-trusted-api-contracts)
owns proposed tables; [readiness](../../docs/01-final-clarity-v2-plan.md#35-transfer-object-storage-and-ready-state)
owns validation, durable references and state transitions.
Pure [manifest/readiness decisions](../../libs/domain/src/index.ts) also exist with
synthetic [decision evidence](../../docs/evidence/08-manifest-decisions.md).
They require explicit stable, complete inventory at seal time and preserve a
verified cloud Ready state when the source later disconnects. The
[observed manifest migration](../../libs/database/migrations/0005_observed_manifests.sql)
and [five-migration proof](../../docs/evidence/18-manifest-persistence.md) now
enforce fenced draft/page/seal writes, an exact digest and a current-generation
Ready proof. A late instance opens a new revision; a generation reset atomically
moves affected Reports out of Ready. Trusted source inventory is connected
through a synthetic application API proof; quiet-but-incomplete inventory
acceptance remains open. The worker's indexed-file completion and Ready
recomputation are connected in its disposable proof.

## Connected to

Ingested by [source/service](source-and-service.md); viewed by authorized
[staff](staff-identity.md). Dispatch freezes files and contact snapshots only
after explicit Send; no public clinical access is implemented. A synthetic
[doctor directory and API](../../docs/evidence/23-doctor-directory.md) now
support doctor selection groundwork; recipient verification and dispatch remain
open.

## If you change this

**Hits:** ingestion validation, readiness, scoped viewer, dispatch/file grant checks.

**Does not hit:** source deletion policy; link expiry never authorizes file deletion.

## Surfaces

Current: synthetic connected service API, cloud worker, Ready-state persistence
and authenticated staff viewer. These proofs use disposable synthetic data;
there are no production source uploads or persistent clinical V2 Report rows.
Later recipient delivery remains behind OI-06.

## See

[Sharing release boundary](../../docs/01-final-clarity-v2-plan.md#37-sharing-viewing-and-release-restraint).
