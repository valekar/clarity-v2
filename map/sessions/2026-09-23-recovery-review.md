---
id: recovery-review-2026-09-23
type: session
title: Review connected ingestion recovery and browser viewer limits
universe: live
status: verified
updated: 2026-09-23
revision: independent-advisor-review-2026-09-23
---

# Review connected ingestion recovery and browser viewer limits

## Request and result

The user asked for all phases of the [active plan](../../docs/01-final-clarity-v2-plan.md)
to be implemented with GPT-6 Luna agents and a GPT-6 Astra advisor. The
disposable [connected ingestion proof](../../docs/evidence/26-connected-ingestion.md)
reached Ready and the authenticated QIDO/WADO/bulk routes passed. A separate
[Chrome check](../../docs/evidence/25-viewer-and-sharing-ui.md) completed Hanko
sign-in and navigation to a Ready study page, but its embedded OHIF frame was
blocked before the toolbar or pixels loaded.

The independent Astra review identified six priority recovery defects: a lost
seal response, an unchanged digest after source-generation reset, worker import
before manifest seal, lease expiry during slow transfer, concurrent first
admission with one idempotency key, and an unbounded DICOM file-meta UID read.
The first three affect Ready convergence; the fourth can invalidate a long
upload; the fifth can create duplicate admission ownership; the sixth can
allocate excessive memory on malformed input. These findings are assigned to
the local-service and cloud/worker owners and are not marked closed in this
record until their focused and combined proofs pass.

## Verification

Before corrective edits, `CLARITY_VIEWER_PROOF=1 bash
deploy/cloud/scripts/proof.sh` passed one synthetic object through signed
intake, worker-created Ready, staff route authorization and fresh-volume
restore. `pnpm run check`, `pnpm run build` and `pnpm exec turbo run test`
passed for that snapshot. Those checks did not exercise the six races above or
browser pixel rendering. The [workspace evidence](../../docs/evidence/01-workspace-checks.md)
records the command scope.

## Map review and next step

The affected owners are [source/service](../objects/source-and-service.md),
[Report package](../objects/report-package.md) and
[delivery boundary](../objects/delivery-boundary.md). Keep P3/P4 release boxes
open, rerun the database and process race proofs after fixes, then repeat the
combined stack and browser capture. No runtime release state is inferred from
the synthetic checks.
