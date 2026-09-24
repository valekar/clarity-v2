import { errorResponse, jsonResponse } from "../../../../server/staff-api";
import { getStaffServices } from "../../../../server/staff-services";

export const dynamic = "force-dynamic";
const STALE_AFTER_MS = 2 * 60_000;

export async function GET(request: Request): Promise<Response> {
  try {
    const { guard, sourceHealthRepository } = getStaffServices();
    const access = await guard.requireStaffRead(request.headers.get("cookie"));
    if (!access.ok) return errorResponse(access.status, access.reason);
    const items = await sourceHealthRepository.listForStaff(access.principal.staffUserId);
    const now = Date.now();
    return jsonResponse({
      items: items.map((item) => {
        const age = item.reportedAt === null ? Number.POSITIVE_INFINITY : now - Date.parse(item.reportedAt);
        const stale = !Number.isFinite(age) || age < 0 || age > STALE_AFTER_MS;
        const lowCapacity = item.spoolFreeBytes !== null && item.spoolFreeBytes <= 1_073_741_824;
        const status = stale
          ? "stale"
          : item.sourceReachable === false
            ? "offline"
            : item.syncState === "attention" || lowCapacity
              ? "attention"
              : "healthy";
        return {
          sourceId: item.sourceId,
          sourceName: item.sourceName,
          status,
          observedAt: item.reportedAt,
          lastSuccessfulSyncAt: item.lastSuccessfulSyncAt,
          lastErrorCode: item.lastErrorCode,
          queuedStudies: item.queuedStudies,
          queuedUploads: item.queuedUploads,
          spoolFreeBytes: item.spoolFreeBytes,
          spoolCapacityBytes: item.spoolCapacityBytes,
          sourceReachable: stale ? null : item.sourceReachable,
          cloudReachable: stale ? null : true,
        };
      }),
      nextCursor: null,
    });
  } catch {
    return errorResponse(503, "source_health_unavailable");
  }
}
