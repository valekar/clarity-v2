# Workspace command and compiled-export evidence

Date: 2026-09-23. Scope: P1.2 for the currently implemented packages. The
[root manifest](../../package.json), [Turbo graph](../../turbo.json),
[CI workflow](../../.github/workflows/ci.yml) and
[compiled import probe](../../scripts/check-compiled-node.ts) own the commands.

- `pnpm run check` passed documentation, authored line/import policy, formatting,
  ESLint and strict TypeScript checks across current app/library packages.
- `pnpm run build` passed for web, desktop, sync-service, worker and the compiled
  domain package. Turbo orders dependent builds; development is persistent and
  uncached, while deterministic synthetic tests have no output artifacts.
- `pnpm exec turbo run test` ran two tasks: three root source-policy tests and five
  domain manifest/readiness tests. All eight passed. This was checked after
  correcting the initial Turbo configuration that had run only root tests.
- `pnpm run check:compiled-node` loaded compiled inactive service/worker entries
  and the compiled `@clarity/domain` package export from a temporary directory
  outside the source tree. The entries exited in their documented inactive state.

The command graph will need extension and fresh checks as later database, auth,
storage and provider packages are added. These results prove packaging/build
boundaries for current code, not a clinical service, native installer or CI run on
a remote runner. The initial run left P1.1 and P1.3 open.

## Expanded workspace rerun

After adding the database, contracts, imaging, messaging, server and storage
libraries, the disposable `CLARITY_VIEWER_PROOF=1 bash deploy/cloud/scripts/proof.sh`
exited 0. Both web and worker images performed a fresh `pnpm install
--frozen-lockfile` in their Docker builds and compiled their transitive workspace
dependencies before the connected synthetic proof. `pnpm run
check:source-policy` passed authored line limits, package import boundaries and
V1 import policy; `pnpm run check:compiled-node` loaded compiled service entries
and the domain, server, storage and imaging exports from an external temporary
directory. `pnpm run typecheck` passed 12 current package tasks, and `pnpm run
build` passed 11 build tasks including the standalone web route graph.
`pnpm exec turbo run test` passed 16 tasks, including the sync-service,
worker and imaging suites. The final `pnpm run check` passed documentation
(99 Markdown files, 564 local links and four parsed Mermaid diagrams), source
policy, Prettier, ESLint and strict TypeScript. The sync-service suite later
passed 57/57 after the compiled process and singleton-lock tests. This closes
P1.1 for the V2 workspace. P1.3 remains open for production HTTPS, key custody
and hosted topology.
