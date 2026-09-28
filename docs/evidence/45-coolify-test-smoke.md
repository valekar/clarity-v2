# Coolify synthetic test smoke

`deploy/cloud/scripts/coolify-smoke.mjs` adds a host-side smoke check for a
running synthetic Coolify deployment. It checks web health, rejects missing
staff authentication, accepts an active Hanko-backed staff session, acquires a
paired source lease, admits one generated CT Study and object, seals its
one-member manifest, then waits for the worker to index it and make the Report
Ready and staff-viewable. It then checks unauthenticated WADO denial and
authenticated WADO readback against the exact generated DICOM bytes. The
manifest digest follows the domain `sealManifest` contract: UID-sorted canonical
member objects serialized with JSON. Run instructions and retained-data behavior are in
[`deploy/cloud/COOLIFY-SMOKE.md`](../../deploy/cloud/COOLIFY-SMOKE.md).

The route names and payloads were checked against the current health,
staff-access, Study admission, upload admission/completion, lease and manifest
handlers. `node --check deploy/cloud/scripts/coolify-smoke.mjs` passed. The
script was not run against a hosted Coolify deployment; that check remains
pending a dedicated test deployment and its synthetic staff/device credentials.
Each successful run leaves one synthetic Report in the test deployment for
review and approved retention handling.
