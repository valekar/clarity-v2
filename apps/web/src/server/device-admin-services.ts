import "server-only";
import { createDeviceAdminRepository } from "@clarity/database/device-repository";
import { createStaffPool } from "@clarity/database/staff-repository";
import { createDeviceHttpApi } from "@clarity/server/device/device-http-api";
import { getIngestionServices } from "./ingestion-services";
import { publicOrigin, getStaffServices } from "./staff-services";

let api: ReturnType<typeof createDeviceHttpApi> | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

export function getDeviceAdminApi() {
  if (api) return api;
  const runtimePool = createStaffPool({
    connectionString: requiredEnvironment("DATABASE_URL"),
    maxConnections: 2,
    connectionTimeoutMs: 2_000,
    idleTimeoutMs: 10_000,
    queryTimeoutMs: 5_000,
  });
  api = createDeviceHttpApi({
    dashboardOrigin: publicOrigin(),
    staff: getStaffServices().guard,
    adminRepository: createDeviceAdminRepository(runtimePool),
    deviceRepository: getIngestionServices().devices,
  });
  return api;
}
