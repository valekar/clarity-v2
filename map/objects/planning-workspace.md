---
id: planning-workspace
type: object
title: V2 planning workspace
universe: live
status: verified
updated: 2026-09-23
revision: implementation-foundation-2026-09-23
---

# V2 planning workspace

## Purpose

The separate clarity-v2 folder holds the plan, ICM memory and first monorepo
scaffold. This card verifies project ownership, not a running clinical system.

## Why this shape

The user wants a fresh implementation without changing V1, with reusable source
identified before coding. [ACTIVE](../../docs/ACTIVE.md) selects the plan.

## Shape

[Plan](../../docs/01-final-clarity-v2-plan.md) owns scope/schema/acceptance;
[reuse assessment](../../docs/research/reuse-assessment.md) owns source selection;
[engineering rules](../../docs/engineering-rules.md) own implementation conventions.
The [foundation shells](foundation-shells.md) cite the app and library packages
now present. Remaining planned packages are added only with real consumers.

## Connected to

Routes [foundation shells](foundation-shells.md),
[source/service](source-and-service.md), [identity](staff-identity.md) and
[Report package](report-package.md). Maintained through
[session maintenance](../processes/session-maintenance.md).

## If you change this

**Hits:** active-plan pointer, affected decisions/cards, plan template if format changes.

**Does not hit:** the sibling V1 source/database; a V2 plan cannot migrate them.

## Surfaces

Read/write: product owner and authorized agents. No deployed service consumes it.
No known external automation points into this newly created workspace.

## See

[Plan v1.2](../../docs/01-final-clarity-v2-plan.md) and
[dated session evidence](../sessions/2026-09-23-v2-planning.md).
