---
id: foundation-shells
type: object
title: Buildable application shells and workspace packages
universe: live
status: verified
updated: 2026-09-24
revision: native-desktop-window-frame-2026-09-24
---

# Buildable application shells and workspace packages

## Purpose

The V2 monorepo has explicit web, desktop, sync-service and worker entry packages,
plus shared UI, pure domain decisions and TypeScript configuration. Clinical
runtime integration remains partial.

## Why this shape

The user asked for a new project alongside V1. Separate process/package owners
make the later installed service independent of the Electron window, while the
static shell keeps incomplete clinical workflows visibly inactive.

## Shape

[pnpm workspace](../../pnpm-workspace.yaml) and [Turbo tasks](../../turbo.json)
resolve twelve workspaces plus root tasks. [Web](../../apps/web/src/app/page.tsx)
serves a Studies/Doctors/Settings preview with a disabled sharing form and
database-backed protected staff routes;
[desktop](../../apps/desktop/src/main.ts) loads local HTML when unconfigured,
or a fixed hosted `/sign-in` route with a persistent staff partition and exact
dashboard/Hanko origin allowlist when configured. Its sandboxed renderer has
no Node or general preload bridge, with
[focused navigation tests](../../docs/evidence/17-desktop-hosted-auth-shell.md).
The desktop keeps Electron's [native framed BrowserWindow](../../apps/desktop/src/main.ts)
with standard OS close, minimize and zoom/maximize controls. The duplicate
in-page actions were removed after the user's [native-control correction](../../docs/evidence/44-desktop-window-controls.md).
The normal [sync entry](../../apps/sync-service/src/main.ts)
exits explicitly without work; a [synthetic process entry](../../apps/sync-service/src/synthetic-main.ts)
exercises local discovery. The [worker entry](../../apps/worker/src/main.ts)
contains a bounded poller with a
[disposable running proof](../../docs/evidence/15-worker-foundation.md) and is not deployed.
The [sync package](../../apps/sync-service/src/discovery/inventory-coordinator.ts)
has tested SQLite checkpoints, bounded Orthanc inventory and change replay that
the entry does not yet launch. A durable source lease and generation fence now
protect local queue commits; the anchored inventory has
[synthetic process evidence](../../docs/evidence/14-anchored-inventory.md) and
independent crash/resume findings were corrected with focused regressions.
A separate [foreground lifecycle probe](../../docs/evidence/11-macos-lifecycle-probe.md)
uses the compiled Node/SQLite runtime without activating the service entry.
[Database](../../libs/database/CONTEXT.md) holds a fresh schema and
[disposable proof](../../docs/evidence/06-database-foundation.md), plus audited
[staff access functions](../../docs/evidence/12-staff-access-database.md). An
[isolated cloud stack](../../deploy/cloud/CONTEXT.md) applies those migrations
and runs Hanko/Orthanc against synthetic data. Separate
[web](../../deploy/cloud/Dockerfile.web) and
[worker](../../deploy/cloud/Dockerfile.worker) images build and pass a disposable
[application-overlay startup proof](../../docs/evidence/07-cloud-stack.md);
connected device ingestion remains unproven.
[UI](../../libs/ui/src/clarity-brand.tsx) is browser-safe;
[domain](../../libs/domain/src/index.ts) owns compiled, pure manifest and readiness
decisions with focused synthetic tests;
[server](../../libs/server/CONTEXT.md) owns compiled, server-only Hanko session
validation and a database-backed access guard with
[synthetic adapter evidence](../../docs/evidence/10-hanko-session-adapter.md) and
[disposable PostgreSQL evidence](../../docs/evidence/13-staff-access-guard.md);
[storage](../../libs/storage/src/intake-objects.ts) owns the synthetic-tested
intake object adapter for [worker import](../../docs/evidence/15-worker-foundation.md)
and [scoped upload admission](../../docs/evidence/22-upload-admission.md);
[contracts](../../libs/contracts/package.json) owns browser-safe device DTOs;
[messaging](../../libs/messaging/CONTEXT.md) owns a synthetic uncertain-acceptance
adapter without external delivery;
[config](../../libs/config/tsconfig.base.json) owns shared TypeScript rules.

## Connected to

Owned by [planning workspace](planning-workspace.md). The [source/service](source-and-service.md),
[staff identity](staff-identity.md) and [Report package](report-package.md) cards
track the current proof boundaries; source/service and Report package remain stubs
until their connected clinical path is demonstrated.

## If you change this

**Hits:** workspace lockfile, Turbo graph, package exports, typechecks, build docs.

**Does not hit:** source Orthanc data, Hanko identities, patient records or V1.

## Surfaces

Developers can run the web/desktop shells and build entry modules. The web
preview has browser-checked keyboard, narrow layout and form states, recorded in
[UI evidence](../../docs/evidence/02-staff-ui.md). Protected staff access and
administration have [two-identity Hanko browser proof](../../docs/evidence/16-staff-web-hanko.md).
Clinical ingestion/viewing and deployed consumers remain open.

## See

[Foundation evidence](../sessions/2026-09-23-v2-scaffold.md) and
[active plan](../../docs/ACTIVE.md).
