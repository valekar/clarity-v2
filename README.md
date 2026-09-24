# Clarity V2

Foundation workspace for an installable Clarity desktop application, automatic
local Orthanc ingestion and a dedicated cloud backend. The first deployment is
planned for one diagnostic centre and its named staff.

**Current state: partial synthetic implementation, no release.** A disposable
V2 cloud proof has exercised Hanko staff access, PostgreSQL migrations, private
intake storage, Orthanc ingestion, a compiled sync service, a worker and scoped
staff viewing. The standalone web preview at `/` has no connected study data;
the authenticated `/staff` path needs the cloud services. Sharing remains
disabled pending recipient verification. Installed service lifecycle, signed
installers, production hosting and a real centre pilot are open in the
[active plan](docs/ACTIVE.md). The latest connected rerun is blocked by Docker
BuildKit filesystem errors on this host.

Start with [the V2 implementation plan](docs/01-final-clarity-v2-plan.md).
The plan owns scope, architecture, proposed schema and acceptance. Supporting
research lives in [Hanko research](docs/research/hanko.md) and the
[source reuse assessment](docs/research/reuse-assessment.md).

Agents start at [AGENTS.md](AGENTS.md), then use the [ICM map](map/AGENTS.md).
There is no wiki. Decisions and session evidence live in the map. Runtime cards
cite source and remain clearly distinguished from planned clinical behaviour.

The existing `/Users/valekar/Projects/clarity` application is a read-only reference.
V2 must have separate storage, credentials, deployment resources and Git history.
The workspace has a Git working tree; Git history changes remain operator-owned.

## Workspace commands

Use Node.js 22.20.0 and pnpm 12.3.4. Install from the pinned lockfile. The local
web command shows the inactive preview without cloud services:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm --filter @clarity/web dev --hostname 127.0.0.1 --port 3111
```

The documentation tools also run without installing packages on Node 22.20.0:

```sh
node --experimental-strip-types scripts/generate-map.ts
node --experimental-strip-types scripts/check-docs.ts
```

The [apps](apps/CONTEXT.md) own web, desktop, sync-service and worker boundaries.
The [libs](libs/CONTEXT.md) hold shared UI, contracts, domain decisions,
database/server/storage adapters, synthetic messaging and TypeScript settings.
`pnpm build` compiles package code; it does not package a signed desktop
installer. The disposable synthetic cloud integration command is
`bash deploy/cloud/scripts/proof.sh`; its optional proof modes and limits are
documented in [deploy/cloud/CONTEXT.md](deploy/cloud/CONTEXT.md). It must not be
treated as a production deployment or clinical acceptance. Current release and
recovery gates are tracked in [the operational status](docs/operational-status.md).
