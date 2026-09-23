import { isStudyAdmissionRequest, type StudyAdmissionRequest } from "@clarity/contracts";
import { errorResponse, jsonResponse, readJsonObject } from "../../../../server/staff-api";
import { getIngestionServices } from "../../../../server/ingestion-services";

export const dynamic = "force-dynamic";

const UID = /^[0-9]+(?:\.[0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FENCE = /^[0-9]{1,19}$/;

function invalidBody(): Response {
  return jsonResponse({ error: "invalid_request" }, 400);
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError("Optional study observation is invalid.");
  const normalized = value.trim();
  if (/([\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f])/u.test(normalized))
    throw new TypeError("Optional study observation is invalid.");
  return normalized === "" ? null : normalized;
}

function bodyFence(value: Record<string, unknown>): Readonly<{
  admissionKey: string;
  sourceGeneration: number;
  fencingToken: string;
}> | null {
  const admissionKey = value.admissionKey;
  const sourceGeneration = value.sourceGeneration;
  const fencingToken = value.fencingToken;
  if (
    typeof admissionKey !== "string" ||
    !UUID.test(admissionKey) ||
    typeof sourceGeneration !== "number" ||
    !Number.isSafeInteger(sourceGeneration) ||
    sourceGeneration < 1 ||
    typeof fencingToken !== "string" ||
    !FENCE.test(fencingToken)
  )
    return null;
  return { admissionKey: admissionKey.toLowerCase(), sourceGeneration, fencingToken };
}

function errorStatus(error: unknown): 403 | 409 | 503 {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "42501") return 403;
  if (code === "22023" || code === "23505" || code === "23514" || code === "40001") return 409;
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
    if (error instanceof SyntaxError || error instanceof TypeError) return invalidBody();
    return errorResponse(503, "unavailable");
  }
  if (!body) return invalidBody();
  const fence = bodyFence(body);
  const idempotencyHeader = request.headers.get("idempotency-key");
  if (!isStudyAdmissionRequest(body)) return invalidBody();
  const studyInstanceUid = body.studyInstanceUid;
  const orthancStudyId = body.orthancStudyId;
  if (
    !fence ||
    idempotencyHeader?.toLowerCase() !== fence.admissionKey ||
    fence.admissionKey !== body.admissionKey.toLowerCase() ||
    !UID.test(studyInstanceUid)
  )
    return invalidBody();

  try {
    const services = getIngestionServices();
    const header = request.headers.get("authorization");
    const authenticated = await services.guard.authenticate(header);
    if (!authenticated.ok) return errorResponse(authenticated.status, authenticated.reason);
    const access = await services.guard.authorizeMutation(header, {
      sourceId: authenticated.sourceId,
      sourceGeneration: String(fence.sourceGeneration),
      fencingToken: fence.fencingToken,
    });
    if (!access.ok) return errorResponse(access.status, access.reason);
    const requestBody = body as StudyAdmissionRequest;
    const result = await services.ingestion.admitStudy({
      sourceId: access.sourceId,
      deviceId: access.deviceId,
      sourceGeneration: fence.sourceGeneration,
      fencingToken: fence.fencingToken,
      admissionKey: fence.admissionKey,
      studyInstanceUid,
      orthancStudyId: orthancStudyId.trim(),
      patientId: optionalText(requestBody.patientId),
      patientIssuerOfPatientId: optionalText(requestBody.patientIssuerOfPatientId),
      patientName: optionalText(requestBody.patientName),
      patientBirthDate: optionalText(requestBody.patientBirthDate),
      patientSex: optionalText(requestBody.patientSex),
      studyDate: optionalText(requestBody.studyDate),
      studyTime: optionalText(requestBody.studyTime),
      studyDescription: optionalText(requestBody.studyDescription),
      accessionNumber: optionalText(requestBody.accessionNumber),
      modalities: optionalText(requestBody.modalities),
    });
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(errorStatus(error), "ingestion_unavailable");
  }
}
