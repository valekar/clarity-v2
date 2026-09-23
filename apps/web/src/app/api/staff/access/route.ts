import { errorResponse, jsonResponse } from "../../../../server/staff-api";
import { getStaffServices } from "../../../../server/staff-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { guard } = getStaffServices();
    const access = await guard.requireStaffRead(request.headers.get("cookie"));
    return access.ok
      ? jsonResponse({ principal: access.principal })
      : errorResponse(access.status, access.reason);
  } catch {
    return errorResponse(503, "unavailable");
  }
}
