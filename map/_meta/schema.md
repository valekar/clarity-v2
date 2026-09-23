# Map node schema

Every card in objects/, processes/, decisions/ and sessions/ has flat YAML
frontmatter. Keep scalar values unquoted and on one line for the small parser.
Templates have no frontmatter so unfinished examples are not cataloged as records.

| Field | Allowed values / meaning |
| --- | --- |
| id | Unique lowercase hyphenated slug, including a date where helpful |
| type | object, process, decision, session |
| title | Human-readable one-line name without table pipes |
| universe | live, leftover, ghost |
| status | verified, stale, stub |
| updated | ISO calendar date |
| revision | Evidence anchor: plan version, source commit or dated session |

`verified` needs dated evidence and a source citation; it does not mean deployed.
`ghost` must remain `stub`: proposals are not implementation. A live planning
document/process can be verified while all runtime objects remain ghost.
`leftover` preserves a superseded record; its body links the replacement.
Directory and type must agree. Do not use a record's status to hide unresolved
decisions; write approved, proposed and open sections inside the decision.

Objects explain purpose, why, shape, relationships, Hits / Does not hit, surfaces
and source. Processes describe input → actual movement → output with citations.
Decisions distinguish user instructions from recommendations. Sessions state what
changed, verification and next step, with no raw patient identifiers or private URLs.

Generated owners: catalog.md, objects/_index.md, AGENTS.md and routing.md.
Source: cards plus CLAUDE.md. Regenerate; do not hand-edit generated output.
