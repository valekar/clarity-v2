# Local sync service entry

The compiled entry refuses to claim synchronization is active; it exits with
code 78 and a setup message. The service now has a private Orthanc change-feed
adapter and a durable SQLite checkpoint/queue foundation. Synthetic HTTP and
process-crash tests cover bounded pages, idempotent replay, persisted attempts,
source generations, cursor reset replay and rollback of an uncommitted
checkpoint/job transaction. The capture loop is not connected to the service
entry and does not access a clinic source.

SQLite uses pinned `better-sqlite3` 13.0.3 because Node 22's built-in SQLite
module is still marked active development. The native package ships macOS,
Linux and Windows prebuilds. pnpm is configured to skip its inferred native
build hook because the package has no install script and already carries those
prebuilds; a fresh filtered frozen install is the acceptance check for this
choice. This does not prove that compiling from source works. Linux CI has not
yet been verified. The future OS-managed process will own pairing, polling,
durable recovery and private uploads. Real install/logout/recovery evidence
remains P0/P5.

Synthetic inventory route probe: disposable `orthancteam/orthanc:26.8.2`
(runtime `/system` reported Orthanc 1.13.0), bound only to localhost and
loaded with two generated 670-byte synthetic DICOM instances in one study.
`/studies/{id}/instances?since=0&limit=1`, then `since=1`, then `since=2`
returned both instances on all three requests; the child route ignores those
parameters and is not safe for bounded inventory. The global
`/instances?since=0&limit=1`, `since=1`, and `since=2` requests returned
distinct page counts `1, 1, 0`, confirming bounded global pagination on this
image. The TypeScript inventory adapter uses that global route, resolves each
instance's series and study metadata with a concurrency cap of four, and groups
persisted instances by normalized StudyInstanceUID. This is one local synthetic
compatibility probe, not a claim about every Orthanc version or large-source
capacity. The named disposable container was removed after the probe.
