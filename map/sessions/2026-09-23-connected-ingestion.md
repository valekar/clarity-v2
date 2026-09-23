---
id: connected-ingestion-2026-09-23
type: session
title: Prove connected synthetic ingestion and extract imaging identity reader
universe: live
status: verified
updated: 2026-09-23
revision: connected-device-ready-viewer-proof-2026-09-23
---

# Prove connected synthetic ingestion and extract imaging identity reader

## Request and result

The task was to complete connected P3.4/P4.1/P4.2 work using synthetic data,
prove device admission through worker-created Ready state, and expose a reusable
bounded DICOM identity parser. Added migration 0012 upload routes/repository,
web signed upload/verification, lease-fenced study and manifest APIs, and the
disposable [connected ingestion proof](../../docs/evidence/26-connected-ingestion.md).
The harness pairs devices, admits one generated Study and upload, seals its
manifest, runs the compiled worker to Ready, verifies cloud Orthanc/DICOMweb,
checks takeover/revocation and source-offline snapshot access. The authenticated
staff-viewer helper then verifies QIDO/WADO/bulk/OHIF and authorization outcomes
against that same Report. The proof stack also passes replacement and fresh
volume restore.

Extracted the narrow Part 10 identity reader from the worker into
[`@clarity/imaging`](../../libs/imaging/src/index.ts); the worker retains
streaming hash/size logic and imports the shared identity type/parser. The parser
behavior and little-endian-only envelope are unchanged. No pixel decoding or
codec coverage was added.

## Verification

- `pnpm --filter @clarity/database proof` passed through migrations 0001–0012.
- `pnpm --filter @clarity/worker test` passed 13 focused tests; imaging and
  worker build/typecheck passed after extraction.
- `CLARITY_VIEWER_PROOF=1 bash deploy/cloud/scripts/proof.sh` passed connected
  upload→worker→Ready, staff viewer authorization, replacement, backup/restore
  into fresh volumes and cleanup of disposable resources.
- Connected acceptance covered one synthetic object. This run did not prove
  restart at every integrated API boundary, local sync-service activation,
  late-instance handling through the service, large multipart route behavior,
  or atomicity between PostgreSQL and Orthanc. Keep P3.4/P4.1/P4.2 phase gates
  open for their remaining acceptance items.

## Map review and next step

Updated [source/service](../objects/source-and-service.md),
[Report package](../objects/report-package.md), shared library context and
evidence. Runtime remains synthetic-only. Follow up on integrated restart and
late-instance tests, compiled imaging package import proof, then reassess the
phase checklist without promoting incomplete acceptance.
