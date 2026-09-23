import { isTrustedDeviceIpcSender, parseDeviceAdminIpcRequest } from "@clarity/domain";

const MAX_RESPONSE_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export type DeviceAdminBridgeDependencies = Readonly<{
  dashboardOrigin: string;
  cookieName: string;
  getHankoCookie(): Promise<string | null>;
  fetcher?: typeof fetch;
}>;

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("response-too-large");
  }
  if (!response.body) throw new Error("missing-response-body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

export function createDeviceAdminBridge(dependencies: DeviceAdminBridgeDependencies) {
  const origin = new URL(dependencies.dashboardOrigin).origin;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(dependencies.cookieName)) {
    throw new TypeError("Hanko cookie name is invalid.");
  }
  const fetcher = dependencies.fetcher ?? fetch;

  return Object.freeze({
    async invoke(frameUrl: string, isMainFrame: boolean, rawRequest: unknown): Promise<unknown> {
      if (!isTrustedDeviceIpcSender(frameUrl, origin, isMainFrame)) {
        return { ok: false, error: "forbidden" };
      }
      const request = parseDeviceAdminIpcRequest(rawRequest);
      if (!request) return { ok: false, error: "invalid_request" };
      if (request.operation === "readSyncStatus") {
        return { ok: true, status: "unavailable" };
      }

      const cookie = await dependencies.getHankoCookie();
      if (!cookie || /[\r\n;]/.test(cookie)) return { ok: false, error: "unauthenticated" };
      const pathname =
        request.operation === "createPairing"
          ? "/api/device-admin/pairings"
          : "/api/device-admin/revoke";
      const body =
        request.operation === "createPairing"
          ? { sourceId: request.sourceId }
          : { deviceId: request.deviceId, expectedVersion: request.expectedVersion };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetcher(new URL(pathname, origin), {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json",
            cookie: `${dependencies.cookieName}=${cookie}`,
            origin,
          },
          body: JSON.stringify(body),
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          return { ok: false, error: response.status === 401 ? "unauthenticated" : "forbidden" };
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return { ok: false, error: "unavailable" };
        }
        const result = await readBoundedJson(response);
        if (request.operation === "createPairing") {
          if (
            response.status !== 201 ||
            !exactObject(result, ["pairingId", "pairingCode", "expiresAt"]) ||
            typeof result.pairingId !== "string" ||
            typeof result.pairingCode !== "string" ||
            typeof result.expiresAt !== "string"
          )
            return { ok: false, error: "unavailable" };
          return {
            ok: true,
            pairingId: result.pairingId,
            pairingCode: result.pairingCode,
            expiresAt: result.expiresAt,
          };
        }
        if (
          response.status === 200 &&
          exactObject(result, ["revoked"]) &&
          result.revoked === true
        ) {
          return { ok: true, revoked: true };
        }
        return { ok: false, error: response.status === 409 ? "conflict" : "unavailable" };
      } catch {
        return { ok: false, error: "unavailable" };
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
