# Staff source health panel

Date: 2026-09-24. This increment adds operational source status to the staff
Studies page using the staff-authorized `/api/staff/source-health` response.

## Behavior

The panel lists active sources returned for the signed-in staff account. It
shows the source's reported status, report time, last successful sync, queued
study/upload counts, local free space, and cloud reachability at the last
report. Healthy status is explicitly time-qualified. Stale or unavailable
status is presented as unknown; offline and attention statuses get their own
copy. Low space is called out at the API's one-GiB threshold, including an exact
zero-byte reading. The UI does not show patient or study identifiers, nor raw
error codes. The API authorization, freshness threshold and status derivation
are recorded in the [source-health session](../../map/sessions/2026-09-24-source-health.md).

The panel reads the same-origin no-store endpoint on page load and every 60
seconds. Each request has a 12-second abort bound. A failed, invalid, or
timed-out response says current source and cloud health is unknown and offers a
retry. Staff can refresh manually. A source with no heartbeat appears as stale
with unavailable metrics, per the API contract.

## Verification and limits

- `pnpm --filter @clarity/web typecheck` passed.
- `pnpm --filter @clarity/web test` passed all 12 tests, including DTO shape,
  stale/healthy/low-space copy, zero capacity formatting, invalid timestamp and
  capacity rejection, source-count bound, and abort behavior for a hanging
  request.
- Focused Prettier check passed for changed UI, tests, and evidence files.
- A connected browser run was not available. The panel's authenticated fetch,
  visual layout, retry, and periodic refresh still
  need browser verification. Connected PostgreSQL 18 integration was not
  rerun in this UI increment; the source-health session records the backend's
  isolated PostgreSQL proof.
- Only synthetic operational DTOs were used in focused tests. No patient data
  is rendered by this panel.
