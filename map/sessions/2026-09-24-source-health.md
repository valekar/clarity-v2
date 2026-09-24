---
id: source-health-2026-09-24
type: session
title: Add fenced source health reporting and staff read API
universe: live
status: verified
updated: 2026-09-24
revision: source-health-fenced-report-2026-09-24
---

# Add fenced source health reporting and staff read API

## Request and result

The bounded P4.4 backend increment adds source operational visibility in the
synthetic device path. Migration
[`0016_source_health.sql`](../../libs/database/migrations/0016_source_health.sql)
stores source reachability, queue counts, spool free/capacity bytes, a bounded
error code and last successful sync cycle. The compiled sync loop posts reports
through its paired device credential. Its failure path classifies only typed
Orthanc transport/HTTP errors as source-unreachable; other failures report
`sync_failed` and preserve the retry loop.

The device API requires a current paired identity and then rechecks active
source, generation, device lease and fence in a locked database write. The
staff API rechecks Hanko identity and active membership, and its database read
also verifies membership before returning up to 100 active sources. The web
server computes `stale` after two minutes or when no report exists. Reports from
expired leases or a superseded fence are hidden. No patient or study identifiers
are stored in the health record.

## Verification

- Database, sync-service and web TypeScript checks passed.
- The focused sync-loop test verifies an Orthanc transport failure reports
  `sourceReachable: false`, while a local failure retains `true` and reports
  `sync_failed`.
- An isolated local PostgreSQL 15 cluster applied migration 0016 with migrator,
  runtime and device-auth roles. Device-auth recorded a report; runtime read it
  for active staff; after a fence takeover the prior report was hidden and a
  stale writer was rejected. This used a minimal synthetic schema fixture, not
  the full application migrations, and does not establish PostgreSQL 18 parity
  or prove concurrent transaction scheduling.
- Docker-backed integration remains unrun because the workspace's existing
  BuildKit/overlay I/O failure blocks the disposable PostgreSQL stack.

## Map review and next step

Updated the [source/service card](../objects/source-and-service.md) and database
context for migration 0016 and the staff read boundary. The viewer/status surface
can now consume `GET /api/staff/source-health`; all active sources are returned
up to the current 100-source bound, with unreported sources shown as stale.
Connected compiled-service reporting against the full disposable stack and
pagination beyond 100 sources remain open. ICM reviewed; no other runtime map
relationship changed.
