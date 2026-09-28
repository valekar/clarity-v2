# Hosted Clarity staff application

Input: Hanko session cookie and the dedicated V2 cloud services. Output:
authorization-checked staff pages and scoped APIs. `/` redirects to `/sign-in`;
Hanko owns authentication, while current Clarity PostgreSQL membership grants
staff/admin access. Public signup is disabled for the staff deployment;
administrators provision Hanko users and Clarity identity links before login.
Unknown authenticated identities create no Clarity staff row and have no access.

Protected Studies, Doctors and Settings use left navigation. Doctors lists and
searches active directory entries and accepts Indian mobile numbers in its
synthetic add form; the API stores canonical +91 E.164. See the
[doctor UI proof](../../docs/evidence/43-indian-doctor-directory-ui.md).
Studies query fenced source-backed Reports and open the scoped DICOMweb viewer. Settings shows
staff access controls to admins and offers a named Electron request to navigate
within the same window to bundled local Orthanc configuration. The hosted page
does not receive source credentials; an ordinary browser cannot configure a
workstation. The separate
sharing preview has no final Send until recipient policy and provider gates
are accepted.

The app is not a local desktop backend. Electron hosts these pages when its
trusted dashboard/Hanko origins are configured. The current source and viewer
paths have synthetic proofs; installed service, clinical breadth and recipient
release acceptance are separate plan gates. See
[active plan](../../docs/ACTIVE.md) and
[desktop clarification](../../map/sessions/2026-09-24-desktop-onboarding-source-settings.md).
