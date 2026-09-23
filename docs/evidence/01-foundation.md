# V2 foundation scaffold evidence

Date: 2026-09-23. Scope: the authorized workspace scaffold, not completion of
P0/P1 or clinical acceptance. [Plan and acceptance](../01-final-clarity-v2-plan.md)
remain canonical. [Session](../../map/sessions/2026-09-23-v2-scaffold.md)
records the decision and map change.

## Artifacts

- Root [workspace manifest](../../package.json), generated
  [pnpm lockfile](../../pnpm-lock.yaml) and [Turbo graph](../../turbo.json).
- App shells: [web](../../apps/web/CONTEXT.md),
  [desktop](../../apps/desktop/CONTEXT.md),
  [sync service](../../apps/sync-service/CONTEXT.md) and
  [worker](../../apps/worker/CONTEXT.md).
- Shared [UI](../../libs/ui/CONTEXT.md) and
  [TypeScript config](../../libs/config/CONTEXT.md). Exact dependencies are pinned;
  Node 22.20.0 and pnpm 12.3.4 are the local scaffold toolchain.

## Checks actually run

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed after lockfile regeneration for the project peer policy; pnpm reported 416 supply-chain entries passing its check |
| `pnpm run format:check` | Passed on authored scaffold source/config and documentation scripts; generated lockfile excluded from formatting |
| `pnpm run lint` | Passed on app, library and script source |
| `pnpm run typecheck` | Passed for all five TypeScript package owners plus documentation scripts under strict settings |
| `pnpm run build` | Passed; Turbo compiled web, desktop, sync-service and worker entries. Next.js generated a static `/` route |
| Local Next.js HTTP smoke | Production server returned HTTP 200 and the explicit foundation page; localhost listen required sandbox escalation |
| Compiled sync/worker entries | Both exited 78 with an explicit inactive message; they did not poll, upload or send |
| Electron binary smoke | Pinned Electron 44.4.4 launched as Node (embedded Node 24.21.0); no desktop UI, signing or installer test |
| `pnpm run check:docs` | Passed in the delivered sibling folder: 59 Markdown files, 223 local links, nine map cards and 19 requirement IDs |
| V1 preservation read | All 518 tracked/nonignored V1 files matched the pre-work SHA-256 snapshot; no added/removed nonignored files |

Versions came from exact registry metadata and the existing local Node/pnpm
toolchain. Official references: [Next.js manual setup](https://nextjs.org/docs/app/getting-started/installation),
[Turborepo repository structure](https://turborepo.com/docs/crafting-your-repository/structuring-a-repository),
[Electron prerequisites](https://www.electronjs.org/docs/latest/tutorial/tutorial-prerequisites)
and [pnpm workspace/build settings](https://pnpm.io/settings).

## Limits

The web page is public and contains no clinical data. It has no Hanko session,
staff authorization, Orthanc ingestion, DICOM viewer, database, delivery or Docker
deployment. The Electron binary smoke did not open its window. No OS service or
native installer ran; Windows acceptance is open. Runtime packages from the plan
without a first consumer remain uncreated. No V1 code was copied into this scaffold.
