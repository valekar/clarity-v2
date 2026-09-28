# Hanko staff username and password proof

**Status:** Synthetic Hanko v3.0.4 public signup denial, administrator
provisioning, username/password login, session validation, logout and replay
denial passed on 2026-09-27. This proves the Hanko authentication path; hosted
Coolify login and active Clarity membership remain separate acceptance checks.

## Verified settings

The proof used the repository's pinned
`ghcr.io/teamhanko/hanko:v3.0.4` image and digest. The Coolify runtime and the
focused disposable proof use these settings:

```yaml
account:
  allow_deletion: false
  allow_signup: false
email:
  enabled: false
  optional: true
  acquire_on_registration: false
  acquire_on_login: false
  require_verification: false
  use_as_login_identifier: false
  use_for_authentication: false
email_delivery:
  enabled: false
username:
  enabled: true
  optional: false
  acquire_on_registration: true
  acquire_on_login: true
  use_as_login_identifier: true
  min_length: 3
  max_length: 32
password:
  enabled: true
  optional: false
  acquire_on_registration: always
  acquire_on_login: always
  recovery: false
  min_length: 8
```

With `account.allow_signup: false`, Hanko's public registration flow no longer
advertises the `register_login_identifier` action. The login-only frontend uses
the Hanko `<hanko-login>` element. Hanko's v3.0.4 Admin API supports creating a
username-only user with `POST /users`, then creating its password credential
with `POST /users/{user_id}/password`; the password service hashes the supplied
password into Hanko's database. The Coolify admin listener is bound to
`127.0.0.1:8001`. A short-lived helper shares Hanko's network namespace to call
it; the port is not published or routed through Coolify.

Hanko authenticates the account but does not grant Clarity access. The
repeatable Coolify provisioning command creates no membership and uses the
restricted Clarity operator function to create an identity link. The first
administrator is granted through `bootstrap_first_staff_admin`; an active
administrator grants later staff roles through protected Staff Settings.

## Evidence

Run the focused provider proof with:

```sh
bash deploy/cloud/scripts/proof-hanko-username-password.sh
```

It creates an isolated Compose project and removes its containers, volumes,
network and generated configuration on exit. The proof verified that signup
had no registration action. Repeating Hanko provisioning with a different
password reported an existing account without changing its original password.
That original password logged in without an email claim; `/sessions/validate` returned a valid subject
and session ID, logout invalidated the cookie, and a fresh login created a new
session for the same subject. Credentials and session tokens were not printed.
The disposable Compose stack starts its unused Mailpit dependency, but the
profile has no configured email delivery and the proof sends no messages.

The proof does not establish hosted cookie scope, browser rendering of the
login-only element, Coolify deployment, Clarity active membership or recovery.
Email, passkeys, MFA and account/password recovery are disabled in this test
profile. Recovery remains an open acceptance item.

The proof driver is
[`prove-hanko-username-password.py`](../../deploy/cloud/scripts/prove-hanko-username-password.py),
the disposable service harness is
[`proof-hanko-username-password.sh`](../../deploy/cloud/scripts/proof-hanko-username-password.sh),
and the private username/password helper is
[`provision-hanko-username-password.mjs`](../../deploy/cloud/scripts/provision-hanko-username-password.mjs).
