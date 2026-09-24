import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";
import { OrthancDiscoveryClient } from "../src/orthanc/discovery-client.js";
import { IngestionClient } from "../src/transfers/ingestion-client.js";
import { InstanceUploader } from "../src/transfers/instance-uploader.js";
import {
  SourceBytesChangedError,
  StaleUploadGenerationError,
  pruneOrphanedSpools,
  spoolInstance,
  stableAdmissionKey,
  stableStudyAdmissionKey,
} from "../src/transfers/spool-instance.js";
import type { LocalUpload } from "../src/persistence/upload-spool-store.js";

const studyUid = "2.25.880";
const seriesUid = "2.25.881";
const sopUid = "2.25.882";
const deviceAuthorization = `ClarityDevice 123e4567-e89b-12d3-a456-426614174000.${"A".repeat(43)}`;
const servers: Server[] = [];
let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "clarity-v2-spool-test-"));
});

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await import("node:fs/promises").then(({ rm }) =>
    rm(directory, { recursive: true, force: true }),
  );
});

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("admission keys are deterministic UUIDv5 values for local source and SOP identity", () => {
  const first = stableAdmissionKey("synthetic-source", sopUid);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, stableAdmissionKey("synthetic-source", sopUid));
  assert.notEqual(first, stableAdmissionKey("other-source", sopUid));
  const study = stableStudyAdmissionKey("synthetic-source", studyUid);
  assert.match(study, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(study, stableStudyAdmissionKey("synthetic-source", studyUid));
  assert.notEqual(study, stableStudyAdmissionKey("synthetic-source", "2.25.999"));
});

async function bodyBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function sourceFixture(initial: Buffer) {
  const state = { bytes: initial, reads: 0 };
  const server = createServer((request, response) => {
    if (request.url !== "/instances/orthanc-instance/file") {
      response.writeHead(404).end();
      return;
    }
    state.reads += 1;
    response.writeHead(200, {
      "content-type": "application/dicom",
      "content-length": state.bytes.length,
    });
    const split = Math.floor(state.bytes.length / 2);
    response.write(state.bytes.subarray(0, split));
    response.end(state.bytes.subarray(split));
  });
  const baseUrl = await listen(server);
  return { state, baseUrl };
}

interface CloudOptions {
  mode?: "put" | "multipart";
  expectedBytes?: Buffer;
  expireFirst?: boolean;
  loseAcceptedPartResponse?: number;
  failPartBeforeAcceptance?: number;
  loseCompletionResponse?: boolean;
  failStatusOnce?: boolean;
  alreadyReceived?: boolean;
  takeoverDuringPut?: boolean;
  afterPutAccepted?: () => void;
}

async function cloudFixture(options: CloudOptions = {}) {
  const state = {
    leaseCalls: 0,
    authorizationCalls: 0,
    putCalls: 0,
    acceptedParts: new Map<number, Buffer>(),
    etags: new Map<number, string>(),
    uploadStatus: "uploading",
    completionCalls: 0,
    body: options.expectedBytes ?? Buffer.alloc(0),
    lostParts: new Set<number>(),
    failedParts: new Set<number>(),
    statusFailed: false,
    takeoverDuringPut: options.takeoverDuringPut === true,
  };
  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    if (path.startsWith("/api/") && request.headers.authorization !== deviceAuthorization) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "POST" && path === "/api/ingestion/lease") {
      state.leaseCalls += 1;
      const takeoverReady = state.takeoverDuringPut && state.putCalls > 0;
      sendJson(response, {
        sourceGeneration: takeoverReady && state.leaseCalls > 1 ? 2 : 1,
        fencingToken: takeoverReady && state.leaseCalls > 1 ? "13" : "12",
        leaseExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
      });
      return;
    }
    if (request.method === "POST" && path === "/api/ingestion/uploads") {
      const admission = JSON.parse((await bodyBytes(request)).toString("utf8")) as {
        byteCount: number;
        sha256: string;
        admissionKey: string;
        sourceGeneration?: number;
      };
      assert.equal(admission.admissionKey, stableAdmissionKey("synthetic-source", sopUid));
      assert.equal(admission.sourceGeneration, 1);
      assert.equal(admission.sha256, hash(state.body));
      state.authorizationCalls += 1;
      if (options.alreadyReceived) {
        state.uploadStatus = "received";
        sendJson(response, {
          uploadId: "00000000-0000-4000-8000-000000000001",
          status: state.uploadStatus,
        });
        return;
      }
      const expiresAt =
        options.expireFirst && state.authorizationCalls === 1
          ? new Date(Date.now() - 60_000).toISOString()
          : new Date(Date.now() + 10 * 60_000).toISOString();
      if (options.mode === "put") {
        sendJson(response, {
          uploadId: "00000000-0000-4000-8000-000000000001",
          expiresAt,
          mode: "put",
          put: { url: `${root}/signed/file`, headers: { "content-type": "application/dicom" } },
        });
      } else {
        const middle = Math.ceil(admission.byteCount / 2);
        const ranges = [
          { partNumber: 1, offset: 0, byteCount: middle },
          { partNumber: 2, offset: middle, byteCount: admission.byteCount - middle },
        ];
        sendJson(response, {
          uploadId: "00000000-0000-4000-8000-000000000001",
          multipartUploadId: "multipart-synthetic",
          expiresAt,
          mode: "multipart",
          parts: ranges.map((part) => ({
            ...part,
            put: { url: `${root}/signed/part/${part.partNumber}`, headers: {} },
            ...(state.etags.has(part.partNumber)
              ? { acknowledgedEtag: state.etags.get(part.partNumber) }
              : {}),
          })),
        });
      }
      return;
    }
    if (request.method === "PUT" && path === "/signed/file") {
      state.putCalls += 1;
      const bytes = await bodyBytes(request);
      state.body = bytes;
      options.afterPutAccepted?.();
      state.uploadStatus = "uploading";
      if (state.takeoverDuringPut)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      response.writeHead(200, { etag: `"${hash(bytes)}"` }).end();
      return;
    }
    const partPath = path.match(/^\/signed\/part\/(\d+)$/);
    if (request.method === "PUT" && partPath) {
      const partNumber = Number(partPath[1]);
      state.putCalls += 1;
      if (options.failPartBeforeAcceptance === partNumber && !state.failedParts.has(partNumber)) {
        state.failedParts.add(partNumber);
        request.socket.destroy();
        return;
      }
      const bytes = await bodyBytes(request);
      const etag = `"${hash(bytes)}"`;
      state.acceptedParts.set(partNumber, bytes);
      state.etags.set(partNumber, etag);
      if (options.loseAcceptedPartResponse === partNumber && !state.lostParts.has(partNumber)) {
        state.lostParts.add(partNumber);
        response.destroy();
        return;
      }
      response.writeHead(200, { etag }).end();
      return;
    }
    if (
      request.method === "POST" &&
      path === "/api/ingestion/uploads/00000000-0000-4000-8000-000000000001/complete"
    ) {
      state.completionCalls += 1;
      const completion = JSON.parse((await bodyBytes(request)).toString("utf8")) as {
        byteCount: number;
        sha256: string;
        parts: Array<{ partNumber: number; etag: string; byteCount: number }>;
      };
      if (options.mode === "put") {
        assert.equal(completion.parts.length, 0);
      } else {
        const ordered = [...completion.parts].sort(
          (left, right) => left.partNumber - right.partNumber,
        );
        for (const part of ordered) assert.equal(state.etags.get(part.partNumber), part.etag);
        state.body = Buffer.concat(
          ordered.map((part) => state.acceptedParts.get(part.partNumber)!),
        );
      }
      assert.equal(state.body.length, completion.byteCount);
      assert.equal(hash(state.body), completion.sha256);
      state.uploadStatus = "received";
      if (options.loseCompletionResponse) {
        options.loseCompletionResponse = false;
        response.destroy();
        return;
      }
      sendJson(response, { status: "received" });
      return;
    }
    if (
      request.method === "GET" &&
      path === "/api/ingestion/uploads/00000000-0000-4000-8000-000000000001"
    ) {
      if (options.failStatusOnce && !state.statusFailed) {
        state.statusFailed = true;
        response.destroy();
        return;
      }
      sendJson(response, { status: state.uploadStatus });
      return;
    }
    response.writeHead(404).end();
  });
  const root = await listen(server);
  return { root, state, server };
}

function openStore(path: string): CheckpointStore {
  const store = new CheckpointStore(path);
  store.capturePage(
    "synthetic-source",
    { databaseServerIdentifier: "synthetic-db", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  return store;
}

function observation() {
  return {
    orthancInstanceId: "orthanc-instance",
    orthancStudyId: "orthanc-study",
    studyInstanceUid: studyUid,
    seriesInstanceUid: seriesUid,
    sopInstanceUid: sopUid,
  };
}

async function spool(
  store: CheckpointStore,
  sourceUrl: string,
  spoolDirectory: string,
  freeBytes: () => Promise<number> = async () => 100 * 1024 * 1024,
): Promise<LocalUpload> {
  return spoolInstance(
    "synthetic-source",
    0,
    observation(),
    new OrthancDiscoveryClient({ baseUrl: sourceUrl, pageSize: 2 }),
    store,
    {
      directory: spoolDirectory,
      maximumObjectBytes: 4 * 1024 * 1024,
      reserveFreeBytes: 4096,
      freeBytes,
    },
  );
}

function uploader(
  store: CheckpointStore,
  sourceUrl: string,
  apiUrl: string,
  leaseHeartbeatIntervalMs = 60_000,
): InstanceUploader {
  return new InstanceUploader(
    "synthetic-source",
    store,
    new OrthancDiscoveryClient({ baseUrl: sourceUrl, pageSize: 2 }),
    new IngestionClient({
      apiBaseUrl: apiUrl,
      deviceAuthorization,
      allowInsecureLocalhost: true,
      leaseHeartbeatIntervalMs,
    }),
    4 * 1024 * 1024,
  );
}

test("ingestion client accepts only the issued ClarityDevice authorization scheme", () => {
  assert.throws(
    () =>
      new IngestionClient({
        apiBaseUrl: "https://cloud.example.invalid",
        deviceAuthorization: "Bearer synthetic-token",
      }),
    /issued ClarityDevice authorization/,
  );
});

test("uploader stops an in-flight signed PUT and records attention after cloud lease takeover", async () => {
  const store = openStore(join(directory, "takeover.sqlite"));
  const bytes = Buffer.from("synthetic-slow-transfer-only");
  const source = await sourceFixture(bytes);
  const cloud = await cloudFixture({ mode: "put", expectedBytes: bytes, takeoverDuringPut: true });
  const upload = await spool(store, source.baseUrl, join(directory, "takeover-spool"));
  try {
    await assert.rejects(
      uploader(store, source.baseUrl, cloud.root, 50).send(upload),
      /cloud source lease was lost during upload/,
    );
    assert.ok(cloud.state.leaseCalls >= 2);
    assert.equal(cloud.state.putCalls, 1);
    assert.equal(cloud.state.completionCalls, 0);
    assert.equal(store.uploads.findBySop("synthetic-source", sopUid)?.state, "needs-attention");
  } finally {
    store.close();
  }
});

test("spools one private Orthanc file atomically with a durable SHA and restrictive mode", async () => {
  const bytes = Buffer.concat([Buffer.from("DICM"), Buffer.alloc(128 * 1024, 0x5a)]);
  const source = await sourceFixture(bytes);
  const spoolDir = join(directory, "atomic-spool");
  const store = openStore(join(directory, "atomic-spool.sqlite"));
  const upload = await spool(store, source.baseUrl, spoolDir);
  assert.equal(upload.byteCount, bytes.length);
  assert.equal(upload.sha256, hash(bytes));
  assert.equal(upload.state, "spooled");
  assert.equal((await stat(upload.spoolPath!)).mode & 0o777, 0o600);
  assert.equal((await readdir(spoolDir)).length, 1);
  assert.equal(source.state.reads, 1);
  store.close();
});

test("low spool capacity refuses admission before reading or persisting a file", async () => {
  const source = await sourceFixture(Buffer.from("DICM"));
  const store = openStore(join(directory, "low-space.sqlite"));
  await assert.rejects(
    spool(store, source.baseUrl, join(directory, "low-space"), async () => 4096),
    /free-space reserve/,
  );
  assert.equal(source.state.reads, 0);
  assert.equal(store.uploads.findBySop("synthetic-source", sopUid), null);
  store.close();
});

test("spool capacity loss during a response removes the partial file and records no upload", async () => {
  const source = await sourceFixture(Buffer.alloc(128 * 1024, 0x5a));
  const spoolDir = join(directory, "midstream-low-space");
  const store = openStore(join(directory, "midstream-low-space.sqlite"));
  let checks = 0;
  await assert.rejects(
    spool(store, source.baseUrl, spoolDir, async () => (++checks < 3 ? 1024 * 1024 : 4096)),
    /reached its protected free-space reserve/,
  );
  assert.equal(source.state.reads, 1);
  assert.equal((await readdir(spoolDir)).length, 0);
  assert.equal(store.uploads.findBySop("synthetic-source", sopUid), null);
  store.close();
});

test("changed Orthanc bytes stop admission and preserve the local snapshot for attention", async () => {
  const source = await sourceFixture(Buffer.from("DICM-original"));
  const store = openStore(join(directory, "changed-source.sqlite"));
  const upload = await spool(store, source.baseUrl, join(directory, "changed-spool"));
  const cloud = await cloudFixture({ mode: "put" });
  source.state.bytes = Buffer.from("DICM-replaced");
  await assert.rejects(
    uploader(store, source.baseUrl, cloud.root).send(upload),
    SourceBytesChangedError,
  );
  assert.equal(cloud.state.authorizationCalls, 0);
  assert.equal(store.uploads.get(upload.admissionKey)?.state, "needs-attention");
  assert.ok(await stat(upload.spoolPath!));
  store.close();
});

test("source mutation after signed PUT acceptance blocks cloud completion", async () => {
  const source = await sourceFixture(Buffer.from("DICM-before-put"));
  const store = openStore(join(directory, "changed-during-upload.sqlite"));
  const upload = await spool(store, source.baseUrl, join(directory, "changed-during-upload-spool"));
  const cloud = await cloudFixture({
    mode: "put",
    expectedBytes: Buffer.from("DICM-before-put"),
    afterPutAccepted: () => {
      source.state.bytes = Buffer.from("DICM-mutated-before-completion");
    },
  });
  await assert.rejects(
    uploader(store, source.baseUrl, cloud.root).send(upload),
    SourceBytesChangedError,
  );
  assert.equal(cloud.state.putCalls, 1);
  assert.equal(cloud.state.completionCalls, 0);
  assert.equal(cloud.state.authorizationCalls, 1);
  assert.equal(store.uploads.get(upload.admissionKey)?.state, "needs-attention");
  assert.ok(await stat(upload.spoolPath!));
  store.close();
});

test("changed local spool bytes stop admission and preserve the file for attention", async () => {
  const source = await sourceFixture(Buffer.from("DICM-stable"));
  const cloud = await cloudFixture({ mode: "put" });
  const store = openStore(join(directory, "changed-spool.sqlite"));
  const upload = await spool(store, source.baseUrl, join(directory, "changed-spool-bytes"));
  await writeFile(upload.spoolPath!, "DICM-corrupted");
  await assert.rejects(
    uploader(store, source.baseUrl, cloud.root).send(upload),
    /Local spool bytes changed/,
  );
  assert.equal(cloud.state.authorizationCalls, 0);
  assert.equal(store.uploads.get(upload.admissionKey)?.state, "needs-attention");
  assert.ok(await stat(upload.spoolPath!));
  store.close();
});

test("startup spool recovery removes only untracked private artifacts", async () => {
  const source = await sourceFixture(Buffer.from("DICM-kept"));
  const spoolDir = join(directory, "orphan-recovery");
  const store = openStore(join(directory, "orphan-recovery.sqlite"));
  const tracked = await spool(store, source.baseUrl, spoolDir);
  const orphan = join(spoolDir, "11111111-1111-4111-8111-111111111111.spool");
  const partial = join(spoolDir, "22222222-2222-4222-8222-222222222222.spool.partial");
  const unrelated = join(spoolDir, "keep-me.txt");
  await writeFile(orphan, "orphan");
  await writeFile(partial, "partial");
  await writeFile(unrelated, "unrelated");

  assert.deepEqual(await pruneOrphanedSpools(spoolDir, store), {
    removedPartial: 1,
    removedSpool: 1,
  });
  assert.ok(await stat(tracked.spoolPath!));
  assert.ok(await stat(unrelated));
  await assert.rejects(stat(orphan));
  await assert.rejects(stat(partial));
  store.close();
});

test("byte-identical unadmitted SOP spool is rehashed and safely rebound to a new generation", async () => {
  const bytes = Buffer.from("DICM-generation");
  const source = await sourceFixture(bytes);
  const spoolDir = join(directory, "stale-generation-spool");
  const store = openStore(join(directory, "stale-generation.sqlite"));
  const cloud = await cloudFixture({ mode: "put", expectedBytes: bytes });
  const upload = await spool(store, source.baseUrl, spoolDir);
  store.capturePage(
    "synthetic-source",
    { databaseServerIdentifier: "replaced-db", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  const checkpoint = store.getCheckpoint("synthetic-source")!;
  assert.equal(checkpoint.generation, 1);
  const rebound = await spoolInstance(
    "synthetic-source",
    checkpoint.generation,
    observation(),
    new OrthancDiscoveryClient({ baseUrl: source.baseUrl, pageSize: 2 }),
    store,
    {
      directory: spoolDir,
      maximumObjectBytes: 4 * 1024 * 1024,
      reserveFreeBytes: 4096,
      freeBytes: async () => 100 * 1024 * 1024,
    },
  );
  assert.equal(rebound.admissionKey, upload.admissionKey);
  assert.equal(rebound.generation, 1);
  assert.equal(rebound.sha256, upload.sha256);
  assert.notEqual(rebound.spoolPath, upload.spoolPath);
  await assert.rejects(readFile(upload.spoolPath!));
  assert.equal(source.state.reads, 2);
  assert.equal((await uploader(store, source.baseUrl, cloud.root).send(rebound)).state, "received");
  assert.equal(cloud.state.authorizationCalls, 1);
  store.close();
});

test("changed bytes or prior cloud admission prevent stale spool supersession", async () => {
  const source = await sourceFixture(Buffer.from("DICM-old-generation"));
  const spoolDir = join(directory, "unsafe-generation-spool");
  const store = openStore(join(directory, "unsafe-generation.sqlite"));
  const upload = await spool(store, source.baseUrl, spoolDir);
  store.uploads.recordAuthorization(
    upload.admissionKey,
    upload.generation,
    "cloud-upload-already-admitted",
    new Date(Date.now() + 60_000).toISOString(),
  );
  store.capturePage(
    "synthetic-source",
    { databaseServerIdentifier: "replaced-db", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  const options = {
    directory: spoolDir,
    maximumObjectBytes: 4 * 1024 * 1024,
    reserveFreeBytes: 4096,
    freeBytes: async () => 100 * 1024 * 1024,
  };
  await assert.rejects(
    spoolInstance(
      "synthetic-source",
      1,
      observation(),
      new OrthancDiscoveryClient({ baseUrl: source.baseUrl, pageSize: 2 }),
      store,
      options,
    ),
    StaleUploadGenerationError,
  );
  assert.equal(source.state.reads, 1);
  const admittedConflict = store.uploads.get(upload.admissionKey)!;
  assert.equal(admittedConflict.generation, 0);
  assert.equal(admittedConflict.state, "needs-attention");
  assert.match(admittedConflict.attentionReason!, /reconcile cloud status/);

  const unadmittedStore = openStore(join(directory, "changed-generation.sqlite"));
  const different = await sourceFixture(Buffer.from("DICM-old-generation"));
  const unadmitted = await spool(
    unadmittedStore,
    different.baseUrl,
    join(directory, "changed-generation-spool"),
  );
  unadmittedStore.capturePage(
    "synthetic-source",
    { databaseServerIdentifier: "replaced-db", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  different.state.bytes = Buffer.from("DICM-new-generation");
  await assert.rejects(
    spoolInstance(
      "synthetic-source",
      1,
      observation(),
      new OrthancDiscoveryClient({ baseUrl: different.baseUrl, pageSize: 2 }),
      unadmittedStore,
      { ...options, directory: join(directory, "changed-generation-spool") },
    ),
    /bytes changed across source generations/,
  );
  const changedConflict = unadmittedStore.uploads.get(unadmitted.admissionKey)!;
  assert.equal(changedConflict.generation, 0);
  assert.equal(changedConflict.state, "needs-attention");
  assert.match(changedConflict.attentionReason!, /different bytes/);
  assert.ok(await stat(unadmitted.spoolPath!));
  store.close();
  unadmittedStore.close();
});

test("multipart recovery reconciles lost provider and completion responses after reopen", async () => {
  const bytes = Buffer.concat([Buffer.from("DICM"), Buffer.alloc(64 * 1024, 0x24)]);
  const source = await sourceFixture(bytes);
  const cloud = await cloudFixture({
    mode: "multipart",
    expectedBytes: bytes,
    loseAcceptedPartResponse: 1,
    failPartBeforeAcceptance: 2,
    loseCompletionResponse: true,
  });
  const spoolDir = join(directory, "multipart-spool");
  const dbPath = join(directory, "multipart.sqlite");
  let store = openStore(dbPath);
  const upload = await spool(store, source.baseUrl, spoolDir);
  await assert.rejects(uploader(store, source.baseUrl, cloud.root).send(upload));
  assert.equal(cloud.state.acceptedParts.has(1), true);
  assert.equal(store.uploads.listParts(upload.admissionKey).length, 0);
  store.close();

  store = new CheckpointStore(dbPath);
  const resumed = store.uploads.get(upload.admissionKey)!;
  await assert.rejects(uploader(store, source.baseUrl, cloud.root).send(resumed));
  assert.equal(store.uploads.listParts(upload.admissionKey).length, 1);
  assert.equal(cloud.state.acceptedParts.has(2), false);
  store.close();

  store = new CheckpointStore(dbPath);
  const finalResume = store.uploads.get(upload.admissionKey)!;
  const result = await uploader(store, source.baseUrl, cloud.root).send(finalResume);
  assert.equal(result.state, "received");
  assert.equal(cloud.state.uploadStatus, "received");
  assert.equal(cloud.state.body.length, bytes.length);
  assert.equal(store.uploads.get(upload.admissionKey)?.spoolPath, null);
  assert.equal(store.uploads.listParts(upload.admissionKey).length, 2);
  await assert.rejects(readFile(upload.spoolPath!));
  store.close();
});

test("an expired signed PUT is reauthorized once before any object write", async () => {
  const bytes = Buffer.concat([Buffer.from("DICM"), Buffer.alloc(4096, 0x33)]);
  const source = await sourceFixture(bytes);
  const cloud = await cloudFixture({ mode: "put", expectedBytes: bytes, expireFirst: true });
  const store = openStore(join(directory, "expired-upload.sqlite"));
  const upload = await spool(store, source.baseUrl, join(directory, "expired-spool"));
  const result = await uploader(store, source.baseUrl, cloud.root).send(upload);
  assert.equal(result.state, "received");
  assert.equal(cloud.state.authorizationCalls, 2);
  assert.equal(cloud.state.putCalls, 1);
  store.close();
});

test("completion accepted before process death is reconciled from durable status after reopen", async () => {
  const bytes = Buffer.concat([Buffer.from("DICM"), Buffer.alloc(8192, 0x45)]);
  const source = await sourceFixture(bytes);
  const cloud = await cloudFixture({
    mode: "put",
    expectedBytes: bytes,
    loseCompletionResponse: true,
    failStatusOnce: true,
  });
  const spoolDir = join(directory, "completion-crash-spool");
  const dbPath = join(directory, "completion-crash.sqlite");
  let store = openStore(dbPath);
  const upload = await spool(store, source.baseUrl, spoolDir);
  await assert.rejects(uploader(store, source.baseUrl, cloud.root).send(upload));
  assert.equal(cloud.state.uploadStatus, "received");
  assert.equal(store.uploads.get(upload.admissionKey)?.state, "completion-unknown");
  store.close();

  store = new CheckpointStore(dbPath);
  const resumed = store.uploads.get(upload.admissionKey)!;
  const result = await uploader(store, source.baseUrl, cloud.root).send(resumed);
  assert.equal(result.state, "received");
  assert.equal(cloud.state.authorizationCalls, 1);
  assert.equal(cloud.state.putCalls, 1);
  assert.equal(cloud.state.completionCalls, 1);
  assert.equal(store.uploads.get(upload.admissionKey)?.spoolPath, null);
  store.close();
});

test("idempotent cloud admission already received clears the spool without a repeated PUT", async () => {
  const bytes = Buffer.from("DICM-cloud-already-received");
  const source = await sourceFixture(bytes);
  const cloud = await cloudFixture({ mode: "put", expectedBytes: bytes, alreadyReceived: true });
  const store = openStore(join(directory, "idempotent-received.sqlite"));
  const upload = await spool(store, source.baseUrl, join(directory, "idempotent-received-spool"));

  const result = await uploader(store, source.baseUrl, cloud.root).send(upload);
  const durable = store.uploads.get(upload.admissionKey);
  assert.equal(result.state, "received");
  assert.equal(durable?.state, "received");
  assert.equal(durable?.spoolPath, null);
  assert.equal(cloud.state.authorizationCalls, 1);
  assert.equal(cloud.state.putCalls, 0);
  assert.equal(cloud.state.completionCalls, 0);
  store.close();
});
