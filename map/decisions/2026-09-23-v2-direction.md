---
id: v2-direction-2026-09-23
type: decision
title: Separate installed V2 with automatic Orthanc intake
universe: live
status: verified
updated: 2026-09-23
revision: hanko-confirmation-2026-09-23
---

# Separate installed V2 with automatic Orthanc intake

## Approved direction

The 23 September user request authorizes a separate V2 planning folder and plan,
preserving V1. Selected direction: TypeScript, pnpm/Turbo monorepo, Next.js,
Electron on Windows/macOS, Hanko replacing Clerk, one centre with named staff,
automatic intake from private local Orthanc and cloud object storage. Earlier
clarification requires synchronization after quit/lock/logout while the host and
dependencies permit work. User-selected ICM memory replaces a wiki in V2.

This supersedes V1's one-root-package/no-monorepo and wiki conventions **for V2**.
The user's follow-up on 23 September authorizes the separate V2 project scaffold,
with its plan and necessary files copied into that sibling folder. Clinical
integration, V1 migration, deployment and message send remain later work.

## Proposed choices

Sibling path `/Users/valekar/Projects/clarity-v2`; independently managed system
service packaged with Electron; dedicated cloud backend; verified-email staff
onboarding; fixed admin/staff roles; Report-local patient snapshots; five-minute
polling; direct private intake-object upload followed by cloud Orthanc indexing.
These are design proposals with P0 proof gates, not completed integrations.

## Open inputs

The user clarified on 23 September 2026 that Hanko alone owns V2 staff identity;
the earlier Auth0 wording no longer creates a provider choice. The user specified
synthetic-only integration proofs for now. OS details, real cloud/source inputs,
packaging, capacity, retention and recipient verification remain in the plan's
open inputs.

## Impact and source

Canonical [approved/proposed split](../../docs/01-final-clarity-v2-plan.md#approved-direction-proposals-and-open-inputs)
and [open inputs](../../docs/01-final-clarity-v2-plan.md#open-inputs-and-explicit-gates).
Affected: [source/service](../objects/source-and-service.md),
[staff identity](../objects/staff-identity.md), [Report package](../objects/report-package.md).
