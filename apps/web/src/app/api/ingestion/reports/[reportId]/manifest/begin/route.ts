import { errorResponse, jsonResponse, readJsonObject } from "../../../../../../../server/staff-api";
import { getIngestionServices } from "../../../../../../../server/ingestion-services";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FENCE = /^[0-9]{1,19}$/;
function invalid(): Response {
  return jsonResponse({ error: "invalid_request" }, 400);
}
function errorStatus(error: unknown): 403 | 409 | 503 {
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
  context: Readonly<{ params: Promise<{ reportId: string }> }>,
): Promise<Response> {
  const { reportId } = await context.params;
  if (!UUID.test(reportId)) return invalid();
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return jsonResponse({ error: "unsupported_media_type" }, 415);
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonObject(request);
  } catch (error) {
    if (error instanceof RangeError) return errorResponse(413, "request_too_large");
    if (error instanceof SyntaxError || error instanceof TypeError) return invalid();
    return errorResponse(503, "unavailable");
  }
  if (
    !body ||
    typeof body.sourceGeneration !== "number" ||
    !Number.isSafeInteger(body.sourceGeneration) ||
    body.sourceGeneration < 1 ||
    typeof body.fencingToken !== "string" ||
    !FENCE.test(body.fencingToken) ||
    typeof body.inventoryAttemptId !== "string" ||
    !UUID.test(body.inventoryAttemptId) ||
    !(
      body.expectedCurrentRevision === null ||
      (typeof body.expectedCurrentRevision === "number" &&
        Number.isSafeInteger(body.expectedCurrentRevision) &&
        body.expectedCurrentRevision > 0)
    ) ||
    typeof body.expectedReportVersion !== "number" ||
    !Number.isSafeInteger(body.expectedReportVersion) ||
    body.expectedReportVersion < 1
  )
    return invalid();
  try {
    const services = getIngestionServices();
    const header = request.headers.get("authorization");
    const authenticated = await services.guard.authenticate(header);
    if (!authenticated.ok) return errorResponse(authenticated.status, authenticated.reason);
    const access = await services.guard.authorizeMutation(header, {
      sourceId: authenticated.sourceId,
      sourceGeneration: String(body.sourceGeneration),
      fencingToken: body.fencingToken,
    });
    if (!access.ok) return errorResponse(access.status, access.reason);
    const revision = await services.ingestion.beginManifest({
      reportId,
      expectedCurrentRevision: body.expectedCurrentRevision as number | null,
      expectedReportVersion: body.expectedReportVersion,
      sourceGeneration: body.sourceGeneration,
      deviceId: access.deviceId,
      fencingToken: body.fencingToken,
      attemptId: body.inventoryAttemptId,
    });
    return jsonResponse({ revision });
  } catch (error) {
    return errorResponse(errorStatus(error), "manifest_unavailable");
  }
}
