# Synthetic spool capacity and source mutation proof

Date: 2026-09-23. Scope: focused synthetic P3.3 local spool and upload
recovery cases. The tests use temporary SQLite/spool paths and loopback HTTP
fixtures; they do not contact a clinic source, cloud account or recipient.

The existing [upload-transfer test suite](../../apps/sync-service/test/upload-transfer.test.ts)
now covers these cases:

- Free space below the configured reserve rejects before reading Orthanc or
  creating an upload row.
- Free space falling below the reserve during a streamed response cancels the
  read, removes the partial file and leaves no upload row.
- Orthanc bytes changed before authorization prevent cloud admission, retain
  the original spool snapshot and persist `needs-attention`.
- Orthanc bytes changed after the signed PUT is accepted prevent completion,
  retain the spool snapshot and persist `needs-attention`.
- Local spool corruption prevents authorization and preserves the file for
  review.

The changed-during-transfer case models the race between pre-upload validation
and cloud completion. The fixture confirms that one signed PUT was accepted,
the client sent no completion request, and the durable row needs attention.
Cloud-side reconciliation of an already accepted object remains necessary
before an operator can safely resume this case.

## Verification

From the workspace root, these commands passed:

```sh
pnpm --filter @clarity/sync-service build
pnpm exec tsc -p apps/sync-service/tsconfig.test.json
node --test apps/sync-service/test-dist/test/upload-transfer.test.js
```

The focused Node test file passed 16/16. The low-space condition is injected
through the existing free-space probe; this proves the state transitions and
cleanup behavior, not filesystem-specific ENOSPC semantics, device capacity or
OS service behavior. This evidence is synthetic and does not close the full
P3.3 acceptance.
