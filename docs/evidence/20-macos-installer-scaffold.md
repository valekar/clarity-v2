# Inert macOS installer scaffold proof

Date: 2026-09-23. Scope: synthetic, local macOS arm64 package assembly and
temporary-root script tests. No system service was installed or registered.

`deploy/installers/macos/` now has a `pkgbuild` script, a dedicated-user
LaunchDaemon template, release activation and uninstall scripts. Preinstall
requires a pre-provisioned `_clarity-sync` account. Postinstall creates private
data/log directories but deliberately leaves the template outside
`/Library/LaunchDaemons` and does not bootstrap launchd. Release switching
uses an atomic symlink replacement. Uninstall preserves the local SQLite queue,
spool, configuration and logs by default.

`node --test deploy/installers/macos/tests/scaffold.test.mjs` passed 4/4.
`sh -n` passed for all five scripts and `plutil -lint` accepted the plist.
The test built an unsigned disposable `.pkg` and inspected its payload with
`pkgutil`; a temporary root exercised upgrade, rollback, uninstall preservation,
system-root mutation guards and release-path traversal denial. The package
fixture used a small executable reporting the pinned Node version: copying the
full Node binary initially exhausted the then-available host disk space.
This verifies package layout and script logic, not that the real bundled
service executable runs after installation. Rebuildable Docker cache was later
pruned; containers and volumes were left intact.

P0.3 and P5.1–P5.3 remain open. Required later evidence includes a compiled
real release, protected credential access, native installed launchd service,
logout/boot/crash recovery, signing/notarization, upgrade rollback against
compatible queue/schema versions, and the Windows installer/service matrix.
