# Viewer and sharing UI increment evidence

Date: 2026-09-23. This is an implementation and focused-test record for the
current P4.3/P4.4 and P6.2 UI increment. It does not close those plan items.

## Staff studies and doctor surfaces

- `/staff` provides authenticated, keyset-paginated study search, shows a verified
  cloud-view status only when the current sealed membership proof is complete,
  and links to the scoped study page and sharing preview.
- `/staff/doctors` checks active staff access on render and reads/creates directory
  entries through `/api/doctors`. Search is capped at 20. Shared-phone matches
  require an explicit confirmation; inactive exact matches are not reused.
- `/staff/sharing` checks active staff access and loads only the existing doctor
  directory API. Its test-only patient mobile is manually entered. The preview is
  generic and contains no study details. Copy copies generic preview text only.
  QR is unavailable because no verified expiring link exists, and Send remains
  disabled until recipient policy and dispatch backend are ready.
- Studies, Doctors and Settings share a compact labelled navigation. The sharing
  preview is reachable from Studies and is not presented as a current report send.

## Scoped viewer implementation

- The server gateway rechecks active Hanko staff membership for each OHIF and
  DICOMweb request, requires a Ready Report with current sealed, indexed manifest
  membership, and does not require the source Orthanc to be online for cloud reads.
- QIDO metadata is requested as DICOM JSON, bounded, filtered against exact
  manifest members, and returned `private, no-store`. Unexpected non-JSON metadata
  content is rejected. BulkDataURI values are rewritten to same-origin gateway
  routes, which recheck membership before proxying. WADO bodies are streamed.
  The WADO default Accept uses the DICOM PS3.18 WADO-RS `multipart/related` form
  with `type="application/dicom"` ([current standard section](https://dicom.nema.org/medical/dicom/2026a/output/chtml/part02/sect_N.5.3.2.2.html)).
- OHIF is proxied on the staff origin and requires the requested Study UID to
  resolve to an authorized Ready Report. The synthetic cloud Orthanc config loads
  its OHIF plugin alongside DICOMweb. The official [Orthanc OHIF plugin
  configuration](https://orthanc.uclouvain.be/hg/orthanc-ohif/file/tip/Sources/app-config-system.js)
  uses relative `../dicom-web` roots for QIDO/WADO, matching this same-origin
  gateway path. The integration proof verifies the authenticated OHIF route returns
  the configured application HTML. It does not exercise the actual browser viewer
  request sequence or clinical rendering.

## Connected synthetic cloud proof

- `CLARITY_VIEWER_PROOF=1 bash deploy/cloud/scripts/proof.sh` exited 0. Its connected
  ingestion harness created a synthetic sealed/indexed Ready Report from the device
  route and worker, confirmed Orthanc readback, disabled the source, and wrote a
  private fixture for the viewer assertions. The viewer proof then passed source-
  offline Ready search, exact Study and instance QIDO, authorized WADO and BulkData
  reads, unrelated Study UID denial, and authenticated OHIF HTML route. Metadata
  responses were checked as non-cacheable. The same combined proof reported that
  restored database/object bytes matched the originals.
- Two provider-issued synthetic Hanko identities were used for the authenticated
  web flow. The proof exercised pending review, explicit admin grant, staff API
  access, membership disablement taking effect on the next request, Hanko logout
  replay denial, and OHIF denial after session revocation. No real patient or
  recipient was used.
- The proof establishes route authorization and small synthetic transport/readback.
  It does not establish diagnostic rendering, broad modality support, or bounded
  Orthanc memory use.

## Browser UI check

- `CLARITY_VIEWER_BROWSER_DIAGNOSTIC=1 CLARITY_COMPILED_SYNC_PROOF=1 bash
deploy/cloud/scripts/proof.sh` exited 0 through migration, Hanko, connected
  ingestion, browser diagnostic, separate-source compiled service-to-Ready,
  replacement and restore checks. The authenticated Study search and link to
  `/staff/studies/<reportId>` passed with the source-offline synthetic Report
  shown as Ready.
- The combined viewer and multipart disposable proof exited 0. Chromium at
  375×812 reported visible Studies/Doctors/Settings navigation, no horizontal
  overflow, successful study search/open, and iframe/top-level OHIF HTTP 200.
  That earlier diagnostic observed the OHIF application root and one canvas; scoped
  study and series QIDO requests returned HTTP 200. It also observed a second
  `/studies` query without a Study UID and returned HTTP 400. That denial is
  expected: the gateway requires an explicit authorized Study UID and does not
  expose an unscoped Orthanc worklist. The sanitized request record classified
  the extra parameter only as `other_key`/`other`; its name/value were not
  emitted. The observed QIDO status summary was four HTTP 200 responses and one
  HTTP 400 across five same-origin DICOMweb responses.
- Comparing the gateway parser with the official
  [OHIF QIDO implementation](https://docs.ohif.org/coverage/extensions/default/src/dicomwebdatasource/qido.js)
  suggests the QIDO compatibility gap: OHIF forms comma-separated include-field
  tag lists and calls nested series and instance routes. The previous gateway
  parser rejected comma-separated tag lists and query parameters on nested
  routes. The updated browser proof confirmed the scoped study and series QIDO
  paths with comma-separated 8-hex include tags, and the focused regression
  covers those forms plus manifest filtering and unscoped-query denial. The safe
  query collector emitted names from a fixed allowlist or `other_key`, with
  value-shape enums only.
- A synthetic frame Fetch failed once while a request in the same route
  class returned HTTP 200. Chromium reported neither a blocked reason nor a CORS
  error. The available summary cannot distinguish cancellation from another
  fetch failure, so frame retry/recovery remains open.

## Synthetic pixel assertion follow-up

- The shared proof DICOM is now an 8×8 unsigned 16-bit MONOCHROME2 synthetic
  image. Its quadrants contain ascending values 0, 21845, 43690 and 65535.
  In response to the [OHIF 3.11 technical FAQ](https://docs.ohif.org/3.11/faq/technical/),
  it also carries mandatory `PixelSpacing=1\\1` and the FAQ's rendering tags:
  `WindowCenter=32768`, `WindowWidth=65536`, `RescaleSlope=1` and
  `RescaleIntercept=0`. `InstanceNumber=1` is present for sorting. Image position
  and orientation were not added because the FAQ lists them for MPR, which this
  single-image proof does not exercise.
  The browser diagnostic captures Chromium's actual canvas screenshot, decodes
  its PNG pixels and requires four spatial samples to be grayscale and strictly
  ascending with visible contrast. It ignores canvases smaller than 64×64 so
  small UI canvases cannot satisfy the image assertion.
- An initial strict run failed because the mobile OHIF sidebar left its main
  canvas 16 pixels wide; a synthetic-only screenshot showed the pattern in the
  series thumbnail behind OHIF's first-run walkthrough and investigational-use
  notice. The diagnostic now keeps the staff search/study checks at 375×812,
  reloads the same report at 1280×900, dismisses both notices and clicks the
  series thumbnail before sampling.
- The latest full `CLARITY_VIEWER_BROWSER_DIAGNOSTIC=1 bash
  deploy/cloud/scripts/proof.sh` run exited 0 on the fifteen-migration schema
  and cleaned its disposable stack. The source-offline synthetic Ready study
  passed authenticated search, exact scoped QIDO and WADO checks. At 1280×900,
  after the three UI actions, OHIF's canvas was 858×649 pixels (CSS 857×648).
  Chromium screenshot samples from the four synthetic quadrants were grayscale
  luminance [28, 113, 170, 255] in ascending order, so the strict four-region
  contrast assertion passed. The mobile staff page remained 375×812 with visible
  navigation and no horizontal overflow; the OHIF viewer itself was evaluated
  at the wide viewport, not at mobile width.
- The final run recorded six same-origin DICOMweb responses: five HTTP 200 and
  one HTTP 400 for the intentionally unscoped worklist query. Two frame
  responses returned HTTP 200 with `multipart/related`; two additional frame
  Fetches were canceled as `net::ERR_ABORTED`. Chromium reported no CORS or
  blocked reason. Category-only console output included `not_found`, `other`
  (three events) and `dicom_runtime`; the visible-text checks found no error,
  loading, no-image or retry message. The successful run needed no failure
  screenshot. Exact Study scope and gateway authorization were unchanged.

This proves one tiny synthetic unsigned 16-bit MONOCHROME2 pixel pattern through
the browser rendering path. It does not establish CT variation, MR, non-image
DICOM, compressed transfer syntax/codec support, diagnostic suitability, or
OHIF layout at mobile width. These remain P4.3 acceptance work. No clinic data
was used.

This is not evidence of CT/MR variation, compressed transfer syntax or codec
breadth, non-image DICOM support, diagnostic suitability, keyboard interaction,
or loading/error recovery. No clinic data was used.

## Checks

- `pnpm --filter @clarity/server test` passed 30/30 tests, including session
  rejection, nonmember SOP denial, exact QIDO filtering, unexpected metadata
  content-type rejection, BulkDataURI rewriting, streamed WADO, source-offline
  cloud lookup semantics, and OHIF study authorization.
- `pnpm --filter @clarity/web typecheck` passed.
- `pnpm --filter @clarity/web test` passed 2/2 tests.
- `pnpm --filter @clarity/web build` passed and included `/staff/doctors`,
  `/staff/sharing`, `/staff/studies/[reportId]`, `/dicom-web/[...path]`, and
  `/ohif/[[...path]]` as dynamic routes.
- `prove-staff-web.py` accepts a private connected viewer-fixture JSON and tests
  authenticated Study/instance QIDO, WADO, BulkDataURI, OHIF, unrelated-UID denial,
  membership-disable denial, and Hanko-session revocation. Python syntax and CLI
  usage checks passed.

No manual screen-reader or narrow responsive-viewport session was run for these
new surfaces. The browser interaction verified search-to-study navigation and
an OHIF iframe HTTP navigation at a narrow viewport, but did not establish
actual viewer rendering or diagnostic suitability. CT and MR variation, non-image DICOM, compressed transfer
syntax/codec behavior, and browser viewer recovery remain open. No real recipient,
patient fixture, or external message was used in the UI checks.

The pinned Orthanc DICOMweb plugin reports that WADO/STOW chunked transfers are
stored in memory because that plugin build targets an older Orthanc SDK. Thus a
small streamed response through this application gateway does not demonstrate
bounded memory at the Orthanc service. Large-study/codec capacity remains open.
