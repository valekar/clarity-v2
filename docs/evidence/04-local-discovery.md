# Synthetic local discovery foundation

Date: 2026-09-23. Scope: the compiled `apps/sync-service` package contains a
private Orthanc change-feed adapter, bounded inventory/reconciliation logic and
a durable SQLite checkpoint, queue and logical Report index. Its executable
entry still exits with code 78 and does not read a clinic source.

## Verified increment

- `pnpm install --filter @clarity/sync-service --frozen-lockfile --force`
  reconstructed dependencies on this macOS arm64 host; the bundled
  `better-sqlite3` binding loaded and reported SQLite 3.53.4. A subsequent
  workspace `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @clarity/sync-service build`, `typecheck` and `test` passed.
  Twenty-one tests cover bounded change pages, atomic cursor/queue updates,
  reopen/replay deduplication, process death before commit, source identity and
  cursor reset, initial inventory resume, late-event replay, periodic
  same-cursor reconciliation, metadata validation, a four-request cap,
  501-job replay, source queue lease expiry/concurrent processors, stale
  generation rejection and deletion shifting offset pages without a feed event.
- `pnpm check` passed at the final local discovery boundary: docs/line-limit,
  source policy, formatting, lint (zero errors, one unrelated unused-type
  warning) and TypeScript checks. All authored sync files are under 700 lines.

The current source is [the coordinator](../../apps/sync-service/src/discovery/inventory-coordinator.ts),
[queue processor](../../apps/sync-service/src/discovery/queue-processor.ts),
[SQLite discovery store](../../apps/sync-service/src/persistence/discovery-store.ts),
[checkpoint store](../../apps/sync-service/src/persistence/checkpoint-store.ts),
[Orthanc discovery client](../../apps/sync-service/src/orthanc/discovery-client.ts)
and [change adapter](../../apps/sync-service/src/orthanc/change-feed.ts).
Tests use synthetic HTTP fixtures and temporary SQLite files.
The local queue now uses a durable source lease and generation checks when
committing work. Inventory restart uses a fresh pass ID, and completion refuses
stale cursor/generation or outstanding eligible jobs. Only one inventory pass
can be active per source. These are local coordination guarantees; they do not
connect the service executable to a clinic Orthanc.

## Orthanc route compatibility probe

A disposable `orthancteam/orthanc:26.8.2` container (runtime `/system` reported
Orthanc 1.13.0) held two generated 670-byte synthetic DICOM instances in one
study. Its `/studies/{id}/instances?since=0&limit=1` child route returned both
instances for offsets 0, 1 and 2. The global `/instances?since=...&limit=1`
route returned page counts 1, 1 and 0. Inventory therefore pages the global
route and resolves study/series metadata with bounded concurrency. The named
disposable container was removed. This probes one pinned image and small
dataset; it does not establish large-source capacity or all Orthanc versions.
Versioned Orthanc [change types](https://orthanc.uclouvain.be/hg/orthanc/file/Orthanc-1.13.0/OrthancServer/Sources/ServerEnumerations.h)
and [SQLite schema](https://orthanc.uclouvain.be/hg/orthanc/file/Orthanc-1.13.0/OrthancServer/Sources/Database/PrepareDatabase.sql)
show that Deleted events are not durable `/changes` tombstones and resource
deletion can remove earlier change rows. Thus an unchanged cursor does not prove
offset pages stayed stable. The static route probe did not test this hazard.

## Still required for P3.2

The coordinator is callable and resumable but is not connected to the service
entry or an installed periodic scheduler. Its local Reports do not yet reach
cloud admission. A real installed source, high-volume inventory, Linux/Windows
native binding and lifecycle remain untested. The [Orthanc reset proof](03-ingestion-proof.md)
showed cursor 5→0→5 with the same final value; periodic inventory is the
designed backstop. The tested matching-pass detector converges for one synthetic
deletion-without-feed fixture, but does not prove arbitrary mutation safety.
Verified ascending ID-anchor traversal and actual index-backend ordering
compatibility are still needed for authoritative bounded inventory. Series UID
conflict semantics and response-byte bounds also remain. P3.2 stays unchecked
pending those fixes and a running service proof.
