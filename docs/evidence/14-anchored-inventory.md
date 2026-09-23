# Anchored synthetic Orthanc inventory and process proof

Date: 2026-09-23. Scope: P3.2's bounded local discovery implementation.
The [coordinator](../../apps/sync-service/src/discovery/inventory-coordinator.ts),
[page decision](../../apps/sync-service/src/discovery/anchored-instance-page.ts),
[SQLite revalidation](../../apps/sync-service/src/persistence/discovery-revalidation-store.ts),
[bounded Orthanc reader](../../apps/sync-service/src/orthanc/discovery-client.ts)
and [synthetic process entry](../../apps/sync-service/src/synthetic-main.ts) own
this increment.

`pnpm --filter @clarity/sync-service test` passed 31 of 31 focused tests,
including a compiled child process using a private SQLite file and loopback
synthetic Orthanc fixture. The child completed one durable logical Report with
two instances; the parent reopened SQLite after process exit and confirmed the
completed run. The entry has a required `--synthetic-only` switch and finite
step/page budgets. The normal service entry remains inactive.

Inventory now uses the global `/instances` route as its authoritative walk. It
captures a finite upper Orthanc ID, durably overlaps pages around the last
accepted ID, backs up after deletion-induced offset overshoot, revalidates
known local instances by a SQLite keyset, and replays the captured change-feed
horizon. Tests cover deleted anchors/predecessors without feed events, insertion
around an anchor, empty/tail pages, continuous arrivals beyond the upper ID,
generation reset, late replay, crash resume and a 102-row revalidation where a
row disappears between batches. A 404 marks its local observation missing and
retains the logical Report; it does not delete verified cloud bytes.

After an independent review, the final inventory page now persists the
revalidation boundary in the same SQLite transaction as the transition to
`revalidating`. A deleted known instance is checked after reopening at that
exact crash boundary. A 501-event fixed-horizon replay remains pending and
resumes after process restart instead of being reported complete. Source
generation changes between fetch and commit during both scanning and
revalidation reject the stale write and restart the active run under the new
generation. The focused tests exercise all three cases.

Disposable Orthanc 1.13.0 with PostgreSQL index plugin 10.3 returned strictly
increasing global instance IDs with overlap paging against PostgreSQL 16 (12
IDs) and 18.6 (three IDs). Runtime pages are checked for strict ordering;
unsupported behavior fails closed. This small pinned-version probe does not
establish ordering across all Orthanc versions or backends. Named proof
containers were removed.

The filtered service source/test Prettier check passed; all authored service
files were at most 613 lines. A workspace build passed 8/8 and typecheck 9/9
at the agent's check point. The global check was still affected by concurrent
web/worker edits and is rerun at closeout.

P3.2 remains unchecked: this is a synthetic process and local checkpoint
proof, not an installed or continuously running clinic service. Continuous
insertions before the chosen anchor can delay total traversal, although each
call has a finite page budget. Slow-response timeout behaviour is not yet
independently tested. Cloud admission, large-source capacity, cross-backend
compatibility and automatic clinical backfill remain open.
