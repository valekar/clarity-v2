# Native desktop window controls

## Scope

On 24 September 2026, the user rejected the extra Minimize/Expand/Close panel
inside the app and requested the operating system's original title-bar controls.
The Electron main window now explicitly uses a standard frame and default title
bar, with the normal resizable/minimizable/maximizable/closable capabilities.
The temporary hosted React panel, bundled-page injection, preload bridge and
window-control IPC were removed. The same main window continues to host sign-in
and the bundled Orthanc Settings page.

## Checks

- `pnpm --filter @clarity/desktop build` passed after the correction.
- `pnpm --filter @clarity/desktop test` passed **18/18**.
- `pnpm --filter @clarity/web typecheck` passed, and the disposable Docker web
  image rebuilt and restarted without the panel.
- The relaunched synthetic macOS Electron app showed the red, yellow and green
  native buttons in its focused title bar. Its accessibility tree exposed
  `close button`, `full screen button` (also zoom) and `minimize button` as
  native window elements; the hosted sign-in content contained no in-page
  window-controls element.
- The native zoom action expanded the window and the same action restored its
  original size. The native minimize button removed the window from the active
  surface; the synthetic app was restarted and left open at sign-in.

## Remaining acceptance

This verifies the synthetic macOS development window. The Windows caption
buttons and both packaged installers have not been run. P2.4 remains unchecked.
