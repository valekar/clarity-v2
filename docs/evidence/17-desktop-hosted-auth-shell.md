# Electron hosted staff shell prototype

Date: 2026-09-23. Scope: an uninstalled P0.2/P5 desktop boundary increment.
The [Electron main process](../../apps/desktop/src/main.ts) now accepts fixed
dashboard and Hanko origins through configuration. With both configured it
uses a persistent isolated staff partition and opens the hosted `/sign-in`
route. Without them it retains the inactive local status screen. Navigation
and network access are limited to the exact trusted origins; new windows and
permission requests are denied. Renderer sandbox, context isolation and Node
disablement remain in force, with no general preload bridge.

The desktop package build/typecheck and four focused origin/navigation tests
passed using the pinned Electron 44.4.4. This proves the static application
boundary, not login, recovery or optional passkey behaviour inside a packaged
desktop app. No installer was built or registered, and no macOS/Windows logout,
reboot or signing acceptance was performed. P0.2/P5 remain unchecked; the
separate [two-identity web proof](16-staff-web-hanko.md) used HTTP cookie
forwarding and does not prove real browser cookie topology.
