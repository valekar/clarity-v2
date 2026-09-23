import { getScopedOhifProxy } from "../../../server/viewer-services";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  try {
    const { path = [] } = await context.params;
    return await getScopedOhifProxy().handle(request, path);
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
