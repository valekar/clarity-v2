---
id: native-window-controls-session-2026-09-24
type: session
title: Restore native Electron window controls
universe: live
status: verified
updated: 2026-09-24
revision: native-window-controls-session-2026-09-24
---

# Restore native Electron window controls

## Request and result

The user rejected the extra window-control panel and asked for the original
macOS traffic lights and Windows caption buttons. [Plan v1.6](../../docs/01-final-clarity-v2-plan.md)
now states BR-12 as native OS controls. The temporary React panel, local-page
injection, preload bridge and IPC were removed. [Electron](../../apps/desktop/src/main.ts)
uses a standard framed, resizable window and explicitly shows the macOS window
buttons. No custom window controls remain in the rendered sign-in page.

## Verification

The desktop build, 18 focused tests, web typecheck and disposable Docker web
build passed. The web container was restarted and the synthetic Electron app
reopened on `/sign-in`. Its focused macOS title bar showed red/yellow/green
buttons; native accessibility elements were close, full screen/zoom and
minimize. Native zoom/restore worked, and minimize removed the active window;
the synthetic app was restarted and left open. See
[evidence 44](../../docs/evidence/44-desktop-window-controls.md).
Windows and packaged installer behavior remain unverified.

## Map review and next step

Updated [foundation shells](../objects/foundation-shells.md) and the active
plan. P2.4 stays open for packaged macOS/Windows acceptance, logout and
session-expiry proof.
