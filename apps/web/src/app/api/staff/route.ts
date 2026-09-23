import {
  databaseErrorStatus,
  errorResponse,
  jsonResponse,
  mutationOriginAllowed,
  readJsonObject,
} from "../../../server/staff-api";
import { getStaffServices } from "../../../server/staff-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { guard, repository } = getStaffServices();
    const access = await guard.requireStaffAdmin(request.headers.get("cookie"));
    if (!access.ok) return errorResponse(access.status, access.reason);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const afterId = url.searchParams.get("after");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (afterId !== null && !isUuid(afterId))
    )
      return errorResponse(409, "invalid_page_request");
    return jsonResponse(
      await repository.listStaffUsers({ limit, ...(afterId === null ? {} : { afterId }) }),
    );
  } catch {
    return errorResponse(503, "unavailable");
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!mutationOriginAllowed(request)) return errorResponse(403, "origin_rejected");
  let body: Record<string, unknown> | null;
  try {
    body = await readJsonObject(request);
  } catch (error) {
    return error instanceof RangeError
      ? errorResponse(413, "request_too_large")
      : errorResponse(503, "unavailable");
  }
  if (!body) return errorResponse(415, "json_required");
  const targetUserId = body.targetUserId;
  const role = body.role;
  if (
    typeof targetUserId !== "string" ||
    !isUuid(targetUserId) ||
    (role !== "admin" && role !== "staff")
  )
    return errorResponse(409, "invalid_membership_request");

  try {
    const { guard, repository } = getStaffServices();
    const access = await guard.requireStaffAdmin(request.headers.get("cookie"));
    if (!access.ok) return errorResponse(access.status, access.reason);
    const target = await repository.findStaffUserById(targetUserId);
    if (!target?.active || target.membership)
      return errorResponse(409, "staff_identity_not_pending");
    const changed = await repository.changeMembership({
      actorUserId: access.principal.staffUserId,
      targetUserId,
      expectedVersion: 0,
      role,
      status: "active",
    });
    return changed
      ? jsonResponse({ updated: true }, 201)
      : errorResponse(409, "membership_changed");
  } catch (error) {
    return errorResponse(databaseErrorStatus(error), "membership_update_failed");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
