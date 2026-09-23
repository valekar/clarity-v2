import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";

let directory: string;
let databasePath: string;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "clarity-sync-checkpoint-"));
  databasePath = join(directory, "sync.sqlite");
});

after(() => rmSync(directory, { recursive: true, force: true }));

test("page jobs and cursor commit together, replay is idempotent, and state survives reopen", () => {
  let store = new CheckpointStore(databasePath);
  const identity = { databaseServerIdentifier: "source-a", databaseVersion: 7 };
  const page = {
    last: 2,
    done: true,
    changes: [
      { sequence: 1, changeType: "NewInstance", resourceType: "Instance", orthancId: "instance-a" },
      { sequence: 2, changeType: "StableStudy", resourceType: "Study", orthancId: "study-a" },
    ],
  };
  const first = store.capturePage("fixture", identity, 0, page);
  assert.equal(first.checkpoint.cursor, 2);
  assert.equal(first.checkpoint.generation, 0);
  assert.equal(first.resetDetected, true);
  assert.deepEqual(
    store.listPending("fixture").map((job) => job.changeType),
    ["reconcile-source", "NewInstance", "StableStudy"],
  );
  store.capturePage("fixture", identity, 0, page);
  const jobs = store.listPending("fixture");
  assert.equal(jobs.length, 3);
  assert.throws(
    () =>
      store.capturePage("fixture", identity, 0, {
        last: 9,
        done: true,
        changes: [
          { sequence: 9, changeType: "NewInstance", resourceType: "Instance", orthancId: "stale" },
        ],
      }),
    /stale Orthanc page/,
  );
  assert.equal(store.getCheckpoint("fixture")?.cursor, 2);
  assert.equal(store.listPending("fixture").length, 3);
  store.markProcessing(jobs[1]!.id);
  store.close();

  store = new CheckpointStore(databasePath);
  assert.equal(store.getCheckpoint("fixture")?.cursor, 2);
  assert.equal(store.listPending("fixture")[1]?.attempts, 1);
  store.markComplete(jobs[1]!.id);
  assert.equal(store.listPending("fixture").length, 2);
  store.close();
});

test("source identity changes advance generation and queue reconciliation with the page", () => {
  const path = join(directory, "generation.sqlite");
  const store = new CheckpointStore(path);
  store.capturePage("fixture", { databaseServerIdentifier: "source-a", databaseVersion: 7 }, 0, {
    last: 5,
    done: true,
    changes: [],
  });
  const result = store.capturePage(
    "fixture",
    { databaseServerIdentifier: "source-b", databaseVersion: 7 },
    0,
    {
      last: 1,
      done: true,
      changes: [
        { sequence: 1, changeType: "NewInstance", resourceType: "Instance", orthancId: "replayed" },
      ],
    },
  );
  assert.equal(result.checkpoint.cursor, 1);
  assert.equal(result.checkpoint.generation, 1);
  assert.equal(result.checkpoint.reconciliationRequired, true);
  assert.deepEqual(
    store.listPending("fixture").map((job) => [job.generation, job.changeType]),
    [
      [1, "reconcile-source"],
      [1, "NewInstance"],
    ],
  );
  store.close();
});

test("queue lease is exclusive, renewable, and reclaimable after expiry", () => {
  const store = new CheckpointStore(join(directory, "queue-lease.sqlite"));
  store.capturePage("lease-source", { databaseServerIdentifier: "lease", databaseVersion: 6 }, 0, {
    last: 0,
    done: true,
    changes: [],
  });
  assert.equal(store.acquireQueueLease("lease-source", "worker-a", 1_000, 10_000), true);
  assert.equal(store.acquireQueueLease("lease-source", "worker-b", 1_000, 10_500), false);
  assert.equal(store.renewQueueLease("lease-source", "worker-a", 1_000, 10_500), true);
  assert.equal(store.acquireQueueLease("lease-source", "worker-b", 1_000, 11_600), true);
  assert.equal(store.renewQueueLease("lease-source", "worker-a", 1_000, 11_600), false);
  store.close();
});

test("page limit is bounded", () => {
  const store = new CheckpointStore(join(directory, "bounds.sqlite"));
  assert.throws(() => store.listPending("fixture", 501), /between 1 and 500/);
  store.close();
});

test("an uncommitted process death rolls back both checkpoint and queued event", async () => {
  const path = join(directory, "crash.sqlite");
  const marker = join(directory, "crash.marker");
  const store = new CheckpointStore(path);
  store.capturePage("fixture", { databaseServerIdentifier: "source-a", databaseVersion: 7 }, 0, {
    last: 1,
    done: true,
    changes: [
      { sequence: 1, changeType: "NewInstance", resourceType: "Instance", orthancId: "durable" },
    ],
  });
  const helperPath = new URL("./crash-writer.js", import.meta.url);
  const child = spawn(process.execPath, [helperPath.pathname, path, marker], { stdio: "ignore" });
  try {
    let started = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        started = readFileSync(marker, "utf8") === "transaction-open";
        if (started) break;
      } catch {
        await delay(20);
      }
    }
    assert.equal(started, true, "child opened its transaction");
    child.kill("SIGKILL");
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code, signal) =>
        signal === "SIGKILL" ? resolve() : reject(new Error(`child exit ${code}/${signal}`)),
      );
      child.once("error", reject);
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  store.close();
  const reopened = new CheckpointStore(path);
  assert.equal(reopened.getCheckpoint("fixture")?.cursor, 1);
  assert.deepEqual(
    reopened.listPending("fixture").map((job) => job.orthancId),
    [null, "durable"],
  );
  reopened.close();
});
