import { errorResponse, jsonResponse } from "../../../../server/staff-api";
import { getStaffServices } from "../../../../server/staff-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const access = await getStaffServices().guard.requireStaffAdmin(request.headers.get("cookie"));
    return access.ok
      ? jsonResponse({ authorized: true })
      : errorResponse(access.status, access.reason);
  } catch {
    return errorResponse(503, "unavailable");
  }
}
