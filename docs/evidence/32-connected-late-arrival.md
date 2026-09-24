# Connected synthetic late-arrival proof

Date: 2026-09-23. The [connected cloud harness](../../deploy/cloud/scripts/prove-connected-ingestion.mjs)
now exercises a second CT SOP after a one-file Report reaches Ready on manifest
revision 1. The [fixture generator](../../deploy/cloud/scripts/make-synthetic-dicom.py)
accepts a synthetic instance suffix so the later object shares the original
Study and Series while retaining a distinct SOP UID and byte digest.

`CLARITY_CONNECTED_PROOF=1 bash deploy/cloud/scripts/proof.sh` passed on a
disposable V2 stack with migrations 0001–0015. The connected flag now starts
the application overlay as its required dependency. The harness observed:

1. Initial generated DICOM was admitted, uploaded through a signed PUT,
   verified, imported by the running worker and Ready under sealed revision 1.
2. Admitting the later SOP immediately changed the Report to
   `processing|manifest_dirty=true|revision=1`.
3. Signed upload completion and worker import indexed the later file while the
   Report stayed `processing|manifest_dirty=true`. This covers the risky order
   in which cloud indexing finishes before a fresh source inventory seal.
4. A fresh exact two-member manifest was paged and sealed as revision 2; the
   Report returned to `ready|manifest_dirty=false|revision=2`.
5. Existing connected checks still passed: Orthanc UID/byte readback for the
   original SOP, device lease takeover/revocation denial, source-offline Ready
   snapshot, replacement persistence and fresh-volume restore. The proof trap
   removed its disposable containers, networks and volumes.

This is a generated two-instance cloud journey, not evidence that a real centre
discovers all late files or that quiet means inventory complete. It does not
exercise a process crash within the second-instance interval, CT/MR/nonimage
viewer breadth or installed-device behavior. P4.2 remains open for those gates.
