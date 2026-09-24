---
id: studies-pagination-review-2026-09-24
type: session
title: Review staff Studies search pagination
universe: live
status: verified
updated: 2026-09-24
revision: staff-study-keyset-pagination-2026-09-24
---

# Review staff Studies search pagination

## Request and result

Reviewed P4.4's paginated staff Studies search. The existing `/staff` route
already calls the staff-authorized repository with a 25-study page size, passes
an opaque cursor when continuing, and preserves the search term on its Next page
link. The repository uses a stable `(created_at, report_id)` keyset cursor and
fetches one extra row to determine whether another page exists. The existing
[viewer and staff UI evidence](../../docs/evidence/25-viewer-and-sharing-ui.md)
records authenticated search and narrow-width study navigation. No runtime
change was needed; no patient or study values were added to logs or this card.

## Verification

`pnpm --filter @clarity/web test` passed 12/12 and
`pnpm --filter @clarity/web typecheck` passed. Source review confirmed the
route-to-repository cursor flow and query preservation. A connected browser run
with more than 25 synthetic search results was not available, so multi-page
browser navigation under a populated result set remains unverified.

## Map review and next step

ICM reviewed: [staff identity](../objects/staff-identity.md) and
[Report package](../objects/report-package.md). No relationship facts changed;
runtime map owners remain as recorded. P4.4 still needs the connected populated
search/browser acceptance described above, plus its independent source-health
and capacity requirements.
