#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const project = process.env.CLARITY_PROOF_PROJECT;
const envFile = process.env.CLARITY_PROOF_ENV_FILE;
const webUrl = process.env.CLARITY_WEB_URL;
const cloudOrthancUrl = process.env.CLARITY_PROOF_CLOUD_ORTHANC_URL;
const orthancUser = process.env.ORTHANC_HTTP_USERNAME;
const orthancPassword = process.env.ORTHANC_HTTP_PASSWORD;
const resultFile = process.env.CLARITY_PROOF_RESULT_FILE;
const pnpm = process.env.PNPM ?? "pnpm";
if (!project || !envFile || !webUrl || !cloudOrthancUrl || !orthancUser || !orthancPassword) {
  throw new Error(
    "Set project, env file, web URL, cloud Orthanc URL and Orthanc proof credentials in CLARITY_* variables.",
  );
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
const sourceId = randomUUID();
const deviceId = randomUUID();
const proofNonce = randomUUID();
const networkName = `clarity-v2-sync-proof-${process.pid}-${randomBytes(4).toString("hex")}`;
const sourceContainerName = `${networkName}-source`;
const sourceImage =
  "orthancteam/orthanc:26.8.2@sha256:9758c8702a89abece99fcfe6d5571d5eaae59587e8e1ce36b9aafc8d4f24457b";
const temp = await mkdtemp(join(tmpdir(), "clarity-v2-sync-process-proof-"));
await chmod(temp, 0o700);
const sourceConfigPath = join(temp, "source-orthanc.json");
const sourceOrthancPassword = credential();
const sourceAuthorization = `Basic ${Buffer.from(`proof:${sourceOrthancPassword}`).toString("base64")}`;
const stateDirectory = join(temp, "state");
const spoolDirectory = join(temp, "spool");
const databasePath = join(stateDirectory, "sync.sqlite");
const serviceRequire = createRequire(join(root, "apps/sync-service/package.json"));
const Database = serviceRequire("better-sqlite3");
let child;
let stopping;
let childError;
let sigtermRequested = false;
let sourceUrl;
let sourceContainerStarted = false;
let proofNetworkCreated = false;

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const diagnostic = String(result.stderr ?? "")
      .slice(-1200)
      .trim();
    throw new Error(
      `${command} failed (${result.status ?? "signal"})${diagnostic ? `: ${diagnostic}` : ""}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

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

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function credential() {
  return randomBytes(32).toString("base64url");
}

async function jsonRequest(base, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let value = {};
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Orthanc endpoint ${path} returned non-JSON (${response.status}).`);
  }
  if (!response.ok) throw new Error(`Orthanc endpoint ${path} returned HTTP ${response.status}.`);
  return value;
}

async function writeDicom() {
  const path = join(temp, "synthetic.dcm");
  const generator = join(root, "deploy/cloud/scripts/make-synthetic-dicom.py");
  const uidSuffix = BigInt(`0x${randomBytes(12).toString("hex")}`).toString();
  const output = checked("python3", [generator, path, uidSuffix]);
  const [studyInstanceUid, seriesInstanceUid, sopInstanceUid] = output.split("\t");
  if (!studyInstanceUid || !seriesInstanceUid || !sopInstanceUid)
    throw new Error("Synthetic DICOM generator returned incomplete UIDs.");
  if ([studyInstanceUid, seriesInstanceUid, sopInstanceUid].some((uid) => uid.length > 64))
    throw new Error("Synthetic DICOM generator returned a UID longer than the DICOM limit.");
  return {
    path,
    bytes: await readFile(path),
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid,
  };
}

async function startSourceOrthanc() {
  await writeFile(
    sourceConfigPath,
    `${JSON.stringify(
      {
        Name: `Synthetic source ${proofNonce}`,
        RemoteAccessAllowed: true,
        AuthenticationEnabled: true,
        RegisteredUsers: { proof: sourceOrthancPassword },
        DicomServerEnabled: false,
        HttpPort: 8042,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  checked("docker", ["network", "create", "--label", "clarity.proof=sync-process", networkName]);
  proofNetworkCreated = true;
  checked("docker", [
    "run",
    "--detach",
    "--name",
    sourceContainerName,
    "--network",
    networkName,
    "--publish",
    "127.0.0.1::8042",
    "--mount",
    `type=bind,src=${sourceConfigPath},dst=/etc/orthanc/00-proof.json,readonly`,
    sourceImage,
    "/etc/orthanc/00-proof.json",
  ]);
  sourceContainerStarted = true;
  const published = checked("docker", ["port", sourceContainerName, "8042/tcp"]);
  const port = Number(published.split(":").at(-1));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Source Orthanc did not receive a valid localhost-only port.");
  sourceUrl = `http://127.0.0.1:${port}/`;
  if (new URL(sourceUrl).origin === new URL(cloudOrthancUrl).origin)
    throw new Error("Source and cloud Orthanc endpoints must be distinct.");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      await jsonRequest(sourceUrl, "system", { headers: { authorization: sourceAuthorization } });
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error("Disposable source Orthanc did not become ready within 45 seconds.");
}

async function assertSopAbsentFromCloud(sopInstanceUid) {
  const authorization = `Basic ${Buffer.from(`${orthancUser}:${orthancPassword}`).toString("base64")}`;
  const found = await jsonRequest(cloudOrthancUrl, "tools/find", {
    method: "POST",
    headers: { authorization },
    body: { Level: "Instance", Query: { SOPInstanceUID: sopInstanceUid } },
  });
  if (!Array.isArray(found) || found.length !== 0)
    throw new Error("Unique synthetic SOP already exists in cloud Orthanc before sync starts.");
}

function prepareSource() {
  psql(
    `INSERT INTO public.orthanc_sources(id,display_name) VALUES ('${sourceId}','Synthetic compiled sync process ${proofNonce}');`,
  );
  const bootstrapState = psql(
    "SELECT COALESCE(bootstrapped_user_id::text,'') FROM public.staff_access_control WHERE singleton_id=1;",
  );
  if (!bootstrapState) {
    const adminId = randomUUID();
    const identityId = randomUUID();
    psql(
      `INSERT INTO public.staff_users(id,display_name) VALUES ('${adminId}','Synthetic proof administrator'); INSERT INTO public.staff_identities(id,staff_user_id,provider,issuer,subject) VALUES ('${identityId}','${adminId}','hanko','https://synthetic-proof.invalid','sync-process-${proofNonce}'); SET ROLE clarity_v2_bootstrap_operator; SELECT public.bootstrap_first_staff_admin('${adminId}','${identityId}'); RESET ROLE;`,
    );
  }
  const deviceSecret = credential();
  const pairingSecret = `cp2_${credential()}`;
  const pairingId = randomUUID();
  psql(
    `SELECT public.create_source_pairing((SELECT bootstrapped_user_id FROM public.staff_access_control WHERE singleton_id=1), '${sourceId}', '${pairingId}', decode('${sha(pairingSecret)}','hex'), clock_timestamp()+interval '10 minutes'); SELECT * FROM public.consume_source_pairing(decode('${sha(pairingSecret)}','hex'), '${deviceId}', 'Synthetic compiled sync proof', decode('${sha(deviceSecret)}','hex'));`,
  );
  return `ClarityDevice ${deviceId}.${deviceSecret}`;
}

async function uploadSyntheticToSource(dicom) {
  const response = await fetch(new URL("instances", sourceUrl), {
    method: "POST",
    headers: {
      authorization: sourceAuthorization,
      "content-type": "application/dicom",
    },
    body: dicom.bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Source Orthanc upload returned HTTP ${response.status}.`);
  const value = await response.json();
  if (value.Status !== "Success" || typeof value.ID !== "string")
    throw new Error("Source Orthanc did not accept the synthetic DICOM instance.");
  return value.ID;
}

function launchService(deviceAuthorization, build = true) {
  if (build) {
    checked(pnpm, ["exec", "turbo", "run", "build", "--filter=@clarity/sync-service..."], {
      timeout: 120_000,
    });
  }
  child = spawn(process.execPath, [join(root, "apps/sync-service/dist/main.js")], {
    cwd: root,
    env: {
      ...process.env,
      CLARITY_SYNC_SOURCE_KEY: sourceId,
      CLARITY_SYNC_STATE_DB: databasePath,
      CLARITY_SYNC_SPOOL_DIR: spoolDirectory,
      CLARITY_ORTHANC_URL: sourceUrl,
      CLARITY_ORTHANC_AUTHORIZATION: sourceAuthorization,
      CLARITY_INGESTION_API_URL: webUrl,
      CLARITY_DEVICE_AUTHORIZATION: deviceAuthorization,
      CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-2000);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  child.once("error", (error) => {
    childError = error;
  });
  child.proofOutput = () => ({ stdout, stderr });
  return child;
}

async function waitForReady(studyInstanceUid, processHandle) {
  const deadline = Date.now() + 180_000;
  let state = "";
  while (Date.now() < deadline) {
    if (childError) throw new Error("Could not start compiled sync-service process.");
    if (processHandle.exitCode !== null)
      throw new Error(`Compiled service exited early (${processHandle.exitCode}).`);
    state = psql(
      `SELECT r.state||'|'||COALESCE(b.state,'')||'|'||COALESCE((SELECT string_agg(DISTINCT u.status, ',') FROM public.ingestion_uploads u WHERE u.report_id=r.id),'') FROM public.reports r LEFT JOIN public.ingestion_batches b ON b.report_id=r.id AND b.revision=r.current_manifest_revision WHERE r.source_id='${sourceId}' AND r.study_instance_uid='${studyInstanceUid}' GROUP BY r.id,b.state;`,
    );
    if (state === "ready|sealed|completed") return state;
    await delay(500);
  }
  throw new Error(
    `Cloud did not reach ready|sealed|completed within 180 seconds (last state: ${state || "none"}).`,
  );
}

function localUploadState(sopInstanceUid) {
  if (!existsSync(databasePath)) return null;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database
      .prepare("SELECT state, upload_id, spool_path FROM local_instance_upload WHERE sop_uid = ?")
      .get(sopInstanceUid);
  } finally {
    database.close();
  }
}

async function waitForDurableSpool(dicom, processHandle) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (childError) throw new Error("Could not start compiled sync-service process.");
    if (processHandle.exitCode !== null)
      throw new Error(
        `Compiled service exited before durable spooling (${processHandle.exitCode}).`,
      );
    const local = localUploadState(dicom.sopInstanceUid);
    if (local?.state === "spooled" && local.spool_path) {
      return local;
    }
    await delay(2);
  }
  throw new Error("Compiled service did not reach the durable source-spool boundary.");
}

async function waitForReceivedUpload(dicom, processHandle) {
  const deadline = Date.now() + 30_000;
  let local = null;
  while (Date.now() < deadline) {
    if (childError) throw new Error("Could not start compiled sync-service process.");
    if (processHandle.exitCode !== null)
      throw new Error(
        `Compiled service exited before receipt checkpoint (${processHandle.exitCode}).`,
      );
    local = localUploadState(dicom.sopInstanceUid);
    if (local?.state === "received" && local.upload_id && local.spool_path === null) return local;
    await delay(100);
  }
  throw new Error(
    `Compiled service did not persist the received upload checkpoint within 30 seconds (last state: ${local?.state ?? "none"}).`,
  );
}

async function killChildForRecovery(processHandle) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null)
    throw new Error("Compiled service exited before the requested crash boundary.");
  const exited = new Promise((resolveExit) =>
    processHandle.once("exit", (code, signal) => resolveExit([code, signal])),
  );
  processHandle.kill("SIGKILL");
  const [code, signal] = await Promise.race([
    exited.then((value) => value),
    delay(5_000).then(() => [null, null]),
  ]);
  if (signal !== "SIGKILL") throw new Error("Compiled service did not die from SIGKILL.");
  return { code, signal };
}

function assertReportAndUploadCounts(dicom, expectedUploadCount, uploadId = null) {
  const counts = psql(
    `SELECT (SELECT count(*) FROM public.reports WHERE source_id='${sourceId}' AND study_instance_uid='${dicom.studyInstanceUid}')||'|'||(SELECT count(*) FROM public.ingestion_uploads u JOIN public.reports r ON r.id=u.report_id WHERE r.source_id='${sourceId}' AND r.study_instance_uid='${dicom.studyInstanceUid}')||'|'||COALESCE((SELECT min(u.id::text) FROM public.ingestion_uploads u JOIN public.reports r ON r.id=u.report_id WHERE r.source_id='${sourceId}' AND r.study_instance_uid='${dicom.studyInstanceUid}'),'');`,
  );
  const expected = `1|${expectedUploadCount}|${uploadId ?? ""}`;
  if (counts !== expected)
    throw new Error(`Expected ${expected} Report/upload counts; got ${counts}.`);
}

function cloudUploadState(dicom) {
  const row = psql(
    `SELECT count(*)||'|'||COALESCE(min(u.status),'')||'|'||COALESCE(min(u.id::text),'') FROM public.ingestion_uploads u JOIN public.reports r ON r.id=u.report_id WHERE r.source_id='${sourceId}' AND r.study_instance_uid='${dicom.studyInstanceUid}' AND u.expected_sha256='${sha(dicom.bytes)}';`,
  );
  const [count, status, id] = row.split("|");
  return { count: Number(count), status, id: id || null };
}

async function verifyCloudOrthanc(dicom) {
  const authorization = `Basic ${Buffer.from(`${orthancUser}:${orthancPassword}`).toString("base64")}`;
  const found = await jsonRequest(cloudOrthancUrl, "tools/find", {
    method: "POST",
    headers: { authorization },
    body: { Level: "Instance", Query: { SOPInstanceUID: dicom.sopInstanceUid } },
  });
  if (!Array.isArray(found) || found.length !== 1 || typeof found[0] !== "string")
    throw new Error("Cloud Orthanc did not return exactly one imported synthetic SOP.");
  const bytesResponse = await fetch(
    new URL(`instances/${encodeURIComponent(found[0])}/file`, cloudOrthancUrl),
    { headers: { authorization }, signal: AbortSignal.timeout(30_000) },
  );
  const bytes = Buffer.from(await bytesResponse.arrayBuffer());
  if (
    !bytesResponse.ok ||
    bytes.byteLength !== dicom.bytes.byteLength ||
    sha(bytes) !== sha(dicom.bytes)
  )
    throw new Error("Cloud Orthanc readback bytes differ from the synthetic source object.");
  return found[0];
}

async function cleanupDocker() {
  if (sourceContainerStarted) {
    spawnSync("docker", ["stop", "--time", "5", sourceContainerName], {
      encoding: "utf8",
      timeout: 10_000,
    });
    spawnSync("docker", ["rm", "--force", sourceContainerName], {
      encoding: "utf8",
      timeout: 10_000,
    });
  }
  if (proofNetworkCreated) {
    spawnSync("docker", ["network", "rm", networkName], {
      encoding: "utf8",
      timeout: 10_000,
    });
  }
}

async function stopChild() {
  if (!child || child.pid === undefined) return null;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  if (!stopping) {
    stopping = new Promise((resolveStop) =>
      child.once("exit", (code, signal) => resolveStop({ code, signal })),
    );
    sigtermRequested = child.kill("SIGTERM");
  }
  const stopped = await Promise.race([stopping, delay(10_000).then(() => null)]);
  if (stopped) return stopped;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  return await Promise.race([stopping, delay(5_000).then(() => null)]);
}

let result;
try {
  await startSourceOrthanc();
  const dicom = await writeDicom();
  await assertSopAbsentFromCloud(dicom.sopInstanceUid);
  const deviceAuthorization = prepareSource();
  const sourceOrthancInstanceId = await uploadSyntheticToSource(dicom);
  let processHandle = launchService(deviceAuthorization);
  const durableSpool = await waitForDurableSpool(dicom, processHandle);
  if (!durableSpool.spool_path) throw new Error("Durable synthetic spool path is missing.");
  const crash = await killChildForRecovery(processHandle);
  const reopenedSpool = localUploadState(dicom.sopInstanceUid);
  const beforeRestartCloud = cloudUploadState(dicom);
  const crashBoundary =
    beforeRestartCloud.count === 0
      ? "durable_spool_before_cloud_admission"
      : `durable_cloud_${beforeRestartCloud.status}`;
  if (
    !reopenedSpool ||
    reopenedSpool.spool_path !== durableSpool.spool_path ||
    beforeRestartCloud.count > 1 ||
    (beforeRestartCloud.count === 0 &&
      (reopenedSpool.state !== "spooled" || reopenedSpool.upload_id !== null)) ||
    (beforeRestartCloud.count === 1 &&
      (!beforeRestartCloud.id ||
        reopenedSpool.upload_id !== beforeRestartCloud.id ||
        !["admitted", "uploading"].includes(beforeRestartCloud.status) ||
        !["authorized", "uploading"].includes(reopenedSpool.state)))
  ) {
    throw new Error(
      "SQLite/cloud state did not retain one coherent upload boundary after SIGKILL.",
    );
  }
  assertReportAndUploadCounts(dicom, beforeRestartCloud.count, beforeRestartCloud.id);
  processHandle = launchService(deviceAuthorization, false);
  const cloudState = await waitForReady(dicom.studyInstanceUid, processHandle);
  const cloudOrthancInstanceId = await verifyCloudOrthanc(dicom);
  const uploadId = psql(
    `SELECT u.id FROM public.ingestion_uploads u JOIN public.reports r ON r.id=u.report_id WHERE r.source_id='${sourceId}' AND r.study_instance_uid='${dicom.studyInstanceUid}' AND u.expected_sha256='${sha(dicom.bytes)}';`,
  );
  assertReportAndUploadCounts(dicom, 1, uploadId);
  const receivedCheckpoint = await waitForReceivedUpload(dicom, processHandle);
  const postImportCloud = cloudUploadState(dicom);
  if (
    postImportCloud.count !== 1 ||
    postImportCloud.status !== "completed" ||
    postImportCloud.id !== receivedCheckpoint.upload_id
  ) {
    throw new Error(
      "Post-import crash boundary was not a single completed cloud upload matching the local receipt.",
    );
  }
  const postImportOrthancInstanceId = await verifyCloudOrthanc(dicom);
  const postImportCrash = await killChildForRecovery(processHandle);
  const checkpointAfterPostImportKill = localUploadState(dicom.sopInstanceUid);
  const cloudAfterPostImportKill = cloudUploadState(dicom);
  assertReportAndUploadCounts(dicom, 1, uploadId);
  if (
    postImportCrash.signal !== "SIGKILL" ||
    checkpointAfterPostImportKill?.state !== "received" ||
    checkpointAfterPostImportKill.upload_id !== receivedCheckpoint.upload_id ||
    checkpointAfterPostImportKill.spool_path !== null ||
    cloudAfterPostImportKill.count !== 1 ||
    cloudAfterPostImportKill.status !== "completed" ||
    cloudAfterPostImportKill.id !== receivedCheckpoint.upload_id
  ) {
    throw new Error(
      "Completed cloud/import state did not survive the post-import SIGKILL coherently.",
    );
  }
  processHandle = launchService(deviceAuthorization, false);
  const postImportRestartState = await waitForReady(dicom.studyInstanceUid, processHandle);
  const restartedOrthancInstanceId = await verifyCloudOrthanc(dicom);
  const postImportRestartCloud = cloudUploadState(dicom);
  assertReportAndUploadCounts(dicom, 1, uploadId);
  if (
    restartedOrthancInstanceId !== postImportOrthancInstanceId ||
    postImportRestartCloud.count !== 1 ||
    postImportRestartCloud.status !== "completed" ||
    postImportRestartCloud.id !== receivedCheckpoint.upload_id
  ) {
    throw new Error(
      "Post-import restart changed or duplicated the completed upload or Orthanc instance.",
    );
  }
  const shutdown = await stopChild();
  if (!sigtermRequested || shutdown?.code !== 0 || shutdown.signal !== null) {
    throw new Error("Compiled sync-service did not stop gracefully after SIGTERM.");
  }
  result = {
    sourceId,
    studyInstanceUid: dicom.studyInstanceUid,
    seriesInstanceUid: dicom.seriesInstanceUid,
    sopInstanceUid: dicom.sopInstanceUid,
    sourceOrthancInstanceId,
    cloudOrthancInstanceId,
    cloudState,
    crashSignal: crash.signal,
    postImportCrashSignal: postImportCrash.signal,
    postImportCrashBoundary: "completed_cloud_upload_and_verified_orthanc_import",
    postImportRestartState,
    postImportRestartPreservedUploadAndInstance: true,
    durableSpoolSurvivedKill: true,
    crashBoundary,
    uploadRowsBeforeRestart: beforeRestartCloud.count,
    uploadStateBeforeRestart: beforeRestartCloud.status || null,
    uploadCountAfterRestart: 1,
    sourceBytes: dicom.bytes.byteLength,
    sourceSha256: sha(dicom.bytes),
    compiledEntry: true,
    processStartedAndStopped: true,
    proof: [
      "synthetic DICOM uploaded to the disposable source Orthanc",
      "compiled sync-service discovered the source Study and Instance",
      "cloud device lease and study admission",
      "signed object upload and cloud manifest seal",
      "worker marked the source-backed Report Ready",
      "Cloud Orthanc UID and byte readback matched the synthetic source",
      "SIGKILL after the durable local source spool and crash-time cloud checkpoint inspection",
      "compiled sync-service reopened the same SQLite/spool paths and reached Ready",
      "one Report and one cloud upload remained after restart",
      "SIGKILL after the completed cloud upload, local received checkpoint, and exact Orthanc readback",
      "compiled sync-service restarted from the received checkpoint without changing the cloud upload or Orthanc instance",
      "compiled sync-service stopped with SIGTERM after recovery",
    ],
  };
  if (resultFile) await writeFile(resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  await stopChild();
  await cleanupDocker();
  await rm(temp, { recursive: true, force: true });
}
