# Source reuse assessment

Inspected 2026-09-23. V1 HEAD: `65d77d33dab802d31d15eb60d3d38c29f624846b`.
Its existing documentation changes/untracked maps were present before this work.
They are preserved. These findings describe inspected source, not a new test run.

## What exists

V1 is TypeScript/Next.js with PostgreSQL, pg-boss, resumable tus uploads,
Orthanc/OHIF, S3-compatible storage and Clerk. Staff create/reuse patients and
manually create Reports before file/folder/ZIP intake. Twenty SQL migrations are
present. Source includes staff permissions, processing/recovery, scoped viewing,
atomic dispatch/outbox and delivery adapters. The active plan records deployed
synthetic viewer/storage proof and separate outstanding provider/recipient gates.

Sources: [manifest](../../../clarity/package.json),
[active plan](../../../clarity/docs/ACTIVE.md),
[requirements](../../../clarity/docs/requirements.md),
[architecture](../../../clarity/docs/architecture.html).
These sibling links assume the proposed `Projects/clarity-v2` location.

## Reuse matrix

All destination paths below are **planned**. Reuse means selective copy plus
adaptation and tests, never a runtime dependency on the sibling V1 repository.

| Existing owner | Decision and why | Planned V2 owner / proof |
| --- | --- | --- |
| [staff access core](../../../clarity/libs/domain/staff-access.ts) | Adapt pure permission checks; reduce branch/owner hierarchy to single-centre admin/staff | `libs/domain/src/staff-access.ts`; disabled/unmapped/action-denial tests |
| [staff session](../../../clarity/libs/server/auth/centre-session.ts), [membership repository](../../../clarity/libs/server/auth/repositories/membership-administration-repository.ts) | Rewrite Clerk extraction and literal provider assumptions; do not treat replacement as a UI-only task | `libs/server/src/auth/`; Hanko and authorization integration tests |
| [identity schema](../../../clarity/database/migrations/0004_branch_authorization_foundation.sql) | Reuse stable internal UUID concept; fresh V2 identities/memberships schema | `libs/database/migrations/`; no transplanted Clerk columns |
| [recipient session](../../../clarity/libs/server/auth/recipient-session.ts) | Do not copy verified-Clerk-phone assumptions into Hanko | Deferred recipient-policy gate; no public access until replacement is proven |
| [DICOM validation](../../../clarity/libs/server/imaging/file-validation.ts), [processor](../../../clarity/libs/server/imaging/report-file-processor.ts) | Reuse validation/hash/readback/recovery approach; adapt input from completed intake object | `libs/imaging/src/`, `apps/worker/src/ingestion/`; corrupt/duplicate/crash cases |
| [Orthanc adapter](../../../clarity/libs/server/imaging/orthanc-client.ts) | Adapt cloud import/readback; implement a distinct local read-only discovery adapter | `libs/imaging/src/cloud-orthanc.ts`, `apps/sync-service/src/orthanc/` |
| [PDF object adapter](../../../clarity/libs/server/imaging/hetzner-object-store.ts) | Reuse S3 configuration/readback ideas; it is PDF-oriented, not a direct DICOM upload pipeline | `libs/storage/src/`; scoped multipart admission/completion/readback tests |
| [upload repositories](../../../clarity/libs/server/uploads/upload-session-repository.ts), [tus server](../../../clarity/libs/server/uploads/tus-upload-server.ts) | Preserve durability lessons; omit browser tus endpoints from first V2 when direct multipart intake is selected | `apps/sync-service/src/transfers/`, `libs/server/src/ingestion/`; persistent upload recovery |
| [readiness](../../../clarity/libs/server/imaging/report-readiness.ts) | Adapt from manually frozen file selections to observed study revision manifests | `libs/domain/src/report-readiness.ts`; late-instance and incomplete-set tests |
| [DICOMweb policy](../../../clarity/libs/domain/recipient-dicomweb.ts), [staff file service](../../../clarity/libs/server/sharing/staff-report-file-response.ts) | Reuse scoped read-only gateway rules, cancellation and transfer admission | `libs/server/src/viewing/`; unauthorized study/instance and expiry cases |
| [viewer workspace](../../../clarity/src/features/reports/report-workspace.tsx), [content notice](../../../clarity/src/components/study-content-notice.tsx) | Selectively reuse staff viewer and honest image/nonimage display; codec evidence remains per platform | `apps/web/src/features/viewer/`, `libs/ui/src/`; synthetic CT/nonimage/unsupported syntax |
| [dispatch service](../../../clarity/libs/server/dispatch/report-dispatch-service.ts), [dispatch core](../../../clarity/libs/domain/report-dispatch.ts) | Preserve atomic grants/file snapshot/outbox/idempotency; remove V1-specific provider/branch coupling | `libs/server/src/sharing/`, `libs/domain/src/sharing.ts` |
| [delivery worker](../../../clarity/libs/server/messaging/delivery-worker.ts), [MSG91 adapter](../../../clarity/libs/server/messaging/msg91-adapter.ts) | Reuse bounded retries, uncertain-send reconciliation and callback concepts; adapt to selected V2 channel only | `apps/worker/src/delivery/`, `libs/messaging/src/`; duplicate/unknown-provider-result cases |
| [doctor UI](../../../clarity/src/features/doctors/doctor-combobox.tsx), [phone parsing](../../../clarity/libs/server/reports/phone-number.ts) | Reuse search/select/add and E.164 normalization in sharing screen | `apps/web/src/features/sharing/`, `libs/domain/src/contacts.ts` |
| [brand](../../../clarity/src/components/clarity-brand.tsx), [staff shell](../../../clarity/src/components/staff-shell.tsx) | Preserve identity and accessible primitives; simplify navigation | `libs/ui/src/`, `apps/web/src/components/` |
| [Docker compose](../../../clarity/deploy/docker-compose.yml), [worker](../../../clarity/src/processes/worker.ts) | Reuse health/readiness/persistence pattern with entirely new resources | `deploy/cloud/`, `apps/worker/`; final-image/restore tests |
| [source line check](../../../clarity/scripts/check-source-lines.ts), [synthetic DICOM](../../../clarity/tests/fixtures/synthetic-dicom.ts) | Port checks and safe fixtures with monorepo scope updates | `scripts/`, `tests/fixtures/`; 700/701 boundary and synthetic-only checks |

## Omit from the first V2 build

- Manual New Report wizard, browser file/folder/ZIP DICOM intake, upload-reselection
  UX and manual patient creation as the normal study path.
- Branch switcher, multiple-business ownership, billing, subscriptions, tenant
  administration, examination catalogue and cross-centre patient matching.
- Telegram onboarding, multiple fallback channels and the local arbitrary ZIP
  viewer. Preserve V1; add V2 features only for a demonstrated requirement.
- Source deletion/archive jobs, broad Orthanc proxy, local JSON link database,
  hard-coded credentials and manual OsiriX viewer URL entry.
- Automatic copying of every old migration, compatibility layer or test. Port
  tests that still prove V2 requirements and add genuinely new sync/service tests.

PDF attachment entry is an explicit later input decision: Orthanc-origin DICOM
documents are in scope; do not quietly recreate the old PDF upload wizard.

## Client workflow evidence

The supplied [Flask source](/Users/valekar/Downloads/ClarityScanLink/app.py) exposes
study discovery (`studies`, line 537), application-owned token generation
(`generate`, line 994), the sharing form (`link_page`, line 1151) and WhatsApp
redirection (`wa_send_logged`, line 1523). These were read, not executed.

Earlier recorded Chrome inspection confirmed study filters, doctor
directory, logs/status, a recipient page and the generated-link sharing page.
The latter has patient mobile entry, doctor search/select with mobile autofill,
add-doctor, separate prepared messages, copy controls and a QR code. It currently
opens WhatsApp compose; it does not demonstrate backend delivery. Checklist timed
out and Old Studies could not be verified live. No real sends/record edits occurred.

Retain this compact workflow and automatic source metadata. Do not inherit
bearer-only access, unrestricted proxy routing, exposed-token export, JSON
read/modify/write storage or scan-date deletion. The
[previous source review](../../../clarity/docs/clarity-scanlink-gap-review.md)
contains the earlier synthetic findings; it is not new V2 acceptance evidence.

The shared ChatGPT discussion inspired QR sharing, integrated viewing and reliable
boot/recovery. Its historical proposals are not authorization to change expiry,
recipient verification, backup provider or retention.

## V1 Hanko migration impact — research only

Replacement touches `src/proxy.ts`, root `ClerkProvider`, sign-in/sign-out UI,
`libs/server/auth/centre-session.ts`, `recipient-session.ts`, sign-in return helpers,
membership administration's hard-coded `clerk`, API actor fields, deploy env,
bootstrap tools and their tests. Provider-neutral app UUIDs help but are not a
complete migration. V1 recipient grants rely on verified phone claims that must
not be synthesized from staff-entered numbers.

If requested later: create an explicit identity mapping, verify account ownership,
preserve app user UUIDs/audit/grants, enroll credentials, invalidate old sessions,
test rollback and then cut over. No identity auto-link by matching email alone;
no production export or migration was performed. V2 starts with new staff
enrollment and a fresh database, so this migration is not its prerequisite.
