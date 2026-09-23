import {
  databaseErrorStatus,
  errorResponse,
  jsonResponse,
  mutationOriginAllowed,
  readJsonObject,
} from "../../../server/staff-api";
import { getDoctorRepository } from "../../../server/doctor-services";
import { getStaffServices } from "../../../server/staff-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { guard } = getStaffServices();
    const access = await guard.requireStaffRead(request.headers.get("cookie"));
    if (!access.ok) return errorResponse(access.status, access.reason);
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "20");
    if (query.length > 80 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return errorResponse(409, "invalid_doctor_search");
    }
    return jsonResponse({ doctors: await getDoctorRepository().search(query, limit) });
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
  if (
    typeof body.displayName !== "string" ||
    typeof body.phoneE164 !== "string" ||
    typeof body.confirmedSharedPhone !== "boolean" ||
    Object.keys(body).some(
      (key) => !["displayName", "phoneE164", "confirmedSharedPhone"].includes(key),
    )
  ) {
    return errorResponse(409, "invalid_doctor_details");
  }
  try {
    const { guard } = getStaffServices();
    const access = await guard.requireStaffRead(request.headers.get("cookie"));
    if (!access.ok) return errorResponse(access.status, access.reason);
    const result = await getDoctorRepository().create({
      displayName: body.displayName,
      phoneE164: body.phoneE164,
      confirmedSharedPhone: body.confirmedSharedPhone,
      actorStaffUserId: access.principal.staffUserId,
    });
    return jsonResponse(result, result.outcome === "created" ? 201 : 200);
  } catch (error) {
    if (error instanceof TypeError) return errorResponse(409, "invalid_doctor_details");
    return errorResponse(databaseErrorStatus(error), "doctor_create_failed");
  }
}
