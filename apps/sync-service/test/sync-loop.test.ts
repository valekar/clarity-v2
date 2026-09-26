import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";
import { classifySyncFailure, nextPollDelayMs, SyncLoop } from "../src/runtime/sync-loop.js";
import type { InventoryCoordinator } from "../src/discovery/inventory-coordinator.js";
import type { OrthancChangeFeedAdapter } from "../src/orthanc/change-feed.js";
import type { OrthancDiscoveryClient } from "../src/orthanc/discovery-client.js";
import type { IngestionClient } from "../src/transfers/ingestion-client.js";
import { OrthancUnavailableError } from "../src/orthanc/errors.js";

const complete = {
  run: { generation: 0, completedAt: new Date(1_000).toISOString() },
  status: "complete" as const,
  pagesProcessed: 0,
};

async function waitForCount(count: () => number, minimum: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (count() < minimum && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.ok(count() >= minimum, `expected at least ${minimum} reports, got ${count()}`);
}

test("only a known Orthanc transport failure marks the source unreachable", () => {
  assert.deepEqual(classifySyncFailure(new OrthancUnavailableError()), {
    sourceReachable: false,
    lastErrorCode: "orthanc_unavailable",
  });
  assert.deepEqual(classifySyncFailure(new Error("local queue failure")), {
    sourceReachable: true,
    lastErrorCode: "sync_failed",
  });
});

test("successful polls honor the configured minutes and failed polls back off within an hour", () => {
  assert.equal(nextPollDelayMs(5 * 60_000, 0), 5 * 60_000);
  assert.equal(nextPollDelayMs(10 * 60_000, 0), 10 * 60_000);
  assert.equal(nextPollDelayMs(5 * 60_000, 1), 10 * 60_000);
  assert.equal(nextPollDelayMs(5 * 60_000, 7), 60 * 60_000);
  assert.equal(nextPollDelayMs(5_000, 0), 5_000);
});

test("sync loop advances initial discovery, polls changes, and schedules periodic reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-sync-loop-test-"));
  const store = new CheckpointStore(join(directory, "state.sqlite"));
  store.capturePage(
    "synthetic-source",
    { databaseServerIdentifier: "synthetic-db", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  let initialCalls = 0;
  let periodicCalls = 0;
  let feedCalls = 0;
  const coordinator = {
    runInitial: async () => {
      initialCalls += 1;
      return complete;
    },
    runPeriodicReconciliation: async () => {
      periodicCalls += 1;
      return periodicCalls === 1 ? { ...complete, status: "scanning" as const } : complete;
    },
  } as unknown as InventoryCoordinator;
  const feed = {
    pollOnce: async () => {
      feedCalls += 1;
      return { done: true };
    },
  } as unknown as OrthancChangeFeedAdapter;
  const orthanc = {} as OrthancDiscoveryClient;
  const cloud = { reportHealth: async () => undefined } as unknown as IngestionClient;
  const loop = new SyncLoop(store, feed, coordinator, orthanc, cloud, {
    sourceKey: "synthetic-source",
    spoolDirectory: join(directory, "spool"),
    maximumObjectBytes: 1024 * 1024,
    reserveFreeBytes: 4096,
    pageBudget: 10,
    uploadBatchSize: 2,
    pollIntervalMs: 1000,
    reconciliationIntervalMs: 10_000,
  });

  try {
    await loop.runOnce(1_000);
    assert.equal(initialCalls, 1);
    assert.equal(feedCalls, 0);
    await loop.runOnce(11_000);
    assert.equal(feedCalls, 1);
    assert.equal(periodicCalls, 1);
    await loop.runOnce(11_500);
    assert.equal(feedCalls, 2);
    assert.equal(periodicCalls, 2);
    await loop.runOnce(12_000);
    assert.equal(periodicCalls, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle health heartbeat refreshes cloud health and lease without polling Orthanc", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-sync-idle-heartbeat-"));
  const store = new CheckpointStore(join(directory, "state.sqlite"));
  store.capturePage(
    "synthetic-source",
    { databaseServerIdentifier: "synthetic-db", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  let initialCalls = 0;
  let feedCalls = 0;
  const reports: Array<{ sourceReachable: boolean; lastSuccessfulSyncAt: string | null }> = [];
  const coordinator = {
    runInitial: async () => {
      initialCalls += 1;
      return complete;
    },
  } as unknown as InventoryCoordinator;
  const feed = {
    pollOnce: async () => {
      feedCalls += 1;
      return { done: true };
    },
  } as unknown as OrthancChangeFeedAdapter;
  const cloud = {
    reportHealth: async (report: (typeof reports)[number]) => {
      reports.push(report);
    },
  } as unknown as IngestionClient;
  const loop = new SyncLoop(store, feed, coordinator, {} as OrthancDiscoveryClient, cloud, {
    sourceKey: "synthetic-source",
    spoolDirectory: join(directory, "spool"),
    maximumObjectBytes: 1024 * 1024,
    reserveFreeBytes: 4096,
    pageBudget: 10,
    uploadBatchSize: 2,
    pollIntervalMs: 500,
    reconciliationIntervalMs: 10_000,
    idleHealthIntervalMs: 40,
  });

  const controller = new AbortController();
  try {
    const run = loop.run(controller.signal);
    await waitForCount(() => reports.length, 3);
    controller.abort();
    await run;
    assert.equal(initialCalls, 1);
    assert.equal(feedCalls, 0);
    assert.ok(reports.length >= 3, `expected idle heartbeats, got ${reports.length}`);
    assert.ok(reports.every((report) => report.sourceReachable));
    assert.ok(
      reports.every((report) => report.lastSuccessfulSyncAt === reports[0]?.lastSuccessfulSyncAt),
    );
  } finally {
    controller.abort();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle health heartbeat retains the last observed Orthanc outage until a poll succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-sync-idle-outage-"));
  const store = new CheckpointStore(join(directory, "state.sqlite"));
  store.capturePage(
    "synthetic-source",
    { databaseServerIdentifier: "synthetic-db", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  let feedCalls = 0;
  const reports: boolean[] = [];
  const coordinator = {
    runInitial: async () => {
      throw new OrthancUnavailableError();
    },
  } as unknown as InventoryCoordinator;
  const feed = {
    pollOnce: async () => {
      feedCalls += 1;
      return { done: true };
    },
  } as unknown as OrthancChangeFeedAdapter;
  const cloud = {
    reportHealth: async (report: { sourceReachable: boolean }) => {
      reports.push(report.sourceReachable);
    },
  } as unknown as IngestionClient;
  const loop = new SyncLoop(store, feed, coordinator, {} as OrthancDiscoveryClient, cloud, {
    sourceKey: "synthetic-source",
    spoolDirectory: join(directory, "spool"),
    maximumObjectBytes: 1024 * 1024,
    reserveFreeBytes: 4096,
    pageBudget: 10,
    uploadBatchSize: 2,
    pollIntervalMs: 500,
    reconciliationIntervalMs: 10_000,
    idleHealthIntervalMs: 40,
  });

  const controller = new AbortController();
  try {
    const run = loop.run(controller.signal);
    await waitForCount(() => reports.length, 3);
    controller.abort();
    await run;
    assert.equal(feedCalls, 0);
    assert.ok(reports.length >= 3, `expected idle health reports, got ${reports.length}`);
    assert.ok(reports.every((sourceReachable) => !sourceReachable));
  } finally {
    controller.abort();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
