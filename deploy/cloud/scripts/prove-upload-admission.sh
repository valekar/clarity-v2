#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
image='quay.io/minio/minio:RELEASE.2025-05-24T17-08-30Z@sha256:a616cd8f37758b0296db62cc9e6af05a074e844cc7b5c0a0e62176d73828d440'
mc_image='quay.io/minio/mc:RELEASE.2025-05-21T01-59-54Z@sha256:09f93f534cde415d192bb6084dd0e0ddd1715fb602f8a922ad121fd2bf0f8b44'
name="clarity-v2-upload-proof-$$"
volume=''
docker run --rm -d --name "$name" -p 127.0.0.1::9000 \
  -e MINIO_ROOT_USER=syntheticupload -e MINIO_ROOT_PASSWORD=syntheticuploadpassword \
  "$image" server /data --address :9000 >/dev/null
volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$name")"
cleanup() {
  local result=$?
  trap - EXIT
  docker rm -fv "$name" >/dev/null 2>&1 || true
  if docker inspect "$name" >/dev/null 2>&1 ||
     { [[ -n "$volume" ]] && docker volume inspect "$volume" >/dev/null 2>&1; }; then
    echo 'Disposable upload proof container or anonymous volume remained.' >&2
    result=1
  fi
  return "$result"
}
trap cleanup EXIT
port="$(docker port "$name" 9000/tcp | sed 's/.*://')"
for attempt in $(seq 1 40); do
  if curl --silent --fail "http://127.0.0.1:$port/minio/health/live" >/dev/null; then break; fi
  sleep 1
done
docker run --rm --network "container:$name" \
  --volume "$repo_root/deploy/cloud/minio/intake-upload-policy.json:/proof/policy.json:ro" \
  --entrypoint /bin/sh "$mc_image" -ec \
  'mc alias set proof http://127.0.0.1:9000 syntheticupload syntheticuploadpassword >/dev/null; mc mb proof/clarity-v2-intake >/dev/null; mc admin policy create proof scoped-upload /proof/policy.json >/dev/null; mc admin user add proof scopedupload scopeduploadpassword >/dev/null; mc admin policy attach proof scoped-upload --user scopedupload >/dev/null'

pnpm --dir "$repo_root" --filter @clarity/storage build >/dev/null
S3_PROOF_PORT="$port" S3_PROOF_ROOT="$repo_root" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const { S3UploadAdmission } = await import(`${process.env.S3_PROOF_ROOT}/libs/storage/dist/upload-admission.js`);

const endpoint = new URL(`http://127.0.0.1:${process.env.S3_PROOF_PORT}`);
const config = {
  internalEndpoint: endpoint,
  publicEndpoint: endpoint,
  bucket: 'clarity-v2-intake',
  region: 'us-east-1',
  accessKey: 'scopedupload',
  secretKey: 'scopeduploadpassword',
};
const client = new S3UploadAdmission(config);
const key = 'intake/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.dcm';
const expiresAt = new Date(Date.now() + 10 * 60_000);
await assert.rejects(client.createUpload(key, 13, new Date(Date.now() + 16 * 60_000)));
assert.equal(await client.head(key), null);
const single = await client.createUpload(key, 13, expiresAt);
assert.equal(single.mode, 'put');
const put = await fetch(single.url, { method: 'PUT', headers: single.headers, body: 'synthetic DCM' });
assert.equal(put.status, 200, await put.text());
assert.equal(await client.head(key), 13);
const stream = await client.open(key);
assert.equal(await new Response(stream).text(), 'synthetic DCM');
const invalid = await fetch(single.url.replace('X-Amz-Signature=', 'X-Amz-Signature=0'), {
  method: 'PUT', body: 'synthetic DCM',
});
assert.equal(invalid.status, 403);
const oldNow = new Date(Date.now() - 20 * 60_000);
const oldClient = new S3UploadAdmission(config, fetch, () => oldNow);
const expired = await oldClient.createUpload(key, 13, new Date(oldNow.getTime() + 60_000));
assert.equal(expired.mode, 'put');
const expiredResponse = await fetch(expired.url, { method: 'PUT', body: 'synthetic DCM' });
assert.equal(expiredResponse.status, 403);

const multipartKey = 'intake/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000003.dcm';
const multipart = await client.createUpload(multipartKey, 64 * 1024 * 1024, expiresAt);
assert.equal(multipart.mode, 'multipart');
assert.equal(multipart.parts.length, 2);
const resumed = client.resumeUpload(multipartKey, 64 * 1024 * 1024, multipart.uploadId, expiresAt);
assert.equal(resumed.uploadId, multipart.uploadId);
assert.deepEqual(resumed.parts.map((part) => part.partNumber), [1, 2]);
const etags = [];
for (const part of resumed.parts) {
  const response = await fetch(part.url, {
    method: 'PUT', headers: part.headers, body: Buffer.alloc(part.byteCount, part.partNumber),
  });
  assert.equal(response.status, 200, await response.text());
  etags.push({ partNumber: part.partNumber, etag: response.headers.get('etag') });
}
await client.completeMultipart(multipartKey, multipart.uploadId, etags);
assert.equal(await client.head(multipartKey), 64 * 1024 * 1024);
const abandonedKey = 'intake/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000004.dcm';
const abandoned = await client.createUpload(abandonedKey, 64 * 1024 * 1024, expiresAt);
assert.equal(abandoned.mode, 'multipart');
await client.abortMultipart(abandonedKey, abandoned.uploadId);
assert.equal(await client.head(abandonedKey), null);
console.log('S3 upload admission proof passed: presigned PUT, tamper/expiry denial, HEAD/GET, multipart resume/completion and abort.');
NODE
