import { isDeviceLeaseResponse } from "@clarity/contracts";
import { errorResponse, jsonResponse, readJsonObject } from "../../../../server/staff-api";
import { getIngestionServices } from "../../../../server/ingestion-services";

export const dynamic = "force-dynamic";

const FENCE = /^[0-9]{1,19}$/;

function invalidBody(): Response {
  return jsonResponse({ error: "invalid_request" }, 400);
}

function errorStatus(error: unknown): 403 | 409 | 503 {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "42501") return 403;
  if (code === "22023" || code === "23514" || code === "40001") return 409;
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
  if (!body || (body.action !== "acquire" && body.action !== "renew")) return invalidBody();
  if (
    body.action === "renew" &&
    (typeof body.sourceGeneration !== "number" ||
      !Number.isSafeInteger(body.sourceGeneration) ||
      body.sourceGeneration < 1 ||
      typeof body.fencingToken !== "string" ||
      !FENCE.test(body.fencingToken))
  )
    return invalidBody();

  try {
    const services = getIngestionServices();
    const access = await services.guard.authenticate(request.headers.get("authorization"));
    if (!access.ok) return errorResponse(access.status, access.reason);
    const expiresAt = new Date(Date.now() + 4 * 60_000);
    const lease =
      body.action === "acquire"
        ? await services.ingestion.acquireLease(access.sourceId, access.deviceId, expiresAt)
        : await services.ingestion.renewLease(
            access.sourceId,
            access.deviceId,
            body.sourceGeneration as number,
            body.fencingToken as string,
            expiresAt,
          );
    if (!isDeviceLeaseResponse(lease))
      throw new Error("Lease operation returned an invalid result.");
    return jsonResponse(lease);
  } catch (error) {
    return errorResponse(errorStatus(error), "lease_unavailable");
  }
}
