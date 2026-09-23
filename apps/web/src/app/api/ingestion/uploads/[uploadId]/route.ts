import { errorResponse, jsonResponse } from "../../../../../server/staff-api";
import { getIngestionServices } from "../../../../../server/ingestion-services";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: Readonly<{ params: Promise<{ uploadId: string }> }>,
): Promise<Response> {
  const { uploadId } = await context.params;
  if (!UUID.test(uploadId)) return jsonResponse({ error: "invalid_request" }, 400);
  try {
    const services = getIngestionServices();
    const access = await services.guard.authenticate(request.headers.get("authorization"));
    if (!access.ok) return errorResponse(access.status, access.reason);
    const upload = await services.ingestion.getUpload(uploadId, access.sourceId, access.deviceId);
    if (!upload) return jsonResponse({ error: "not_found" }, 404);
    let status = upload.status;
    if (["admitted", "uploading"].includes(status) && upload.expiresAt <= new Date())
      status = "expired";
    return jsonResponse({ status });
  } catch {
    return errorResponse(503, "upload_status_unavailable");
  }
}
