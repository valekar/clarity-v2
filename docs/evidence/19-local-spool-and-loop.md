# Local spool and synchronization loop proof

Date: 2026-09-23. Scope: synthetic local portions of P3.2/P3.3. The
[SQLite spool store](../../apps/sync-service/src/persistence/upload-spool-store.ts),
[source spooling](../../apps/sync-service/src/transfers/spool-instance.ts),
[device upload client](../../apps/sync-service/src/transfers/ingestion-client.ts)
and [injected sync loop](../../apps/sync-service/src/runtime/sync-loop.ts) are
compiled TypeScript. The current sync-service suite passes 68/68, including
production/test TypeScript compilation. The run used
`node_modules/.bin/tsc -p apps/sync-service/tsconfig.json`,
`node_modules/.bin/tsc -p apps/sync-service/tsconfig.test.json`, and
`node --test apps/sync-service/test-dist/test/*.test.js`. Source policy and
targeted Prettier checks also pass.

The local path streams one private Orthanc instance into a restrictive spool
file, persists SHA-256/byte count and per-part ETag/hash receipts in SQLite,
and uses a restart-stable UUIDv5 admission key. It rechecks source and spool
bytes before admission, rejects a capacity reserve breach before and during
spooling, handles expired signed URLs, and reconciles lost part or completion
responses after reopening the database. Startup cleanup removes only
untracked private spool artifacts. Old local-generation spools are rebound
only when no cloud upload was admitted and source identity/bytes still match;
other stale rows persist a `needs-attention` reason. The client accepts only
the `ClarityDevice` authorization scheme. The injected loop advances initial
inventory, change replay, bounded upload batches and incomplete periodic
reconciliation on subsequent polls.
The follow-up normalized Orthanc `IssuerOfPatientID` into the SQLite Report
observation and shared Study admission DTO. A full new source snapshot clears
missing patient fields, including a removed name for the same ID and fields
from a changed ID/issuer, so local metadata cannot mix two patient identities.

The normal [service entry](../../apps/sync-service/src/main.ts) now wires the
private Orthanc adapter, durable SQLite store, paired-device cloud client and
graceful shutdown. A [compiled child-process test](../../apps/sync-service/test/compiled-service-process.test.ts)
served synthetic Orthanc and cloud HTTP fixtures, observed one discovery,
signed PUT, completion and manifest seal, then sent SIGTERM. A second compiled
process reopened the same SQLite database without another PUT, completion or
manifest seal. A follow-up deliberately committed
the cloud manifest seal while dropping its HTTP response, stopped the first
process, and restarted the compiled service. The restart matched the cloud's
current manifest revision, digest and cloud generation against the durable
local attempt, reconciled the lost response, and did not upload or seal again.
The process proof also verified SQLite reopen and SIGTERM shutdown.
[Singleton-lock tests](../../apps/sync-service/test/service-lock.test.ts)
use a dedicated SQLite `BEGIN EXCLUSIVE` lock file; they cover duplicate live
process denial, simultaneous acquisition, and lock release after killing its
owner. Local manifest recovery tests cover a source
inventory-generation reset with unchanged bytes; the service retains the
separate cloud generation used for fencing and reseals when either proof
generation or local inventory generation changed. A slow synthetic PUT test
simulated a lease takeover during transfer: renewal with a changed generation
or fence aborted the transfer, and the client did not adopt the new ownership.
The sync-service suite passed 68/68 after these additions.

Received rows without a spool are now reconciled by posting their stable
admission under a freshly acquired cloud fence. A still-authorized `received`
upload remains pending without rereading Orthanc; `completed` is cached for the
current process. If the cloud returns a replacement upload session, the service
re-spools only after matching Study/Series/SOP identity, byte count and SHA-256.
A missing source or changed bytes becomes durable `needs-attention`. The
regression closes and reopens SQLite, recreates the client/lease, verifies a
replacement signed upload, and exercises the orchestration through
`SyncLoop.runOnce()`.

The normal entry also accepts `--config <absolute-path>` for installer-managed
JSON configuration. The file is bounded to 16 KiB, must be a regular
non-symlink, rejects unknown keys and non-string values, and on macOS must have
owner-only permissions. Existing environment-only launches remain supported.
Focused tests reject relative paths, links, oversized files, broad macOS modes
and malformed keys without exposing credential text. The unsigned macOS release
smoke launched the compiled package with missing and malformed config paths;
both exited 78 before service startup. Windows ACL enforcement remains a native
acceptance item.

The process recovery tests above use local fixture servers. A separate
[fifteen-migration combined proof](26-connected-ingestion.md) then used the
compiled service entry against a disposable source Orthanc and the V2 cloud
web, signed intake, worker and Orthanc. One new source Study reached Ready
without manual intake; cloud byte readback matched the source. This establishes
one-object activation, but does not test restart/crash recovery across that
same Docker path. A separate [connected multipart recovery proof](26-connected-ingestion.md)
used the compiled local `InstanceUploader` and SQLite spool with a 67,108,865-byte
synthetic transfer fixture against the disposable cloud APIs and MinIO. A
correctly signed but expired URL was rejected; then MinIO accepted part 1 while
the fixture dropped the successful response. Before restart SQLite had no part
receipt. Reopening SQLite retained the same upload ID, retried the accepted
part idempotently, uploaded all three parts, and reached cloud `received` after
server-side size and SHA-256 verification. This fixture was synthetic opaque
transfer data, not a parseable DICOM. Its assertions stop at verified intake
status; worker outcome is outside this fixture's acceptance. P3.2 and P3.3
remain open for their broader source, capacity and
installed-service acceptance; no clinic source, cloud account or real patient
data was used.
