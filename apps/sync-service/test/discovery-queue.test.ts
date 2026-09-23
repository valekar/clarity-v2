import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { DiscoveryQueueProcessor } from "../src/discovery/queue-processor.js";
import {
  createOrthancFixture,
  directory,
  makeCoordinator,
  sourceState,
  syntheticStudy,
} from "./discovery-fixtures.js";

test("queue replay uses a single source/Study UID Report key for late events", async () => {
  const study = syntheticStudy("study-queue", "2.25.50", ["instance-queue"], { sopStart: 510 });
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(join(directory, "queue-replay.sqlite"), baseUrl, "source-4", 2);
  const capture = runtime.store.capturePage(
    "source-4",
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
          orthancId: "instance-queue",
        },
      ],
    },
  );
  assert.equal(capture.checkpoint.cursor, 1);
  const processor = new DiscoveryQueueProcessor(runtime.store, runtime.orthanc);
  await processor.process("source-4");
  await processor.process("source-4");
  assert.equal(runtime.store.discovery.listReports("source-4").length, 1);
  assert.equal(runtime.store.discovery.listInstances("source-4", "2.25.50").length, 1);
  runtime.store.close();
});

test("concurrent processors share one exclusive source lease", async () => {
  const study = syntheticStudy("study-lease", "2.25.61", ["instance-lease-a", "instance-lease-b"], {
    sopStart: 610,
  });
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(
    join(directory, "queue-processors.sqlite"),
    baseUrl,
    "lease-source",
  );
  runtime.store.capturePage(
    "lease-source",
    { databaseServerIdentifier: "synthetic-db", databaseVersion: 6 },
    0,
    {
      last: 2,
      done: true,
      changes: [
        {
          sequence: 1,
          changeType: "NewInstance",
          resourceType: "Instance",
          orthancId: "instance-lease-a",
        },
        {
          sequence: 2,
          changeType: "NewInstance",
          resourceType: "Instance",
          orthancId: "instance-lease-b",
        },
      ],
    },
  );
  const first = new DiscoveryQueueProcessor(runtime.store, runtime.orthanc);
  const second = new DiscoveryQueueProcessor(runtime.store, runtime.orthanc);
  const [firstResult, secondResult] = await Promise.all([
    first.process("lease-source"),
    second.process("lease-source"),
  ]);
  assert.equal(firstResult.completed + secondResult.completed, 2);
  assert.equal(runtime.store.discovery.listReports("lease-source").length, 1);
  assert.equal(runtime.store.discovery.listInstances("lease-source", "2.25.61").length, 2);
  assert.equal(
    source.requests.filter((request) => request.includes("/instances/instance-lease-")).length,
    2,
  );
  assert.equal(runtime.store.listPendingWork("lease-source", 500).length, 0);
  runtime.store.close();
});

test("a queue result fetched before a generation reset cannot resurrect stale state", async () => {
  const study = syntheticStudy("study-generation-fence", "2.25.54", ["instance-fenced"], {
    sopStart: 540,
  });
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(
    join(directory, "queue-generation-fence.sqlite"),
    baseUrl,
    "source-generation-fence",
    2,
  );
  runtime.store.capturePage(
    "source-generation-fence",
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
          orthancId: "instance-fenced",
        },
      ],
    },
  );
  const job = runtime.store.listPendingWork("source-generation-fence")[0];
  assert.ok(job);
  const leaseOwner = "stale-result-test";
  assert.equal(runtime.store.acquireQueueLease(job.sourceKey, leaseOwner), true);
  runtime.store.markProcessing(job.id);
  const staleObservation = await runtime.orthanc.getInstance("instance-fenced");
  runtime.store.capturePage(
    "source-generation-fence",
    { databaseServerIdentifier: "synthetic-db-replaced", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  assert.equal(
    runtime.store.discovery.commitQueueStudy(
      job.id,
      job.sourceKey,
      leaseOwner,
      staleObservation.study,
      staleObservation.instance,
    ),
    null,
  );
  assert.equal(runtime.store.discovery.listReports("source-generation-fence").length, 0);
  runtime.store.close();
});

test("a queued instance deleted before metadata lookup does not block later jobs", async () => {
  const study = syntheticStudy(
    "study-stale-event",
    "2.25.55",
    ["instance-stale", "instance-live"],
    {
      sopStart: 550,
    },
  );
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(
    join(directory, "stale-event.sqlite"),
    baseUrl,
    "source-stale-event",
    2,
  );
  runtime.store.capturePage(
    "source-stale-event",
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
          orthancId: "instance-stale",
        },
      ],
    },
  );
  const processor = new DiscoveryQueueProcessor(runtime.store, runtime.orthanc);
  await processor.process("source-stale-event");
  study.instances.shift();
  runtime.store.capturePage(
    "source-stale-event",
    { databaseServerIdentifier: "synthetic-db", databaseVersion: 6 },
    1,
    {
      last: 3,
      done: true,
      changes: [
        {
          sequence: 2,
          changeType: "NewInstance",
          resourceType: "Instance",
          orthancId: "instance-stale",
        },
        {
          sequence: 3,
          changeType: "NewInstance",
          resourceType: "Instance",
          orthancId: "instance-live",
        },
      ],
    },
  );
  const result = await processor.process("source-stale-event");
  assert.equal(result.completed, 2);
  assert.equal(result.remaining, 0);
  assert.equal(runtime.store.discovery.listReports("source-stale-event").length, 1);
  const instances = runtime.store.discovery.listInstances("source-stale-event", "2.25.55");
  assert.equal(
    instances.find((item) => item.orthancInstanceId === "instance-stale")?.sourceMissing,
    true,
  );
  assert.equal(
    instances.find((item) => item.orthancInstanceId === "instance-live")?.sourceMissing,
    false,
  );
  assert.equal(runtime.store.getCheckpoint("source-stale-event")?.reconciliationRequired, true);
  assert.equal(
    runtime.store
      .listPending("source-stale-event")
      .some((job) => job.changeType === "reconcile-source"),
    true,
  );
  runtime.store.close();
});

test("process death before queue/report commit leaves both retryable and atomic", async () => {
  const study = syntheticStudy("study-crash", "2.25.50", ["instance-crash"], { sopStart: 510 });
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const path = join(directory, "queue-crash.sqlite");
  const marker = join(directory, "queue-crash.marker");
  let runtime = makeCoordinator(path, baseUrl, "fixture", 2);
  runtime.store.capturePage(
    "fixture",
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
          orthancId: "instance-crash",
        },
      ],
    },
  );
  const job = runtime.store
    .listPending("fixture")
    .find((candidate) => candidate.changeType === "NewInstance");
  assert.ok(job);
  runtime.store.markProcessing(job.id);
  runtime.store.close();

  const helperPath = new URL("./crash-writer.js", import.meta.url);
  const child = spawn(
    process.execPath,
    [helperPath.pathname, path, marker, "report", String(job.id)],
    { stdio: "ignore" },
  );
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
    assert.equal(started, true, "child opened the queue/report transaction");
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

  runtime = makeCoordinator(path, baseUrl, "fixture", 2);
  assert.equal(runtime.store.discovery.getReport("fixture", "2.25.50"), null);
  assert.equal(
    runtime.store.listPending("fixture").find((candidate) => candidate.id === job.id)?.status,
    "processing",
  );
  await new DiscoveryQueueProcessor(runtime.store, runtime.orthanc).process("fixture");
  assert.equal(runtime.store.discovery.listReports("fixture").length, 1);
  assert.equal(runtime.store.discovery.listInstances("fixture", "2.25.50").length, 1);
  assert.equal(
    runtime.store.listPending("fixture").some((candidate) => candidate.id === job.id),
    false,
  );
  runtime.store.close();
});
