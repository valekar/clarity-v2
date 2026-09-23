import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeDicomUid } from "../src/discovery/normalize.js";
import { stableAdmissionKey } from "../src/transfers/spool-instance.js";
import { OrthancDiscoveryClient } from "../src/orthanc/discovery-client.js";
import {
  createOrthancFixture,
  directory,
  finishInventory,
  makeCoordinator,
  sourceState,
  syntheticStudy,
} from "./discovery-fixtures.js";

test("normalizes DICOM UIDs and rejects malformed or overlong identities", () => {
  assert.equal(normalizeDicomUid(" 1.2.840.10008.1.2 ", "UID"), "1.2.840.10008.1.2");
  assert.throws(() => normalizeDicomUid("1.02.3", "UID"), /valid normalized/);
  assert.throws(() => normalizeDicomUid("1..3", "UID"), /valid normalized/);
  assert.throws(() => normalizeDicomUid(`1.${"2".repeat(64)}`, "UID"), /valid normalized/);
});

test("initial inventory checkpoints first, resumes interrupted pages, and deduplicates logical Reports", async () => {
  const source = sourceState(
    [syntheticStudy("study-old", "2.25.10", ["instance-a", "instance-b"], { sopStart: 110 })],
    [{ Seq: 5, ChangeType: "StableStudy", ResourceType: "Study", ID: "study-old" }],
  );
  const baseUrl = await createOrthancFixture(source);
  const path = join(directory, "initial-resume.sqlite");
  let runtime = makeCoordinator(path, baseUrl, "source-1", 1);
  const result = await runtime.coordinator.runInitial(2);
  assert.notEqual(result.status, "complete");
  assert.ok(result.run?.upperBoundCaptured);
  assert.ok(result.run?.upperInstanceId);
  assert.ok(
    source.requests.findIndex((value) => value.startsWith("GET /changes")) <
      source.requests.findIndex((value) => value.startsWith("GET /statistics")),
  );
  runtime.store.close();

  runtime = makeCoordinator(path, baseUrl, "source-1", 1);
  await finishInventory(runtime.coordinator, "initial");
  const reports = runtime.store.discovery.listReports("source-1");
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.studyInstanceUid, "2.25.10");
  assert.equal(reports[0]?.patientName, null);
  assert.equal(reports[0]?.patientId, null);
  assert.equal(runtime.store.discovery.listInstances("source-1", "2.25.10").length, 2);
  assert.equal(runtime.store.getCheckpoint("source-1")?.cursor, 5);
  const checkpoint = runtime.store.getCheckpoint("source-1")!;
  for (const instance of runtime.store.discovery.listInstances("source-1", "2.25.10")) {
    const upload = runtime.store.uploads.insertSpool({
      admissionKey: stableAdmissionKey("source-1", instance.sopInstanceUid),
      sourceKey: "source-1",
      generation: checkpoint.generation,
      orthancInstanceId: instance.orthancInstanceId,
      studyInstanceUid: instance.studyInstanceUid,
      seriesInstanceUid: instance.seriesInstanceUid!,
      sopInstanceUid: instance.sopInstanceUid,
      spoolPath: null,
      byteCount: 1,
      sha256: "a".repeat(64),
    });
    runtime.store.uploads.markReceived(upload.admissionKey, checkpoint.generation);
  }
  const firstMemberPage = runtime.store.discovery.listManifestMemberPage(
    "source-1",
    "2.25.10",
    checkpoint.generation,
    0,
    1,
  );
  const secondMemberPage = runtime.store.discovery.listManifestMemberPage(
    "source-1",
    "2.25.10",
    checkpoint.generation,
    1,
    1,
  );
  assert.equal(firstMemberPage.ready, true);
  assert.equal(secondMemberPage.ready, true);
  assert.equal(firstMemberPage.scanned, 1);
  assert.equal(secondMemberPage.scanned, 1);
  assert.ok(
    firstMemberPage.members[0]!.sopInstanceUid < secondMemberPage.members[0]!.sopInstanceUid,
  );
  runtime.store.close();
});

test("patient issuer is retained and identity changes clear stale local patient name", async () => {
  const study = syntheticStudy("study-patient", "2.25.19", ["instance-patient"], {
    sopStart: 190,
    optionalMetadata: true,
  });
  study.patientId = "patient-old";
  study.patientIssuerOfPatientId = "issuer-old";
  study.patientName = "Old^Name";
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(
    join(directory, "patient-identity.sqlite"),
    baseUrl,
    "patient-source",
    2,
  );
  await finishInventory(runtime.coordinator, "initial");
  const first = runtime.store.discovery.getReport("patient-source", "2.25.19");
  assert.equal(first?.patientId, "patient-old");
  assert.equal(first?.patientIssuerOfPatientId, "issuer-old");
  assert.equal(first?.patientName, "Old^Name");

  delete study.patientName;
  await finishInventory(runtime.coordinator, "periodic");
  assert.equal(runtime.store.discovery.getReport("patient-source", "2.25.19")?.patientName, null);

  study.patientName = "Old^Name";
  await finishInventory(runtime.coordinator, "periodic");
  study.patientId = "patient-new";
  study.patientIssuerOfPatientId = "issuer-new";
  delete study.patientName;
  await finishInventory(runtime.coordinator, "periodic");
  const refreshed = runtime.store.discovery.getReport("patient-source", "2.25.19");
  assert.equal(refreshed?.patientId, "patient-new");
  assert.equal(refreshed?.patientIssuerOfPatientId, "issuer-new");
  assert.equal(refreshed?.patientName, null);
  runtime.store.close();
});

test("change replay captures a late instance after the inventory snapshot", async () => {
  const study = syntheticStudy("study-late", "2.25.20", ["instance-first"], { sopStart: 210 });
  const source = sourceState([study]);
  source.injectLateInstanceAfterEmptyPage = true;
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(join(directory, "late.sqlite"), baseUrl, "source-2", 1);
  await finishInventory(runtime.coordinator, "initial");
  const instances = runtime.store.discovery.listInstances("source-2", "2.25.20");
  assert.deepEqual(instances.map((item) => item.sopInstanceUid).sort(), ["2.25.210", "2.25.300"]);
  assert.equal(runtime.store.discovery.listReports("source-2").length, 1);
  assert.equal(runtime.store.getCheckpoint("source-2")?.cursor, 6);
  assert.ok(source.requests.some((value) => value.includes("/changes?since=0")));
  runtime.store.close();
});

test("anchored inventory repairs a deletion-induced offset shift without a deletion event", async () => {
  const study = syntheticStudy(
    "study-shift",
    "2.25.25",
    ["instance-a", "instance-b", "instance-c", "instance-d"],
    { sopStart: 250 },
  );
  const source = sourceState([study]);
  source.deleteFirstInstanceOnOffsetPage = true;
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(
    join(directory, "offset-shift.sqlite"),
    baseUrl,
    "source-shift",
    1,
  );
  await finishInventory(runtime.coordinator, "initial");
  const instances = runtime.store.discovery.listInstances("source-shift", "2.25.25");
  assert.equal(instances.length, 4);
  assert.equal(
    instances.find((item) => item.orthancInstanceId === "instance-b")?.sopInstanceUid,
    "2.25.251",
  );
  assert.equal(
    instances.find((item) => item.orthancInstanceId === "instance-a")?.sourceMissing,
    true,
  );
  assert.equal(runtime.store.getCheckpoint("source-shift")?.cursor, 0);
  runtime.store.close();
});

test("final inventory page freezes its revalidation bound before a crash", async () => {
  const targetId = "instance-050";
  const study = syntheticStudy(
    "study-revalidate",
    "2.25.28",
    Array.from({ length: 102 }, (_, index) => `instance-${String(index).padStart(3, "0")}`),
    { sopStart: 2800 },
  );
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const path = join(directory, "revalidate-resume.sqlite");
  let runtime = makeCoordinator(path, baseUrl, "source-revalidate", 500);
  const first = await runtime.coordinator.runInitial(2);
  assert.equal(first.status, "revalidating");
  assert.equal(first.run?.revalidationAfterSopUid, null);
  assert.equal(first.run?.revalidationUpperSopUid, "2.25.2901");
  runtime.store.close();

  study.instances.splice(
    0,
    study.instances.length,
    ...study.instances.filter((instance) => instance.id !== targetId),
  );
  runtime = makeCoordinator(path, baseUrl, "source-revalidate", 500);
  await finishInventory(runtime.coordinator, "initial");
  const rows = runtime.store.discovery.listInstances("source-revalidate", "2.25.28");
  const missing = rows.find((instance) => instance.orthancInstanceId === targetId);
  assert.equal(missing?.sourceMissing, true);
  assert.equal(
    runtime.store.discovery.getReport("source-revalidate", "2.25.28")?.sourceMissing,
    false,
  );
  assert.equal(rows.length, 102);
  assert.ok(source.requests.every((request) => request.startsWith("GET ")));
  runtime.store.close();
});

test("a feed generation reset between an instance fetch and commit restarts on entry", async () => {
  const study = syntheticStudy(
    "study-scan-reset",
    "2.25.281",
    ["scan-instance-a", "scan-instance-b", "scan-instance-c"],
    {
      sopStart: 2810,
    },
  );
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(
    join(directory, "scan-generation-fence.sqlite"),
    baseUrl,
    "source-scan-fence",
    2,
  );
  const first = await runtime.coordinator.runInitial(2);
  assert.equal(first.status, "scanning");
  assert.ok(first.run);
  const page = await runtime.orthanc.listInstanceIds(first.run.nextInstanceOffset, 2);
  const pairs = await runtime.orthanc.resolveInstances(page.ids);
  source.databaseServerIdentifier = "synthetic-db-restarted";
  assert.equal((await runtime.feed.pollOnce()).resetDetected, true);
  assert.throws(
    () =>
      runtime.store.discovery.recordAnchoredInstancePage(
        first.run!.id,
        first.run!.nextInstanceOffset,
        first.run!.nextInstanceOffset + 1,
        first.run!.lastInstanceId,
        pairs.at(-1)?.instance.orthancInstanceId ?? null,
        pairs,
        true,
      ),
    /generation changed/,
  );
  const resumed = await runtime.coordinator.runInitial(2);
  assert.equal(resumed.run?.generation, 1);
  assert.ok(resumed.run?.status === "scanning-instances" || resumed.run?.status === "revalidating");
  assert.notEqual(resumed.run?.id, first.run.id);
  runtime.store.close();
});

test("a feed generation reset between revalidation fetch and commit restarts on entry", async () => {
  const study = syntheticStudy("study-reval-reset", "2.25.282", ["reval-instance"], {
    sopStart: 2820,
  });
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(
    join(directory, "revalidation-generation-fence.sqlite"),
    baseUrl,
    "source-reval-fence",
    2,
  );
  const first = await runtime.coordinator.runInitial(2);
  assert.equal(first.status, "revalidating");
  assert.ok(first.run);
  const batch = runtime.store.discovery.listInventoryRevalidationBatch(first.run.id, 100);
  const outcomes = await runtime.orthanc.revalidateKnownInstances(batch);
  source.databaseServerIdentifier = "synthetic-db-restarted";
  assert.equal((await runtime.feed.pollOnce()).resetDetected, true);
  assert.throws(
    () =>
      runtime.store.discovery.commitInventoryRevalidationBatch(
        first.run!.id,
        first.run!.revalidationAfterSopUid,
        outcomes,
      ),
    /generation changed/,
  );
  const resumed = await runtime.coordinator.runInitial(2);
  assert.equal(resumed.run?.generation, 1);
  assert.ok(resumed.run?.status === "scanning-instances" || resumed.run?.status === "revalidating");
  assert.notEqual(resumed.run?.id, first.run.id);
  runtime.store.close();
});

test("a source generation reset starts a fresh mark-sweep pass", async () => {
  const original = syntheticStudy(
    "study-before-reset",
    "2.25.56",
    ["instance-before-reset-a", "instance-before-reset-b", "instance-before-reset-c"],
    { sopStart: 560 },
  );
  const replacement = syntheticStudy("study-after-reset", "2.25.57", ["instance-after-reset"], {
    sopStart: 570,
  });
  const source = sourceState([original]);
  source.replaceStudyOnOffsetPage = replacement;
  const baseUrl = await createOrthancFixture(source);
  const runtime = makeCoordinator(
    join(directory, "generation-pass.sqlite"),
    baseUrl,
    "source-generation-pass",
    1,
  );
  const first = await runtime.coordinator.runInitial(4);
  assert.equal(first.status, "scanning");
  assert.ok(first.run);
  let result = first;
  for (let attempt = 0; attempt < 100 && result.status !== "complete"; attempt += 1) {
    result = await runtime.coordinator.runInitial(3);
  }
  assert.equal(result.status, "complete");
  assert.notEqual(result.run?.id, first.run.id);
  assert.ok(result.run?.completedAt);
  assert.ok(Date.now() - Date.parse(result.run!.completedAt!) < 10_000);
  assert.equal(
    runtime.store.discovery.getReport("source-generation-pass", "2.25.56")?.sourceMissing,
    true,
  );
  assert.equal(
    runtime.store.discovery.getReport("source-generation-pass", "2.25.57")?.sourceMissing,
    false,
  );
  assert.equal(runtime.store.getCheckpoint("source-generation-pass")?.generation, 1);
  runtime.store.close();
});

test("501 feed events continue durably across process restart and finish the later horizon", async () => {
  const source = sourceState([]);
  source.injectPatientEventsDuringStudyScan = 501;
  const baseUrl = await createOrthancFixture(source);
  let runtime = makeCoordinator(
    join(directory, "replay-batches.sqlite"),
    baseUrl,
    "source-batches",
    500,
  );
  const first = await runtime.coordinator.runInitial(10);
  assert.equal(first.status, "reconciliation-pending");
  assert.equal(first.run?.status, "awaiting-replay");
  assert.equal(first.run?.feedHorizon, null);
  assert.equal(first.run?.feedDoneAtHorizon, null);
  assert.equal(runtime.store.listPendingWork("source-batches", 500).length, 0);
  assert.ok(first.run);
  runtime.store.close();

  runtime = makeCoordinator(
    join(directory, "replay-batches.sqlite"),
    baseUrl,
    "source-batches",
    500,
  );
  const second = await runtime.coordinator.runInitial(10);
  assert.equal(second.status, "complete");
  assert.equal(second.run?.feedHorizon, 501);
  assert.equal(second.run?.feedDoneAtHorizon, true);
  assert.equal(second.run?.status, "complete");
  assert.equal(runtime.store.listPendingWork("source-batches", 500).length, 0);
  assert.equal(runtime.store.getCheckpoint("source-batches")?.cursor, 501);
  assert.equal(runtime.store.listPendingWork("source-batches", 500).length, 0);
  assert.equal(
    runtime.store.discovery.findInventoryRun("source-batches", "initial", true)?.status,
    "complete",
  );
  runtime.store.close();
});

test("periodic inventory catches a silent reset even when the cursor returns to the same value", async () => {
  const oldA = syntheticStudy("study-a-old", "2.25.30", ["instance-a-old"], { sopStart: 310 });
  const oldB = syntheticStudy("study-b-old", "2.25.31", ["instance-b-old"], { sopStart: 311 });
  const source = sourceState(
    [oldA, oldB],
    [{ Seq: 5, ChangeType: "StableStudy", ResourceType: "Study", ID: oldA.id }],
  );
  const baseUrl = await createOrthancFixture(source);
  const path = join(directory, "same-cursor-reset.sqlite");
  const runtime = makeCoordinator(path, baseUrl, "source-3", 2);
  await finishInventory(runtime.coordinator, "initial");
  assert.equal(runtime.store.getCheckpoint("source-3")?.cursor, 5);
  source.studies.delete(oldA.id);
  source.studies.delete(oldB.id);
  const replacement = syntheticStudy("study-a-new", "2.25.30", ["instance-a-new"], {
    sopStart: 310,
  });
  const newStudy = syntheticStudy("study-c-new", "2.25.32", ["instance-c-new"], { sopStart: 312 });
  source.studies.set(replacement.id, replacement);
  source.studies.set(newStudy.id, newStudy);
  source.studyOrder = [replacement.id, newStudy.id];
  await finishInventory(runtime.coordinator, "periodic");
  const reports = runtime.store.discovery.listReports("source-3");
  assert.equal(reports.length, 3);
  assert.equal(
    runtime.store.discovery.getReport("source-3", "2.25.30")?.orthancStudyId,
    "study-a-new",
  );
  assert.equal(runtime.store.discovery.getReport("source-3", "2.25.31")?.sourceMissing, true);
  assert.equal(runtime.store.discovery.getReport("source-3", "2.25.32")?.sourceMissing, false);
  assert.equal(
    runtime.store.discovery.listInstances("source-3", "2.25.30")[0]?.orthancInstanceId,
    "instance-a-new",
  );
  assert.equal(runtime.store.getCheckpoint("source-3")?.cursor, 5);
  assert.equal(runtime.store.getCheckpoint("source-3")?.generation, 0);
  runtime.store.close();
});

test("instance metadata requests never exceed the configured concurrency cap", async () => {
  const study = syntheticStudy(
    "study-concurrent",
    "2.25.40",
    Array.from({ length: 8 }, (_, i) => `instance-${i}`),
    { sopStart: 410 },
  );
  const source = sourceState([study]);
  const baseUrl = await createOrthancFixture(source);
  const client = new OrthancDiscoveryClient({ baseUrl, pageSize: 8, maxConcurrency: 3 });
  const page = await client.getGlobalInstancePage(0);
  assert.equal(page.pairs.length, 8);
  assert.ok(source.maxActiveInstanceRequests <= 3);
  assert.ok(source.maxActiveInstanceRequests > 1);
});

test("Orthanc list responses are rejected above the streaming JSON byte limit", async () => {
  const body = new Uint8Array(256 * 1024 + 1).fill(32);
  const client = new OrthancDiscoveryClient({
    baseUrl: "http://127.0.0.1:8042",
    fetchImpl: async () => new Response(body),
  });
  await assert.rejects(() => client.listInstanceIds(0), /262144-byte JSON bound/);
});
