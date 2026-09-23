import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";
import { directory } from "./discovery-fixtures.js";

const reportId = "123e4567-e89b-42d3-a456-426614174000";
const uploadId = "123e4567-e89b-42d3-a456-426614174001";
const uid = "2.25.9981";
const dicom = Buffer.from("synthetic-dicom-payload-only");

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  return address.port;
}

function json(response: import("node:http").ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function requestJson(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const completed = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 3_000)),
  ]);
  if (!completed) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

test("compiled production service discovers, uploads and seals one synthetic study", async () => {
  const source = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/system")
      return json(response, { DatabaseServerIdentifier: "synthetic-main", DatabaseVersion: 6 });
    if (path === "/changes") return json(response, { Last: 0, Done: true, Changes: [] });
    if (path === "/statistics") return json(response, { CountInstances: 1 });
    if (path === "/instances") return json(response, ["instance-main"]);
    if (path === "/studies/study-main") {
      return json(response, { MainDicomTags: { StudyInstanceUID: uid }, PatientMainDicomTags: {} });
    }
    if (path === "/instances/instance-main") {
      return json(response, {
        ParentSeries: "series-main",
        MainDicomTags: { SOPInstanceUID: "2.25.9982" },
      });
    }
    if (path === "/series/series-main") {
      return json(response, {
        ParentStudy: "study-main",
        MainDicomTags: { SeriesInstanceUID: "2.25.9983" },
      });
    }
    if (path === "/instances/instance-main/file") {
      response
        .writeHead(200, {
          "content-type": "application/dicom",
          "content-length": String(dicom.length),
        })
        .end(dicom);
      return;
    }
    response.writeHead(404).end();
  });
  let receivedBytes = Buffer.alloc(0);
  const calls: string[] = [];
  let reportVersion = 1;
  let proof: { revision: number | null; digest: string | null; generation: number | null } = {
    revision: null,
    digest: null,
    generation: null,
  };
  let sealCalls = 0;
  let loseFirstSealResponse = true;
  const cloud = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/api/ingestion/lease") {
      return json(response, {
        sourceGeneration: 1,
        fencingToken: "42",
        leaseExpiresAt: new Date(Date.now() + 240_000).toISOString(),
      });
    }
    if (url.pathname === "/api/ingestion/studies") {
      return json(response, {
        reportId,
        studyInstanceUid: uid,
        version: reportVersion,
        currentManifestRevision: proof.revision,
        currentManifestDigest: proof.digest,
        currentManifestGeneration: proof.generation,
      });
    }
    if (url.pathname === "/api/ingestion/uploads") {
      return json(response, {
        uploadId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        mode: "put",
        put: {
          url: `http://127.0.0.1:${cloudPort}/signed/object`,
          headers: { "content-type": "application/dicom" },
        },
      });
    }
    if (url.pathname === "/signed/object" && request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      receivedBytes = Buffer.concat(chunks);
      response
        .writeHead(200, { etag: `"${createHash("sha256").update(receivedBytes).digest("hex")}"` })
        .end();
      return;
    }
    if (url.pathname === `/api/ingestion/uploads/${uploadId}/complete`)
      return json(response, { status: "received" });
    if (url.pathname === `/api/ingestion/reports/${reportId}/manifest/begin`)
      return json(response, { revision: 1 });
    if (url.pathname === `/api/ingestion/reports/${reportId}/manifest/pages`)
      return json(response, { accepted: 1 });
    if (url.pathname === `/api/ingestion/reports/${reportId}/manifest/seal`) {
      const body = await requestJson(request);
      sealCalls += 1;
      proof = {
        revision: body.revision as number,
        digest: body.observedManifestDigest as string,
        generation: body.sourceGeneration as number,
      };
      reportVersion = (body.expectedReportVersion as number) + 1;
      if (loseFirstSealResponse) {
        loseFirstSealResponse = false;
        response.destroy();
        return;
      }
      return json(response, { sealed: true });
    }
    response.writeHead(404).end();
  });
  const sourcePort = await listen(source);
  const cloudPort = await listen(cloud);
  const databasePath = join(directory, "compiled-service.sqlite");
  const spoolDirectory = join(directory, "compiled-service-spool");
  const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const serviceEnvironment = {
    ...process.env,
    CLARITY_SYNC_SOURCE_KEY: "synthetic-main-source",
    CLARITY_SYNC_STATE_DB: databasePath,
    CLARITY_SYNC_SPOOL_DIR: spoolDirectory,
    CLARITY_ORTHANC_URL: `http://127.0.0.1:${sourcePort}/`,
    CLARITY_ORTHANC_AUTHORIZATION: "Basic dGVzdDp0ZXN0",
    CLARITY_INGESTION_API_URL: `http://127.0.0.1:${cloudPort}/`,
    CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST: "1",
    CLARITY_DEVICE_AUTHORIZATION: `ClarityDevice ${reportId}.${"A".repeat(43)}`,
  };
  const startService = (): ChildProcess =>
    spawn(process.execPath, [join(projectRoot, "dist/main.js")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: serviceEnvironment,
    });
  const child = startService();
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  try {
    const deadline = Date.now() + 12_000;
    while (sealCalls === 0 && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`compiled service exited early: ${stderr}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.ok(sealCalls > 0, `no manifest seal: ${stderr}`);
    assert.deepEqual(receivedBytes, dicom);
    assert.match(stdout, /sync service started/);
    await stopChild(child);
    const store = new CheckpointStore(databasePath);
    assert.equal(store.getCheckpoint("synthetic-main-source")?.cursor, 0);
    assert.equal(store.uploads.findBySop("synthetic-main-source", "2.25.9982")?.state, "received");
    const pendingSeal = store.manifests.get("synthetic-main-source", uid);
    assert.equal(pendingSeal?.currentRevision, null);
    assert.ok(pendingSeal?.attemptId);
    assert.equal(pendingSeal?.revision, 1);
    assert.equal(
      store.discovery.findInventoryRun("synthetic-main-source", "initial", true)?.status,
      "complete",
    );
    store.close();
    const beforeRestartCalls = calls.length;
    const beforeRestartStudies = calls.filter((call) =>
      call.endsWith("/api/ingestion/studies"),
    ).length;
    const restarted = startService();
    let restartError = "";
    restarted.stderr?.setEncoding("utf8").on("data", (chunk: string) => (restartError += chunk));
    try {
      const restartDeadline = Date.now() + 4_000;
      while (
        calls.filter((call) => call.endsWith("/api/ingestion/studies")).length ===
          beforeRestartStudies &&
        Date.now() < restartDeadline
      ) {
        if (restarted.exitCode !== null) {
          throw new Error(`compiled service failed to reopen durable state: ${restartError}`);
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      assert.ok(
        calls.filter((call) => call.endsWith("/api/ingestion/studies")).length >
          beforeRestartStudies,
        "restarted service did not reconcile cloud proof",
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    } finally {
      await stopChild(restarted);
    }
    assert.ok(calls.length > beforeRestartCalls);
    assert.equal(calls.filter((call) => call === "PUT /signed/object").length, 1);
    assert.equal(sealCalls, 1);
    const reconciledStore = new CheckpointStore(databasePath);
    const reconciled = reconciledStore.manifests.get("synthetic-main-source", uid);
    assert.equal(reconciled?.attemptId, null);
    assert.equal(reconciled?.currentRevision, 1);
    assert.equal(reconciled?.currentDigest, proof.digest);
    assert.equal(
      reconciled?.currentGeneration,
      reconciledStore.getCheckpoint("synthetic-main-source")?.generation,
    );
    assert.equal(reconciled?.currentCloudGeneration, 1);
    reconciledStore.close();
  } finally {
    await stopChild(child);
    await Promise.all([
      new Promise<void>((resolvePromise) => source.close(() => resolvePromise())),
      new Promise<void>((resolvePromise) => cloud.close(() => resolvePromise())),
    ]);
  }
});
