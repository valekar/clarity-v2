---
id: received-recovery-and-config-2026-09-23
type: session
title: Recover fenced receipts and support private service config
universe: live
status: verified
updated: 2026-09-23
revision: sync-recovery-config-68-tests-2026-09-23
---

# Recover fenced receipts and support private service config

## Request and result

The task was to close the local P3.3 restart gap where SQLite retained a
`received` row without a spool after a cloud lease/fence changed, and add the
installer-facing `--config <absolute-path>` contract without installing a
service. The sync loop now reconciles through upload admission under the current
cloud lease. A still-authorized receipt stays pending without reading Orthanc;
a completed object is treated as durable. When admission returns a replacement
session, the service re-spools only after matching Study/Series/SOP identity,
byte count and SHA-256. It can accept a changed Orthanc locator when UIDs and
bytes still match. Missing or changed source data is persisted as
`needs-attention`, and no upload bytes are sent.

The production entry now reads a bounded private JSON file from `--config`.
Environment-only launches remain supported. The JSON allows the eight named
`CLARITY_*` settings, requires string values, rejects unknown keys, limits the
file to 16 KiB and rejects nonregular files and symlinks. macOS additionally
requires owner-only access. No OS service was installed or registered.

## Verification

- Production and test TypeScript compilation passed with
  `node_modules/.bin/tsc -p apps/sync-service/tsconfig.json` and
  `node_modules/.bin/tsc -p apps/sync-service/tsconfig.test.json`.
- The compiled sync-service suite passed 68/68 with
  `node --test apps/sync-service/test-dist/test/*.test.js`. The new regressions
  cover SQLite reopen and a recreated lease client, current-fence `received`,
  completed, replacement upload, changed/missing bytes, changed locator with
  identical bytes, and a `SyncLoop.runOnce()` pass over a durable received row.
- `node --experimental-strip-types scripts/check-source-policy.ts` and targeted
  Prettier checks passed; authored recovery/test files remain under 700 lines.
- The isolated unsigned macOS package smoke passed. Missing and malformed
  `--config` paths exited 78 before service startup. Windows ACL enforcement,
  signing, registration and native service execution remain open.
- The latest fifteen-migration disposable cloud run passed separate synthetic
  source Orthanc discovery through the compiled service to cloud Ready, exact
  UID/SHA-256 byte readback, SIGTERM exit and fresh-volume restore. See
  [connected evidence](../../docs/evidence/26-connected-ingestion.md) and
  [local spool evidence](../../docs/evidence/19-local-spool-and-loop.md).

## Map review and next step

Updated [private source/service](../objects/source-and-service.md) and local
transfer/connected proof evidence. No new relationship card was needed: cloud
pairing and manifest ownership remain as recorded. Runtime remains synthetic;
P3.2/P3.3 broader source and capacity acceptance, protected credential storage,
clinical validation and installed-service platform evidence are still open.
