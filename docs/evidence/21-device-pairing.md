# Synthetic device pairing and lease proof

Date: 2026-09-23. `bash deploy/proof-database/prove-device-security.sh`
passed against a disposable PostgreSQL 18.6 database after migrations
0001–0009. The harness removed its container and anonymous volume and checked
that neither remained. All identities and source rows were synthetic.

The proof exercised admin-created one-time pairing, verifier-only token
storage, expired and consumed code denial, device-created credential response,
source-bound lease generation/fencing DTO, revocation clearing and advancing
the fence, and restricted SQL roles. The staff runtime cannot consume a code
or read a device credential verifier; the device role cannot create admin
pairings, read staff identities or read unrelated Reports. A newly paired
device did not receive a lease until it explicitly acquired one. Lost pairing
response recovery requires a fresh admin code rather than replay of the old
code.

The web now has staff-admin pair/revoke routes and a device-initiated code
exchange route; the server tests cover their credential separation. The
Electron bridge limits requests to the trusted main frame, fixed operations
and configured Hanko cookie name. Domain tests (9), desktop tests (7), server
tests (22), and desktop/server/database builds passed. A web build passed
before the worker added an issuer field; the latest web typecheck awaits that
worker-owned StudyObservation DTO update. A packaged Electron/native IPC run and a containerized two-identity
pairing journey have not run. The service does not yet store a paired credential
in a protected OS vault or connect its production entry to the lease route.
P3.1 and P0.3 therefore remain open.
