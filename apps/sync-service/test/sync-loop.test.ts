import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";
import { SyncLoop } from "../src/runtime/sync-loop.js";
import type { InventoryCoordinator } from "../src/discovery/inventory-coordinator.js";
import type { OrthancChangeFeedAdapter } from "../src/orthanc/change-feed.js";
import type { OrthancDiscoveryClient } from "../src/orthanc/discovery-client.js";
import { IngestionClient } from "../src/transfers/ingestion-client.js";

const complete = {
  run: { generation: 0, completedAt: new Date(1_000).toISOString() },
  status: "complete" as const,
  pagesProcessed: 0,
};

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
  const cloud = new IngestionClient({
    apiBaseUrl: "http://127.0.0.1:9999",
    deviceAuthorization: `ClarityDevice 123e4567-e89b-12d3-a456-426614174000.${"A".repeat(43)}`,
    allowInsecureLocalhost: true,
    fetchImpl: async () => new Response("{}"),
  });
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
