import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { S3IntakeObjects } from "../../../libs/storage/dist/intake-objects.js";
import { readDicomIdentity } from "../../../apps/worker/dist/dicom.js";
import { OrthancClient } from "../../../apps/worker/dist/orthanc-client.js";

const endpoint = new URL(process.env.S3_PROOF_ENDPOINT ?? "");
const bucket = process.env.S3_PROOF_BUCKET ?? "";
const objectKey = process.env.S3_PROOF_OBJECT_KEY ?? "";
const accessKey = process.env.S3_PROOF_ACCESS_KEY ?? "";
const secretKey = process.env.S3_PROOF_SECRET_KEY ?? "";
const dicomPath = process.env.ORTHANC_PROOF_DICOM_PATH ?? "";
const orthancUrl = process.env.ORTHANC_PROOF_URL ?? "";
const orthancUsername = process.env.ORTHANC_PROOF_USERNAME ?? "";
const orthancPassword = process.env.ORTHANC_PROOF_PASSWORD ?? "";
if (!endpoint.host || !bucket || !objectKey || !accessKey || !secretKey) {
  throw new Error("S3 proof endpoint, bucket, nested key and credentials are required.");
}

const expected = "clarity-v2 worker synthetic S3 check\n";
const good = new S3IntakeObjects({ endpoint, bucket, region: "us-east-1", accessKey, secretKey });
const bad = new S3IntakeObjects({ endpoint, bucket, region: "us-east-1", accessKey: "invalid-proof-key", secretKey });
try {
  const response = await bad.open(objectKey).then(async (body) => {
    for await (const _chunk of body) { /* drain the rejected credential response */ }
    return "unexpectedly accepted";
  }).catch((error) => String(error));
  assert.match(response, /Intake object read failed \((401|403)\)/);

  const chunks = [];
  let length = 0;
  for await (const chunk of await good.open(objectKey)) {
    length += chunk.byteLength;
    chunks.push(chunk);
  }
  const actual = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString("utf8");
  assert.equal(actual, expected);
  console.log("S3 SigV4 nested-key read and invalid-credential denial passed.");

  if (!dicomPath || !orthancUrl || !orthancUsername || !orthancPassword) {
    throw new Error("Orthanc proof URL, credentials and synthetic DICOM path are required.");
  }
  const orthanc = new OrthancClient(new URL(orthancUrl), orthancUsername, orthancPassword);
  const dicomBytes = createReadStream(dicomPath);
  const dicomIdentity = await readDicomIdentity(Readable.toWeb(dicomBytes));
  const beforeId = await orthanc.findBySopInstanceUid(dicomIdentity.sopInstanceUid);
  assert.ok(beforeId, "synthetic fixture is present from the cloud proof's initial upload");
  const fileStat = await stat(dicomPath);
  const duplicateId = await orthanc.importInstance(Readable.toWeb(createReadStream(dicomPath)), fileStat.size);
  assert.equal(duplicateId, beforeId, "Orthanc AlreadyStored response reconciles to its existing ID");
  assert.deepEqual(await orthanc.readIdentity(duplicateId), dicomIdentity);
  const orthancHash = createHash("sha256");
  let orthancBytes = 0;
  for await (const chunk of await orthanc.readBytes(duplicateId)) {
    orthancBytes += chunk.byteLength;
    orthancHash.update(chunk);
  }
  const sourceHash = createHash("sha256");
  for await (const chunk of createReadStream(dicomPath)) sourceHash.update(chunk);
  assert.equal(orthancBytes, fileStat.size);
  assert.equal(orthancHash.digest("hex"), sourceHash.digest("hex"));
  console.log("Orthanc raw DICOM POST, AlreadyStored reconciliation, simplified tags and byte readback passed.");
} finally {
  await good.remove(objectKey);
}
