#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const project = process.env.CLARITY_PROOF_PROJECT;
const envFile = process.env.CLARITY_PROOF_ENV_FILE;
const webUrl = process.env.CLARITY_WEB_URL;
const resultFile = process.env.CLARITY_PROOF_RESULT_FILE;
if (!project || !envFile || !webUrl)
  throw new Error("Set CLARITY_PROOF_PROJECT, CLARITY_PROOF_ENV_FILE and CLARITY_WEB_URL.");
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
const sourceId = "92000000-0000-4000-8000-000000000001";
const deviceIds = ["92000000-0000-4000-8000-000000000002", "92000000-0000-4000-8000-000000000003"];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const verifier = (value) => sha(value);
const temp = await mkdtemp(join(tmpdir(), "clarity-v2-connected-proof-"));

function psql(sql) {
  const result = spawnSync(
    "docker",
    [
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
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (result.status !== 0) throw new Error(`Disposable proof SQL failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function jsonRequest(path, { method = "GET", credential, body, headers = {} } = {}) {
  const response = await fetch(new URL(path, webUrl), {
    method,
    headers: {
      ...(credential ? { authorization: credential } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let value = {};
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Web API ${path} returned non-JSON (${response.status}).`);
  }
  if (!response.ok)
    throw new Error(
      `Web API ${path} returned ${response.status}: ${String(value.error ?? "unexpected response")}`,
    );
  return value;
}

function authFor(secret, deviceId) {
  return `ClarityDevice ${deviceId}.${secret}`;
}
function newCredential() {
  return randomBytes(32).toString("base64url");
}

try {
  const sourceSql = `INSERT INTO public.orthanc_sources(id,display_name) VALUES ('${sourceId}','Synthetic connected proof');`;
  psql(sourceSql);
  const bootstrapState = psql(
    "SELECT COALESCE(bootstrapped_user_id::text,'') FROM public.staff_access_control WHERE singleton_id=1;",
  );
  if (!bootstrapState) {
    const adminId = randomUUID();
    const identityId = randomUUID();
    psql(
      `INSERT INTO public.staff_users(id,display_name) VALUES ('${adminId}','Synthetic proof administrator'); INSERT INTO public.staff_identities(id,staff_user_id,provider,issuer,subject) VALUES ('${identityId}','${adminId}','hanko','https://synthetic-proof.invalid','connected-proof-${randomUUID()}'); SET ROLE clarity_v2_bootstrap_operator; SELECT public.bootstrap_first_staff_admin('${adminId}','${identityId}'); RESET ROLE;`,
    );
  }
  const credentials = [];
  for (let index = 0; index < deviceIds.length; index += 1) {
    const deviceId = deviceIds[index];
    const pairingId = randomUUID();
    const pairingSecret = `cp2_${newCredential()}`;
    const deviceSecret = newCredential();
    psql(
      `SELECT public.create_source_pairing((SELECT bootstrapped_user_id FROM public.staff_access_control WHERE singleton_id=1), '${sourceId}', '${pairingId}', decode('${verifier(pairingSecret)}','hex'), clock_timestamp()+interval '10 minutes'); SELECT * FROM public.consume_source_pairing(decode('${verifier(pairingSecret)}','hex'), '${deviceId}', 'Synthetic proof device ${index + 1}', decode('${verifier(deviceSecret)}','hex'));`,
    );
    credentials.push(authFor(deviceSecret, deviceId));
  }

  const lease = await jsonRequest("/api/ingestion/lease", {
    method: "POST",
    credential: credentials[0],
    body: { action: "acquire" },
  });
  const fence = { sourceGeneration: lease.sourceGeneration, fencingToken: lease.fencingToken };
  const dicomPath = join(temp, "synthetic.dcm");
  const generator = join(root, "deploy/cloud/scripts/make-synthetic-dicom.py");
  const generated = spawnSync("python3", [generator, dicomPath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (generated.status !== 0)
    throw new Error(`Synthetic DICOM generation failed: ${generated.stderr.trim()}`);
  const [studyInstanceUid, seriesInstanceUid, sopInstanceUid] = generated.stdout.trim().split("\t");
  if (!studyInstanceUid || !seriesInstanceUid || !sopInstanceUid)
    throw new Error("Synthetic DICOM generator returned incomplete UIDs.");
  const bytes = await readFile(dicomPath);
  const fileSha = sha(bytes);
  const studyAdmissionKey = randomUUID();
  const study = await jsonRequest("/api/ingestion/studies", {
    method: "POST",
    credential: credentials[0],
    headers: { "idempotency-key": studyAdmissionKey },
    body: {
      admissionKey: studyAdmissionKey,
      ...fence,
      studyInstanceUid,
      orthancStudyId: "synthetic-orthanc-study",
      patientId: "SYNTHETIC-ONLY",
      patientIssuerOfPatientId: "SYNTHETIC-AUTHORITY",
      patientName: "SYNTHETIC^PROOF",
      patientBirthDate: null,
      patientSex: "U",
      studyDate: "20260923",
      studyTime: "120000",
    },
  });
  if (study.studyInstanceUid !== studyInstanceUid)
    throw new Error("Study admission returned another Study UID.");
  const admissionKey = randomUUID();
  const upload = await jsonRequest("/api/ingestion/uploads", {
    method: "POST",
    credential: credentials[0],
    headers: { "idempotency-key": admissionKey },
    body: {
      admissionKey,
      ...fence,
      orthancInstanceId: "synthetic-orthanc-instance",
      studyInstanceUid,
      seriesInstanceUid,
      sopInstanceUid,
      byteCount: bytes.byteLength,
      sha256: fileSha,
    },
  });
  if (upload.mode !== "put" || typeof upload.put?.url !== "string")
    throw new Error("Synthetic object did not receive a single-part upload URL.");

  const manifestAttemptId = randomUUID();
  const manifestMembers = [{ sopInstanceUid, sha256: fileSha }];
  const observedManifestDigest = sha(JSON.stringify(manifestMembers));
  const begin = await jsonRequest(`/api/ingestion/reports/${study.reportId}/manifest/begin`, {
    method: "POST",
    credential: credentials[0],
    body: {
      ...fence,
      inventoryAttemptId: manifestAttemptId,
      expectedCurrentRevision: null,
      expectedReportVersion: study.version,
    },
  });
  if (begin.revision !== 1) throw new Error("Manifest draft was not created at revision 1.");
  const page = await jsonRequest(`/api/ingestion/reports/${study.reportId}/manifest/pages`, {
    method: "POST",
    credential: credentials[0],
    body: {
      ...fence,
      inventoryAttemptId: manifestAttemptId,
      revision: begin.revision,
      expectedReportVersion: study.version,
      members: manifestMembers,
    },
  });
  if (page.accepted !== 1) throw new Error("Manifest did not persist its exact synthetic member.");
  const sealed = await jsonRequest(`/api/ingestion/reports/${study.reportId}/manifest/seal`, {
    method: "POST",
    credential: credentials[0],
    body: {
      ...fence,
      inventoryAttemptId: manifestAttemptId,
      revision: begin.revision,
      expectedCurrentRevision: null,
      expectedReportVersion: study.version,
      sourceObservedAt: new Date().toISOString(),
      sourceStable: true,
      inventoryComplete: true,
      observedManifestDigest,
    },
  });
  if (sealed.sealed !== true) throw new Error("Synthetic source manifest was not sealed.");

  const putResponse = await fetch(upload.put.url, {
    method: "PUT",
    headers: upload.put.headers,
    body: bytes,
  });
  if (!putResponse.ok)
    throw new Error(`Signed synthetic upload returned HTTP ${putResponse.status}.`);
  const complete = await jsonRequest(`/api/ingestion/uploads/${upload.uploadId}/complete`, {
    method: "POST",
    credential: credentials[0],
    body: { ...fence, byteCount: bytes.byteLength, sha256: fileSha, parts: [] },
  });
  if (complete.status !== "received")
    throw new Error("Server did not persist the verified object as received.");

  const retry = await jsonRequest("/api/ingestion/uploads", {
    method: "POST",
    credential: credentials[0],
    headers: { "idempotency-key": admissionKey },
    body: {
      admissionKey,
      ...fence,
      orthancInstanceId: "synthetic-orthanc-instance",
      studyInstanceUid,
      seriesInstanceUid,
      sopInstanceUid,
      byteCount: bytes.byteLength,
      sha256: fileSha,
    },
  });
  if (retry.uploadId !== upload.uploadId || !["received", "completed"].includes(retry.status))
    throw new Error("Admission retry did not reconcile the durable upload result.");

  const expectedReady = "ready|indexed|completed|sealed";
  let state = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    state = psql(
      `SELECT r.state||'|'||f.state||'|'||u.status||'|'||b.state FROM public.reports r JOIN public.report_files f ON f.report_id=r.id JOIN public.ingestion_uploads u ON u.report_file_id=f.id JOIN public.ingestion_batches b ON b.report_id=r.id AND b.revision=r.current_manifest_revision WHERE r.id='${study.reportId}' AND f.sop_instance_uid='${sopInstanceUid}' AND u.id='${upload.uploadId}' AND b.revision=1;`,
    );
    if (state === expectedReady) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (state !== expectedReady)
    throw new Error(
      `Worker did not reach the expected sealed/indexed Ready state (got ${state || "no rows"}).`,
    );

  const orthancBase = process.env.CLARITY_PROOF_ORTHANC_URL;
  const orthancUser = process.env.ORTHANC_HTTP_USERNAME;
  const orthancPassword = process.env.ORTHANC_HTTP_PASSWORD;
  if (!orthancBase || !orthancUser || !orthancPassword)
    throw new Error("Set CLARITY_PROOF_ORTHANC_URL and Orthanc proof credentials.");
  const basic = `Basic ${Buffer.from(`${orthancUser}:${orthancPassword}`).toString("base64")}`;
  const findResponse = await fetch(new URL("tools/find", orthancBase), {
    method: "POST",
    headers: { authorization: basic, "content-type": "application/json" },
    body: JSON.stringify({ Level: "Instance", Query: { SOPInstanceUID: sopInstanceUid } }),
  });
  const instanceIds = await findResponse.json();
  if (
    !findResponse.ok ||
    !Array.isArray(instanceIds) ||
    instanceIds.length !== 1 ||
    typeof instanceIds[0] !== "string"
  )
    throw new Error("Orthanc did not return exactly one imported synthetic SOP.");
  const instanceId = instanceIds[0];
  const tagsResponse = await fetch(
    new URL(`instances/${encodeURIComponent(instanceId)}/simplified-tags`, orthancBase),
    { headers: { authorization: basic } },
  );
  const tags = await tagsResponse.json();
  if (
    !tagsResponse.ok ||
    tags.StudyInstanceUID !== studyInstanceUid ||
    tags.SeriesInstanceUID !== seriesInstanceUid ||
    tags.SOPInstanceUID !== sopInstanceUid
  )
    throw new Error("Orthanc readback UIDs differ from the upload reservation.");
  const fileResponse = await fetch(
    new URL(`instances/${encodeURIComponent(instanceId)}/file`, orthancBase),
    { headers: { authorization: basic } },
  );
  const indexedBytes = Buffer.from(await fileResponse.arrayBuffer());
  if (
    !fileResponse.ok ||
    sha(indexedBytes) !== fileSha ||
    indexedBytes.byteLength !== bytes.byteLength
  )
    throw new Error("Orthanc readback bytes differ from the uploaded synthetic object.");
  const dicomwebUrl = new URL(
    `dicom-web/studies/${encodeURIComponent(studyInstanceUid)}/series/${encodeURIComponent(seriesInstanceUid)}/instances?SOPInstanceUID=${encodeURIComponent(sopInstanceUid)}`,
    orthancBase,
  );
  const dicomwebResponse = await fetch(dicomwebUrl, {
    headers: { authorization: basic, accept: "application/dicom+json" },
  });
  const dicomwebBody = await dicomwebResponse.text();
  if (
    !dicomwebResponse.ok ||
    dicomwebBody.length > 64 * 1024 ||
    !dicomwebBody.includes(sopInstanceUid)
  )
    throw new Error("Synthetic Study is not queryable through Orthanc DICOMweb.");

  // Expire the first lease in the disposable database to exercise takeover without waiting.
  psql(
    `UPDATE public.orthanc_sources SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='${sourceId}';`,
  );
  const takeover = await jsonRequest("/api/ingestion/lease", {
    method: "POST",
    credential: credentials[1],
    body: { action: "acquire" },
  });
  if (
    takeover.sourceGeneration !== fence.sourceGeneration ||
    takeover.fencingToken === fence.fencingToken
  )
    throw new Error("Lease takeover did not issue the current cloud fencing token.");
  const hiddenStatus = await fetch(new URL(`/api/ingestion/uploads/${upload.uploadId}`, webUrl), {
    headers: { authorization: credentials[0] },
  });
  if (hiddenStatus.status !== 404)
    throw new Error(
      `Prior lease owner could read upload status after takeover (${hiddenStatus.status}).`,
    );
  const staleAdmissionKey = randomUUID();
  const staleStudy = await fetch(new URL("/api/ingestion/studies", webUrl), {
    method: "POST",
    headers: {
      authorization: credentials[0],
      "content-type": "application/json",
      "idempotency-key": staleAdmissionKey,
    },
    body: JSON.stringify({
      admissionKey: staleAdmissionKey,
      ...fence,
      studyInstanceUid: "1.2.826.0.1.3680043.10.987.9",
      orthancStudyId: "stale",
      patientId: null,
    }),
  });
  if (staleStudy.status !== 403)
    throw new Error(`Prior lease owner admitted a study after takeover (${staleStudy.status}).`);
  const deviceVersion = psql(
    `SELECT version::text FROM public.device_installations WHERE id='${deviceIds[1]}';`,
  );
  psql(
    `SELECT public.revoke_source_device((SELECT bootstrapped_user_id FROM public.staff_access_control WHERE singleton_id=1), '${deviceIds[1]}', ${deviceVersion}::bigint);`,
  );
  const revoked = await fetch(new URL("/api/ingestion/lease", webUrl), {
    method: "POST",
    headers: { authorization: credentials[1], "content-type": "application/json" },
    body: JSON.stringify({
      action: "renew",
      sourceGeneration: takeover.sourceGeneration,
      fencingToken: takeover.fencingToken,
    }),
  });
  if (revoked.status !== 401)
    throw new Error(`Revoked paired device remained authenticated (${revoked.status}).`);

  psql(`UPDATE public.orthanc_sources SET status='disabled' WHERE id='${sourceId}';`);
  const offlineState = psql(
    `SELECT s.status||'|'||r.state FROM public.orthanc_sources s JOIN public.reports r ON r.id='${study.reportId}' WHERE s.id='${sourceId}';`,
  );
  if (offlineState !== "disabled|ready")
    throw new Error(
      "The Ready synthetic Report did not remain available as a snapshot after its source went offline.",
    );

  const proofResult = {
    sourceId,
    deviceId: deviceIds[0],
    reportId: study.reportId,
    studyInstanceUid,
    seriesInstanceUid,
    sopInstanceUid,
    orthancInstanceId: instanceId,
    dicomwebAccessible: true,
    reportState: "ready",
    sourceOffline: true,
    proof: [
      "pairing consume",
      "cloud lease",
      "study admission",
      "upload reservation before signed PUT",
      "server size/hash verification",
      "manifest seal",
      "worker import and atomic state completion",
      "idempotent received retry",
      "Orthanc UID and byte readback",
      "lease takeover denial",
      "device revocation denial",
    ],
  };
  if (resultFile) await writeFile(resultFile, `${JSON.stringify(proofResult)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(proofResult));
} finally {
  await rm(temp, { recursive: true, force: true });
}
