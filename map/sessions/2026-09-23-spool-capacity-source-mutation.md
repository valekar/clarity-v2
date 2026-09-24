---
id: spool-capacity-source-mutation-2026-09-23
type: session
title: Prove synthetic spool capacity and source mutation handling
universe: live
status: verified
updated: 2026-09-23
revision: p3-3-spool-mutation-proof-2026-09-23
---

# Prove synthetic spool capacity and source mutation handling

## Request and result

Added a focused transfer regression to the existing synthetic sync-service
suite. It mutates Orthanc bytes after a signed PUT accepts the original spool
and verifies that cloud completion is withheld, the spool is retained and the
durable upload is marked `needs-attention`. Existing regressions in the same
suite cover low space before and during streaming, changed source bytes before
admission, and changed local spool bytes. Detailed results are in the
[synthetic P3.3 evidence](../../docs/evidence/31-spool-capacity-source-mutation.md).

## Verification

The sync-service build and test TypeScript compilation passed. The focused
`upload-transfer.test.js` run passed 16/16. The added race test confirms one
accepted PUT and zero completion requests after the source mutation. Low-space
behavior uses an injected free-space probe and proves cleanup/state behavior,
not native filesystem ENOSPC semantics. No clinic data, live Orthanc, cloud
account or real recipient was used.

## Map review and next step

Reviewed the [source/service relationship](../objects/source-and-service.md)
and exact spool/uploader implementations. Its map fact and links were already
accurate, so no relationship card changed. The remaining P3.3 evidence must
cover OS service and filesystem behavior plus its broader connected recovery
acceptance before its plan checkbox can be closed.
