import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";
import { SyncLoop } from "../src/runtime/sync-loop.js";
import type { InventoryCoordinator } from "../src/discovery/inventory-coordinator.js";
import type { OrthancChangeFeedAdapter } from "../src/orthanc/change-feed.js";
import { OrthancDiscoveryClient } from "../src/orthanc/discovery-client.js";
import { IngestionClient } from "../src/transfers/ingestion-client.js";
import { InstanceUploader } from "../src/transfers/instance-uploader.js";
import { recoverReceivedUpload } from "../src/transfers/received-recovery.js";
import { spoolInstance, stableAdmissionKey } from "../src/transfers/spool-instance.js";

const sourceKey = "synthetic-source";
const studyUid = "2.25.880";
const seriesUid = "2.25.881";
const sopUid = "2.25.882";
const reportId = "123e4567-e89b-42d3-a456-426614174000";
const oldUploadId = "123e4567-e89b-42d3-a456-426614174001";
const replacementUploadId = "123e4567-e89b-42d3-a456-426614174002";
const deviceAuthorization = `ClarityDevice ${reportId}.${"A".repeat(43)}`;
const servers: Server[] = [];
let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "clarity-received-recovery-"));
});

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await rm(directory, { recursive: true, force: true });
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function observation(orthancInstanceId = "orthanc-instance") {
  return {
    orthancInstanceId,
    orthancStudyId: "orthanc-study",
    studyInstanceUid: studyUid,
    seriesInstanceUid: seriesUid,
    sopInstanceUid: sopUid,
  };
}

async function sourceFixture(bytes: Buffer) {
  const state = { bytes, reads: 0, missing: false };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/system")
      return json(response, { DatabaseServerIdentifier: "recovery-db", DatabaseVersion: 6 });
    if (path === "/changes") return json(response, { Last: 1, Done: true, Changes: [] });
    if (path === "/studies/orthanc-study") {
      return json(response, {
        MainDicomTags: { StudyInstanceUID: studyUid },
        PatientMainDicomTags: {},
      });
    }
    if (path === "/instances/orthanc-instance") {
      return json(response, {
        ParentSeries: "orthanc-series",
        MainDicomTags: { SOPInstanceUID: sopUid },
      });
    }
    if (path === "/series/orthanc-series") {
      return json(response, {
        ParentStudy: "orthanc-study",
        MainDicomTags: { SeriesInstanceUID: seriesUid },
      });
    }
    if (/^\/instances\/[^/]+\/file$/.test(path)) {
      if (state.missing) return response.writeHead(404).end();
      state.reads += 1;
      response.writeHead(200, {
        "content-type": "application/dicom",
        "content-length": String(state.bytes.length),
      });
      return response.end(state.bytes);
    }
    response.writeHead(404).end();
  });
  return { state, server, baseUrl: await listen(server) };
}

async function cloudFixture(options: {
  bytes: Buffer;
  replaceReceived?: boolean;
  status?: string;
}): Promise<{
  root: string;
  state: { authorizationCalls: number; putCalls: number; uploadStatus: string; body: Buffer };
}> {
  const state = {
    authorizationCalls: 0,
    putCalls: 0,
    uploadStatus: options.status ?? "received",
    body: options.bytes,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/") && request.headers.authorization !== deviceAuthorization) {
      return response.writeHead(401).end();
    }
    if (request.method === "POST" && url.pathname === "/api/ingestion/lease") {
      return json(response, {
        sourceGeneration: 2,
        fencingToken: "13",
        leaseExpiresAt: new Date(Date.now() + 240_000).toISOString(),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/ingestion/studies") {
      return json(response, {
        reportId,
        studyInstanceUid: studyUid,
        version: 1,
        currentManifestRevision: null,
        currentManifestDigest: null,
        currentManifestGeneration: null,
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/ingestion/uploads/")) {
      return json(response, { status: state.uploadStatus });
    }
    if (request.method === "POST" && url.pathname === "/api/ingestion/uploads") {
      const admission = JSON.parse((await readBody(request)).toString("utf8")) as {
        admissionKey: string;
        sourceGeneration: number;
        sha256: string;
      };
      assert.equal(admission.admissionKey, stableAdmissionKey(sourceKey, sopUid));
      assert.equal(admission.sourceGeneration, 2);
      assert.equal(admission.sha256, digest(options.bytes));
      state.authorizationCalls += 1;
      if (
        state.uploadStatus === "completed" ||
        (state.uploadStatus === "received" && !options.replaceReceived)
      ) {
        return json(response, { uploadId: oldUploadId, status: state.uploadStatus });
      }
      state.uploadStatus = "uploading";
      return json(response, {
        uploadId: replacementUploadId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        mode: "put",
        put: { url: `${root}/signed/object`, headers: { "content-type": "application/dicom" } },
      });
    }
    if (request.method === "PUT" && url.pathname === "/signed/object") {
      state.putCalls += 1;
      state.body = await readBody(request);
      state.uploadStatus = "uploading";
      return response.writeHead(200, { etag: `"${digest(state.body)}"` }).end();
    }
    if (
      request.method === "POST" &&
      url.pathname === `/api/ingestion/uploads/${replacementUploadId}/complete`
    ) {
      const completion = JSON.parse((await readBody(request)).toString("utf8")) as {
        byteCount: number;
        sha256: string;
      };
      assert.equal(completion.byteCount, options.bytes.length);
      assert.equal(completion.sha256, digest(options.bytes));
      state.uploadStatus = "received";
      return json(response, { status: "received" });
    }
    if (request.method === "POST" && /\/manifest\/(begin|pages|seal)$/.test(url.pathname)) {
      if (url.pathname.endsWith("/begin")) return json(response, { revision: 1 });
      if (url.pathname.endsWith("/pages")) return json(response, { accepted: 1 });
      return json(response, { sealed: true });
    }
    response.writeHead(404).end();
  });
  const root = await listen(server);
  return { root, state };
}

function client(apiBaseUrl: string): IngestionClient {
  return new IngestionClient({
    apiBaseUrl,
    deviceAuthorization,
    allowInsecureLocalhost: true,
    leaseHeartbeatIntervalMs: 60_000,
  });
}

function spoolOptions(directoryPath: string) {
  return {
    directory: directoryPath,
    maximumObjectBytes: 4 * 1024 * 1024,
    reserveFreeBytes: 4096,
    freeBytes: async () => 100 * 1024 * 1024,
  };
}

async function prepareReceived(
  store: CheckpointStore,
  sourceUrl: string,
  spoolDirectory: string,
  bytes: Buffer,
) {
  store.capturePage(sourceKey, { databaseServerIdentifier: "recovery-db", databaseVersion: 6 }, 0, {
    last: 0,
    done: true,
    changes: [],
  });
  const orthanc = new OrthancDiscoveryClient({ baseUrl: sourceUrl, pageSize: 2 });
  const upload = await spoolInstance(sourceKey, 0, observation(), orthanc, store, {
    ...spoolOptions(spoolDirectory),
  });
  assert.equal(upload.sha256, digest(bytes));
  store.uploads.recordAuthorization(
    upload.admissionKey,
    upload.generation,
    oldUploadId,
    new Date(Date.now() + 60_000).toISOString(),
  );
  store.uploads.markReceived(upload.admissionKey, upload.generation);
  await unlink(upload.spoolPath!);
  store.uploads.clearReceivedSpoolPath(upload.admissionKey);
  return upload;
}

test("reopened SQLite re-admits a stale receipt after current-fence authorization", async () => {
  const bytes = Buffer.from("DICM-recovered-receipt");
  const source = await sourceFixture(bytes);
  const spoolDirectory = join(directory, "stale-receipt-spool");
  const databasePath = join(directory, "stale-receipt.sqlite");
  let store = new CheckpointStore(databasePath);
  const original = await prepareReceived(store, source.baseUrl, spoolDirectory, bytes);
  store.close();
  store = new CheckpointStore(databasePath);
  const cloud = await cloudFixture({ bytes, replaceReceived: true });
  const orthanc = new OrthancDiscoveryClient({ baseUrl: source.baseUrl, pageSize: 2 });
  const recovered = await recoverReceivedUpload(
    store.uploads.get(original.admissionKey)!,
    0,
    observation("orthanc-replaced-instance"),
    orthanc,
    store,
    client(cloud.root),
    spoolOptions(spoolDirectory),
  );
  if (typeof recovered !== "object") throw new Error("expected a replacement local spool");
  assert.equal(recovered.state, "spooled");
  assert.equal(recovered.orthancInstanceId, "orthanc-replaced-instance");
  const result = await new InstanceUploader(
    sourceKey,
    store,
    orthanc,
    client(cloud.root),
    4 * 1024 * 1024,
  ).send(recovered);
  assert.equal(result.state, "received");
  assert.equal(cloud.state.putCalls, 1);
  assert.deepEqual(cloud.state.body, bytes);
  const final = store.uploads.get(original.admissionKey)!;
  assert.equal(final.state, "received");
  assert.equal(final.uploadId, replacementUploadId);
  assert.equal(final.spoolPath, null);
  store.close();
});

test("valid same-fence receipt stays pending if Orthanc is offline; completed is cached for the run", async () => {
  const bytes = Buffer.from("DICM-pending-receipt");
  const source = await sourceFixture(bytes);
  const spoolDirectory = join(directory, "pending-receipt-spool");
  const store = new CheckpointStore(join(directory, "pending-receipt.sqlite"));
  const original = await prepareReceived(store, source.baseUrl, spoolDirectory, bytes);
  source.state.missing = true;
  const cloud = await cloudFixture({ bytes });
  const orthanc = new OrthancDiscoveryClient({ baseUrl: source.baseUrl, pageSize: 2 });
  const recoveryClient = client(cloud.root);
  const pending = await recoverReceivedUpload(
    store.uploads.get(original.admissionKey)!,
    0,
    observation(),
    orthanc,
    store,
    recoveryClient,
    spoolOptions(spoolDirectory),
  );
  assert.equal(pending, "pending");
  assert.equal(source.state.reads, 1);
  cloud.state.uploadStatus = "completed";
  const completed = await recoverReceivedUpload(
    store.uploads.get(original.admissionKey)!,
    0,
    observation(),
    orthanc,
    store,
    recoveryClient,
    spoolOptions(spoolDirectory),
  );
  assert.equal(completed, "completed");
  assert.equal(cloud.state.authorizationCalls, 1);
  assert.equal(store.uploads.get(original.admissionKey)?.state, "received");
  store.close();
});

test("changed or missing source after replacement authorization requires attention", async () => {
  for (const missing of [false, true]) {
    const bytes = Buffer.from("DICM-original-receipt");
    const source = await sourceFixture(bytes);
    const spoolDirectory = join(directory, `changed-${missing}-spool`);
    const store = new CheckpointStore(join(directory, `changed-${missing}.sqlite`));
    const original = await prepareReceived(store, source.baseUrl, spoolDirectory, bytes);
    const cloud = await cloudFixture({ bytes, replaceReceived: true });
    if (missing) source.state.missing = true;
    else source.state.bytes = Buffer.from("DICM-mutated-receipt");
    await assert.rejects(
      recoverReceivedUpload(
        store.uploads.get(original.admissionKey)!,
        0,
        observation(),
        new OrthancDiscoveryClient({ baseUrl: source.baseUrl, pageSize: 2 }),
        store,
        client(cloud.root),
        spoolOptions(spoolDirectory),
      ),
    );
    const blocked = store.uploads.get(original.admissionKey)!;
    assert.equal(blocked.state, "needs-attention");
    assert.equal(blocked.spoolPath, null);
    assert.equal(cloud.state.putCalls, 0);
    store.close();
  }
});

test("SyncLoop revisits a reopened received row, re-spools and replaces the stale cloud upload", async () => {
  const bytes = Buffer.from("DICM-sync-loop-recovery");
  const source = await sourceFixture(bytes);
  const spoolDirectory = join(directory, "loop-recovery-spool");
  const store = new CheckpointStore(join(directory, "loop-recovery.sqlite"));
  const original = await prepareReceived(store, source.baseUrl, spoolDirectory, bytes);
  store.capturePage(sourceKey, { databaseServerIdentifier: "recovery-db", databaseVersion: 6 }, 0, {
    last: 1,
    done: true,
    changes: [
      {
        sequence: 1,
        changeType: "NewInstance",
        resourceType: "Instance",
        orthancId: "orthanc-instance",
      },
    ],
  });
  const cloud = await cloudFixture({ bytes, replaceReceived: true });
  const orthanc = new OrthancDiscoveryClient({ baseUrl: source.baseUrl, pageSize: 2 });
  const coordinator = {
    runInitial: async () => ({
      run: { generation: 0, completedAt: new Date().toISOString() },
      status: "complete" as const,
      pagesProcessed: 0,
    }),
    runPeriodicReconciliation: async () => ({
      run: { generation: 0, completedAt: new Date().toISOString() },
      status: "complete" as const,
      pagesProcessed: 0,
    }),
  } as unknown as InventoryCoordinator;
  const feed = {
    pollOnce: async () => ({
      checkpoint: store.getCheckpoint(sourceKey)!,
      done: true,
      fetchedFrom: 1,
      changesCaptured: 0,
      resetDetected: false,
    }),
  } as unknown as OrthancChangeFeedAdapter;
  const loop = new SyncLoop(store, feed, coordinator, orthanc, client(cloud.root), {
    sourceKey,
    spoolDirectory,
    maximumObjectBytes: 4 * 1024 * 1024,
    reserveFreeBytes: 4096,
    pageBudget: 10,
    uploadBatchSize: 2,
    pollIntervalMs: 1000,
    reconciliationIntervalMs: 10_000,
  });
  try {
    await loop.runOnce(Date.now());
    await loop.runOnce(Date.now() + 11_000);
    assert.equal(cloud.state.putCalls, 1);
    assert.deepEqual(cloud.state.body, bytes);
    assert.equal(store.uploads.get(original.admissionKey)?.uploadId, replacementUploadId);
    assert.equal(store.uploads.get(original.admissionKey)?.state, "received");
  } finally {
    store.close();
  }
});
