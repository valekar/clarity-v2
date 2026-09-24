---
id: staff-source-health-ui-2026-09-24
type: session
title: Add staff source health status panel
universe: live
status: verified
updated: 2026-09-24
revision: staff-source-health-panel-2026-09-24
---

# Add staff source health status panel

## Request and result

The Studies dashboard now reads the staff-authorized source-health API and
shows per-source status, freshness, last successful sync, queue counts, local
free space, and last-reported cloud reachability. Stale, unavailable, offline,
attention, and low-space states have distinct bounded copy. API data is parsed
at the browser boundary; patient/study identifiers and raw error codes are not
rendered. Requests abort after 12 seconds and refresh every 60 seconds. See
[staff source health evidence](../../docs/evidence/38-staff-source-health-panel.md).

## Verification

`pnpm --filter @clarity/web typecheck` passed. All 12 web tests passed, including
focused source-status parsing, wording, zero-capacity formatting, and malformed
response cases plus a hanging-request timeout. Focused formatting checks passed. Connected browser behavior was
not rerun, and connected PostgreSQL 18 integration was not rerun in this UI
increment. See the [source-health session](2026-09-24-source-health.md) for API
authorization and database verification.

No clinic or patient data was used in focused UI tests. The UI does not claim
current health after a failed/stale report.

## Map review and next step

Updated [Report package](../objects/report-package.md) to record the operational
status surface. The source/service ownership and API authorization remain with
the source-health implementation. Root owns plan, ACTIVE and generated catalog
closeout. Run the connected browser proof when Docker storage is recovered.
