import { randomUUID } from "node:crypto";
import { errorResponse, jsonResponse, readJsonObject } from "../../../../server/staff-api";
import { getIngestionServices } from "../../../../server/ingestion-services";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FENCE = /^[0-9]{1,19}$/;
const UID = /^[0-9]+(?:\.[0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BYTES = 5 * 1024 * 1024 * 1024;

function invalid(): Response {
  return jsonResponse({ error: "invalid_request" }, 400);
}
function status(error: unknown): 403 | 409 | 503 {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "42501") return 403;
  if (["22023", "23503", "23505", "23514", "40001"].includes(String(code))) return 409;
  return 503;
}

export async function POST(request: Request): Promise<Response> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return jsonResponse({ error: "unsupported_media_type" }, 415);
  }
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonObject(request);
  } catch (error) {
    if (error instanceof RangeError) return errorResponse(413, "request_too_large");
    if (error instanceof SyntaxError || error instanceof TypeError) return invalid();
    return errorResponse(503, "unavailable");
  }
  const key = request.headers.get("idempotency-key");
  if (
    !body ||
    typeof key !== "string" ||
    !UUID.test(key) ||
    typeof body.admissionKey !== "string" ||
    body.admissionKey.toLowerCase() !== key.toLowerCase() ||
    typeof body.sourceGeneration !== "number" ||
    !Number.isSafeInteger(body.sourceGeneration) ||
    body.sourceGeneration < 1 ||
    typeof body.fencingToken !== "string" ||
    !FENCE.test(body.fencingToken) ||
    typeof body.orthancInstanceId !== "string" ||
    !body.orthancInstanceId.trim() ||
    body.orthancInstanceId.length > 200 ||
    typeof body.studyInstanceUid !== "string" ||
    !UID.test(body.studyInstanceUid) ||
    body.studyInstanceUid.length > 64 ||
    typeof body.seriesInstanceUid !== "string" ||
    !UID.test(body.seriesInstanceUid) ||
    body.seriesInstanceUid.length > 64 ||
    typeof body.sopInstanceUid !== "string" ||
    !UID.test(body.sopInstanceUid) ||
    body.sopInstanceUid.length > 64 ||
    typeof body.byteCount !== "number" ||
    !Number.isSafeInteger(body.byteCount) ||
    body.byteCount < 1 ||
    body.byteCount > MAX_BYTES ||
    typeof body.sha256 !== "string" ||
    !SHA256.test(body.sha256)
  )
    return invalid();
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
    const uploadId = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const durable = await services.ingestion.admitUpload({
      sourceId: access.sourceId,
      deviceId: access.deviceId,
      sourceGeneration: body.sourceGeneration,
      fencingToken: body.fencingToken,
      admissionKey: key.toLowerCase(),
      uploadId,
      orthancInstanceId: body.orthancInstanceId,
      studyInstanceUid: body.studyInstanceUid,
      seriesInstanceUid: body.seriesInstanceUid,
      sopInstanceUid: body.sopInstanceUid,
      byteCount: body.byteCount,
      sha256: body.sha256,
      objectKey: `intake/${access.sourceId}/${uploadId}.dcm`,
      expiresAt,
    });
    if (durable.status === "received" || durable.status === "completed") {
      return jsonResponse({ uploadId: durable.uploadId, status: durable.status });
    }
    if (durable.status === "aborted" || durable.status === "expired")
      return errorResponse(409, "upload_not_active");
    const activeExpiry = durable.expiresAt;
    let instruction;
    if (durable.multipartUploadId) {
      instruction = services.uploads.resumeUpload(
        durable.objectKey,
        durable.byteCount,
        durable.multipartUploadId,
        activeExpiry,
      );
    } else {
      instruction = await services.uploads.createUpload(
        durable.objectKey,
        durable.byteCount,
        activeExpiry,
      );
      if (instruction.mode === "multipart") {
        const attached = await services.ingestion.attachMultipart({
          uploadId: durable.uploadId,
          deviceId: access.deviceId,
          sourceGeneration: body.sourceGeneration,
          fencingToken: body.fencingToken,
          multipartUploadId: instruction.uploadId,
        });
        if (!attached) {
          await services.uploads.abortMultipart(durable.objectKey, instruction.uploadId);
          return errorResponse(409, "upload_fence_changed");
        }
      }
    }
    if (instruction.mode === "put") {
      return jsonResponse({
        uploadId: durable.uploadId,
        expiresAt: activeExpiry.toISOString(),
        mode: "put",
        put: { url: instruction.url, headers: instruction.headers },
      });
    }
    return jsonResponse({
      uploadId: durable.uploadId,
      expiresAt: activeExpiry.toISOString(),
      mode: "multipart",
      multipartUploadId: instruction.uploadId,
      parts: instruction.parts.map((part) => ({
        partNumber: part.partNumber,
        offset: part.offset,
        byteCount: part.byteCount,
        put: { url: part.url, headers: part.headers },
      })),
    });
  } catch (error) {
    return errorResponse(status(error), "upload_unavailable");
  }
}
