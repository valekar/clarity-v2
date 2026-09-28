#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const webUrl = process.env.CLARITY_SMOKE_WEB_URL;
const deviceCredential = process.env.CLARITY_SMOKE_DEVICE_CREDENTIAL;
const staffCookie = process.env.CLARITY_SMOKE_STAFF_COOKIE;
const approval = process.env.CLARITY_SMOKE_CONFIRM_SYNTHETIC;
if (!webUrl || !deviceCredential || !staffCookie || approval !== "ONLY") {
  throw new Error(
    "Set CLARITY_SMOKE_WEB_URL, CLARITY_SMOKE_DEVICE_CREDENTIAL, CLARITY_SMOKE_STAFF_COOKIE, and CLARITY_SMOKE_CONFIRM_SYNTHETIC=ONLY.",
  );
}

const origin = new URL(webUrl);
if (
  !["http:", "https:"].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  (origin.protocol !== "https:" && process.env.CLARITY_SMOKE_ALLOW_HTTP !== "1")
) {
  throw new Error(
    "Smoke target must be an HTTPS origin (HTTP requires CLARITY_SMOKE_ALLOW_HTTP=1).",
  );
}
origin.pathname = origin.pathname.replace(/\/$/, "");
const cookie = staffCookie.trim();
if (!cookie || /[\r\n]/.test(cookie) || /[\r\n]/.test(deviceCredential)) {
  throw new Error("Smoke credentials are empty or malformed.");
}

const root = resolve(new URL("../../..", import.meta.url).pathname);
const temp = await mkdtemp(join(tmpdir(), "clarity-v2-coolify-smoke-"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const uidSuffix = BigInt(`0x${randomBytes(8).toString("hex")}`).toString();
const studyUid = `1.2.826.0.1.3680043.10.987.${uidSuffix}`;
const seriesUid = `${studyUid}.1`;
const sopUid = `${seriesUid}.1`;
const sourceStudyId = `coolify-smoke-${randomUUID()}`;

async function request(path, { method = "GET", auth, headers = {}, body } = {}) {
  const response = await fetch(
    new URL(path.replace(/^\//, ""), `${origin.href.replace(/\/$/, "")}/`),
    {
      method,
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const text = await response.text();
  let value = {};
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON HTTP ${response.status}.`);
    }
  }
  return { response, value };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function post(path, body, auth, headers = {}) {
  const { response, value } = await request(path, { method: "POST", body, auth, headers });
  assert(response.ok, `POST ${path} returned HTTP ${response.status}.`);
  return value;
}

try {
  const { response: health, value: healthBody } = await request("/api/health");
  assert(
    health.ok && healthBody.status === "ok",
    `Cloud health returned HTTP ${health.status} or an unexpected response.`,
  );
  console.log("PASS cloud health endpoint");

  const denied = await request("/api/staff/access");
  assert(
    denied.response.status === 401,
    `Unauthenticated staff access returned HTTP ${denied.response.status}, expected 401.`,
  );
  const access = await request("/api/staff/access", { headers: { cookie } });
  assert(
    access.response.ok && access.value.principal?.role,
    "Staff cookie did not authenticate an active staff account.",
  );
  console.log("PASS staff authentication and unauthenticated denial");

  const lease = await post("/api/ingestion/lease", { action: "acquire" }, deviceCredential);
  assert(
    Number.isSafeInteger(lease.sourceGeneration) && lease.sourceGeneration > 0,
    "Device lease did not return a source generation.",
  );
  assert(
    typeof lease.fencingToken === "string" && /^[0-9]{1,19}$/.test(lease.fencingToken),
    "Device lease did not return a fencing token.",
  );
  console.log("PASS paired synthetic device lease");

  const studyAdmissionKey = randomUUID();
  const fence = { sourceGeneration: lease.sourceGeneration, fencingToken: lease.fencingToken };
  const study = await post(
    "/api/ingestion/studies",
    {
      admissionKey: studyAdmissionKey,
      ...fence,
      studyInstanceUid: studyUid,
      orthancStudyId: sourceStudyId,
      patientId: "SYNTHETIC-ONLY",
      patientIssuerOfPatientId: "CLARITY-COOLIFY-SMOKE",
      patientName: "SYNTHETIC^COOLIFY_SMOKE",
      patientBirthDate: null,
      patientSex: "U",
      studyDate: new Date().toISOString().slice(0, 10).replaceAll("-", ""),
      studyTime: "120000",
      modalities: "CT",
    },
    deviceCredential,
    { "idempotency-key": studyAdmissionKey },
  );
  assert(
    study.studyInstanceUid === studyUid && typeof study.reportId === "string",
    "Study admission returned an unexpected Report.",
  );
  console.log("PASS synthetic Study admission");

  const generated = spawnSync(
    "python3",
    [
      join(root, "deploy/cloud/scripts/make-synthetic-dicom.py"),
      join(temp, "smoke.dcm"),
      uidSuffix,
      "1",
      "ct",
      "COOLIFY_SMOKE",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert(generated.status === 0, `Synthetic DICOM generation failed: ${generated.stderr.trim()}`);
  assert(
    generated.stdout.trim() === `${studyUid}\t${seriesUid}\t${sopUid}`,
    "Synthetic DICOM UIDs differ from the admitted Study.",
  );
  const dicom = await readFile(join(temp, "smoke.dcm"));
  const digest = sha256(dicom);
  const uploadAdmissionKey = randomUUID();
  const upload = await post(
    "/api/ingestion/uploads",
    {
      admissionKey: uploadAdmissionKey,
      ...fence,
      orthancInstanceId: `synthetic-${randomUUID()}`,
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sopUid,
      byteCount: dicom.byteLength,
      sha256: digest,
    },
    deviceCredential,
    { "idempotency-key": uploadAdmissionKey },
  );
  assert(
    upload.mode === "put" && typeof upload.put?.url === "string",
    "Object store did not issue the synthetic upload URL.",
  );

  const members = [{ sopInstanceUid: sopUid, sha256: digest }];
  // sealManifest hashes JSON.stringify of UID-sorted {sopInstanceUid, sha256} objects.
  const canonicalMembers = [...members].sort((left, right) =>
    left.sopInstanceUid < right.sopInstanceUid
      ? -1
      : left.sopInstanceUid > right.sopInstanceUid
        ? 1
        : 0,
  );
  const manifestAttemptId = randomUUID();
  const begin = await post(
    `/api/ingestion/reports/${encodeURIComponent(study.reportId)}/manifest/begin`,
    {
      ...fence,
      inventoryAttemptId: manifestAttemptId,
      expectedCurrentRevision: null,
      expectedReportVersion: study.version,
    },
    deviceCredential,
  );
  assert(begin.revision === 1, "Synthetic inventory did not begin at revision 1.");
  const page = await post(
    `/api/ingestion/reports/${encodeURIComponent(study.reportId)}/manifest/pages`,
    {
      ...fence,
      inventoryAttemptId: manifestAttemptId,
      revision: 1,
      expectedReportVersion: study.version,
      members,
    },
    deviceCredential,
  );
  assert(page.accepted === 1, "Synthetic inventory did not accept its exact SOP member.");
  const sealed = await post(
    `/api/ingestion/reports/${encodeURIComponent(study.reportId)}/manifest/seal`,
    {
      ...fence,
      inventoryAttemptId: manifestAttemptId,
      revision: 1,
      expectedCurrentRevision: null,
      expectedReportVersion: study.version,
      sourceObservedAt: new Date().toISOString(),
      sourceStable: true,
      inventoryComplete: true,
      observedManifestDigest: sha256(JSON.stringify(canonicalMembers)),
    },
    deviceCredential,
  );
  assert(sealed.sealed === true, "Synthetic inventory did not seal.");

  const put = await fetch(upload.put.url, {
    method: "PUT",
    headers: upload.put.headers,
    body: dicom,
    signal: AbortSignal.timeout(30_000),
  });
  assert(put.ok, `Synthetic object upload returned HTTP ${put.status}.`);
  const completed = await post(
    `/api/ingestion/uploads/${encodeURIComponent(upload.uploadId)}/complete`,
    { ...fence, byteCount: dicom.byteLength, sha256: digest, parts: [] },
    deviceCredential,
  );
  assert(completed.status === "received", "Cloud did not mark the synthetic object received.");
  console.log("PASS synthetic object upload and sealed manifest");

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const studies = await request(`/api/studies?q=${encodeURIComponent(studyUid)}`, {
      headers: { cookie },
    });
    assert(
      studies.response.ok,
      `Authenticated Study search returned HTTP ${studies.response.status}.`,
    );
    const item = Array.isArray(studies.value.items)
      ? studies.value.items.find(
          (entry) => entry.studyInstanceUid === studyUid && entry.reportId === study.reportId,
        )
      : undefined;
    if (
      item?.status === "ready" &&
      item.canView === true &&
      item.memberCount === 1 &&
      item.indexedCount === 1
    ) {
      ready = true;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  assert(
    ready,
    "Worker did not index the exact synthetic SOP and make the Report Ready within 120 seconds.",
  );
  console.log(
    `PASS worker indexed one synthetic SOP; Report ${study.reportId} is Ready and staff-viewable`,
  );

  const wadoPath = `/dicom-web/studies/${studyUid}/series/${seriesUid}/instances/${sopUid}`;
  const deniedImage = await fetch(new URL(wadoPath, `${origin.href.replace(/\/$/, "")}/`), {
    headers: { accept: 'multipart/related; type="application/dicom"' },
    signal: AbortSignal.timeout(15_000),
  });
  assert(
    deniedImage.status === 401,
    `Unauthenticated DICOMweb read returned HTTP ${deniedImage.status}, expected 401.`,
  );
  const image = await fetch(new URL(wadoPath, `${origin.href.replace(/\/$/, "")}/`), {
    headers: { cookie, accept: 'multipart/related; type="application/dicom"' },
    signal: AbortSignal.timeout(30_000),
  });
  assert(image.ok, `Authenticated DICOMweb WADO read returned HTTP ${image.status}.`);
  assert(
    (image.headers.get("cache-control") ?? "").includes("no-store"),
    "DICOMweb response is missing no-store caching policy.",
  );
  const reader = image.body?.getReader();
  assert(reader, "Authenticated DICOMweb response had no body.");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("DICOMweb smoke response exceeded its 2 MiB bound.");
    }
    chunks.push(Buffer.from(value));
  }
  const wadoBody = Buffer.concat(chunks, total);
  assert(
    wadoBody.includes(dicom),
    "Authenticated DICOMweb response did not contain the exact synthetic DICOM bytes.",
  );
  console.log("PASS unauthenticated DICOMweb denial and authorized exact-byte WADO read");
  console.log(`Synthetic Study UID: ${studyUid}`);
  console.log(
    "Smoke data remains in the test deployment for review; remove it through the approved test-data retention process.",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
