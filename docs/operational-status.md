# Clarity V2 operational status and synthetic runbook

Updated 2026-09-24. This document is the operator handoff for the current
workspace. [The active plan](01-final-clarity-v2-plan.md) remains the release
authority; this page records what can be run today and what has no accepted
procedure yet. Use synthetic data only.

## Release state

| Slice | State | Evidence and gate |
| --- | --- | --- |
| Local UI preview | Runnable | `pnpm --filter @clarity/web dev --hostname 127.0.0.1 --port 3111` serves an inactive Studies/Doctors/Settings preview. It does not connect clinical data. |
| Disposable cloud integration | Previously passed narrow synthetic proofs; latest rerun blocked | [Cloud stack](evidence/07-cloud-stack.md), [connected ingestion](evidence/26-connected-ingestion.md), [viewer](evidence/25-viewer-and-sharing-ui.md). Docker BuildKit currently reports an overlay input/output error. |
| Staff pilot | Not released | Real installed service, signed installers, two-OS lifecycle, source and clinical-content breadth, cloud topology and centre acceptance remain open. |
| External sharing | Not released | OI-06 recipient verification, final Send, grants, provider/canary, expiry and phone-browser acceptance remain open. The outbox is [policy-blocked](evidence/27-policy-gated-dispatch-outbox.md). |

The current source-health API and staff panel have focused tests and an isolated
PostgreSQL 15 fence proof. The combined V2 stack, PostgreSQL 18, and browser
behavior have not been rerun. Migration 0017 has a separate isolated
PostgreSQL 15 uncertain-row rotation and role-denial proof. The synthetic
dispatch worker remains an injectable test contract only; it is not scheduled
or granted permission to deliver.

## Pinned synthetic components

The workspace pins Node.js 22.20.0, pnpm 12.3.4, Electron 44.4.4, Next.js
16.3.6 and React 19.3.0. The disposable Compose file pins PostgreSQL
18.6, Hanko 3.0.4 and Orthanc 26.8.2 by image digest. MinIO in that stack is
an archived test emulator, not a selected production store. These are build
and proof versions, not a validated centre OS or clinical compatibility matrix.

## Run and inspect the disposable proof

1. From the V2 workspace, run `pnpm install --frozen-lockfile`, `pnpm run check`
   and `pnpm run build`. Passing these checks does not verify a clinical path.
2. With a healthy Docker daemon, run `bash deploy/cloud/scripts/proof.sh` for
   isolated Clarity/Hanko migrations, Orthanc index/storage and fresh-volume
   restore. The script generates its own credentials and synthetic DICOM, uses
   unique V2 Compose project names, and removes its volumes in its exit trap.
3. For connected staff viewing and compiled sync, run
   `CLARITY_VIEWER_PROOF=1 CLARITY_COMPILED_SYNC_PROOF=1 bash deploy/cloud/scripts/proof.sh`.
   Read the exact outcome in the command output and the dated evidence files;
   never infer a pass from a container being present.
4. If BuildKit reports a filesystem error, stop new proofs and preserve the
   diagnostic. Check `docker info` and available disk space. Do not prune shared
   Docker resources or restart the daemon while other workloads run without
   operator coordination. On 2026-09-24, the fresh proof failed before service
   startup while writing `/var/lib/docker/buildkit/containerdmeta.db`.

The cloud proof's restore validates synthetic application database, Hanko,
Orthanc index and object references in disposable volumes. A production backup
schedule, key escrow, bucket choice, restore target and recovery objectives have
not been selected. No production restore command is accepted yet.

## Failure handling in the current design

- A Hanko or staff database outage denies staff access; do not bypass the
  membership guard. Device sync has a separate machine identity.
- A source outage or cloud outage must leave local checkpoints and queued
  files intact. Reconcile the durable queue after recovery; do not delete the
  source or spool as a repair step. A compiled local SIGKILL proof now clears
  a stale source queue claim only after the singleton lock; installed-service
  recovery remains unproved.
- A worker crash must reconcile the intake object and Orthanc import before
  marking a Report Ready. Retain intake bytes until durable cloud references
  are recorded; the cross-system fence race is still an open acceptance gate.
- Low disk and changed source bytes have synthetic attention states. The staff
  panel reads fenced source-capacity reports and labels missing or old reports
  stale; use local service diagnostics during proofs because the connected
  reporting path has not been rerun. Do not interpret a Ready cloud copy as a
  healthy source.
- Provider acceptance with a lost response is uncertain. Reconcile by the
  stable idempotency key before any resend. Current outbox rows are blocked by
  recipient policy and cannot be delivered.

## Release handoff still required

Record a real target OS/architecture and Orthanc/source profile (OI-02/04),
dedicated cloud host/domain, maintained object store, SMTP and independently
held keys (OI-03/09), signing and upgrade owner (OI-05), recipient verification
(OI-06), provider/template/consent and canary destination (OI-07), and content
format scope (OI-08). Then execute the plan's installed service, browser,
provider, capacity, restore, upgrade and rollback acceptance on those targets.
No patient data or real recipient message is part of this runbook.
