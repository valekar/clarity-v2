import { getDeviceAdminApi } from "../../../../server/device-admin-services";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    return await getDeviceAdminApi().handle(request);
  } catch {
    return Response.json(
      { error: "unavailable" },
      {
        status: 503,
        headers: { "cache-control": "no-store, private" },
      },
    );
  }
}
