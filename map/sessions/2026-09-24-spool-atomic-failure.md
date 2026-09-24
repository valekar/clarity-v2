---
id: spool-atomic-failure-2026-09-24
type: session
title: Prove spool write and rename recovery after injected failures
universe: live
status: verified
updated: 2026-09-24
revision: p3-3-atomic-spool-retry-2026-09-24
---

# Prove spool write and rename recovery after injected failures

## Request and result

Added narrow `writeChunk` and `renameFile` injection seams to source spooling.
Spool writes now validate the returned byte count and cancel the Orthanc stream
on write/rename failure before cleanup. The new
[atomic failure proof](../../docs/evidence/40-spool-atomic-recovery.md) forces
ENOSPC after a real partial write, fails rename after sync, and rejects an
invalid writer byte count. Each case checks no partial/final artifact and no
SQLite upload row, reopens the database, retries exact source bytes and verifies
the one durable successful row/file.

## Verification

Sync-service build and test TypeScript compilation passed. The focused upload
transfer plus atomic failure tests passed 19/19. Prettier, source-policy and
diff checks passed. Failures are injected through local I/O hooks; native
filesystem ENOSPC and installed-service behavior remain unverified.

## Map review and next step

Updated the [source/service owner](../objects/source-and-service.md) to link
this synthetic recovery evidence. Its runtime remains ghost/stub. Run a native
constrained-volume proof on installed macOS and Windows service identities,
including restart and recovery after the volume returns writable.
