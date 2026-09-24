---
id: local-preview-run-2026-09-24
type: session
title: Run the local Clarity V2 preview
universe: live
status: verified
updated: 2026-09-24
revision: local-preview-2026-09-24
---

# Run the local Clarity V2 preview

## Request and result

The user asked whether the [active plan](../../docs/ACTIVE.md) was fully
implemented and to see the application running. The plan remains incomplete:
7 of 28 task boxes are checked. Started the web development server at
`http://127.0.0.1:3111/` and opened the read-only staff workspace preview in
the browser. It shows Studies, Doctors and Settings navigation with clearly
inactive study intake and sharing controls.

## Verification

`pnpm --filter @clarity/web dev --hostname 127.0.0.1 --port 3111` reported
Next.js ready. HTTP requests to `/`, `/staff` and `/api/health` each returned
200. Visually inspected `/`: it displays “INACTIVE PREVIEW,” “Not connected,”
zero studies and a disabled “Generate and send” control. The `/staff` response
is an unavailable fallback without the Hanko and cloud services.

The local Docker proof stack cannot currently provide a full synthetic flow:
Docker reports an overlay filesystem input/output error for the existing V2
proof containers. Other containers are running on the host, so this session
did not restart Docker or disturb them. No real service installation,
deployment, recipient delivery or clinical test was performed.

## Map review and next step

ICM reviewed: no object or relationship status changed from running the local
preview. Complete the remaining plan gates with the named inputs and restore
the disposable Docker proof environment before claiming end-to-end acceptance.
