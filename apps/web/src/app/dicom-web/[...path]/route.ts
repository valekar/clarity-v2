import { dicomwebPathFromRequest } from "@clarity/server/viewer/scoped-dicomweb";
import { getScopedDicomwebGateway } from "../../../server/viewer-services";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const path = dicomwebPathFromRequest(request);
    if (!path)
      return Response.json(
        { error: "invalid_dicomweb_request" },
        {
          status: 400,
          headers: { "cache-control": "private, no-store" },
        },
      );
    return await getScopedDicomwebGateway().handle(request, path);
  } catch {
    return Response.json(
      { error: "viewer_unavailable" },
      {
        status: 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}
