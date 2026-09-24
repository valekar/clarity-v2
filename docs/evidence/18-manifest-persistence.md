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

The [reverse-order admission cutoff proof](28-manifest-admission-cutoff.md)
extends the disposable PostgreSQL suite through migration 0015. It admits and
indexes a late SOP before sealing revision 2, keeps the Report non-Ready until
that fresh seal, and preserves a revision-1 dispatch's frozen scope. It also
proves the runtime cannot mark an upload completed outside the worker path.
The earlier disposable PostgreSQL proof runs as part of the 14-migration suite.
It admits a late SOP after a revision-1 dispatch was created,
opens and seals revision 2, and confirms that worker indexing restores Report
readiness while the existing dispatch remains bound to revision 1 and its
original recipient snapshot. It also rejects sealing when the caller reports
the source inventory as incomplete. See the [late-manifest dispatch-scope
proof](../../deploy/proof-database/late-manifest-dispatch-scope.sql) and the
[dispatch evidence](27-policy-gated-dispatch-outbox.md).

P4.2 remains open. These are trusted SQL proofs, not a continuously running
device inventory or a connected late-arrival/restart exercise. The incomplete
case proves that an explicit `inventory_complete=false` cannot seal; it does
not establish how quiet-but-incomplete Orthanc studies are detected. No clinic
Orthanc, production database or recipient delivery was used.
