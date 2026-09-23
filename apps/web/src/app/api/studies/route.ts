import { errorResponse, jsonResponse } from "../../../server/staff-api";
import { getStaffServices } from "../../../server/staff-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const access = await getStaffServices().guard.requireStaffRead(request.headers.get("cookie"));
    if (!access.ok) return errorResponse(access.status, access.reason);
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (url.searchParams.getAll("q").length > 1 || url.searchParams.getAll("cursor").length > 1) {
      return errorResponse(400, "invalid_request");
    }
    const page = await getStaffServices().studyRepository.list({
      staffUserId: access.principal.staffUserId,
      search: query,
      ...(cursor === undefined ? {} : { cursor }),
      limit: 25,
    });
    return jsonResponse(page);
  } catch (error) {
    return error instanceof TypeError
      ? errorResponse(400, "invalid_request")
      : errorResponse(503, "unavailable");
  }
}
