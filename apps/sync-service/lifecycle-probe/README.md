# Synthetic compiled lifecycle probe

Run this macOS-only, disposable P0.3 proof from the workspace root:

```sh
pnpm --filter @clarity/sync-service probe:lifecycle
```

The runner compiles a standalone TypeScript ESM probe, stages the exact local
Node 22.20.0 executable and the `better-sqlite3` 13.0.3 macOS arm64 prebuild in
a temporary directory, then launches the staged executable by absolute path.
The staged runtime has no pnpm, Electron, workspace source, or inherited Node
module path. Its heartbeat database retains at most 32 heartbeat rows and 16
startup rows.

The probe creates a random synthetic secret in a mode `0600` file with an
owner ACL. It reads that value only to answer a generated challenge with
HMAC-SHA256. The raw secret is never written to logs or output. All runtime,
database, credential, challenge-response, and plist files are removed at the
end of the run, including failure paths. The runner prints a redacted JSON
summary with runtime hashes, startup/PID/UID values, commit sequences, exit
results, and timings.

The generated system-launchd plist uses a placeholder account and fixed future
data/log paths. `plutil -lint` validates it. The runner never calls `launchctl`
and never registers or installs the plist.

This proof covers foreground startup, bounded SQLite heartbeats, SIGTERM
admission shutdown and database close, forced-kill recovery of committed
sequence, generic bounded missing-credential diagnostics, and launchd plist
syntax. It does not prove service-account access, logout or boot behavior,
installation or registration, Linux or Windows behavior, code signing, or
operation on a designated administrator host. The production `src/main.ts`
remains inactive.
