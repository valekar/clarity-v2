---
id: idempotent-admission-restart-2026-09-24
type: session
title: Recover synthetic cloud admission after service crash
universe: live
status: verified
updated: 2026-09-24
revision: local-cloud-admission-response-loss-2026-09-24
---

# Recover synthetic cloud admission after service crash

## Request and result

The task was to advance P3.4's duplicate/restart admission proof using local
synthetic services. The compiled sync-service test now lets the cloud fixture
commit one stable upload admission and withhold its response, then SIGKILLs the
service before SQLite records the upload ID. Before restart, SQLite retains the
same spooled bytes and has no upload ID. After restart, the service retries the
same stable admission key, reuses one cloud upload ID, performs one signed PUT,
and addresses the same logical Study.

This exposed a persisted local queue lease that blocked immediate restart for
up to 60 seconds after SIGKILL. The normal service entry now clears only the
configured source's local queue lease after it acquires the exclusive singleton
service lock. The test also starts a duplicate compiled process while the
owner holds that lock and confirms its failed startup cannot clear a synthetic
active queue lease. Spool files and cloud lease/fence state are preserved.

## Verification

- `pnpm --filter @clarity/sync-service build` passed.
- `pnpm exec tsc -p apps/sync-service/tsconfig.test.json` passed.
- The focused compiled service-process test passed 1/1 after exercising the
  admission response-loss crash, restart, same-key retry and duplicate-process
  lock boundary.

This proves only the local loopback synthetic boundary. It does not prove the
connected Docker crash path or a native installed-service restart.

## Map review and next step

Updated the [source/service owner](../objects/source-and-service.md) and
[compiled crash evidence](../../docs/evidence/33-compiled-sync-crash-recovery.md).
The broader P3.4 acceptance gate remains open for connected duplicate/restart
cases and native service acceptance.
