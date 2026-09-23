---
name: planning-doc-generator
description: Create repository-grounded Clarity V2 implementation plans with explicit source ownership, diagrams, phased acceptance and ICM closeout.
---

# Clarity V2 planning document generator

Adapted from the V1 project skill for the user's separate V2 scope. This file owns
plan format; [root AGENTS.md](../../../AGENTS.md) routes engineering authority.

## Context

1. Read root AGENTS.md, [active plan](../../../docs/ACTIVE.md),
   [map entry](../../../map/AGENTS.md), the relevant decision/session and object card.
2. Read each cited canonical owner. Inspect source, callers, database consumers and
   deployment wiring where they exist. Mark missing code and commands **Planned**.
3. Reuse the active plan for the same objective. For a new objective, inspect
   docs/ and docs/completed/ if present, then choose the next NN. V2 numbering is
   independent of V1. Never silently execute a plan or change the sibling project.

## Output

Use [assets/template.md](assets/template.md); save as
`docs/NN-final-<topic>-plan.md`. State version, date, author, goal and honest status.
Immediately after contents, describe final goal, user/system outcomes, non-goals
and concrete acceptance. Separate approved requirements, proposed choices and
unresolved inputs. Give requirements stable IDs, priority and source.

Ground the diagnosis and reuse decisions in exact source owners. Show planned
paths, contracts, state changes, recovery, trust boundaries, schema/migration,
deployment and verification. Prefer top-down flows and vertical sequence diagrams;
link an existing canonical schema instead of copying it into another document.

Each phased task names deliverable, owner and observable verification. Trace every
requirement to tasks/evidence. Leave unexecuted implementation boxes unchecked.
Distinguish source presence, tested behaviour and deployment. Never fabricate
provider approval, capacity, credentials, runnable scripts or platform acceptance.

Describe only the authorized deployment scope. Keep external inputs and release
gates visible. Runtime services/packages need a current purpose, not hypothetical
reuse. Keep the first staff pilot distinct from the later recipient-sharing gate.

## Closeout

Update docs/ACTIVE.md and relevant ICM decision/session cards. Update object/process
relationships only when facts change. Follow
[session maintenance](../../../map/processes/session-maintenance.md), regenerate
catalogs and run documented checks. There is **no wiki** in V2. Preserve V1.
