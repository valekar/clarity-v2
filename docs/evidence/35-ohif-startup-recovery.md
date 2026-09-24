# OHIF startup recovery

Date: 2026-09-24. This increment adds an honest, bounded loading and retry
state around the authenticated Study page's same-origin OHIF frame.

## Behavior

The Study page starts with an accessible `role=status` message while it checks
for a visible canvas at least 64×64 CSS and backing pixels inside its same-origin
OHIF frame. It polls for up to 45 seconds. If a canvas appears, the page asks
staff to confirm that expected images are visible. If none appears, it explains
that the study may still be loading or may contain no renderable images, warns
against treating a blank view as a negative finding, and offers a keyboard
accessible Retry viewer button. Retry remounts the same scoped viewer URL.

The check intentionally describes a canvas, not successful diagnostic image
rendering. It cannot distinguish slow OHIF startup from a non-image study, an
empty study, or an internal viewer failure. Compatibility notices and the
approved source-viewer fallback remain in place.

## Verification and limits

- `pnpm --filter @clarity/web typecheck` passed.
- `pnpm --filter @clarity/web test` passed all 7 existing web tests.
- No browser rerun was available in this increment. The recorded OHIF startup
  stall from the previous run is not newly reproduced; Docker BuildKit storage
  errors still block the disposable browser stack. The 45-second state and retry
  interaction need connected browser verification.
- No clinical source data was used. CT/MR rendering, non-image behavior, codecs,
  and diagnostic suitability remain open.
