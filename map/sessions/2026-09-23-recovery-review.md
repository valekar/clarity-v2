---
id: recovery-review-2026-09-23
type: session
title: Review connected ingestion recovery and browser viewer limits
universe: live
status: verified
updated: 2026-09-23
revision: reviewed-fifteen-migration-recovery-proof-2026-09-23
---

# Review connected ingestion recovery and browser viewer limits

## Request and result

The user asked for all phases of the [active plan](../../docs/01-final-clarity-v2-plan.md)
to be implemented with GPT-6 Luna agents and a GPT-6 Astra advisor. The
disposable [connected ingestion proof](../../docs/evidence/26-connected-ingestion.md)
reached Ready and the authenticated QIDO/WADO/bulk routes passed. The separate
[browser evidence](../../docs/evidence/25-viewer-and-sharing-ui.md) records the
subsequent strict synthetic desktop pixel pass and remaining clinical limits.

The independent Astra review identified six priority recovery defects: a lost
seal response, an unchanged digest after source-generation reset, worker import
before manifest seal, lease expiry during slow transfer, concurrent first
admission with one idempotency key, and an unbounded DICOM file-meta UID read.
The first three affect Ready convergence; the fourth can invalidate a long
upload; the fifth can create duplicate admission ownership; the sixth can
allocate excessive memory on malformed input. The local-service and
cloud/worker owners corrected them. Focused process, SQL, worker and parser
regressions passed, followed by the [fourteen-migration combined proof](../../docs/evidence/26-connected-ingestion.md)
through signed intake, Ready, browser routes, a separate-source compiled
service and fresh-volume restore. PostgreSQL/Orthanc effect atomicity, broad
modality rendering and installed lifecycle still require further proof.

## Verification

Before corrective edits, `CLARITY_VIEWER_PROOF=1 bash
deploy/cloud/scripts/proof.sh` passed one synthetic object through signed
intake, worker-created Ready, staff route authorization and fresh-volume
restore. `pnpm run check`, `pnpm run build` and `pnpm exec turbo run test`
passed for that snapshot. The later `CLARITY_VIEWER_BROWSER_DIAGNOSTIC=1
CLARITY_COMPILED_SYNC_PROOF=1 bash deploy/cloud/scripts/proof.sh` exited 0 with
fourteen migrations, source-offline authenticated viewer routes, a narrow
browser navigation capture and the compiled service reading a separate
Orthanc source. The isolated 14-migration SQL proof and focused 61-test
sync-service, 20-assertion worker and 7-assertion imaging suites passed. Those
checks still do not establish browser pixels, native OS lifecycle or clinic
capacity. The [workspace evidence](../../docs/evidence/01-workspace-checks.md)
records command scope.

## Second advisor pass

A later Astra pass found three further priority gaps. A local `received` upload
whose spool had been removed was skipped indefinitely if the cloud reauthorized
the same SOP under a new fence; the local service now reconciles cloud status,
requests a current authorization and re-spools only the exact source bytes when
needed. A late file could be indexed before the new manifest seal and make an
old scope Ready; migration 0015 adds a durable dirty cutoff. A second new file
while already dirty must also advance the Report CAS so an inventory attempt
opened between admissions cannot seal. The runtime role also held an obsolete
upload-status reconciliation function that could bypass worker validation; the
grant was removed and a role-denial proof added. The isolated 15-migration SQL
proof passed the reverse-order completion, double-admission CAS, excluded-SOP
readmission and runtime denial cases. The final fifteen-migration cloud reruns
passed device-to-Ready, viewer/multipart recovery and separate-source compiled
service activation, each followed by fresh-volume restore and cleanup. The
compiled service suite passed 68 tests. Astra's final read-only pass found no
remaining concrete P0/P1 in these fixes; installed OS lifecycle, true source
completeness and clinical rendering remain open.

## Map review and next step

The affected owners are [source/service](../objects/source-and-service.md),
[Report package](../objects/report-package.md) and
[delivery boundary](../objects/delivery-boundary.md). Keep P3/P4 release boxes
open for their remaining acceptance criteria. The source/service relationship
now names the compiled connected activation; delivery remains policy-blocked
pending OI-06. No production release state is inferred from these synthetic
checks.

## OHIF synthetic pixel follow-up

The shared synthetic DICOM fixture contains an 8×8 four-quadrant MONOCHROME2
ramp and OHIF's documented PixelSpacing and window/rescale tags. The browser
diagnostic samples Chromium's actual canvas screenshot and requires four
spatially ordered grayscale regions, ignoring canvases smaller than 64×64. The
initial mobile-width run failed because the OHIF sidebar left a 16-pixel image
canvas and first-run overlays obscured the viewport. The proof retains 375×812
staff navigation and overflow checks, then reloads the same study at 1280×900,
dismisses the walkthrough and investigational-use notice, and selects the
series thumbnail.

The latest disposable fifteen-migration browser proof exited 0 and cleaned its
stack. At 1280×900 the actual canvas was 858×649; four synthetic quadrant
samples had grayscale luminance [28, 113, 170, 255], passing the strict pixel
assertion. Scoped QIDO/WADO and exact Study authorization remained in force. Two
frame responses were HTTP 200 multipart/related; two additional fetches were
canceled. There was no CORS/blocked reason or visible OHIF error/loading message.
This demonstrates one synthetic unsigned 16-bit MONOCHROME2 desktop render.
OHIF pixel rendering at mobile width, CT variation, MR, non-image DICOM,
compressed transfer syntax/codecs, diagnostic suitability and recovery remain
open. See [viewer evidence](../../docs/evidence/25-viewer-and-sharing-ui.md).

The connected late-arrival proof passed on migration 0015: a second synthetic
SOP admitted after Ready dirtied revision 1, worker indexing completed while
dirty, and a fresh exact two-member revision 2 seal restored Ready. Lease,
revocation and restore cleanup passed. See [late-arrival evidence](../../docs/evidence/32-connected-late-arrival.md).
ICM relationship review is recorded in the Report package card.
