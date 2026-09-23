---
id: v2-implementation-start-2026-09-23
type: session
title: Start phased V2 implementation with synthetic proofs
universe: live
status: verified
updated: 2026-09-23
revision: implementation-start-2026-09-23
---

# Start phased V2 implementation with synthetic proofs

## Request and result

User authorized implementation of the [active plan](../../docs/01-final-clarity-v2-plan.md)
with parallel Luna implementation and Astra advice. An initial checklist audit
found no fully accepted task in the scaffold. User confirmed Hanko-only staff
identity and synthetic-only integration work for now. Updated the
[direction decision](../decisions/2026-09-23-v2-direction.md), plan and Hanko
research; clarified manifest sealing, global DICOM UID ownership, source reset
and stale device fencing. Real OS/clinic/cloud inputs remain open.

The workspace now has [source policy and CI checks](../../scripts/source-policy.ts),
a [synthetic staff UI](../../apps/web/src/app/page.tsx) and compiled
[manifest/readiness rules](../../libs/domain/src/index.ts). P1.2 and P2.3
are checked, backed by [workspace evidence](../../docs/evidence/01-workspace-checks.md)
and [browser evidence](../../docs/evidence/02-staff-ui.md). No
clinical API, Orthanc synchronization, authenticated viewer or messaging is active.

## Verification

The initial map regeneration and `pnpm run check` passed, including
documentation, source policy, formatting, lint and strict TypeScript checks.
The compiled service/worker/domain external-directory import probe passed.
After adding the browser-library boundary rule, full `check` correctly flagged
`libs/domain/src/index.ts` importing `node:crypto`. The domain package now
injects its canonical hasher and passes that gate. Frozen install, root build,
typecheck, format, lint, docs/line-limit and seven root policy/parser tests pass.
The synthetic browser review covered desktop and 375px layouts, labels, keyboard
navigation, invalid mobile feedback, sample doctor autofill and disabled Send.

The disposable [Docker data-path proof](../../docs/evidence/03-ingestion-proof.md)
passed its initial narrow synthetic scope. The later bounded benchmark and
transport decision close P0.4 below. The [local SQLite/discovery proof](../../docs/evidence/04-local-discovery.md)
passed twenty-one synthetic and crash tests plus a filtered forced frozen install.
It now includes bounded global Orthanc instance inventory, replay, callable
periodic reconciliation, source leases and generation-fenced queue commits.
A pinned Orthanc container confirmed its child instance route ignores paging
parameters, while the global route paginates for a static source. Versioned
Orthanc source shows deletion events are not a durable change journal, so P3.2
remains open for mutation-safe inventory and a running service. PostgreSQL
proof passed with [database evidence](../../docs/evidence/06-database-foundation.md),
while P3.4/P4.2 remain open for connected service and Ready behaviour. No centre data, V1 runtime, deployed environment,
installed service or real recipient was used.

The [isolated cloud proof](../../docs/evidence/07-cloud-stack.md) then passed
fresh Clarity/Hanko migrations, Hanko readiness/effective cookie configuration,
role-denial checks, synthetic Orthanc PostgreSQL/S3/DICOMweb readback, container
replacement and database/object restore into new volumes. Disposable resources
were removed. P1.3 remains open for browser topology and final application
runtime images.
The [pure manifest decisions](../../docs/evidence/08-manifest-decisions.md) now
use a caller-injected canonical SHA-256 hasher and explicit seal-time stability;
P4.2 remains open for trusted inventory and running persistence.
An independent [Hanko v3 protocol proof](../../docs/evidence/09-hanko-protocol.md)
completed synthetic Mailpit registration, passcode sessions, logout/replay denial
and fresh login. It does not yet grant application staff access or prove browser
cookie behaviour; P0.2/P2.1 remain open.
The [server-only session adapter](../../docs/evidence/10-hanko-session-adapter.md)
now normalizes bounded passive Hanko validation and passes nine focused tests;
identity repository and protected API authorization still remain.
The [disposable macOS lifecycle probe](../../docs/evidence/11-macos-lifecycle-probe.md)
staged exact Node/SQLite binaries, tested foreground heartbeat and crash recovery,
and linted an unregistered launchd plist. Installed logout/boot/Windows acceptance
remains open for P0.3/P5.
The [staff access database proof](../../docs/evidence/12-staff-access-database.md)
then applied migration 0003 and proved concurrent enrollment/bootstrap,
audited function grants, exact denial SQLSTATEs and last-admin protection under
READ COMMITTED and REPEATABLE READ. The full cloud replacement/restore proof
passed again with three Clarity migrations. Application actor binding remains
open for P2.1/P2.2.
The [database-backed staff guard proof](../../docs/evidence/13-staff-access-guard.md)
then passed with real disposable PostgreSQL and a synthetic Hanko HTTP responder.
It checks current membership for every action and keeps unknown identities pending;
protected routes and provider-issued two-identity proof remain open.
The [anchored inventory process proof](../../docs/evidence/14-anchored-inventory.md)
then passed 31 focused tests and a compiled synthetic child process. Orthanc
1.13.0/PostgreSQL index ordering probes passed for small datasets on PostgreSQL
16 and 18.6. Independent Astra review found three P1 crash/resume and
generation-restart holes. The Luna implementation agent corrected atomic
final-page/revalidation persistence, fixed-horizon replay continuation after
restart, and generation reset during scan/revalidation; all three have focused
regressions. P3.2 remains open for a continuously running service and connected
admission.
The [worker foundation](../../docs/evidence/15-worker-foundation.md) passed 10
focused tests, a four-migration PostgreSQL proof and the full isolated cloud
adapter/restore proof. The worker has a separate limited database role and
durable post-commit intake cleanup state. P4.1 remains open for a single
running worker that consumes a durable received upload across all stores.

The [two-identity Hanko web proof](../../docs/evidence/16-staff-web-hanko.md)
then passed on disposable PostgreSQL/Hanko/Mailpit and the standalone Next
server. Both provider identities enrolled pending and denied; an audited
operator promoted one, who granted and disabled the other through protected
routes. Role, Origin, stale-version, last-admin and logout-replay denials
passed. P2.1 and P2.2 are checked; real browser cookie topology and packaged
Electron remain open under P0.2/P1.3.

Separate [web](../../deploy/cloud/Dockerfile.web) and
[worker](../../deploy/cloud/Dockerfile.worker) images built from a frozen pnpm
install on the pinned Node base. The web image served the synthetic shell and
denied an anonymous staff API; the worker image failed closed without secrets.
They are not connected to the final Compose runtime, so P1.3 stays open.

A later optional [Chromium browser proof](../../docs/evidence/16-staff-web-hanko.md)
completed disposable Hanko registration and passcode login from the web origin,
stored the Secure/HttpOnly cookie across localhost ports, and changed the
protected route result from 401 to pending 403. The initial IP-host attempt
did not retain the Secure cookie. The runner now uses localhost and copies its
standalone web files into private proof storage to survive concurrent builds.
Hanko Elements UI, packaged Electron, HTTPS domain topology and P1.3 remain open.

The [bounded path benchmark](../../docs/evidence/03-ingestion-proof.md) then
streamed 769 generated DICOM instances across small, medium and one large
profile through source Orthanc, private intake and cloud Orthanc. All readbacks
matched SHA-256/size; 638,103,120 actual DICOM bytes generated 5.0× measured
payload-edge traffic over 38.009 seconds on a disposable local stack. Its
separate baseline verified a late `NewInstance` signal and cloud-byte survival
after proof-source volume replacement. P0.4 is checked and the private intake
→ validating worker → cloud Orthanc path selected. Centre capacity and
production reset reconciliation remain open.

The [Electron hosted shell prototype](../../docs/evidence/17-desktop-hosted-auth-shell.md)
then built with four origin/navigation tests. Configured builds open the
hosted sign-in route in a persistent isolated partition and deny off-allowlist
navigation, requests, windows and permissions. No packaged Hanko login,
recovery/passkey, real browser cookie or installed service acceptance has run;
P0.2 and P5 stay open.

The [running-worker proof](../../docs/evidence/15-worker-foundation.md) then
passed against disposable PostgreSQL, scoped private intake and Orthanc. A
staged byte snapshot prevents mutation between validation and import; 12
focused worker tests pass. SIGKILL during completion rolled the DB back,
restart reconciled the existing Orthanc instance, and a second kill after
commit left only intake cleanup for the next restart. A later advisory review
found that this path did not recheck a superseded device fence before import;
P4.1 was reopened pending a takeover/revoke proof. Connected local admission
and broad clinical content remain open.

The [observed manifest migration/proof](../../docs/evidence/18-manifest-persistence.md)
then passed on a disposable five-migration database. Device-role draft/page/seal
functions require current source lease/generation and compare-and-swap version,
recompute the exact member digest, and persist immutable source evidence. The
Ready trigger requires a current-generation proof and all members indexed. A
late second SOP reopened the Report, and a source-generation trigger now moves
Ready Reports out of Ready atomically. The running worker crash harness passed
again on migration 0005. P4.2 remains open for connected trusted inventory and
frozen-dispatch behavior.

The [local spool and sync-loop proof](../../docs/evidence/19-local-spool-and-loop.md)
then passed 45 compiled tests, later 47/47 after source PatientID issuer and
full-snapshot clearing regressions. The injected loop advances anchored inventory,
changes, periodic reconciliation and bounded uploads. A SQLite spool stores
private bytes, hashes and multipart receipts; lost provider/completion replies,
expired URLs, capacity loss and changed bytes have focused regressions. Review
found the initial text/UUID admission-key, Bearer/device-auth and local/cloud
generation mismatches; the local client now uses a deterministic UUIDv5 key and
the `ClarityDevice` scheme, while cloud lease generation/fencing will come from
P3.1/P3.4. The production service entry remains closed and P3.2/P3.3 open.

A [macOS installer scaffold](../../docs/evidence/20-macos-installer-scaffold.md)
then passed disposable package layout and temporary-root upgrade, rollback,
uninstall-preservation tests. It leaves the launchd template inert and has no
actual install, signed package, full bundled Node execution or Windows proof.
P0.3/P5 remain open. Rebuildable Docker builder cache older than one day was
pruned after disk pressure; no containers or volumes were removed by that action.

The [cloud stack proof](../../docs/evidence/07-cloud-stack.md) reran with seven
application migrations and narrow runtime roles, including backup/restore.
Adding an optional device-auth login exposed a non-executable init script,
which was made executable. The next run reached restore and exposed an
extension-owner comment mismatch; the restore command now excludes comments.
The updated device-role restore path still needs a clean rerun.

Astra advisory review identified four current P1 implementation gaps:
nullable lease comparisons in manifest/renewal functions, unrestartable
partial draft manifests, patient fields that can mix across changed source
identity, and worker import after device-fence supersession. The implementers
are correcting these with disposable PostgreSQL and worker proofs. None is
recorded as accepted merely because a prior component test passed.

A [disposable device pairing proof](../../docs/evidence/21-device-pairing.md)
later passed through migration 0009: one-time admin code, expiry/replay denial,
restricted device credential, explicit source lease DTO, revocation fence and
role isolation. Focused web/server/desktop checks cover fixed endpoints and
the narrow admin IPC. The production service does not yet store credentials
or use the lease, and packaged desktop behavior remains unproven; P3.1 stays
open.

Read-only advisory review found the pinned proof MinIO image is not a maintained
production storage choice and the versioned Hanko v3 cookie defaults differ from
older SDK guidance. Updated the [ingestion evidence](../../docs/evidence/03-ingestion-proof.md)
and [Hanko research](../../docs/research/hanko.md); OI-03 and packaged auth proof
remain open.

An independent [cold ICM walk](../../docs/evidence/05-map-routing.md) reached web,
desktop, worker, sync, domain and database owners. It found persistence-impact
routing gaps; the effects route and root/ACTIVE scope wording were corrected.
The [Report](../objects/report-package.md), [identity](../objects/staff-identity.md)
and [source](../objects/source-and-service.md) cards now link the PostgreSQL
foundation while keeping clinical runtime ghost/stub. A real Mermaid parser,
updated cards and a second [cold walk](../../docs/evidence/05-map-routing.md)
now close P1.4 for the current implemented owners. CI runs the same docs gate.

Read-only advisory review of the expanded discovery code identified queue replay,
concurrent inventory and generation-fencing cases. The first correction pass
addresses these in SQLite tests; the offset anchor/backend ordering proof and
bounded metadata remain implementation follow-ups, not accepted P3.2 evidence.

## Map review and next step

ICM reviewed: [foundation shells](../objects/foundation-shells.md) now include
the synthetic UI and pure domain package. [Source/service](../objects/source-and-service.md),
[staff identity](../objects/staff-identity.md) and
[Report package](../objects/report-package.md) remain ghost/stub runtime owners.
Complete the remaining disposable proofs, then reassess individual
checklist boxes against their full acceptance language.
