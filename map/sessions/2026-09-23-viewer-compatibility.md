---
id: viewer-compatibility-2026-09-23
type: session
title: Add safe viewer compatibility states
universe: live
status: verified
updated: 2026-09-23
revision: scoped-viewer-compatibility-notice-2026-09-23
---

# Add safe viewer compatibility states

## Request and result

The bounded task was to make MR, non-image DICOM and unverified compressed
transfer syntax states actionable in the authenticated staff viewer. The Study
page now checks exact scoped series and instance QIDO metadata and shows an
accessible compatibility status. MR is called unverified, known Structured
Report/Encapsulated Document objects receive a no-image warning and source-viewer
fallback, and transfer syntax is marked unknown or unverified without claiming
codec support. Empty, malformed, capped or timed-out inspection also warns staff
not to treat a blank viewport as a negative finding. Details are in
[compatibility evidence](../../docs/evidence/34-viewer-compatibility-fallbacks.md).

## Verification

Web typecheck passed; all seven web tests passed. Python syntax for the browser
diagnostic passed. A disposable authenticated browser run confirmed exact
scoped QIDO and the notice text but did not establish new pixels: OHIF's cold
document remained loading. A bounded browser rerun could not start because
Docker BuildKit and overlay2 returned input/output errors. The five disposable
services were stopped; Docker could not remove their container filesystems.
The prior desktop pixel pass remains recorded separately in
[viewer evidence 25](../../docs/evidence/25-viewer-and-sharing-ui.md).

No real MR image, SR object or compressed pixel-data fixture was rendered. The
synthetic MR/SR cases verify classification and fallback text only; actual MR,
non-image and codec interoperability remain open.

## Map review and next step

Updated [Report package](../objects/report-package.md) to record scoped
compatibility metadata and the remaining modality/codec limits. Root owns plan,
ACTIVE and generated map catalog closeout. No clinic data or gateway auth changes
were made.
