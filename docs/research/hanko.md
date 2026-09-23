# Hanko research and integration recommendation

Research date: 2026-09-23. This is a proposed integration. A disposable
[cloud stack proof](../evidence/07-cloud-stack.md) has run Hanko migrations,
readiness and effective configuration, but packaged-desktop authentication
has not been tested.
An independent [synthetic protocol proof](../evidence/09-hanko-protocol.md)
has exercised Hanko v3 registration, passcode login, validation and logout
through Mailpit. A later [Chromium proof](../evidence/16-staff-web-hanko.md)
verified local cross-port browser cookie storage and protected-route use.
Packaged Electron and production HTTPS domain behaviour remain untested.
The [plan](../01-final-clarity-v2-plan.md) owns implementation choices and gates.

## Findings supported by primary sources

| Finding | Source | V2 implication |
| --- | --- | --- |
| Hanko provides a self-hostable authentication backend, Elements web components and a TypeScript/JavaScript SDK; email/username, passwords, passcodes and passkeys are documented | [Repository overview](https://github.com/teamhanko/hanko) | Use full Hanko authentication, not the separate Passkey API product |
| Elements/SDK are MIT; the backend is AGPL-3.0 and commercial licensing is offered | [Licenses](https://github.com/teamhanko/hanko#licenses) | Record pinned-component licenses; review distribution/network-use obligations before release; do not claim the entire stack is MIT |
| The official Next.js guide mounts client-side Elements and connects it to a configured Hanko backend URL | [Next.js guide](https://docs.hanko.io/quickstarts/fullstack/next) | Reuse the integration pattern with current App Router/proxy conventions; every server operation still checks authorization |
| Hanko maintains server-side sessions and includes a session identifier; the older SDK session guide describes an X-Auth-Token flow, while the [v3.0.4 backend config](https://raw.githubusercontent.com/teamhanko/hanko/backend/v3.0.4/backend/config/config.yaml) defaults to an HttpOnly, Secure, SameSite=Strict cookie with `enable_auth_token_header: false` | [Session guide](https://docs.hanko.io/guides/session-management), [versioned config](https://raw.githubusercontent.com/teamhanko/hanko/backend/v3.0.4/backend/config/config.yaml) | Pin and test one actual browser/Electron cookie topology; do not assume older JavaScript-readable token behaviour or JWT-only revocation semantics |
| GET sessions/validate is passive; POST sessions/validate updates session activity | [GET validation](https://docs.hanko.io/api-reference/public/session-management/validate-a-session), [POST validation](https://docs.hanko.io/api-reference/public/session-management/validate-a-session-1) | Background polling must not indefinitely extend human-session idle time |
| Validation returns claims.subject, claims.session_id, expiration, issuer/audience and verified-email information; old user_id/expiration_time fields are deprecated | [Validation response](https://docs.hanko.io/api-reference/public/session-management/validate-a-session) | Normalize a versioned DTO at the server; do not confuse this response shape with raw JWT claim names |
| Public JWKS are available and the API describes RS256 signing | [JWKS API](https://docs.hanko.io/api-reference/public/well-known/get-json-web-key-set) | Configure trusted issuer/key origin/algorithm and rotation tests; never discover a JWKS URL from an untrusted token |
| Upstream Docker quickstart separates migration and service startup, with PostgreSQL and email delivery configuration | [Compose](https://github.com/teamhanko/hanko/blob/main/deploy/docker-compose/quickstart.yaml), [configuration](https://github.com/teamhanko/hanko/blob/main/deploy/docker-compose/config.yaml) | Treat it as an example: replace demo keys/passwords/old images, avoid public admin/management ports, use production SMTP |
| Published import guidance uses UUID user identifiers and a Hanko Cloud Console workflow | [Import guide source](https://github.com/teamhanko/docs/blob/main/guides/import_export/import-export-users.mdx) | Do not promise one-click self-hosted Clerk import or transferable passkeys; V2 can enroll staff afresh |

## Recommended staff integration

Use self-hosted Hanko in the dedicated V2 cloud stack. Keep Hanko's schema and
migrations separate from Clarity's product schema and roles. Expose its public API
behind HTTPS on an approved origin; keep admin and management interfaces private.
Do not put auth-database access or Hanko administrator credentials in Electron.

The first staff login method should be verified email passcode, with passkeys
enabled only after the real device/release matrix passes. This is a design choice
for predictable enrollment, not a claim that passkeys are unsupported. SMTP sender,
delivery, recovery and rate-limit behaviour need real acceptance before rollout.

The server converts a validated session into `{ issuer, subject, sessionId,
verifiedEmail, expiresAt }`, then looks up an explicit identity link to an active
Clarity user and centre membership. Staff receive no permission merely by
successfully registering with Hanko. Admin-approved membership is required;
unknown identities get a clear no-access screen. Do not use mutable email as a
primary key or user-editable Hanko metadata as the permission source.

For the first small centre, prefer online Hanko session validation at protected
server boundaries with request-local deduplication, then the application permission
check. Fail closed on auth unavailability. Do not introduce an unbounded positive
session cache. If local JWT validation is added for performance, specify and test
revocation latency; verify signature, trusted algorithm/key, issuer, configured
audience, expiry and not-before before using any claim.

Use GET validation for passive reads/polls; the deliberately chosen interactive
activity path may use POST to extend an idle session. Staff disablement must deny
the next protected action from current database facts. Revocation and logout tests
must include already-open Electron and browser windows. Returning to a sensitive
screen after OS unlock should require the configured session check.

The versioned v3.0.4 backend defaults to an HttpOnly, Secure, SameSite=Strict
session cookie and disables the auth-token response header. The older session
guide describes JavaScript-accessible SDK token handling. The local Chromium
proof used Hanko's actual v3 cookie and root-level CORS configuration; it
worked on `localhost`, while the Secure cookie was not stored for the proof's
`127.0.0.1` IP host. P0.2 must still reconcile the actual Elements/SDK release,
hosted domains and Electron cookie persistence with CSRF protection. Do not
assume a server-owned bridge or force the older header flow without an explicit
tested decision. Keep CSP strict and tokens out of URLs/logs.

## Desktop compatibility

The proposed first desktop shell displays the hosted HTTPS Next.js dashboard in a
sandboxed Electron window. Its staff session is separate from both the default
external browser session and the machine synchronization credential. Test cookie
persistence, restart, logout, OTP failure, keyboard access and recovery in the
packaged Windows/macOS app, not just Chrome.

Electron documents macOS platform WebAuthn configuration and signing entitlements;
device-bound Touch ID credentials are not equivalent to automatically synchronized
iCloud passkeys. Do not promise a particular method based on Chromium support alone.
Test Windows Hello, Mac hardware, security keys, enrollment and cancellation on the
selected stable Electron version. Keep email recovery available. Sources:
[Electron app/WebAuthn](https://www.electronjs.org/docs/latest/api/app),
[Electron sessions](https://www.electronjs.org/docs/latest/api/session).

If a required method fails inside Electron, a system-browser login with a narrowly
scoped, single-use, expiring handoff is an alternative to design and test. Hanko
must not be assumed to implement a generic OAuth authorization-code/PKCE flow for
our desktop app. No homemade token handoff is included in the baseline.

The background service uses its own paired installation credential. It must work
after staff logout and cannot depend on a Hanko cookie, human refresh token, user
keychain being unlocked, or an active Electron process.

## Hanko, Auth0 and Orthanc are different inputs

The user explicitly selected Hanko and confirmed on 23 September 2026 that it is
the sole V2 staff identity provider, resolving the earlier Auth0 wording. No Auth0
SDK or dual-provider integration is planned. Hanko can
also federate with Auth0 through SAML, but that is a distinct enterprise feature,
not a reason to add it to a one-centre app. [Hanko Auth0 SAML guide](https://docs.hanko.io/guides/enterprise-sso/auth0)

Orthanc payloads create imaging records. Hanko sessions identify people. Staff
forms supply patient/doctor delivery numbers. Do not derive clinical tables from
identity-provider claims or treat entered mobile numbers as verified identities.

## Existing Clarity migration

V1 replacement is separately estimated in the [reuse assessment](reuse-assessment.md).
Preserve stable internal users; add explicit new-provider identity links with
verified ownership, enroll new credentials and preserve audit/grant references.
Clerk subject strings are not Hanko UUIDs. Existing sessions are not transferable.
Passkey RP IDs and credential export availability also need verification; no
password/hash/passkey import compatibility has been established.

The current recipient login relies on verified mobile numbers. This research has
not established a Hanko equivalent for that workflow. Recipient verification must
be resolved separately before external clinical sharing; staff-entered numbers or
an emailed account are not substitutes for verified ownership of that number.

## Research limits and implementation checks

- A disposable Hanko v3.0.4 server and Mailpit completed a synthetic
  registration/login/logout flow. No SDK, real SMTP account, persistent
  provider user or packaged browser login was tested.
- Some rendered Hanko/Turbo pages failed in the web reader; official Hanko session
  and Turbo structure pages were retrieved read-only over HTTPS and inspected.
- Upstream docs and main branches are mutable. Select exact compatible backend,
  Elements and SDK releases, image digests and OpenAPI snapshots in P0; verify
  configuration keys and paid-cloud versus self-hosted feature availability there.
- Do not copy upstream development settings into production. Prove backup/restore
  of Hanko database plus signing/encryption keys, key rotation, session revocation,
  no-access registration, SMTP outage and authority separation.
- License obligations are a release-owner review item. This document identifies
  upstream licenses; it does not make a legal determination about distribution.
