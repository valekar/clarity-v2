import { getIngestionServices } from "../../../../server/ingestion-services";
import { databaseErrorStatus, errorResponse, jsonResponse, readJsonObject } from "../../../../server/staff-api";

export const dynamic = "force-dynamic";

const FENCE = /^[1-9][0-9]{0,18}$/;
const ERRORS = ["orthanc_unavailable", "low_spool_space", "source_changed", "sync_failed"] as const;

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}

function isBytes(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonObject(request, 4096);
    if (!body) return errorResponse(400, "invalid_request");
    const keys = [
      "sourceGeneration", "fencingToken", "sourceReachable", "syncState", "lastErrorCode",
      "queuedStudies", "queuedUploads", "spoolFreeBytes", "spoolCapacityBytes", "lastSuccessfulSyncAt",
    ];
    if (Object.keys(body).length !== keys.length || keys.some((key) => !(key in body))) {
      return errorResponse(400, "invalid_request");
    }
    if (
      typeof body.sourceGeneration !== "string" || !FENCE.test(body.sourceGeneration) ||
      typeof body.fencingToken !== "string" || !FENCE.test(body.fencingToken) ||
      typeof body.sourceReachable !== "boolean" ||
      !["idle", "syncing", "attention"].includes(String(body.syncState)) ||
      !(body.lastErrorCode === null || ERRORS.includes(body.lastErrorCode as (typeof ERRORS)[number])) ||
      !isCount(body.queuedStudies) || !isCount(body.queuedUploads) ||
      !isBytes(body.spoolFreeBytes) || !isBytes(body.spoolCapacityBytes) ||
      (body.spoolFreeBytes !== null && body.spoolCapacityBytes !== null && body.spoolFreeBytes > body.spoolCapacityBytes) ||
      !(body.lastSuccessfulSyncAt === null || (typeof body.lastSuccessfulSyncAt === "string" &&
        !Number.isNaN(Date.parse(body.lastSuccessfulSyncAt)))) ||
      ((body.syncState === "attention") !== (body.lastErrorCode !== null))
    ) return errorResponse(400, "invalid_request");

    const services = getIngestionServices();
    const authorization = request.headers.get("authorization");
    const identity = await services.guard.authenticate(authorization);
    if (!identity.ok) return errorResponse(identity.status, identity.reason);
    const access = await services.guard.authorizeMutation(authorization, {
      sourceId: identity.sourceId,
      sourceGeneration: body.sourceGeneration,
      fencingToken: body.fencingToken,
    });
    if (!access.ok) return errorResponse(access.status, access.reason);
    const reportedAt = await services.devices.reportHealth({
      sourceId: access.sourceId,
      deviceId: access.deviceId,
      sourceGeneration: body.sourceGeneration,
      fencingToken: body.fencingToken,
      sourceReachable: body.sourceReachable,
      syncState: body.syncState as "idle" | "syncing" | "attention",
      lastErrorCode: body.lastErrorCode as (typeof ERRORS)[number] | null,
      queuedStudies: body.queuedStudies,
      queuedUploads: body.queuedUploads,
      spoolFreeBytes: body.spoolFreeBytes,
      spoolCapacityBytes: body.spoolCapacityBytes,
      lastSuccessfulSyncAt: body.lastSuccessfulSyncAt === null ? null : new Date(body.lastSuccessfulSyncAt),
    });
    return jsonResponse({ reportedAt: reportedAt.toISOString() }, 202);
  } catch (error) {
    if (error instanceof RangeError) return errorResponse(413, "request_too_large");
    return errorResponse(databaseErrorStatus(error), "source_health_unavailable");
  }
}
