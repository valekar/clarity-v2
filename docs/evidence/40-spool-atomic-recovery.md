# Synthetic atomic spool failure and retry proof

Date: 2026-09-24. Scope: local synthetic P3.3 spool commit behavior. Tests use
a loopback Orthanc file response, temporary SQLite database and spool directory.
They do not mount a constrained filesystem, use a clinic source or install the
service.

Three injected failures exercise the spool's atomic-write boundary:

- The writer persists 4 KiB, then throws `ENOSPC` during the next write.
- The rename operation fails after all bytes were written, synced and the file
  handle closed.
- A writer reports more bytes than requested; the spool rejects the invalid
  count before advancing its offset.

For each failure, the client cancels the source response, removes the partial
or complete uncommitted file, and leaves no local upload row. The test closes
and reopens SQLite, confirms the row remains absent, retries against the same
synthetic source bytes, and then closes/reopens SQLite again. The retry leaves
one `spooled` row and file with the exact expected byte count and SHA-256.

## Verification

From the workspace root, these passed:

```sh
pnpm --filter @clarity/sync-service build
pnpm exec tsc -p apps/sync-service/tsconfig.test.json
node --test apps/sync-service/test-dist/test/upload-transfer.test.js apps/sync-service/test-dist/test/spool-atomic-failure.test.js
pnpm exec prettier --check apps/sync-service/src/transfers/spool-instance.ts apps/sync-service/test/spool-atomic-failure.test.ts
pnpm run check:source-policy
git diff --check
```

The focused two-file run passed 19/19 tests. The writer and rename failures
exercise cleanup and queue durability with injected failures; they do not
establish host filesystem ENOSPC, metadata/directory sync behavior, inode
exhaustion, power loss, or OS service recovery. Those need separate installed
macOS and Windows volume-pressure proofs under the service identity.
