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

- In Chrome, the live disposable Hanko Elements sign-in accepted the generated
  admin identity and redirected to `/staff`. The Studies page showed the connected
  source-offline synthetic `SYNTHETIC^PROOF` Report as Ready. Clicking `Open study`
  navigated to `/staff/studies/<reportId>` and displayed the verified-cloud study
  header.
- The embedded OHIF frame then displayed Chrome's
  `chrome-error://chromewebdata/` message, “This page has been blocked by Chrome.”
  No OHIF toolbar or image pixels loaded. This is a browser integration failure;
  the authenticated HTTP proof of OHIF application HTML does not override it.
- The retained proof log does not contain the iframe's initial HTTP status,
  redirect Location, CSP/X-Frame-Options headers, or asset request statuses. The
  disposable stack and private fixture were removed by cleanup, so the specific
  Chrome block cause is not established. No proxy change is justified from this
  capture alone.
- A narrow viewport could not be set with the available browser controls. No
  narrow-width, keyboard-navigation, loading-state, or viewer-error recovery test
  is claimed. The browser proof's bounded opt-in hold auto-continued into the
  replacement/restore checks and cleanup.

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
new surfaces. The browser interaction verified search-to-study navigation but
failed at embedded OHIF load, so it does not establish actual viewer rendering or
diagnostic suitability. CT and MR variation, non-image DICOM, compressed transfer
syntax/codec behavior, and browser viewer recovery remain open. No real recipient,
patient fixture, or external message was used in the UI checks.

The pinned Orthanc DICOMweb plugin reports that WADO/STOW chunked transfers are
stored in memory because that plugin build targets an older Orthanc SDK. Thus a
small streamed response through this application gateway does not demonstrate
bounded memory at the Orthanc service. Large-study/codec capacity remains open.
