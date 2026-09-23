# Local spool and synchronization loop proof

Date: 2026-09-23. Scope: synthetic local portions of P3.2/P3.3. The
[SQLite spool store](../../apps/sync-service/src/persistence/upload-spool-store.ts),
[source spooling](../../apps/sync-service/src/transfers/spool-instance.ts),
[device upload client](../../apps/sync-service/src/transfers/ingestion-client.ts)
and [injected sync loop](../../apps/sync-service/src/runtime/sync-loop.ts) are
compiled TypeScript. `pnpm --filter @clarity/sync-service test` first passed 45 tests;
the follow-up source identity work passed 47/47,
including build and test compilation. Source policy, compiled external import
and documentation checks also passed after this work.

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
The sync-service suite passed 61/61 after these additions.

This process proof uses local fixture servers, not the disposable Docker cloud
API, object store and worker together. It does not establish an installed OS
service, protected credential storage or automated discovery-to-staff-view in
one stack. P3.2 and P3.3 remain open for those connected and centre-scale
acceptance items; no clinic source, cloud account or real patient data was used.
