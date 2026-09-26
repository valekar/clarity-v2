# In-window Orthanc Settings revision

## Scope

On 24 September 2026 the source form was moved from a child BrowserWindow to a
bundled page loaded into the existing Electron main window. Its sidebar and
Back to Settings control preserve the staff Settings context. The hosted page
requests a named transition without receiving Orthanc credentials. The local
page's read, test, save and return operations validate the main-frame sender;
read, test and save also recheck active Clarity administrator membership.

## Checks

- `pnpm --filter @clarity/desktop build` passed.
- `pnpm --filter @clarity/desktop test` passed **18/18**, including rejection of
  non-Settings and cross-origin open requests and unknown return destinations.
- `pnpm --filter @clarity/web typecheck` and the disposable Docker web build
  passed. Browser Settings showed the revised source entry.
- A read-only layout preview of the bundled HTML at a normal desktop width
  showed the left navigation, Settings context, form and Back to Settings.
  The preview has no Electron bridge, so it does not prove local read/save.
- The relaunched branded Electron app accepted a fresh Hanko passcode for the
  preapproved synthetic administrator. From Studies, its Settings button showed
  **Configure Orthanc connection**. Clicking it replaced the content of the
  same standard Electron window with the bundled `file:` Settings page. The
  sidebar stayed visible; the saved loopback source and five-minute interval
  loaded with blank credential fields. **Back to Settings** restored the hosted
  Settings page in that same window. No child window appeared.
- Reopening the in-window form and selecting **Test connection** displayed
  “Orthanc responded successfully.” Saving the unchanged connection updated
  the private config at 18:07:02 local time with mode `0600`; the demo watcher
  restarted one independent sync-service process, and the staff status remained
  Healthy. The automation lost control after the save as the app navigated back
  to Studies, so the form's save toast was not observed.

## Remaining acceptance

The synthetic in-window round trip and same-source test/save passed. P3.5
remains unchecked for denied staff/anonymous calls, packaged macOS/Windows
launches and installed-service continuity.
