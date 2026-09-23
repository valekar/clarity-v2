/**
 * Policy-independent durable outbox transition contract.
 *
 * This module describes delivery bookkeeping only. It does not authorize a
 * recipient, mint a link, or enable an external provider. Persistence adapters
 * must apply each returned state with a lease/attempt compare-and-swap.
 */

export type DispatchDeliveryState = "queued" | "submitted" | "delivered" | "failed" | "uncertain";

export type OutboxIntent = Readonly<{
  id: string;
  dispatchId: string;
  recipientId: string;
  idempotencyKey: string;
  destinationPhoneE164: string;
  messageText: string;
  state: DispatchDeliveryState;
  attempt: number;
  claimToken: string | null;
  claimExpiresAt: string | null;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  version: number;
}>;

export type OutboxTransitionError =
  | "claim_mismatch"
  | "claim_expired"
  | "wrong_state"
  | "provider_message_mismatch"
  | "invalid_input";

export type OutboxTransition<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reason: OutboxTransitionError }>;

export type ProviderReceipt = Readonly<{
  providerMessageId: string;
  state: "accepted";
}>;

export type ProviderCallback = Readonly<{
  eventId: string;
  idempotencyKey: string;
  providerMessageId: string;
  state: "submitted" | "delivered" | "failed";
  occurredAt: string;
}>;

const uuidLike = /^[a-zA-Z0-9_-]{8,128}$/;
const phoneE164 = /^\+[1-9][0-9]{7,14}$/;
const isoTimestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

function validIntent(intent: OutboxIntent): boolean {
  return (
    uuidLike.test(intent.id) &&
    uuidLike.test(intent.dispatchId) &&
    uuidLike.test(intent.recipientId) &&
    uuidLike.test(intent.idempotencyKey) &&
    phoneE164.test(intent.destinationPhoneE164) &&
    intent.messageText.trim().length > 0 &&
    intent.messageText.length <= 2_000 &&
    Number.isSafeInteger(intent.attempt) &&
    intent.attempt >= 0 &&
    Number.isSafeInteger(intent.version) &&
    intent.version > 0
  );
}

function clone(
  intent: OutboxIntent,
  change: Partial<OutboxIntent>,
): OutboxIntent {
  return Object.freeze({ ...intent, ...change, version: intent.version + 1 });
}

/**
 * Claim one never-attempted queued intent. Expired claimed work must first be
 * marked uncertain and reconciled; it is never returned to `queued` here.
 */
export function claimQueuedIntent(
  intent: OutboxIntent,
  claimToken: string,
  now: string,
  claimExpiresAt: string,
): OutboxTransition<OutboxIntent> {
  if (!validIntent(intent) || !uuidLike.test(claimToken) || !isoTimestamp.test(now) || !isoTimestamp.test(claimExpiresAt)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (intent.state !== "queued" || intent.attempt !== 0 || intent.claimToken !== null) {
    return { ok: false, reason: "wrong_state" };
  }
  if (Date.parse(claimExpiresAt) <= Date.parse(now)) return { ok: false, reason: "invalid_input" };
  return {
    ok: true,
    value: clone(intent, { claimToken, claimExpiresAt, attempt: 1 }),
  };
}

/**
 * A provider acceptance is durably recorded as submitted. A lease token is
 * required so a stale worker cannot overwrite reconciliation or callback work.
 */
export function recordProviderAccepted(
  intent: OutboxIntent,
  claimToken: string,
  receipt: ProviderReceipt,
  now: string,
): OutboxTransition<OutboxIntent> {
  if (
    !validIntent(intent) ||
    !uuidLike.test(claimToken) ||
    !uuidLike.test(receipt.providerMessageId) ||
    !isoTimestamp.test(now)
  ) {
    return { ok: false, reason: "invalid_input" };
  }
  const claimResult = checkClaim(intent, claimToken, now);
  if (!claimResult.ok) return claimResult;
  if (intent.state !== "queued") return { ok: false, reason: "wrong_state" };
  return {
    ok: true,
    value: clone(intent, {
      state: "submitted",
      providerMessageId: receipt.providerMessageId,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: null,
    }),
  };
}

/** Unknown HTTP/network outcome is terminal for automatic attempts. */
export function recordProviderOutcomeUnknown(
  intent: OutboxIntent,
  claimToken: string,
  now: string,
): OutboxTransition<OutboxIntent> {
  if (!validIntent(intent) || !uuidLike.test(claimToken) || !isoTimestamp.test(now)) {
    return { ok: false, reason: "invalid_input" };
  }
  const claimResult = checkClaim(intent, claimToken, now);
  if (!claimResult.ok) return claimResult;
  if (intent.state !== "queued") return { ok: false, reason: "wrong_state" };
  return {
    ok: true,
    value: clone(intent, {
      state: "uncertain",
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: "provider_outcome_unknown",
    }),
  };
}

/** Reconcile by stable provider idempotency key; absence never authorizes resend. */
export function reconcileUncertainIntent(
  intent: OutboxIntent,
  receipt: ProviderReceipt | null,
): OutboxTransition<OutboxIntent> {
  if (!validIntent(intent) || (receipt && !uuidLike.test(receipt.providerMessageId))) {
    return { ok: false, reason: "invalid_input" };
  }
  if (intent.state !== "uncertain") return { ok: false, reason: "wrong_state" };
  if (!receipt) return { ok: true, value: intent };
  return {
    ok: true,
    value: clone(intent, {
      state: "submitted",
      providerMessageId: receipt.providerMessageId,
      lastErrorCode: null,
    }),
  };
}

/** Apply a previously signature-verified, deduplicated callback. */
export function applyProviderCallback(
  intent: OutboxIntent,
  callback: ProviderCallback,
): OutboxTransition<OutboxIntent> {
  if (
    !validIntent(intent) ||
    !uuidLike.test(callback.eventId) ||
    !uuidLike.test(callback.idempotencyKey) ||
    !uuidLike.test(callback.providerMessageId) ||
    !isoTimestamp.test(callback.occurredAt)
  ) {
    return { ok: false, reason: "invalid_input" };
  }
  if (callback.idempotencyKey !== intent.idempotencyKey) return { ok: false, reason: "claim_mismatch" };
  if (intent.providerMessageId !== callback.providerMessageId) {
    return { ok: false, reason: "provider_message_mismatch" };
  }
  if (intent.state !== "submitted" && intent.state !== "delivered") {
    return { ok: false, reason: "wrong_state" };
  }
  if (intent.state === "delivered") return { ok: true, value: intent };
  return {
    ok: true,
    value: clone(intent, {
      state: callback.state,
      lastErrorCode: callback.state === "failed" ? "provider_delivery_failed" : null,
    }),
  };
}

function checkClaim(
  intent: OutboxIntent,
  claimToken: string,
  now: string,
): OutboxTransition<never> {
  if (intent.claimToken !== claimToken) return { ok: false, reason: "claim_mismatch" };
  if (!intent.claimExpiresAt || Date.parse(intent.claimExpiresAt) <= Date.parse(now)) {
    return { ok: false, reason: "claim_expired" };
  }
  return { ok: true, value: undefined as never };
}
