#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { CheckpointStore } from "../../../apps/sync-service/dist/persistence/checkpoint-store.js";
import { OrthancDiscoveryClient } from "../../../apps/sync-service/dist/orthanc/discovery-client.js";
import { InstanceUploader } from "../../../apps/sync-service/dist/transfers/instance-uploader.js";
import { IngestionClient } from "../../../apps/sync-service/dist/transfers/ingestion-client.js";
import {
  spoolInstance,
  stableStudyAdmissionKey,
} from "../../../apps/sync-service/dist/transfers/spool-instance.js";
import { S3UploadAdmission } from "../../../libs/storage/dist/upload-admission.js";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const project = process.env.CLARITY_PROOF_PROJECT;
const envFile = process.env.CLARITY_PROOF_ENV_FILE;
const webUrl = process.env.CLARITY_WEB_URL;
const s3PublicEndpoint = process.env.INTAKE_S3_PUBLIC_ENDPOINT;
const uploadPassword = process.env.INTAKE_UPLOAD_PASSWORD;
const resultFile = process.env.CLARITY_PROOF_RESULT_FILE;
if (!project || !envFile || !webUrl || !s3PublicEndpoint || !uploadPassword) {
  throw new Error(
    "Set proof project, env file, web URL, public MinIO endpoint and synthetic upload secret.",
  );
}

const sourceId = randomUUID();
const deviceId = randomUUID();
const proofNonce = randomUUID();
const sourceKey = `synthetic-multipart-${sourceId}`;
const fixtureRoot = await mkdtemp(join(tmpdir(), "clarity-v2-multipart-proof-"));
await chmod(fixtureRoot, 0o700);
const spoolDirectory = join(fixtureRoot, "spool");
const localDatabasePath = join(fixtureRoot, "checkpoint.sqlite");
const filePath = join(fixtureRoot, "synthetic-transfer.bin");
const totalBytes = 64 * 1024 * 1024 + 1;
const partBytes = 32 * 1024 * 1024;
const studyInstanceUid = `2.25.${BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString()}`;
const seriesInstanceUid = `2.25.${BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString()}`;
const sopInstanceUid = `2.25.${BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString()}`;
const orthancInstanceId = `synthetic-instance-${proofNonce}`;
const admissionKey = randomUUID();
const sha256 = createHash("sha256");
let sourceServer;
let sourceUrl;
let store;
let lostAcceptedPartResponse = false;
let expiredUrlRejected = false;
let alteredFirstAuthorization = false;
let injectedAcceptanceLoss = true;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function newCredential() {
  return randomBytes(32).toString("base64url");
}

function checked(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr ?? "")
      .trim()
      .slice(-1000);
    throw new Error(
      `${command} failed (${result.status ?? "signal"})${message ? `: ${message}` : ""}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  envFile,
  "--file",
  join(root, "deploy/cloud/compose.yaml"),
  "--file",
  join(root, "deploy/cloud/compose.application.yaml"),
];

function psql(sql) {
  return checked("docker", [
    ...composeArgs,
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "-X",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--username",
    "postgres",
    "--dbname",
    "clarity_v2_app",
    "--command",
    sql,
  ]);
}

function bootstrapDevice() {
  psql(
    `INSERT INTO public.orthanc_sources(id,display_name) VALUES ('${sourceId}','Synthetic multipart recovery ${proofNonce}');`,
  );
  const admin = psql(
    "SELECT COALESCE(bootstrapped_user_id::text,'') FROM public.staff_access_control WHERE singleton_id=1;",
  );
  if (!admin) {
    const adminId = randomUUID();
    const identityId = randomUUID();
    psql(
      `INSERT INTO public.staff_users(id,display_name) VALUES ('${adminId}','Synthetic proof administrator'); INSERT INTO public.staff_identities(id,staff_user_id,provider,issuer,subject) VALUES ('${identityId}','${adminId}','hanko','https://synthetic-proof.invalid','multipart-${proofNonce}'); SET ROLE clarity_v2_bootstrap_operator; SELECT public.bootstrap_first_staff_admin('${adminId}','${identityId}'); RESET ROLE;`,
    );
  }
  const deviceSecret = newCredential();
  const pairingSecret = `cp2_${newCredential()}`;
  const pairingId = randomUUID();
  psql(
    `SELECT public.create_source_pairing((SELECT bootstrapped_user_id FROM public.staff_access_control WHERE singleton_id=1), '${sourceId}', '${pairingId}', decode('${digest(pairingSecret)}','hex'), clock_timestamp()+interval '10 minutes'); SELECT * FROM public.consume_source_pairing(decode('${digest(pairingSecret)}','hex'), '${deviceId}', 'Synthetic multipart proof', decode('${digest(deviceSecret)}','hex'));`,
  );
  return `ClarityDevice ${deviceId}.${deviceSecret}`;
}

async function makeFixtureFile() {
  const writer = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  const block = Buffer.alloc(1024 * 1024, 0x5c);
  let written = 0;
  let markerWritten = false;
  while (written < totalBytes) {
    let next = block.subarray(0, Math.min(block.length, totalBytes - written));
    if (!markerWritten) {
      next = Buffer.from(next);
      next.write("DICM", 0, "ascii");
      markerWritten = true;
    }
    if (!writer.write(next)) await once(writer, "drain");
    sha256.update(next);
    written += next.length;
  }
  const finished = once(writer, "finish");
  writer.end();
  await finished;
  return sha256.digest("hex");
}

async function listenSource() {
  sourceServer = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== `/instances/${orthancInstanceId}/file`) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/dicom",
      "content-length": String(totalBytes),
    });
    createReadStream(filePath).pipe(response);
  });
  sourceServer.listen(0, "127.0.0.1");
  await once(sourceServer, "listening");
  const address = sourceServer.address();
  if (!address || typeof address === "string") throw new Error("Synthetic source did not bind");
  sourceUrl = `http://127.0.0.1:${address.port}`;
}

function createClient(deviceAuthorization, intercept = false) {
  const fetchImpl = async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    const response = await fetch(input, init);
    if (
      intercept &&
      !alteredFirstAuthorization &&
      init?.method === "POST" &&
      url.pathname === "/api/ingestion/uploads"
    ) {
      const value = await response.clone().json();
      if (value.mode === "multipart" && value.parts?.length >= 3) {
        const now = new Date(Date.now() - 11 * 60_000);
        const expiredSigner = new S3UploadAdmission(
          {
            internalEndpoint: new URL("http://127.0.0.1:9000"),
            publicEndpoint: new URL(s3PublicEndpoint),
            bucket: "clarity-v2-intake",
            region: "us-east-1",
            accessKey: "clarity-intake-upload",
            secretKey: uploadPassword,
          },
          fetch,
          () => now,
        );
        const key = `intake/${sourceId}/${value.uploadId}.dcm`;
        const expiry = new Date(now.getTime() + 10 * 60_000);
        const oldPlan = expiredSigner.resumeUpload(
          key,
          totalBytes,
          value.multipartUploadId,
          expiry,
        );
        value.parts[0].put.url = oldPlan.parts[0].url;
        alteredFirstAuthorization = true;
        return new Response(JSON.stringify(value), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (intercept && init?.method === "PUT" && url.searchParams.has("partNumber")) {
      if (response.status === 403 || response.status === 410) expiredUrlRejected = true;
      else if (
        response.ok &&
        injectedAcceptanceLoss &&
        url.searchParams.get("partNumber") === "1"
      ) {
        injectedAcceptanceLoss = false;
        lostAcceptedPartResponse = true;
        await response.body?.cancel().catch(() => undefined);
        throw new TypeError("synthetic response loss after provider accepted multipart part");
      }
    }
    return response;
  };
  return new IngestionClient({
    apiBaseUrl: webUrl,
    deviceAuthorization,
    allowInsecureLocalhost: true,
    fetchImpl,
  });
}

function multipartObservation() {
  return {
    orthancInstanceId,
    orthancStudyId: `synthetic-study-${proofNonce}`,
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid,
  };
}

async function admitStudy(deviceAuthorization) {
  const cloud = createClient(deviceAuthorization);
  const report = {
    sourceKey,
    studyInstanceUid,
    orthancStudyId: `synthetic-study-${proofNonce}`,
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
  await cloud.admitStudy(report, stableStudyAdmissionKey(sourceKey, studyInstanceUid));
  return cloud;
}

function openStore(path) {
  const opened = new CheckpointStore(path);
  opened.capturePage(
    sourceKey,
    { databaseServerIdentifier: "synthetic-multipart-db", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  return opened;
}

function uploader(opened, cloud) {
  const orthanc = new OrthancDiscoveryClient({ baseUrl: sourceUrl, pageSize: 2 });
  return new InstanceUploader(sourceKey, opened, orthanc, cloud, totalBytes + 1024);
}

async function closeSource() {
  if (!sourceServer) return;
  await new Promise((resolveClose) => sourceServer.close(resolveClose));
  sourceServer = undefined;
}

async function run() {
  checked(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "build",
      "--filter=@clarity/sync-service...",
      "--filter=@clarity/storage...",
    ],
    120_000,
  );
  const expectedSha = await makeFixtureFile();
  await listenSource();
  const deviceAuthorization = bootstrapDevice();
  const cloud = await admitStudy(deviceAuthorization);
  store = openStore(localDatabasePath);
  const upload = await spoolInstance(
    sourceKey,
    0,
    multipartObservation(),
    new OrthancDiscoveryClient({ baseUrl: sourceUrl, pageSize: 2 }),
    store,
    {
      directory: spoolDirectory,
      maximumObjectBytes: totalBytes + 1024,
      reserveFreeBytes: 0,
      freeBytes: async () => totalBytes * 3,
    },
  );
  assert.equal(upload.byteCount, totalBytes);
  assert.equal(upload.sha256, expectedSha);
  await assert.rejects(
    uploader(store, createClient(deviceAuthorization, true)).send(upload),
    /synthetic response loss after provider accepted multipart part/,
  );
  assert.equal(
    alteredFirstAuthorization,
    true,
    "first grant should carry a validly signed stale URL",
  );
  assert.equal(expiredUrlRejected, true, "MinIO should reject the stale signed part URL");
  assert.equal(
    lostAcceptedPartResponse,
    true,
    "MinIO should accept a part before its response is lost",
  );
  const interrupted = store.uploads.get(upload.admissionKey);
  assert.ok(interrupted);
  assert.equal(interrupted.uploadId !== null, true);
  assert.equal(store.uploads.listParts(upload.admissionKey).length, 0);
  const firstUploadId = interrupted.uploadId;
  assert.ok(firstUploadId, "cloud multipart authorization should be durable before transfer");
  store.close();

  store = new CheckpointStore(localDatabasePath);
  const resumed = store.uploads.get(upload.admissionKey);
  assert.ok(resumed);
  assert.equal(resumed.uploadId, firstUploadId, "SQLite reopen should retain the same upload ID");
  const recoveredClient = createClient(deviceAuthorization);
  const result = await uploader(store, recoveredClient).send(resumed);
  assert.equal(result.state, "received");
  assert.equal(result.byteCount, totalBytes);
  assert.equal(result.sha256, expectedSha);
  assert.equal(await recoveredClient.status(firstUploadId), "received");
  assert.equal(store.uploads.listParts(upload.admissionKey).length, 3);
  assert.equal(store.uploads.get(upload.admissionKey)?.spoolPath, null);

  return {
    sourceBytes: totalBytes,
    sourceSha256: expectedSha,
    multipartParts: [partBytes, partBytes, totalBytes - 2 * partBytes],
    expiredSignedPartRejected: expiredUrlRejected,
    providerAcceptedPartResponseWasLost: lostAcceptedPartResponse,
    localReceiptAbsentBeforeRestart: true,
    sameUploadRecoveredAfterSQLiteReopen: true,
    finalStatus: "received",
    finalLocalPartReceipts: store.uploads.listParts(upload.admissionKey).length,
    proof: [
      "signed multipart upload against disposable MinIO",
      "a stale signed URL was rejected, then freshly authorized",
      "provider accepted part 1 before its response was dropped",
      "process-local SQLite was closed and reopened with no part-1 receipt",
      "same multipart upload resumed and verified server-side size and SHA-256",
    ],
  };
}

let result;
try {
  result = await run();
  if (resultFile) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify(result));
} finally {
  store?.close();
  await closeSource();
  await rm(fixtureRoot, { recursive: true, force: true });
}
