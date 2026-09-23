# Scoped synthetic S3 upload admission proof

Date: 2026-09-23. The compiled [upload admission adapter](../../libs/storage/src/upload-admission.ts)
issues short-lived SigV4 URLs under `intake/<source UUID>/<upload UUID>.dcm`.
The web process uses its internal S3 endpoint for initiation, completion, abort,
HEAD and streaming GET; it signs client upload URLs for the configured public
endpoint. It accepts at most 5 GiB and uses 32 MiB parts after the 64 MiB
multipart threshold. `resumeUpload` signs parts for the original stored upload
ID without creating another multipart upload. Server-side completion checks an
S3 error body even when the HTTP status is 200.

`bash deploy/cloud/scripts/prove-upload-admission.sh` passed against an isolated,
disposable pinned MinIO image using the scoped intake-upload policy and a
dedicated temporary user. It proved a signed single PUT, 403 after signature
tampering and expiry, exact HEAD/streamed GET, two-part completion, resumed part URLs and
abort. The script removes its container and anonymous storage on exit. This
proves the adapter protocol with synthetic bytes and the intended upload policy;
it does not prove the device route, centre bandwidth or cloud production storage.

The URL signature follows the [official S3 query signing rules](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html)
and multipart completion handling follows the
[S3 API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html).
