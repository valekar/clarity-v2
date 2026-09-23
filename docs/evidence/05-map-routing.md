# ICM routing and checks

Date: 2026-09-23. An independent read-only advisor started at the
[root entry](../../AGENTS.md), followed [ACTIVE](../ACTIVE.md), then the
[map entry](../../map/AGENTS.md), [catalog](../../map/catalog.md) and
[effects router](../../map/effects/CONTEXT.md). Each implemented boundary was
located through a card before opening source:

| Boundary | Card route | Source reached |
| --- | --- | --- |
| Staff web preview | [Foundation](../../map/objects/foundation-shells.md) | [Page](../../apps/web/src/app/page.tsx) |
| Desktop shell | [Foundation](../../map/objects/foundation-shells.md) | [Main](../../apps/desktop/src/main.ts) |
| Inactive worker | [Foundation](../../map/objects/foundation-shells.md) | [Main](../../apps/worker/src/main.ts) |
| Local discovery | [Source/service](../../map/objects/source-and-service.md) | [Inventory](../../apps/sync-service/src/discovery/inventory-coordinator.ts), [checkpoint](../../apps/sync-service/src/persistence/checkpoint-store.ts) and [adapter](../../apps/sync-service/src/orthanc/change-feed.ts) |
| Pure manifest decisions | [Report package](../../map/objects/report-package.md) | [Domain](../../libs/domain/src/index.ts) |
| PostgreSQL schema | [Foundation](../../map/objects/foundation-shells.md) and [database owner](../../libs/database/CONTEXT.md) | [Migrations](../../libs/database/migrations/0001_foundation.sql) |
| Isolated cloud proof | [Foundation](../../map/objects/foundation-shells.md), [identity](../../map/objects/staff-identity.md) and [Report](../../map/objects/report-package.md) | [Cloud owner](../../deploy/cloud/CONTEXT.md), [Compose](../../deploy/cloud/compose.yaml) and [proof](../../deploy/cloud/scripts/proof.sh) |
| Server Hanko validation | [Staff identity](../../map/objects/staff-identity.md) | [Server owner](../../libs/server/CONTEXT.md) and [adapter](../../libs/server/src/auth/hanko-session.ts) |
| Staff access persistence | [Staff identity](../../map/objects/staff-identity.md) and [database owner](../../libs/database/CONTEXT.md) | [Audited migration](../../libs/database/migrations/0003_staff_access.sql) and [proof](../../deploy/proof-database/prove-staff-access.sh) |

The first walk found no broken route. It identified stale persistence wording in
Report/identity cards and a missing schema-change impact route. Those cards and
the [effects route](../../map/effects/CONTEXT.md) were updated. A second walk
reached the added inventory, cloud, Hanko server and staff SQL owners through the same entry. No clinical
runtime was relabelled live.

`pnpm run check` passed on 2026-09-23: 73 Markdown files, 345 local links,
12 map cards, 19 traced requirements, source line limits, source boundaries,
formatting, lint (zero errors, one unrelated unused-type warning) and strict
TypeScript. The checker parsed all four Mermaid diagrams with pinned
`mermaid@12.0.0`; parser tests include malformed source. It does not render
diagrams in a browser. [CI](../../.github/workflows/ci.yml) runs the same
command plus tests, build and compiled Node import checks. This closes P1.4's
catalog/link/line/diagram and cold-routing acceptance. Later substantive changes
still require map maintenance under the repository rules.
