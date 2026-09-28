---
id: coolify-test-readiness-session-2026-09-27
type: session
title: Prepare an isolated synthetic Coolify test deployment
universe: live
status: verified
updated: 2026-09-27
revision: coolify-test-readiness-session-2026-09-27
---

# Prepare an isolated synthetic Coolify test deployment

## Request and result

The user asked whether Clarity V2 is in a good position and to finish the work
needed for Coolify testing. The [active plan](../../docs/ACTIVE.md) now has a
separate CT.1–CT.3 checkpoint. CT.1 closes only the static configuration gate:
the [synthetic Coolify stack](../../deploy/cloud/coolify-test/README.md) uses
persistent V2-only state, private infrastructure services and an external
dedicated HTTPS S3 intake contract. A
[hosted smoke script](../../deploy/cloud/scripts/coolify-smoke.mjs) is prepared
but unrun. A [disposable Hanko proof](../../docs/evidence/46-hanko-username-password.md)
passed no-email username/password, and the
[staff adapter](../../libs/server/src/auth/hanko-session.ts) now accepts valid
Hanko sessions without email while keeping issuer/subject authorization.

No Coolify deployment occurred. The separate production staff-pilot and
recipient-sharing gates remain open.

## Verification

The [preflight evidence](../../docs/evidence/47-coolify-test-preflight.md)
records successful Compose rendering, script syntax, workspace checks/tests,
and the earlier disposable local image/migration/restore proof. The
[smoke evidence](../../docs/evidence/45-coolify-test-smoke.md) records the API
contract review and that hosted execution is pending. Local Docker later
stopped responding to a read-only daemon query, so no additional container
integration result was claimed. No real identities, messages or patient studies
were used.

## Map review and next step

Updated [planning workspace](../objects/planning-workspace.md) and
[staff identity](../objects/staff-identity.md). The
[cloud owner](../../deploy/cloud/CONTEXT.md) records the test topology. Source
ingestion and recipient boundaries were reviewed; their runtime status did not
change. Next: obtain the dedicated Coolify host, sibling HTTPS domains, scoped
test bucket/keys and synthetic tester/device credentials, then execute hosted
login, signed upload, Ready/view, restart and restore acceptance. Production
account recovery and centre installation remain separate inputs.
