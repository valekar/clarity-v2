---
id: docker-storage-blocker-2026-09-23
type: session
title: Record disposable proof storage failure
universe: live
status: verified
updated: 2026-09-23
revision: docker-overlay-io-2026-09-23
---

# Record disposable proof storage failure

## Request and result

During a synthetic viewer rerun, Docker BuildKit returned a metadata database
input/output error before the web image was committed. The host data volume was
at 100% with roughly 265 MiB free. Removing generated V2 scaffold dependencies
and workspace build caches, then pruning the pnpm store, raised free space to
about 1.5 GiB. Five containers from the failed `clarity-v2-proof-71344` project
were stopped. Targeted non-force removal still failed with overlay2 `unlinkat`
input/output errors. Unrelated running containers and Docker storage paths were
left untouched.

## Verification

`df -h` recorded the storage pressure and recovered free space. Targeted
`docker stop` succeeded for the five proof services; targeted `docker rm`
failed again after space recovery. The [viewer compatibility evidence](../../docs/evidence/34-viewer-compatibility-fallbacks.md)
and [compiled crash evidence](../../docs/evidence/33-compiled-sync-crash-recovery.md)
separate passing local checks from connected acceptance not rerun on this
unhealthy Docker daemon. An earlier strict synthetic pixel and connected
late-arrival proof passed before the storage failure.

## Map review and next step

ICM reviewed; no runtime relationship changed. Recover Docker Desktop storage
with the machine operator while preserving unrelated workloads, then remove
the stopped proof containers and rerun the two opt-in connected proofs with
captured exit status and cleanup. Do not relabel their new acceptance as passed
from the earlier snapshot.
