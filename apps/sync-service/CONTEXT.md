# Local sync service entry

The compiled entry runs the local sync loop when supplied a valid private
configuration. It owns the exclusive service lock, SQLite checkpoint and
upload queue, Orthanc change-feed and inventory adapters, private spool, and
cloud ingestion client. Synthetic process tests exercise discovery, upload,
sealing, restart recovery, and crash recovery; see
[`src/main.ts`](src/main.ts), [`src/runtime/config-file.ts`](src/runtime/config-file.ts),
and [`test/compiled-service-process.test.ts`](test/compiled-service-process.test.ts).
This proves the synthetic process path only; it does not prove installation or
operation against a real centre source.

The private config supports a five-minute default polling interval and whole
minute values from 5 to 60. The five-second interval is restricted to an
explicit synthetic proof with both endpoints on loopback. `--write-config`
accepts a bounded JSON settings patch on stdin, preserves other allowlisted
service values, and replaces a per-user private config atomically with mode 0600. The Electron synthetic demo can restart its same-user service process to
apply changes. This CLI is not a privileged production launchd installer.
Between source polls, the loop reports the last observed health at a bounded
60-second interval. These idle reports keep cloud status and its four-minute
source lease fresh; they do not fetch Orthanc or advance an inventory cursor.
`sourceReachable` retains the last source-poll observation until a later poll
updates it.

SQLite uses pinned `better-sqlite3` 13.0.3 because Node 22's built-in SQLite
module is still marked active development. The native package ships macOS,
Linux and Windows prebuilds. pnpm is configured to skip its inferred native
build hook because the package has no install script and already carries those
prebuilds; a fresh filtered frozen install is the acceptance check for this
choice. This does not prove that compiling from source works. Linux CI has not
yet been verified. Production OS-managed installation, service-account
ownership, pairing, and real-source restart/logout/recovery evidence remain
P0/P5.

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
