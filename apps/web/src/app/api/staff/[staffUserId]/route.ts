import {
  databaseErrorStatus,
  errorResponse,
  jsonResponse,
  mutationOriginAllowed,
  readJsonObject,
} from "../../../../server/staff-api";
import { getStaffServices } from "../../../../server/staff-services";

export const dynamic = "force-dynamic";
type RouteContext = Readonly<{ params: Promise<{ staffUserId: string }> }>;

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
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
  const expectedVersion = body.expectedVersion;
  if (
    !(
      typeof expectedVersion === "number" &&
      Number.isSafeInteger(expectedVersion) &&
      expectedVersion > 0
    ) &&
    !(typeof expectedVersion === "string" && /^[1-9][0-9]*$/.test(expectedVersion))
  ) {
    return errorResponse(409, "invalid_membership_request");
  }
  const { staffUserId } = await context.params;
  if (!isUuid(staffUserId)) return errorResponse(409, "invalid_staff_user");

  try {
    const { guard, repository } = getStaffServices();
    const access = await guard.requireStaffAdmin(request.headers.get("cookie"));
    if (!access.ok) return errorResponse(access.status, access.reason);
    const target = await repository.findStaffUserById(staffUserId);
    if (!target?.membership) return errorResponse(409, "staff_membership_not_found");
    const changed = await repository.changeMembership({
      actorUserId: access.principal.staffUserId,
      targetUserId: staffUserId,
      expectedVersion,
      role: target.membership.role,
      status: "disabled",
    });
    return changed ? jsonResponse({ updated: true }) : errorResponse(409, "membership_changed");
  } catch (error) {
    return errorResponse(databaseErrorStatus(error), "membership_update_failed");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
