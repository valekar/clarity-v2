import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderCallback } from "./outbox.ts";

export type CallbackParseResult =
  | Readonly<{ ok: true; event: ProviderCallback }>
  | Readonly<{
      ok: false;
      reason: "invalid_secret" | "invalid_timestamp" | "stale_timestamp" | "invalid_signature" | "invalid_body";
    }>;

const signaturePattern = /^sha256=([a-f0-9]{64})$/i;
const idPattern = /^[a-zA-Z0-9_-]{8,128}$/;
const timestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

/**
 * Parse a synthetic/compatible provider callback. The caller must durably
 * deduplicate `event.eventId` and update the matching outbox row in one DB
 * transaction; this function authenticates and validates bytes only.
 */
export function verifyProviderCallback(input: Readonly<{
  secret: string;
  signature: string;
  timestamp: string;
  rawBody: string;
  now?: number;
  toleranceMs?: number;
}>): CallbackParseResult {
  if (input.secret.length < 32 || input.secret.length > 512) {
    return { ok: false, reason: "invalid_secret" };
  }
  if (!timestampPattern.test(input.timestamp)) return { ok: false, reason: "invalid_timestamp" };
  if (input.rawBody.length < 2 || Buffer.byteLength(input.rawBody, "utf8") > 8_192) {
    return { ok: false, reason: "invalid_body" };
  }
  const receivedAt = Date.parse(input.timestamp);
  const now = input.now ?? Date.now();
  const tolerance = input.toleranceMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(tolerance) || tolerance < 1) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (Math.abs(now - receivedAt) > tolerance) return { ok: false, reason: "stale_timestamp" };
  const signature = signaturePattern.exec(input.signature);
  if (!signature) return { ok: false, reason: "invalid_signature" };
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.rawBody}`, "utf8")
    .digest();
  const actual = Buffer.from(signature[1]!, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "invalid_signature" };
  }
  let value: unknown;
  try {
    value = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, reason: "invalid_body" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "invalid_body" };
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 5 ||
    typeof candidate.eventId !== "string" ||
    !idPattern.test(candidate.eventId) ||
    typeof candidate.idempotencyKey !== "string" ||
    !idPattern.test(candidate.idempotencyKey) ||
    typeof candidate.providerMessageId !== "string" ||
    !idPattern.test(candidate.providerMessageId) ||
    (candidate.state !== "submitted" &&
      candidate.state !== "delivered" &&
      candidate.state !== "failed") ||
    typeof candidate.occurredAt !== "string" ||
    !timestampPattern.test(candidate.occurredAt) ||
    Number.isNaN(Date.parse(candidate.occurredAt))
  ) {
    return { ok: false, reason: "invalid_body" };
  }
  return {
    ok: true,
    event: Object.freeze({
      eventId: candidate.eventId,
      idempotencyKey: candidate.idempotencyKey,
      providerMessageId: candidate.providerMessageId,
      state: candidate.state,
      occurredAt: candidate.occurredAt,
    }),
  };
}

/** Deterministic helper for local synthetic provider tests only. */
export function signSyntheticCallback(secret: string, timestamp: string, rawBody: string): string {
  if (secret.length < 32 || !timestampPattern.test(timestamp)) {
    throw new TypeError("Invalid synthetic callback signing input.");
  }
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`;
}
