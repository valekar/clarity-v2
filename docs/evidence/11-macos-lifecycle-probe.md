# Disposable macOS service-process lifecycle probe

Date: 2026-09-23. The separate
[probe runner](../../apps/sync-service/lifecycle-probe/run.mjs) compiled
[TypeScript ESM](../../apps/sync-service/lifecycle-probe/src/probe.ts), staged
the exact local Node v22.20.0 executable and `better-sqlite3` 13.0.3 native
binding in a temporary self-contained runtime, then launched through absolute
paths with no system Node/pnpm/Electron/source checkout in the child environment.
The normal sync-service entry remains inactive.

On macOS arm64, the copied Node executable was 111,332,720 bytes with SHA-256
`49161ba4e67afda85c25b2daa1f0e91d1bffc023d2dbc4886eda7a9ba38bca62`.
The `darwin-arm64` SQLite binding was 1,980,736 bytes with SHA-256
`98e0e8acd01c632fe5615243e1296af0372826f8783b18fc31c506f73c47459c`.
The foreground process reported UID 501. It committed a durable heartbeat,
handled SIGTERM by closing admission and SQLite, and left the sequence stable
after exit. After SIGKILL at sequence 2, a fresh process reopened the database
and committed sequence 3 under a new startup ID.

A generated synthetic credential was mode 0600 with a user ACL; the challenge
response matched without printing its raw secret. Missing credential exited 78,
printed a 23-byte generic diagnostic and did not create a database. A generated
launchd plist passed `plutil -lint` and its argument vector passed the probe's
parser. It was **not registered**. An injected failure stopped the spawned child
and removed the temporary runtime. `pnpm check` passed after this increment:
78 Markdown files, 378 local links, 12 map cards, 19 requirements, four parsed
Mermaid diagrams, source policy/line limit, formatting and TypeScript. Lint had
zero errors and one unrelated unused-type warning.

This proves a compiled foreground process, local SQLite crash recovery and a
syntactically valid proposed plist on this Mac. It does not prove installation,
launchd restart, a dedicated service UID, cross-user credential denial,
logout/boot/sleep continuity, Windows behavior, signing or notarization. P0.3
and P5 remain open pending designated-host and platform tests.
