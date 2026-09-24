import assert from "node:assert/strict";
import test from "node:test";
import { handleProviderCallback, type VerifiedCallbackStore } from "../src/callback-handler.ts";
import { signSyntheticCallback } from "../src/signed-callback.ts";

const secret = "synthetic-callback-secret-with-at-least-32-bytes";
const timestamp = "2026-09-24T12:00:00.000Z";
const rawBody = JSON.stringify({
  eventId: "callback-event-1001",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  providerMessageId: "synthetic-message-1001",
  state: "delivered",
  occurredAt: timestamp,
});

test("callback handler verifies bytes before repository call and supports durable event dedupe", async () => {
  const events = new Map<string, Readonly<{ hash: string; state: string }>>();
  let calls = 0;
  const store: VerifiedCallbackStore = {
    async applyVerifiedCallback(input) {
      calls += 1;
      const prior = events.get(input.eventId);
      if (prior) {
        if (prior.hash !== input.payloadSha256) throw new Error("Callback event ID was reused.");
        return prior.state;
      }
      events.set(input.eventId, { hash: input.payloadSha256, state: input.state });
      return input.state;
    },
  };
  const signature = signSyntheticCallback(secret, timestamp, rawBody);
  const input = { store, secret, signature, timestamp, rawBody, now: Date.parse(timestamp) };
  assert.deepEqual(await handleProviderCallback(input), { ok: true, state: "delivered" });
  assert.deepEqual(await handleProviderCallback(input), { ok: true, state: "delivered" });
  assert.equal(calls, 2);
  assert.equal(events.size, 1);
  assert.deepEqual(await handleProviderCallback({ ...input, rawBody: `${rawBody} ` }), {
    ok: false,
    reason: "invalid_signature",
  });
  assert.equal(calls, 2);
});
