# Synthetic staff UI skeleton evidence

Date: 2026-09-23. Scope: P2.3 only. The
[web page](../../apps/web/src/app/page.tsx) and
[styles](../../apps/web/src/app/globals.css) show a synthetic, inactive workflow.
There is no authenticated session, clinical record, viewer, provider or send API.

## Checks

- `pnpm --filter @clarity/web build`, web/UI typechecks, ESLint on the page and
  Prettier passed in the implementation run. `pnpm run check` and `pnpm run build`
  also passed after integration.
- In the local production page, Studies, Doctors and Settings switched to their
  expected empty/unavailable states. Keyboard Tab focused the navigation buttons;
  Enter activated Doctors. The sharing form exposed labelled patient mobile and
  referring-doctor controls in the accessibility tree.
- At a 375px browser viewport, the page showed a stacked layout without a clipped
  navigation or sharing panel. Entering an invalid mobile displayed a validation
  message. Selecting a synthetic doctor displayed its sample mobile. Generate and
  send remained disabled with an unavailable explanation.
- The page contains no backend fetch or external-send action; no patient records
  or actual contacts were loaded. This was a synthetic UI check, not a clinical
  access or delivery test.

Connected studies, active doctor records, authenticated roles, viewer rendering
and recipient delivery remain in later plan phases.
