# Server-only Hanko session adapter

Date: 2026-09-23. The [adapter](../../libs/server/src/auth/hanko-session.ts)
in the new `@clarity/server` package performs passive `GET /sessions/validate`
against a fixed configured Hanko origin. It forwards only the named session
cookie, refuses redirects, uses `no-store`, and bounds request time and response
bytes. HTTP is allowed only for loopback synthetic tests; production origins
must be HTTPS.

The adapter requires a valid provider response, expected issuer/audience,
nonzero UUID subject and session ID, verified email, future session expiration
and future idle expiration when supplied. Invalid sessions and correctly shaped
wrong claims return 401. Provider outage or malformed successful responses
return 503. It does not infer application roles from Hanko claims.

Nine [focused tests](../../libs/server/tests/hanko-session.test.ts) passed,
including duplicate/malformed cookies, fixed URL and single-cookie
forwarding, bad claims, malformed provider DTOs, redirect refusal, timeout and
response-byte limit. The package typecheck/build and owned-file lint passed;
frozen install, root build/typecheck/tests, docs/source-policy checks and the
[compiled external-directory export probe](../../scripts/check-compiled-node.ts)
also passed. The full `pnpm check` at this moment was interrupted by formatting
of concurrently edited sync-service files; that is a separate closeout gate.

P2.1 remains open. This package has no identity repository, application
membership check, protected web route, audited admin bootstrap, browser cookie
topology or packaged Electron test. It has not used a real Hanko cookie against
an application endpoint.
A read-only review found two follow-ups: non-200 provider responses should be
classified as unavailable unless Hanko documents them as invalid sessions,
and early rejected response streams should be canceled. Streaming timeout and
oversized-cookie boundary tests are also pending.
