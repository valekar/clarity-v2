import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IngestionClient } from "../src/transfers/ingestion-client.js";
import { stableStudyAdmissionKey } from "../src/transfers/spool-instance.js";

const authorization = `ClarityDevice 123e4567-e89b-12d3-a456-426614174000.${"A".repeat(43)}`;

test("device client acquires cloud fence and admits a coherent patient observation", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = new IngestionClient({
    apiBaseUrl: "https://cloud.example.invalid",
    deviceAuthorization: authorization,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/api/ingestion/lease") {
        return Response.json({
          sourceGeneration: 3,
          fencingToken: "42",
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        });
      }
      if (url.pathname === "/api/ingestion/studies") {
        return Response.json({
          reportId: "123e4567-e89b-42d3-a456-426614174000",
          studyInstanceUid: "2.25.19",
          version: 1,
          currentManifestRevision: null,
          currentManifestDigest: null,
          currentManifestGeneration: null,
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const admissionKey = stableStudyAdmissionKey("source-synthetic", "2.25.19");
  const report = {
    sourceKey: "source-synthetic",
    studyInstanceUid: "2.25.19",
    orthancStudyId: "orthanc-study-locator",
    patientId: "patient-19",
    patientIssuerOfPatientId: "issuer-19",
    patientName: "Synthetic^Patient",
    patientBirthDate: null,
    patientSex: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    accessionNumber: null,
    modalities: null,
    sourceMissing: false,
  };

  const result = await client.admitStudy(report, admissionKey);
  assert.equal(result.version, 1);
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/api/ingestion/lease", "/api/ingestion/studies"],
  );
  assert.deepEqual(calls[0]?.body, { action: "acquire" });
  assert.equal(calls[1]?.body.admissionKey, admissionKey);
  assert.equal(calls[1]?.body.sourceGeneration, 3);
  assert.equal(calls[1]?.body.fencingToken, "42");
  assert.equal(calls[1]?.body.patientId, "patient-19");
  assert.equal(calls[1]?.body.patientIssuerOfPatientId, "issuer-19");
});

test("a fence conflict discards stale credentials and reacquires before retry", async () => {
  let leases = 0;
  let studyCalls = 0;
  const fences: string[] = [];
  const client = new IngestionClient({
    apiBaseUrl: "https://cloud.example.invalid",
    deviceAuthorization: authorization,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/ingestion/lease") {
        leases += 1;
        return Response.json({
          sourceGeneration: 3,
          fencingToken: String(41 + leases),
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        });
      }
      if (path === "/api/ingestion/studies") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        fences.push(String(body.fencingToken));
        studyCalls += 1;
        if (studyCalls === 1) return Response.json({ error: "fence_conflict" }, { status: 409 });
        return Response.json({
          reportId: "123e4567-e89b-42d3-a456-426614174000",
          studyInstanceUid: "2.25.19",
          version: 1,
          currentManifestRevision: null,
          currentManifestDigest: null,
          currentManifestGeneration: null,
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const report = {
    sourceKey: "source-synthetic",
    studyInstanceUid: "2.25.19",
    orthancStudyId: "orthanc-study-locator",
    patientId: null,
    patientIssuerOfPatientId: null,
    patientName: null,
    patientBirthDate: null,
    patientSex: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    accessionNumber: null,
    modalities: null,
    sourceMissing: false,
  };
  const key = stableStudyAdmissionKey("source-synthetic", report.studyInstanceUid);
  await assert.rejects(client.admitStudy(report, key), /cloud ingestion API request failed/);
  await client.admitStudy(report, key);
  assert.equal(leases, 2);
  assert.deepEqual(fences, ["42", "43"]);
});

test("expired cloud lease reacquires the current source generation before changed study admission", async () => {
  let now = Date.now();
  let leaseCount = 0;
  const captured: { studyBody?: Record<string, unknown> } = {};
  const client = new IngestionClient({
    apiBaseUrl: "https://cloud.example.invalid",
    deviceAuthorization: authorization,
    now: () => now,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (path === "/api/ingestion/lease") {
        leaseCount += 1;
        return Response.json({
          sourceGeneration: leaseCount,
          fencingToken: String(70 + leaseCount),
          leaseExpiresAt: new Date(now + (leaseCount === 1 ? 30_000 : 240_000)).toISOString(),
        });
      }
      if (path === "/api/ingestion/studies") {
        captured.studyBody = body;
        return Response.json({
          reportId: "123e4567-e89b-42d3-a456-426614174000",
          studyInstanceUid: "2.25.19",
          version: 2,
          currentManifestRevision: null,
          currentManifestDigest: null,
          currentManifestGeneration: null,
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  await client.acquireLease();
  now += 31_000;
  await client.admitStudy(
    {
      sourceKey: "source-synthetic",
      studyInstanceUid: "2.25.19",
      orthancStudyId: "orthanc-study-locator",
      patientId: "patient-after-source-reset",
      patientIssuerOfPatientId: "issuer-after-source-reset",
      patientName: null,
      patientBirthDate: null,
      patientSex: null,
      studyDate: null,
      studyTime: null,
      studyDescription: null,
      accessionNumber: null,
      modalities: null,
      sourceMissing: false,
    },
    stableStudyAdmissionKey("source-synthetic", "2.25.19"),
  );
  assert.equal(leaseCount, 2);
  assert.equal(captured.studyBody?.sourceGeneration, 2);
  assert.equal(captured.studyBody?.fencingToken, "72");
  assert.equal(captured.studyBody?.patientId, "patient-after-source-reset");
  assert.equal(captured.studyBody?.patientIssuerOfPatientId, "issuer-after-source-reset");
});

test("cloud lease takeover aborts a transfer that outlives the current lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-cloud-lease-heartbeat-"));
  const spoolPath = join(directory, "synthetic.dcm");
  await writeFile(spoolPath, "synthetic-only");
  let leaseCalls = 0;
  let heartbeat: Awaited<ReturnType<IngestionClient["startLeaseHeartbeat"]>> | null = null;
  const client = new IngestionClient({
    apiBaseUrl: "https://cloud.example.invalid",
    deviceAuthorization: authorization,
    leaseHeartbeatIntervalMs: 5,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/ingestion/lease") {
        leaseCalls += 1;
        if (leaseCalls > 1) {
          return Response.json({
            sourceGeneration: 9,
            fencingToken: "99",
            leaseExpiresAt: new Date(Date.now() + 240_000).toISOString(),
          });
        }
        return Response.json({
          sourceGeneration: 8,
          fencingToken: "88",
          leaseExpiresAt: new Date(Date.now() + 240_000).toISOString(),
        });
      }
      if (path === "/signed/object") {
        const signal = init?.signal;
        assert.ok(signal instanceof AbortSignal);
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    heartbeat = await client.startLeaseHeartbeat();
    const upload = client.putFile(
      { url: "https://cloud.example.invalid/signed/object", headers: {} },
      spoolPath,
      14,
      heartbeat.signal,
    );
    await assert.rejects(upload, /cloud source lease was lost during upload/);
    assert.equal(heartbeat.signal.aborted, true);
    assert.ok(leaseCalls >= 2);
  } finally {
    heartbeat?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest client echoes cloud fences across begin, bounded pages, and seal", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = new IngestionClient({
    apiBaseUrl: "https://cloud.example.invalid",
    deviceAuthorization: authorization,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/api/ingestion/lease") {
        return Response.json({
          sourceGeneration: 3,
          fencingToken: "42",
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        });
      }
      if (path.endsWith("/manifest/begin")) return Response.json({ revision: 1 });
      if (path.endsWith("/manifest/pages")) return Response.json({ accepted: 1 });
      if (path.endsWith("/manifest/seal")) return Response.json({ sealed: true });
      return new Response(null, { status: 404 });
    },
  });
  const reportId = "123e4567-e89b-42d3-a456-426614174000";
  const inventoryAttemptId = "123e4567-e89b-42d3-a456-426614174001";
  const revision = await client.beginManifest(reportId, {
    inventoryAttemptId,
    expectedCurrentRevision: null,
    expectedReportVersion: 2,
  });
  assert.equal(revision, 1);
  assert.equal(
    await client.recordManifestPage(reportId, {
      inventoryAttemptId,
      revision: 1,
      expectedReportVersion: 2,
      members: [{ sopInstanceUid: "1.2.3", sha256: "a".repeat(64) }],
    }),
    1,
  );
  assert.equal(
    await client.sealManifest(reportId, {
      inventoryAttemptId,
      revision: 1,
      expectedCurrentRevision: null,
      expectedReportVersion: 2,
      sourceObservedAt: new Date().toISOString(),
      sourceStable: true,
      inventoryComplete: true,
      observedManifestDigest: "b".repeat(64),
    }),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/ingestion/lease",
      `/api/ingestion/reports/${reportId}/manifest/begin`,
      `/api/ingestion/reports/${reportId}/manifest/pages`,
      `/api/ingestion/reports/${reportId}/manifest/seal`,
    ],
  );
  assert.ok(
    calls
      .slice(1)
      .every((call) => call.body.sourceGeneration === 3 && call.body.fencingToken === "42"),
  );
});
