# Viewer compatibility fallbacks

Date: 2026-09-23. This evidence covers a scoped staff-page metadata notice and
synthetic classification checks. It does not establish MR rendering or codec
support.

## Behavior

The authorized staff Study page now requests series and instance metadata through
the existing same-origin DICOMweb gateway, using the exact Study UID from the
Ready Report page. The gateway continues to recheck Hanko staff access and exact
sealed manifest membership. The client bounds inspection to 32 series and 256
instances per series, and cancels requests on unmount or after 15 seconds.
Malformed, empty, timed-out or capped results show an incomplete-inspection
fallback.

The notice identifies MR as unverified in this build, identifies Structured
Report and Encapsulated PDF/CDA objects as non-image content, and directs staff
not to interpret an empty viewport as a negative finding. Non-native transfer
syntax values, if metadata provides them, are labeled codec-unverified. Missing
syntax metadata is shown as unknown with a source-viewer verification fallback.
No unsupported codec is claimed based on UID alone.

This conservative syntax state is necessary because DICOMweb metadata omits file
meta group `0002`, and DICOMweb response transfer syntax defaults to Explicit VR
Little Endian. Orthanc also warned that QIDO cannot include `0002,0010`; the
request was removed. See [DICOM PS3.18 transfer syntax rules](https://dicom.nema.org/medical/dicom/current/output/chtml/part18/sect_8.7.3.4.html).
The non-image UID classification covers the [SOP Class table's SR and
Encapsulated Document families](https://dicom.nema.org/medical/dicom/current/output/chtml/part04/sect_b.5.html).

## Verification and limits

- `pnpm --filter @clarity/web typecheck` passed.
- `pnpm --filter @clarity/web test` passed 7/7 tests. Synthetic metadata cases
  cover MR/unverified, SR/non-image safe fallback, a non-native syntax warning,
  missing syntax metadata, malformed values, and incomplete inspection.
- `python3 -m py_compile deploy/cloud/scripts/prove-ohif-browser.py` passed.
- Authenticated disposable browser attempts observed the new notice with exact
  Study-scoped QIDO responses returning HTTP 200. The notice reported two
  objects whose transfer syntax could not be confirmed. One run reached two
  HTTP 200 `multipart/related` frame responses but the cold OHIF document had
  not completed and the strict pixel check could not sample its canvas. The
  subsequent bounded-wait browser attempt did not start because Docker BuildKit
  returned a metadata database input/output error. The previous strict desktop
  synthetic pixel pass is recorded in [viewer evidence 25](25-viewer-and-sharing-ui.md);
  this compatibility-code snapshot has not passed a new pixel rerun.
- Docker cleanup stopped the five disposable `clarity-v2-proof-71344` services.
  Container removal then failed repeatedly with overlay2 input/output errors.
  No unrelated containers or Docker storage paths were touched.

These checks do not contain a real MR DICOM image, SR object or compressed
pixel-data fixture. The MR and SR cases are synthetic metadata classifications,
not image-render acceptance. The worker currently rejects unsupported source
transfer syntaxes before import; a compatible cloud object exercising an actual
browser codec failure is not proven here. P4.3 modality and codec acceptance
remains open. No clinic data was used.
