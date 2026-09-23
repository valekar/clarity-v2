import type {
  DeviceAdminRepository,
  DeviceAuthRepository,
} from "@clarity/database/device-repository";
import type { StaffAccessResult } from "../auth/require-staff-access.js";
import { createDevicePairingService, PairingRejectedError } from "./device-pairing.js";

const BODY_LIMIT = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeviceHttpApiOptions = Readonly<{
  dashboardOrigin: string;
  staff: Readonly<{
    requireStaffAdmin(cookie: string | null): Promise<StaffAccessResult>;
  }>;
  adminRepository: Pick<DeviceAdminRepository, "createPairing" | "revokeDevice">;
  deviceRepository: Pick<DeviceAuthRepository, "consumePairing">;
  now?: () => Date;
}>;

type JsonObject = Record<string, unknown>;

function response(status: number, body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, private",
      pragma: "no-cache",
      vary: "Cookie, Authorization, Origin",
    },
  });
}

async function readJson(request: Request): Promise<unknown | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  try {
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    return value;
  } catch {
    return null;
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function sameOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === expectedOrigin;
}

function staffFailure(result: Exclude<StaffAccessResult, { ok: true }>): Response {
  return response(result.status, { error: result.reason });
}

export function createDeviceHttpApi(options: DeviceHttpApiOptions) {
  const expectedOrigin = new URL(options.dashboardOrigin).origin;
  const pairing = createDevicePairingService({
    adminRepository: options.adminRepository,
    deviceRepository: options.deviceRepository,
    ...(options.now ? { now: options.now } : {}),
  });
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/device-admin/pairings") {
        if (!sameOrigin(request, expectedOrigin)) return response(403, { error: "forbidden" });
        const access = await options.staff.requireStaffAdmin(request.headers.get("cookie"));
        if (!access.ok) return staffFailure(access);
        const input = await readJson(request);
        if (
          !exactObject(input, ["sourceId"]) ||
          typeof input.sourceId !== "string" ||
          !UUID.test(input.sourceId)
        ) {
          return response(400, { error: "invalid_request" });
        }
        try {
          const created = await pairing.createPairing(access.principal, input.sourceId);
          return response(201, {
            pairingId: created.pairingId,
            pairingCode: created.pairingSecret,
            expiresAt: created.expiresAt.toISOString(),
          });
        } catch {
          return response(503, { error: "unavailable" });
        }
      }

      if (request.method === "POST" && url.pathname === "/api/device-admin/revoke") {
        if (!sameOrigin(request, expectedOrigin)) return response(403, { error: "forbidden" });
        const access = await options.staff.requireStaffAdmin(request.headers.get("cookie"));
        if (!access.ok) return staffFailure(access);
        const input = await readJson(request);
        if (
          !exactObject(input, ["deviceId", "expectedVersion"]) ||
          typeof input.deviceId !== "string" ||
          !UUID.test(input.deviceId) ||
          typeof input.expectedVersion !== "string" ||
          !/^[1-9][0-9]{0,18}$/.test(input.expectedVersion)
        )
          return response(400, { error: "invalid_request" });
        try {
          const revoked = await options.adminRepository.revokeDevice({
            actorUserId: access.principal.staffUserId,
            deviceId: input.deviceId,
            expectedVersion: input.expectedVersion,
          });
          return revoked ? response(200, { revoked: true }) : response(409, { error: "conflict" });
        } catch {
          return response(503, { error: "unavailable" });
        }
      }

      if (request.method === "POST" && url.pathname === "/api/device/pair") {
        if (request.headers.has("cookie")) return response(401, { error: "unauthenticated" });
        const input = await readJson(request);
        if (
          !exactObject(input, ["pairingCode", "displayName"]) ||
          typeof input.pairingCode !== "string" ||
          typeof input.displayName !== "string"
        )
          return response(400, { error: "invalid_request" });
        try {
          const result = await pairing.pairLocalDevice(input.pairingCode, input.displayName);
          return response(201, {
            deviceId: result.deviceId,
            sourceId: result.sourceId,
            authorization: result.authorization,
          });
        } catch (error) {
          if (error instanceof PairingRejectedError)
            return response(410, { error: "pairing_expired_or_used" });
          if (error instanceof TypeError) return response(400, { error: "invalid_request" });
          return response(503, { error: "unavailable" });
        }
      }

      return response(404, { error: "not_found" });
    },
  });
}
