import type { ParsedDeviceAuthorization } from "./device-credential.js";
import type { DeviceAuthRepository } from "@clarity/database/device-repository";
import { parseDeviceAuthorization, verifyDeviceAuthorization } from "./device-credential.js";

export type DeviceCredentialRecord = Readonly<{
  deviceId: string;
  sourceId: string;
  verifier: Uint8Array;
  status: "paired" | "revoked";
  sourceStatus: "active" | "disabled";
  leaseDeviceId: string | null;
  fencingToken: string;
  leaseExpiresAt: Date | null;
  generation: string;
}>;

export type DeviceAccessResult =
  | Readonly<{
      ok: true;
      deviceId: string;
      sourceId: string;
      fencingToken: string;
      generation: string;
    }>
  | Readonly<{
      ok: false;
      status: 401 | 403 | 503;
      reason: "unauthenticated" | "forbidden" | "unavailable";
    }>;

export type DeviceAccessRepository = Pick<DeviceAuthRepository, "findDeviceCredential">;

export type DeviceMutationFence = Readonly<{
  sourceId: string;
  sourceGeneration: string;
  fencingToken: string;
  now?: Date;
}>;

const unauthorized: DeviceAccessResult = Object.freeze({
  ok: false,
  status: 401,
  reason: "unauthenticated",
});
const unavailable: DeviceAccessResult = Object.freeze({
  ok: false,
  status: 503,
  reason: "unavailable",
});

export function createDeviceAccessGuard(repository: DeviceAccessRepository) {
  async function authenticate(header: string | null | undefined): Promise<DeviceAccessResult> {
    const credential: ParsedDeviceAuthorization | null = parseDeviceAuthorization(header);
    if (!credential) return unauthorized;
    try {
      const record = await repository.findDeviceCredential(credential.deviceId);
      if (!record || record.status !== "paired") return unauthorized;
      if (!verifyDeviceAuthorization(header, record.deviceId, record.verifier)) return unauthorized;
      return Object.freeze({
        ok: true,
        deviceId: record.deviceId,
        sourceId: record.sourceId,
        fencingToken: record.fencingToken,
        generation: record.generation,
      });
    } catch {
      return unavailable;
    }
  }

  async function authorizeMutation(
    header: string | null | undefined,
    fence: DeviceMutationFence,
  ): Promise<DeviceAccessResult> {
    const credential: ParsedDeviceAuthorization | null = parseDeviceAuthorization(header);
    if (!credential) return unauthorized;
    try {
      const record = await repository.findDeviceCredential(credential.deviceId);
      if (!record || record.status !== "paired") return unauthorized;
      if (!verifyDeviceAuthorization(header, record.deviceId, record.verifier)) return unauthorized;
      const now = fence.now ?? new Date();
      if (
        record.sourceId !== fence.sourceId ||
        record.generation !== fence.sourceGeneration ||
        record.sourceStatus !== "active" ||
        record.leaseDeviceId !== record.deviceId ||
        record.fencingToken !== fence.fencingToken ||
        record.leaseExpiresAt === null ||
        record.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        return Object.freeze({ ok: false, status: 403, reason: "forbidden" });
      }
      return Object.freeze({
        ok: true,
        deviceId: record.deviceId,
        sourceId: record.sourceId,
        fencingToken: record.fencingToken,
        generation: record.generation,
      });
    } catch {
      return unavailable;
    }
  }

  return Object.freeze({ authenticate, authorizeMutation });
}

export function deviceAccessForSource(
  access: DeviceAccessResult,
  sourceId: string,
): DeviceAccessResult {
  if (!access.ok) return access;
  return access.sourceId === sourceId
    ? access
    : Object.freeze({ ok: false, status: 403, reason: "forbidden" });
}
