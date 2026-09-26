# Indian doctor directory UI correction

Date: 2026-09-24. Scope: disposable synthetic staff demo at
`http://localhost:63795/staff/doctors`; no real patient or doctor data and no
message dispatch.

The original Doctors page used unstyled class names, so labels and inputs ran
together. Its repository returned no rows for a blank search, leaving the
directory empty even when doctors existed. The add form showed a US number and
required users to enter E.164 syntax.

The [Doctors page](../../apps/web/src/app/staff/doctors/DoctorsDirectory.tsx)
now uses a responsive CSS module, a readable empty state, an explicit Add doctor
action, search and status feedback. The [repository](../../libs/database/src/doctor-repository.ts)
loads the first 20 active doctors for a blank search and matches Indian phone
queries that contain visual spaces. The input accepts a 10-digit Indian mobile;
the country code is visible and canonical `+91` E.164 is retained at the API and
database boundary. The server rejects non-Indian doctor mobiles. The synthetic
sharing preview uses the same Indian input guidance. This does not imply that
recipient identity or delivery is ready.

Verification: `pnpm --filter @clarity/web test`, web and database type checks,
`pnpm run check`, `bash deploy/proof-database/prove-doctors.sh`, and the final
Docker web build passed. `/api/health` returned `{"status":"ok"}` after the
web container was recreated. The database proof
covers blank listing, formatted +91 search, duplicate/shared-phone decisions,
concurrent creation, disabled staff denial and rejection of a US number. In the
running staff browser, `Dr. Synthetic Rao` and `Dr. Synthetic Mehta` were added
through the form. Both appeared in the directory with `+91 90000 00001` and
`+91 90000 00002`, respectively. At an 856 px browser width, the two cards
stacked with no horizontal document overflow (`scrollWidth` = `innerWidth` =
856). A formatted `+91 90000 00002` browser search returned only Dr. Synthetic
Mehta. The same two-row directory was visible inside the running Electron
window. A signed installer and full mobile-device check remain outside this proof.
