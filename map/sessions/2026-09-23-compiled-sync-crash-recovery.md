---
id: compiled-sync-crash-recovery-2026-09-23
type: session
title: Expand compiled sync crash recovery boundaries
universe: live
status: verified
updated: 2026-09-24
revision: p3-2-post-import-crash-proof-2026-09-24
---

# Expand compiled sync crash recovery boundaries

## Request and result

The existing separate-source proof SIGKILLs the compiled entry after a durable
SQLite spool and checks its crash-time cloud admission boundary. This change
adds a second boundary after a completed cloud upload, the local `received`
checkpoint, and exact Orthanc byte readback. After confirming SIGKILL, the
harness captures the local source checkpoint timestamp and requires it to
advance after restart before it accepts cloud Ready, so an already-Ready cloud
row cannot stand in for restart progress. It then requires the single completed
upload and Orthanc instance to remain unchanged. Source changes are in
[`prove-compiled-sync-service.mjs`](../../deploy/cloud/scripts/prove-compiled-sync-service.mjs);
acceptance and the unverified connected run are recorded in
[`33-compiled-sync-crash-recovery.md`](../../docs/evidence/33-compiled-sync-crash-recovery.md).

## Verification

The post-import and fresh source-poll assertions are harness coverage only until
a connected run exercises them. The checkpoint baseline is sampled after the
prior process has exited from SIGKILL. The source checkpoint timestamp is
persisted by the change-feed page capture path. Docker BuildKit and overlay I/O
errors block the disposable Compose proof.
No connected crash/import behavior is claimed as verified by this update. The
pre-existing local compiled-process results are recorded in the evidence card;
local checks for this update are recorded with the agent session result.

## Map review and next step

Reviewed the [source/service owner](../objects/source-and-service.md),
compiled entry and local spool store. Runtime relationship facts have not been
updated because connected crash verification remains outstanding; the service
remains ghost/stub. ICM reviewed; no runtime map change. After Docker recovery,
rerun the opt-in compiled proof, capture the crash boundary result, and update
the canonical source/service owner and plan from evidence.
