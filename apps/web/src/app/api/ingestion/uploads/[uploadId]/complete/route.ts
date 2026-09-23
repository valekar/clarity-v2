import { errorResponse, jsonResponse, readJsonObject } from "../../../../../../server/staff-api";
import { getIngestionServices } from "../../../../../../server/ingestion-services";
import { verifyIntakeObject } from "../../../../../../server/verify-intake-object";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const FENCE = /^[0-9]{1,19}$/;
type Receipt = Readonly<{
  partNumber: number;
  offset: number;
  byteCount: number;
  sha256: string;
  etag: string;
}>;

function status(error: unknown): 403 | 409 | 503 {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "42501") return 403;
  if (["22023", "23503", "23505", "23514", "40001"].includes(String(code))) return 409;
  return 503;
}

export async function POST(
  request: Request,
  context: Readonly<{ params: Promise<{ uploadId: string }> }>,
): Promise<Response> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return jsonResponse({ error: "unsupported_media_type" }, 415);
  const { uploadId } = await context.params;
  if (!UUID.test(uploadId)) return jsonResponse({ error: "invalid_request" }, 400);
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonObject(request, 128 * 1024);
  } catch (error) {
    if (error instanceof RangeError) return errorResponse(413, "request_too_large");
    if (error instanceof SyntaxError || error instanceof TypeError)
      return jsonResponse({ error: "invalid_request" }, 400);
    return errorResponse(503, "unavailable");
  }
  if (
    !body ||
    typeof body.sourceGeneration !== "number" ||
    !Number.isSafeInteger(body.sourceGeneration) ||
    body.sourceGeneration < 1 ||
    typeof body.fencingToken !== "string" ||
    !FENCE.test(body.fencingToken) ||
    typeof body.byteCount !== "number" ||
    !Number.isSafeInteger(body.byteCount) ||
    body.byteCount < 1 ||
    typeof body.sha256 !== "string" ||
    !SHA256.test(body.sha256) ||
    !Array.isArray(body.parts) ||
    body.parts.length > 170
  )
    return jsonResponse({ error: "invalid_request" }, 400);
  const parts: Receipt[] = [];
  let expectedOffset = 0;
  for (let index = 0; index < body.parts.length; index += 1) {
    const part = body.parts[index];
    if (typeof part !== "object" || part === null || Array.isArray(part))
      return jsonResponse({ error: "invalid_request" }, 400);
    const item = part as Record<string, unknown>;
    if (
      item.partNumber !== index + 1 ||
      item.offset !== expectedOffset ||
      typeof item.byteCount !== "number" ||
      !Number.isSafeInteger(item.byteCount) ||
      item.byteCount < 1 ||
      typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256) ||
      typeof item.etag !== "string" ||
      item.etag.length > 256 ||
      !/^[\x21-\x3b\x3d-\x7e]+$/.test(item.etag)
    )
      return jsonResponse({ error: "invalid_request" }, 400);
    expectedOffset += item.byteCount;
    parts.push(item as unknown as Receipt);
  }
  if (parts.length > 0 && expectedOffset !== body.byteCount)
    return jsonResponse({ error: "invalid_request" }, 400);
  try {
    const services = getIngestionServices();
    const authenticated = await services.guard.authenticate(request.headers.get("authorization"));
    if (!authenticated.ok) return errorResponse(authenticated.status, authenticated.reason);
    const access = await services.guard.authorizeMutation(request.headers.get("authorization"), {
      sourceId: authenticated.sourceId,
      sourceGeneration: String(body.sourceGeneration),
      fencingToken: body.fencingToken,
    });
    if (!access.ok) return errorResponse(access.status, access.reason);
    const upload = await services.ingestion.getUpload(uploadId, access.sourceId, access.deviceId);
    if (!upload) return jsonResponse({ error: "not_found" }, 404);
    if (upload.status === "received" || upload.status === "completed")
      return jsonResponse({ status: upload.status });
    if (upload.status !== "admitted" && upload.status !== "uploading")
      return errorResponse(409, "upload_not_active");
    if (upload.byteCount !== body.byteCount || upload.expectedSha256 !== body.sha256)
      return jsonResponse({ error: "receipt_mismatch" }, 409);
    if (upload.multipartUploadId) {
      if (parts.length === 0) return jsonResponse({ error: "invalid_request" }, 400);
      let objectSize = await services.uploads.head(upload.objectKey);
      if (objectSize === null) {
        if (!upload.multipartUploadId) return errorResponse(409, "multipart_not_admitted");
        await services.uploads.completeMultipart(
          upload.objectKey,
          upload.multipartUploadId,
          parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
        );
        objectSize = await services.uploads.head(upload.objectKey);
      }
      if (objectSize !== upload.byteCount) return errorResponse(409, "object_size_mismatch");
    } else {
      if (parts.length !== 0) return jsonResponse({ error: "invalid_request" }, 400);
      const objectSize = await services.uploads.head(upload.objectKey);
      if (objectSize !== upload.byteCount) return errorResponse(409, "object_size_mismatch");
    }
    const verified = await verifyIntakeObject(
      await services.uploads.open(upload.objectKey),
      upload.byteCount,
    );
    if (verified.sha256 !== upload.expectedSha256 || verified.sha256 !== body.sha256)
      return errorResponse(409, "object_hash_mismatch");
    const result = await services.ingestion.completeUpload({
      uploadId,
      sourceId: access.sourceId,
      deviceId: access.deviceId,
      sourceGeneration: body.sourceGeneration,
      fencingToken: body.fencingToken,
      sha256: verified.sha256,
      byteCount: verified.byteCount,
    });
    return jsonResponse({ status: result });
  } catch (error) {
    return errorResponse(status(error), "upload_unavailable");
  }
}
