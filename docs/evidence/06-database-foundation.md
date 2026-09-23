# Disposable PostgreSQL foundation proof

Date: 2026-09-23. Scope: fresh V2 metadata schema and constraint proof, using
generated identifiers in an isolated PostgreSQL 18.6 container. No clinic data,
V1 database, production role or cloud API was used.

The [migration runner](../../libs/database/src/migrate.ts) applies checksummed,
ordered [foundation](../../libs/database/migrations/0001_foundation.sql) and
[ingestion](../../libs/database/migrations/0002_ingestion.sql) migrations only
when the named database starts with `clarity_v2_`. The
[proof harness](../../deploy/proof-database/run-proof.sh) creates a disposable
container and anonymous volume, then removes and verifies both absent.

## Verified

- `pnpm --filter @clarity/database typecheck` and `build`, Prettier, `bash -n`
  and `pnpm --filter @clarity/database proof` passed. The proof reran migrations
  without applying them twice.
- Real PostgreSQL checks exercised Report/file and global UID ownership,
  immutable clinical identity and file digest, draft-only manifest insertion,
  nonempty sealed membership, exact file/hash references and indexed-file Ready
  prerequisites.
- Seal/current-revision CAS, a concurrent member writer versus sealer, source
  generation reset with stable logical Report/file IDs, stale upload fence after
  lease takeover, restricted cloud reconciliation and selected role denials
  passed in the disposable database.

## Still required for P3.4 and P4.2

The service must prove fresh, stable, complete source inventory and provide the
canonical manifest digest. PostgreSQL does not independently recompute the
digest from members. The runtime must enforce a single Ready promotion
transaction with final references, exact indexed scope and authorization; the
disposable role check does not provision production grants. No actual admission
API, device pairing endpoint, Orthanc source adapter, cloud import, or two-device
installer was exercised. These checkboxes stay open.
