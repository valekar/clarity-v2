import assert from "node:assert/strict";
import { S3IntakeObjects } from "../../libs/storage/dist/intake-objects.js";

const endpoint = new URL(process.env.S3_PROOF_ENDPOINT ?? "");
const store = new S3IntakeObjects({
  endpoint,
  bucket: process.env.S3_PROOF_BUCKET ?? "",
  region: "us-east-1",
  accessKey: process.env.S3_PROOF_ACCESS_KEY ?? "",
  secretKey: process.env.S3_PROOF_SECRET_KEY ?? "",
});
await assert.rejects(store.open("outside/sentinel.txt"), /\(403\)/);
await assert.rejects(store.remove("outside/sentinel.txt"), /\(403\)/);
console.log("Scoped worker key was denied read/delete outside intake prefix.");
