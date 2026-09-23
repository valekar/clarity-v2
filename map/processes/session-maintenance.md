---
id: session-maintenance
type: process
title: Record a conversation or change
universe: live
status: verified
updated: 2026-09-23
revision: planning-session-2026-09-23
---

# Record a conversation or change

## Input

Consumes: [planning workspace](../objects/planning-workspace.md), authorized user
request, affected source, [schema](../_meta/schema.md) and relevant current cards.

## Movement

1. Route from root AGENTS through the map to affected owners; inspect source.
2. Update the canonical plan/source or decision within authorized scope. Planning
   does not authorize implementation; see [rules](../../docs/engineering-rules.md).
3. Copy the [session template](../_templates/session.md); record the actual result,
   checks and next step. Copy a decision template only for a durable new decision.
4. Update affected relationship cards. If none changed, record that review result.
   Keep planned runtime owners ghost/stub; cite evidence for verified cards.
5. Run [generate-map.ts](../../scripts/generate-map.ts), then
   [check-docs.ts](../../scripts/check-docs.ts) using README's exact commands.
6. Walk one changed route to source and review impact links. Report limits honestly.

## Output

Produces: current cards, indexed decision/session evidence and reviewable plan/code.
No wiki or duplicate long-form log. Initial evidence:
[planning session](../sessions/2026-09-23-v2-planning.md).

## If you change this

**Hits:** skills, schema/templates, catalog tooling, root closeout routing.

**Does not hit:** runtime clinical state or the sibling V1 wiki/history.
