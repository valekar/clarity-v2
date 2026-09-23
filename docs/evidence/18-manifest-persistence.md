# Observed manifest persistence proof

Date: 2026-09-23. Scope: the PostgreSQL portion of P4.2 on disposable
synthetic resources. [Migration 0005](../../libs/database/migrations/0005_observed_manifests.sql)
adds an immutable source-inventory proof for each sealed Report revision and
device-role functions for draft creation, bounded member pages and sealing.
The [database proof](../../deploy/proof-database/manifests.sql) ran on a fresh
PostgreSQL instance with migrations 0001–0005; the compiled
[worker process proof](15-worker-foundation.md) then passed on the same schema.

The device role could begin a draft only at the expected Report version and
current source lease/generation. It replayed a member page idempotently, rejected
unstable inventory and a wrong deterministic SHA-256, and sealed the exact
member set with a fresh observation. The Ready trigger rejected a sealed
revision before its sole file was indexed. A late second SOP created revision 2
and moved the Report back to Syncing; Ready returned only after the new exact
member set was indexed. A source-generation advance now changes affected
Reports out of Ready and increments versions in the same transaction, invalidating
old fences and compare-and-swap expectations. The proof checks role denial for
the staff web runtime. Generated UIDs and bytes were synthetic.

P4.2 remains open. This proof invokes the trusted SQL functions directly; a
continuously running device has not yet submitted a complete source inventory
through P3.4 cloud admission. Quiet-but-incomplete source behavior and frozen
dispatch scope still need connected acceptance. No clinic Orthanc, production
database or recipient delivery was used.
