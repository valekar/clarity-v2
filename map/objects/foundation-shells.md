---
id: foundation-shells
type: object
title: Buildable application shells and workspace packages
universe: live
status: verified
updated: 2026-09-23
revision: scaffold-0.1.0
---

# Buildable application shells and workspace packages

## Purpose

The V2 monorepo has explicit web, desktop, sync-service and worker entry packages,
plus shared UI and TypeScript configuration; these are foundation code only.

## Why this shape

The user asked for a new project alongside V1. Separate process/package owners
make the later installed service independent of the Electron window, while the
static shell keeps incomplete clinical workflows visibly inactive.

## Shape

[pnpm workspace](../../pnpm-workspace.yaml) and [Turbo tasks](../../turbo.json)
resolve seven root/workspace projects. [Web](../../apps/web/src/app/page.tsx)
serves a static page; [desktop](../../apps/desktop/src/main.ts) loads local HTML
with sandboxed renderer settings. [Sync entry](../../apps/sync-service/src/main.ts)
and [worker entry](../../apps/worker/src/main.ts) exit explicitly without work.
[UI](../../libs/ui/src/clarity-brand.tsx) is browser-safe;
[config](../../libs/config/tsconfig.base.json) owns shared TypeScript rules.

## Connected to

Owned by [planning workspace](planning-workspace.md). The [source/service](source-and-service.md),
[staff identity](staff-identity.md) and [Report package](report-package.md) still
describe future clinical behaviour and remain ghost/stub.

## If you change this

**Hits:** workspace lockfile, Turbo graph, package exports, typechecks, build docs.

**Does not hit:** source Orthanc data, Hanko identities, patient records or V1.

## Surfaces

Developers can run static web/desktop shells and build entry modules. Staff cannot
perform authenticated or clinical actions in this scaffold. No deployed consumer.

## See

[Foundation evidence](../sessions/2026-09-23-v2-scaffold.md) and
[active plan](../../docs/ACTIVE.md).
