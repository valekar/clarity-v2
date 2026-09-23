---
id: report-package
type: object
title: Report and verified imaging package
universe: ghost
status: stub
updated: 2026-09-23
revision: plan-1.0
---

# Report and verified imaging package

## Purpose

Proposed Report tracks a source study, its observed revision and verified cloud files.

## Why this shape

Metadata can arrive before bytes. A quiet study is not guaranteed complete, and
late instances must not silently broaden an already-issued recipient grant.

## Shape

Planned PostgreSQL Reports/files/manifests, object references and cloud Orthanc index.
[Persistence](../../docs/01-final-clarity-v2-plan.md#36-proposed-persistence-and-trusted-api-contracts)
owns proposed tables; [readiness](../../docs/01-final-clarity-v2-plan.md#35-transfer-object-storage-and-ready-state)
owns validation, durable references and state transitions.

## Connected to

Ingested by [source/service](source-and-service.md); viewed by authorized
[staff](staff-identity.md). Dispatch freezes files and contact snapshots only
after explicit Send; no public clinical access is implemented.

## If you change this

**Hits:** ingestion validation, readiness, scoped viewer, dispatch/file grant checks.

**Does not hit:** source deletion policy; link expiry never authorizes file deletion.

## Surfaces

Planned: service metadata intake, cloud worker, staff dashboard, later recipients.
No V2 report rows, bucket objects or viewer routes exist yet.

## See

[Sharing release boundary](../../docs/01-final-clarity-v2-plan.md#37-sharing-viewing-and-release-restraint).
