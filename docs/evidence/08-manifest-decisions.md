# Pure manifest and readiness decisions

Date: 2026-09-23. The [domain package](../../libs/domain/src/index.ts) has
browser-safe, deterministic decisions for bounded draft members, exact inventory
comparison, compare-and-swap revision sealing, verified/indexed readiness and
late-instance reopening. It does no persistence, network access or DICOM byte
handling. A caller supplies SHA-256 for the canonical sorted manifest JSON and
establishes source stability plus complete inventory at seal time.

`pnpm --filter @clarity/domain test`, typecheck and build passed with five focused
tests. The root source-policy check and full `pnpm check` passed after the
Node-only hash import was removed from domain source. Tests cover invalid or
conflicting members, empty/partial/mismatched inventory, stale revision,
unverified/unindexed bytes, source disconnect after a valid seal and a late
instance that opens a new revision without broadening a frozen dispatch. A
duplicate late observation leaves Report status unspecified for the caller to
preserve.

P4.2 remains open: no running inventory owner yet establishes the seal proof,
persists the manifest transaction or drives cloud Ready/dispatch from these
decisions. The PostgreSQL constraints and separate [database proof](06-database-foundation.md)
cover related persistence boundaries but are not wired to this package.
