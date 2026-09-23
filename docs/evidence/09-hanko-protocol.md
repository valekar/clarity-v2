# Disposable Hanko v3 authentication protocol proof

Date: 2026-09-23. Command: `bash deploy/cloud/scripts/proof-hanko-v3.sh`;
exit code 0. The [standalone driver](../../deploy/cloud/scripts/prove-hanko-flow.py)
started only disposable PostgreSQL, Hanko v3.0.4 and Mailpit services with
random temporary credentials and a synthetic `example.invalid` address.
It used Hanko's returned action URLs and CSRF tokens, following the v3 flow API.

The proof registered one synthetic account, received passcodes through Mailpit,
and validated a session cookie. The cookie carried HttpOnly, Secure and
SameSite=Strict attributes, while X-Auth-Token was absent. The driver checked
the configured proof cookie name, domain and path on issue and expiry. Passive
session validation returned a verified email plus the configured synthetic issuer and
audience, UUID subject/session IDs and future RFC3339 expiration. Logout issued
an expiry cookie and revoked the saved session: replay validation returned
invalid. A fresh passcode login reached the same subject with a different
session ID and the same secure cookie attributes. A guaranteed-different wrong
code produced Hanko's specific `passcode_invalid` response; malformed-cookie
validation did not authorize. The driver bounds HTTP responses, total request
time and Mailpit polling, and keeps passcodes/cookies out of its result text.
The disposable Compose containers and volumes were removed.

This proves the live Hanko protocol over a local HTTP client that forwards the
cookie explicitly. A later [Chromium proof](16-staff-web-hanko.md) verified
local cross-port cookie storage and protected-route use, while the staff web
proof completed no-access registration and admin bootstrap. Production HTTPS
origin topology, Electron cookie persistence, logout across open windows and
real email delivery remain untested. P0.2 remains open for those platform gates.
