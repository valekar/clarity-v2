import assert from "node:assert/strict";
import test from "node:test";
import { signSyntheticCallback, verifyProviderCallback } from "../src/signed-callback.ts";

const secret = "synthetic-callback-secret-with-at-least-32-bytes";
const timestamp = "2026-09-23T12:00:00.000Z";
const payload = JSON.stringify({
  eventId: "callback-event-0001",
  idempotencyKey: "idempotency-0001",
  providerMessageId: "synthetic-message-0001",
  state: "delivered",
  occurredAt: timestamp,
});

test("signed bounded callback parses without exposing raw body in errors", () => {
  const result = verifyProviderCallback({
    secret,
    timestamp,
    rawBody: payload,
    signature: signSyntheticCallback(secret, timestamp, payload),
    now: Date.parse(timestamp),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.event.state, "delivered");
});

test("tampered, stale, oversized and malformed callbacks fail closed", () => {
  const signature = signSyntheticCallback(secret, timestamp, payload);
  assert.deepEqual(
    verifyProviderCallback({
      secret,
      timestamp,
      rawBody: `${payload} `,
      signature,
      now: Date.parse(timestamp),
    }),
    { ok: false, reason: "invalid_signature" },
  );
  assert.deepEqual(
    verifyProviderCallback({
      secret,
      timestamp,
      rawBody: payload,
      signature,
      now: Date.parse(timestamp) + 6 * 60_000,
    }),
    { ok: false, reason: "stale_timestamp" },
  );
  assert.deepEqual(
    verifyProviderCallback({
      secret,
      timestamp,
      rawBody: "x".repeat(8_193),
      signature,
      now: Date.parse(timestamp),
    }),
    { ok: false, reason: "invalid_body" },
  );
  const invalidBody = "not-json";
  assert.deepEqual(
    verifyProviderCallback({
      secret,
      timestamp,
      rawBody: invalidBody,
      signature: signSyntheticCallback(secret, timestamp, invalidBody),
      now: Date.parse(timestamp),
    }),
    { ok: false, reason: "invalid_body" },
  );
});
