---
id: ohif-startup-recovery-2026-09-24
type: session
title: Add bounded OHIF startup recovery
universe: live
status: verified
updated: 2026-09-24
revision: ohif-frame-startup-recovery-2026-09-24
---

# Add bounded OHIF startup recovery

## Request and result

The viewer increment adds an accessible startup state to the authenticated
Study page. It checks the same-origin OHIF frame for a visible image canvas for
up to 45 seconds. A canvas produces a cautious confirmation prompt. A timeout
offers retry and directs staff to the approved source viewer while explicitly
warning that no visible canvas can also mean no renderable image. Implementation
details and limits are in [OHIF startup recovery evidence](../../docs/evidence/35-ohif-startup-recovery.md).

## Verification

`pnpm --filter @clarity/web typecheck` passed. `pnpm --filter @clarity/web test`
passed all seven existing tests. No browser rerun was available because the
disposable Docker-backed browser stack remains blocked by BuildKit storage I/O
errors. The UI's timer, OHIF DOM observation, retry interaction and rendered
status have not been browser verified.

No clinical source data was used. This does not establish successful pixels,
CT/MR support, non-image handling, codec support or diagnostic suitability.

## Map review and next step

Updated [Report package](../objects/report-package.md) to record bounded viewer
startup recovery. The card's source-health and active-plan ownership remains
unchanged. After Docker storage recovery, rerun the connected synthetic OHIF
browser proof and confirm both canvas success and timeout/retry behavior. Root
owns plan, ACTIVE and generated catalog closeout.
