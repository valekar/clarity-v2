---
id: sync-service-package-2026-09-23
type: session
title: Package the compiled synthetic sync service
universe: live
status: verified
updated: 2026-09-23
revision: sync-service-package-2026-09-23
---

# Package the compiled synthetic sync service

## Request and result

The bounded P5 increment assembled a real compiled sync-service release from the
pinned Node 22.20.0 runtime and production workspace artifacts. macOS launchd
and Windows service XML now target the same `app/dist/main.js` entry and pass
`--config`. The builders package `@clarity/contracts` with the compiled service;
the Windows builder also stages the pinned WinSW wrapper beside its XML and
runtime. Windows CI is configured to contract against that staged release
layout.

A first package review found that legacy `pnpm deploy` copied workspace sources,
docs and Turbo logs. The builders now stage the app and its compiled dependency
in a temporary workspace and deploy offline from there. That avoids changing
root dependency links. An initial root-workspace deploy did disturb those links;
a workspace install restored them.

The [compiled package evidence](../../docs/evidence/29-sync-service-package.md)
records the actual macOS release, unsigned package payload, runtime smoke result,
checks and remaining native acceptance. The source/service card links that proof
while keeping installed service runtime status open.

## Verification

On macOS arm64, `deploy/installers/macos/build-release.sh 0.1.3-config
/tmp/clarity-sync-release-0.1.3-config` built the release from the temporary
workspace. Its bundled Node reported `v22.20.0`; the compiled entry exited 78
with the inactive-service message for both a missing config path and malformed
JSON at a private 0600 path, with a clean environment. The final 134 MiB release
contained `app/dist/main.js`, `app/package.json`, production `node_modules` and
`runtime/bin/node`, with no source tree or Turbo logs.

`deploy/installers/macos/build-pkg.sh` produced an unsigned disposable `.pkg`.
`pkgutil --payload-files` confirmed the compiled service, compiled contracts
package and bundled Node. `node --test deploy/installers/macos/tests/scaffold.test.mjs`
passed 4/4. `python3 -B -m unittest discover -s deploy/windows -p 'test_*.py'
-v` passed the static Windows service/layout checks and skipped the Windows
release/WinSW binary checks on this Mac. Windows CI now stages and smoke launches
the Windows release and verifies the staged wrapper checksum; that hosted run
has not yet happened. No launchd or Windows service was registered or installed.

## Map review and next step

Updated [source and service](../objects/source-and-service.md) with the package
evidence link. The service owner remains ghost/stub for installed lifecycle
acceptance. Native launchd/Windows startup, protected credentials, real service
install, signing/notarization, compatible-schema upgrade/rollback, and logout,
boot and crash recovery remain open. No plan status was changed.
