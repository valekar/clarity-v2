import { createHash } from "node:crypto";
import { verifyProviderCallback } from "./signed-callback.ts";

export type VerifiedCallbackStore = Readonly<{
  applyVerifiedCallback(
    input: Readonly<{
      eventId: string;
      idempotencyKey: string;
      providerMessageId: string;
      state: "submitted" | "delivered" | "failed";
      occurredAt: string;
      payloadSha256: string;
    }>,
  ): Promise<string>;
}>;

/** Verify a bounded callback, then let the repository atomically deduplicate and apply it. */
export async function handleProviderCallback(
  input: Readonly<{
    store: VerifiedCallbackStore;
    secret: string;
    signature: string;
    timestamp: string;
    rawBody: string;
    now?: number;
    toleranceMs?: number;
  }>,
): Promise<Readonly<{ ok: true; state: string }> | Readonly<{ ok: false; reason: string }>> {
  const parsed = verifyProviderCallback({
    secret: input.secret,
    signature: input.signature,
    timestamp: input.timestamp,
    rawBody: input.rawBody,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.toleranceMs === undefined ? {} : { toleranceMs: input.toleranceMs }),
  });
  if (!parsed.ok) return parsed;
  const event = parsed.event;
  const state = await input.store.applyVerifiedCallback({
    ...event,
    payloadSha256: createHash("sha256").update(input.rawBody, "utf8").digest("hex"),
  });
  return Object.freeze({ ok: true, state });
}
