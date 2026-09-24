import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";

test("manifest attempts and page progress recover after process reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-manifest-state-"));
  const path = join(directory, "state.sqlite");
  try {
    let store = new CheckpointStore(path);
    const input = {
      sourceKey: "synthetic-source",
      studyInstanceUid: "1.2.3",
      generation: 1,
      cloudGeneration: 7,
      expectedReportVersion: 4,
      digest: "a".repeat(64),
      observedAt: new Date().toISOString(),
    };
    const attempt = store.manifests.startAttempt(input);
    assert.ok(attempt.attemptId);
    store.manifests.recordRevision(input.sourceKey, input.studyInstanceUid, attempt.attemptId!, 1);
    store.manifests.advancePage(input.sourceKey, input.studyInstanceUid, attempt.attemptId!, 0, 2);
    store.close();

    store = new CheckpointStore(path);
    const resumed = store.manifests.startAttempt(input);
    assert.equal(resumed.attemptId, attempt.attemptId);
    assert.equal(resumed.revision, 1);
    assert.equal(resumed.nextMember, 2);
    store.manifests.finishAttempt(input.sourceKey, input.studyInstanceUid, attempt.attemptId!);
    const committed = store.manifests.get(input.sourceKey, input.studyInstanceUid)!;
    assert.equal(committed.currentRevision, 1);
    assert.equal(committed.currentDigest, input.digest);
    assert.equal(
      store.manifests.startAttempt({ ...input, expectedReportVersion: 5 }).attemptId,
      null,
    );

    const changed = store.manifests.startAttempt({
      ...input,
      expectedReportVersion: 5,
      digest: "b".repeat(64),
    });
    assert.notEqual(changed.attemptId, attempt.attemptId);
    assert.equal(changed.expectedCurrentRevision, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired source observation starts a fresh attempt while unchanged sealed content is a no-op", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-manifest-freshness-"));
  const store = new CheckpointStore(join(directory, "state.sqlite"));
  try {
    const base = {
      sourceKey: "synthetic-source",
      studyInstanceUid: "1.2.4",
      generation: 1,
      cloudGeneration: 8,
      expectedReportVersion: 5,
      digest: "c".repeat(64),
    };
    const old = store.manifests.startAttempt({
      ...base,
      observedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    const fresh = store.manifests.startAttempt({ ...base, observedAt: new Date().toISOString() });
    assert.notEqual(fresh.attemptId, old.attemptId);
    assert.equal(fresh.nextMember, 0);
    store.manifests.recordRevision(base.sourceKey, base.studyInstanceUid, fresh.attemptId!, 1);
    store.manifests.advancePage(base.sourceKey, base.studyInstanceUid, fresh.attemptId!, 0, 1);
    store.manifests.finishAttempt(base.sourceKey, base.studyInstanceUid, fresh.attemptId!);
    const unchanged = store.manifests.startAttempt({
      ...base,
      expectedReportVersion: 6,
      observedAt: new Date().toISOString(),
    });
    assert.equal(unchanged.attemptId, null);
    const lateInstance = store.manifests.startAttempt({
      ...base,
      digest: "d".repeat(64),
      expectedReportVersion: 6,
      observedAt: new Date().toISOString(),
    });
    assert.equal(lateInstance.expectedCurrentRevision, 1);
    assert.ok(lateInstance.attemptId);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unchanged manifest bytes are published again after a source generation reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-manifest-generation-"));
  const store = new CheckpointStore(join(directory, "state.sqlite"));
  try {
    const input = {
      sourceKey: "synthetic-source",
      studyInstanceUid: "1.2.5",
      generation: 3,
      cloudGeneration: 9,
      expectedReportVersion: 4,
      digest: "e".repeat(64),
      observedAt: new Date().toISOString(),
    };
    const first = store.manifests.startAttempt(input);
    store.manifests.recordRevision(input.sourceKey, input.studyInstanceUid, first.attemptId!, 1);
    store.manifests.advancePage(input.sourceKey, input.studyInstanceUid, first.attemptId!, 0, 1);
    store.manifests.finishAttempt(input.sourceKey, input.studyInstanceUid, first.attemptId!);

    const sameGeneration = store.manifests.startAttempt({
      ...input,
      expectedReportVersion: 5,
      observedAt: new Date().toISOString(),
    });
    assert.equal(sameGeneration.attemptId, null);

    const resetGeneration = store.manifests.startAttempt({
      ...input,
      generation: 4,
      expectedReportVersion: 5,
      observedAt: new Date().toISOString(),
    });
    assert.ok(resetGeneration.attemptId);
    assert.equal(resetGeneration.currentGeneration, 3);
    assert.equal(resetGeneration.expectedCurrentRevision, 1);
    store.manifests.recordRevision(
      input.sourceKey,
      input.studyInstanceUid,
      resetGeneration.attemptId!,
      2,
    );
    store.manifests.advancePage(
      input.sourceKey,
      input.studyInstanceUid,
      resetGeneration.attemptId!,
      0,
      1,
    );
    store.manifests.finishAttempt(
      input.sourceKey,
      input.studyInstanceUid,
      resetGeneration.attemptId!,
    );
    assert.equal(
      store.manifests.get(input.sourceKey, input.studyInstanceUid)?.currentGeneration,
      4,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lost successful seal response reconciles from exact cloud proof after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-manifest-lost-seal-"));
  const path = join(directory, "state.sqlite");
  let store = new CheckpointStore(path);
  try {
    const input = {
      sourceKey: "synthetic-source",
      studyInstanceUid: "1.2.6",
      generation: 2,
      cloudGeneration: 12,
      expectedReportVersion: 10,
      digest: "f".repeat(64),
      observedAt: new Date().toISOString(),
    };
    const attempt = store.manifests.startAttempt(input);
    store.manifests.recordRevision(input.sourceKey, input.studyInstanceUid, attempt.attemptId!, 4);
    store.manifests.advancePage(input.sourceKey, input.studyInstanceUid, attempt.attemptId!, 0, 1);
    store.close();

    store = new CheckpointStore(path);
    const reconciled = store.manifests.reconcileCloudProof(
      input.sourceKey,
      input.studyInstanceUid,
      {
        currentRevision: 4,
        currentDigest: input.digest,
        currentGeneration: input.cloudGeneration,
        reportVersion: 11,
      },
    );
    assert.equal(reconciled, "sealed-attempt");
    const committed = store.manifests.get(input.sourceKey, input.studyInstanceUid)!;
    assert.equal(committed.attemptId, null);
    assert.equal(committed.currentRevision, 4);
    assert.equal(committed.currentDigest, input.digest);
    assert.equal(committed.currentGeneration, input.generation);
    assert.equal(committed.currentCloudGeneration, input.cloudGeneration);
    assert.equal(
      store.manifests.startAttempt({ ...input, expectedReportVersion: 11 }).attemptId,
      null,
    );

    const mismatch = store.manifests.reconcileCloudProof(input.sourceKey, input.studyInstanceUid, {
      currentRevision: 5,
      currentDigest: "a".repeat(64),
      currentGeneration: input.cloudGeneration + 1,
      reportVersion: 12,
    });
    assert.equal(mismatch, "refreshed");
    const rebuild = store.manifests.startAttempt({
      ...input,
      cloudGeneration: input.cloudGeneration + 1,
      expectedReportVersion: 12,
      observedAt: new Date().toISOString(),
    });
    assert.ok(rebuild.attemptId);
    assert.equal(rebuild.expectedCurrentRevision, 5);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("versioned local migrations preserve a pre-manifest checkpoint and pending job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-local-migration-"));
  const path = join(directory, "state.sqlite");
  try {
    let store = new CheckpointStore(path);
    store.capturePage(
      "migration-source",
      { databaseServerIdentifier: "synthetic-db", databaseVersion: 6 },
      0,
      {
        last: 1,
        done: true,
        changes: [
          {
            sequence: 1,
            changeType: "NewInstance",
            resourceType: "Instance",
            orthancId: "instance-a",
          },
        ],
      },
    );
    store.close();
    const legacy = new Database(path);
    legacy.exec("DROP TABLE local_manifest_state; DROP TABLE local_schema_migration;");
    legacy.close();

    store = new CheckpointStore(path);
    assert.equal(store.getCheckpoint("migration-source")?.cursor, 1);
    assert.equal(store.listPending("migration-source", 10).length, 2);
    const reopened = new Database(path);
    const versions = reopened
      .prepare("SELECT version FROM local_schema_migration ORDER BY version")
      .all() as Array<{ version: number }>;
    reopened.close();
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4],
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
