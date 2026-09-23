# Two-identity Hanko and staff web proof

Date: 2026-09-23. Scope: P2.1 and P2.2 on disposable synthetic resources.
The [proof runner](../../deploy/cloud/scripts/proof-hanko-v3.sh) starts Hanko
v3.0.4, Mailpit and PostgreSQL 18.6 with generated credentials, applies the
Clarity/Hanko migrations, builds and starts the standalone
[web app](../../apps/web/src/server/staff-services.ts), and uses two separately
registered provider-issued Hanko sessions. It removes its containers and
volumes on exit. No clinic or V1 resource is used.

`bash deploy/cloud/scripts/proof-hanko-v3.sh` passed after correcting the
proof's first-access/bootstrap order and granting database CONNECT to the
dedicated bootstrap operator role. The two identities first reached
`/api/staff/access`, were independently enrolled as pending, and received 403.
An operator-only SQL function promoted one Hanko-linked account to the first
admin. The protected web API then returned that active role, allowed the
admin to page two distinct accounts and grant the second a staff membership,
and returned the new role on the next request. It denied a staff actor's
admin change, denied the disabled staff actor on the next request, rejected a
stale version and the last-admin removal, and denied the old cookie after
Hanko logout. Mutation requests with a wrong or missing Origin or wrong
content type received 403. The proof kept cookies and passcodes out of logs.

The [session adapter](../../libs/server/src/auth/hanko-session.ts) and
[database-backed guard](../../libs/server/src/auth/require-staff-access.ts)
also have focused tests for malformed/wrong-claim/revoked sessions, provider
outage, database outage and current-membership checks. The
[PostgreSQL proof](12-staff-access-database.md) covers concurrent enrollment,
first-admin bootstrap, version conflicts and last-admin protection. Together
with the running two-identity web flow, these meet P2.1 and P2.2 for the
currently implemented staff APIs.

The two-identity staff API proof forwards provider-issued cookies through an
HTTP client. A separate optional local browser run,
`HANKO_BROWSER_PROOF=1 bash deploy/cloud/scripts/proof-hanko-v3.sh`, also passed
with installed Chrome/Playwright. From a plain web-origin page, Chromium used
Hanko's configured CORS actions to register a new disposable identity, then
completed passcode login. It stored Hanko's Secure/HttpOnly cookie for
`localhost` across the different Hanko and web ports. The protected web route
returned 401 before login and 403 afterward because the new identity had no
staff membership. The script prints neither passcode nor cookie. The runner
copies the standalone Next.js build into its private proof directory so another
workspace build cannot invalidate the live page.

The same browser check failed when the proof used the IP host `127.0.0.1`:
Chromium saw `Set-Cookie` but did not retain the Secure cookie. The disposable
proof now uses `localhost`, whose development Secure-cookie handling permits
this check. Production still needs HTTPS and its chosen domain topology.
Hanko Elements screen flow, recovery, packaged Electron, real Windows/macOS and
hosted-domain behavior remain P0.2/P1.3 gates. No clinical API, recipient
account or real patient record is involved.
