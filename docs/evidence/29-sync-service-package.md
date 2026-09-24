# Compiled synthetic sync-service package

Date: 2026-09-23. Scope: synthetic local macOS arm64 release assembly and
unsigned package inspection. No machine service was installed or registered.

`deploy/installers/macos/build-release.sh` now assembles the shared layout used
by launchd and Windows Service Wrapper: `runtime/bin/node` (macOS) or
`runtime/node.exe` (Windows), `app/dist/main.js`, `app/package.json`, and
production `app/node_modules`. Both launch definitions pass an absolute
`--config` path, which the compiled service now validates and loads as a private
JSON configuration file. Node 22.20.0 archives are checked against the official
`SHASUMS256.txt`; the builder records the target and archive digest in
`BUILD_INFO`. The Windows release also places the pinned
`ClaritySyncService.exe`, matching `ClaritySyncService.xml`, and
`WinSW.lock.json` beside the app/runtime. The PowerShell assembler verifies the
wrapper SHA-256 and records both runtime and wrapper digests in `BUILD_INFO`.
Windows CI checks the resulting artifact and missing-config exit contract
without executing or installing WinSW.

On this Mac, Turborepo built `@clarity/contracts` and `@clarity/sync-service`.
The final builder copies only their manifests and compiled output into a
temporary workspace, then runs offline production deploy there. The staged Node
reported `v22.20.0`; the compiled entry loaded from the staged production
dependency tree and exited 78 for both a missing `--config` file and a malformed
JSON file with private mode 0600. Both runs used a clean environment and printed
the expected inactive-service message. `build-pkg.sh` produced an unsigned disposable `.pkg`;
`pkgutil --payload-files` showed `app/dist/main.js`, the compiled
`@clarity/contracts` dependency, and `runtime/bin/node`. The release contains no
service credentials or config. It was 134 MiB, and contains no workspace source,
docs, tests or Turbo logs.

Exact assembly commands:

```sh
deploy/installers/macos/build-release.sh 0.1.3-config /tmp/clarity-sync-release-0.1.3-config
deploy/installers/macos/build-pkg.sh 0.1.3-config /tmp/clarity-sync-release-0.1.3-config /tmp/ClaritySync-0.1.3-config.pkg
```

A review of the first real artifact found `pnpm deploy` had copied workspace
source, documentation, tests and Turbo logs. Both platform builders now deploy
from a fresh temporary workspace containing only the service and contracts
manifests plus compiled `dist/`; the macOS rerun verified the trimmed output,
strict config-file launch, package payload and exit 78. An earlier legacy
deploy invoked from the shared root disturbed root workspace dependency links;
the workspace install restored them. Subsequent deploy commands ran only in the
temporary workspace.

Focused checks passed: the bundled Node exited 78 for missing and malformed
`--config` paths; `sh -n` for macOS builder/installer scripts,
`node --test deploy/installers/macos/tests/scaffold.test.mjs` (4/4), and
`python3 -m unittest discover -s deploy/windows -p 'test_*.py' -v` (3 passed,
2 skipped because this Mac has neither a Windows release artifact nor the
optional WinSW download). Windows CI now builds and smoke launches its actual
release and verifies the staged WinSW checksum before running the package
contract test. That Windows CI run, installed launchd/Windows lifecycle,
credential-vault access, signing,
notarization, upgrade/rollback against compatible queue schemas, and logout,
boot and crash recovery remain unverified.
