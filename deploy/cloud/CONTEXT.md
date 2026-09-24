# Cloud deployment proof

`compose.yaml` and `scripts/proof.sh` form a disposable synthetic foundation
proof. Run `bash deploy/cloud/scripts/proof.sh` with Docker, curl, Python 3 and
OpenSSL available. It uses generated credentials and a generated synthetic
DICOM file; it does not mount or contact clinic/V1 resources. Host proof ports
bind to `127.0.0.1`; the Docker bridge permits container egress, so this is not
a production network-isolation design. MinIO is an archived upstream emulator
used only to exercise Orthanc S3 integration, not a production storage choice.

The proof covers explicit one-shot Clarity/Hanko migrations, a Clarity runtime
role with narrow staff-table reads and no migration-history access, live Hanko public readiness and effective
v3 cookie settings, Orthanc PostgreSQL index/S3/DICOMweb plugins, synthetic
DICOM byte and QIDO readback, container replacement, database/object backup
restore into new volumes, and disposable-volume cleanup. A live Hanko
registration/login cookie exchange is exercised separately with
`bash deploy/cloud/scripts/proof-hanko-v3.sh`. That flow uses generated
`example.invalid` identities and Mailpit, and checks cookie flags, session
claims, wrong/malformed credential denial, logout/replay denial, fresh-session
issuance and cleanup. The default run does not validate behavior in a real browser or choose
production identity, email, network or storage deployment, and does not establish
full P1.3 acceptance. The optional `HANKO_BROWSER_PROOF=1` run uses local Chrome
and Playwright to prove browser cookie storage and protected-route use across
localhost ports; it does not prove Hanko Elements screens, packaged Electron or
production HTTPS domains. Preserve all V1 cloud resources.

The 23 September connected runs passed with fifteen application migrations, restricted
web/worker/device roles, source-independent Hanko and Orthanc databases, container
replacement, and backup restore into fresh volumes. The separate intake policies
under `minio/` scope the synthetic web uploader and worker to `intake/*` objects;
they do not establish a maintained production object store. The
`compose.application.yaml` overlay now defines container wiring for the web,
worker and separate intake users; `docker compose config --quiet` passed with
synthetic values. `CLARITY_APP_PROOF=1 bash deploy/cloud/scripts/proof.sh` is
the optional container build/liveness and scoped-intake gate. Later
`CLARITY_CONNECTED_PROOF=1`, `CLARITY_COMPILED_SYNC_PROOF=1` and
`CLARITY_VIEWER_PROOF=1` runs passed bounded synthetic ingestion and staff
routes; see [connected evidence](../../docs/evidence/26-connected-ingestion.md)
and [viewer evidence](../../docs/evidence/25-viewer-and-sharing-ui.md). A new
2026-09-24 combined viewer/compiled rerun stopped before startup because Docker
BuildKit could not write its metadata database. These proofs do not establish a
production cloud topology or installed centre service.

`Dockerfile.web` and `Dockerfile.worker` build isolated Node 22 runtime images
from a frozen pnpm workspace install. The web image takes its public Hanko URL
as a build argument because Next.js embeds that value in browser assets. The
worker image deploys only its production package closure. Both are synthetic
runtime artifacts; deployment still needs a final V2 service topology, scoped
secrets and maintained object storage.
