import "server-only";
import { publicOrigin } from "./staff-services";
import { mutationRequestAllowed } from "./origin-policy";

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function errorResponse(
  status: 400 | 401 | 403 | 409 | 413 | 415 | 503,
  code: string,
): Response {
  return jsonResponse({ error: code }, status);
}

export function mutationOriginAllowed(request: Request): boolean {
  try {
    return mutationRequestAllowed(
      request.headers.get("origin"),
      request.headers.get("content-type"),
      publicOrigin(),
    );
  } catch {
    return false;
  }
}

export async function readJsonObject(
  request: Request,
  maxBytes = 4096,
): Promise<Record<string, unknown> | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024) {
    throw new TypeError("Request JSON limit is outside the allowed range.");
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return null;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes)
    throw new RangeError("Request too large.");
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new RangeError("Request too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch (error) {
    if (error instanceof RangeError) throw error;
    return null;
  }
}

export function databaseErrorStatus(error: unknown): 403 | 409 | 503 {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "42501") return 403;
    if (code === "23514") return 409;
  }
  return 503;
}
