import "server-only";
import { createDeviceAuthRepository, createDevicePool } from "@clarity/database/device-repository";
import { createIngestionRepository } from "@clarity/database/ingestion-repository";
import { createDeviceAccessGuard } from "@clarity/server/device/require-device-access";
import { S3UploadAdmission } from "@clarity/storage/upload-admission";

let services:
  | Readonly<{
      guard: ReturnType<typeof createDeviceAccessGuard>;
      devices: ReturnType<typeof createDeviceAuthRepository>;
      ingestion: ReturnType<typeof createIngestionRepository>;
      uploads: S3UploadAdmission;
    }>
  | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

export function getIngestionServices() {
  if (services) return services;
  const pool = createDevicePool({
    connectionString: requiredEnvironment("CLARITY_DEVICE_AUTH_DATABASE_URL"),
    maxConnections: 3,
    connectionTimeoutMs: 2_000,
    idleTimeoutMs: 10_000,
    queryTimeoutMs: 5_000,
  });
  const devices = createDeviceAuthRepository(pool);
  const uploads = new S3UploadAdmission({
    internalEndpoint: new URL(requiredEnvironment("INTAKE_S3_ENDPOINT")),
    publicEndpoint: new URL(requiredEnvironment("INTAKE_S3_PUBLIC_ENDPOINT")),
    bucket: requiredEnvironment("INTAKE_S3_BUCKET"),
    region: requiredEnvironment("INTAKE_S3_REGION"),
    accessKey: requiredEnvironment("INTAKE_S3_ACCESS_KEY"),
    secretKey: requiredEnvironment("INTAKE_S3_SECRET_KEY"),
  });
  services = Object.freeze({
    guard: createDeviceAccessGuard(devices),
    devices,
    ingestion: createIngestionRepository(pool),
    uploads,
  });
  return services;
}
