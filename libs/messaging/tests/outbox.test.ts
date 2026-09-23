import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProviderCallback,
  claimQueuedIntent,
  recordProviderAccepted,
  recordProviderOutcomeUnknown,
  reconcileUncertainIntent,
  type OutboxIntent,
} from "../src/outbox.ts";

const now = "2026-09-23T12:00:00.000Z";
const claimExpiry = "2026-09-23T12:01:00.000Z";
const intent: OutboxIntent = Object.freeze({
  id: "intent-00000001",
  dispatchId: "dispatch-000001",
  recipientId: "recipient-0001",
  idempotencyKey: "idempotency-0001",
  destinationPhoneE164: "+919876543210",
  messageText: "Synthetic-only placeholder, no share link",
  state: "queued",
  attempt: 0,
  claimToken: null,
  claimExpiresAt: null,
  providerMessageId: null,
  lastErrorCode: null,
  version: 1,
});

test("accepted delivery moves queued to submitted, then callback can mark delivered", () => {
  const claim = claimQueuedIntent(intent, "claim-token-001", now, claimExpiry);
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  assert.equal(claim.value.attempt, 1);
  const accepted = recordProviderAccepted(
    claim.value,
    "claim-token-001",
    { providerMessageId: "synthetic-message-0001", state: "accepted" },
    now,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.value.state, "submitted");
  const delivered = applyProviderCallback(accepted.value, {
    eventId: "callback-event-0001",
    idempotencyKey: intent.idempotencyKey,
    providerMessageId: "synthetic-message-0001",
    state: "delivered",
    occurredAt: now,
  });
  assert.equal(delivered.ok, true);
  if (delivered.ok) assert.equal(delivered.value.state, "delivered");
});

test("unknown provider outcome remains uncertain when reconciliation finds nothing", () => {
  const claim = claimQueuedIntent(intent, "claim-token-001", now, claimExpiry);
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  const uncertain = recordProviderOutcomeUnknown(claim.value, "claim-token-001", now);
  assert.equal(uncertain.ok, true);
  if (!uncertain.ok) return;
  assert.equal(uncertain.value.state, "uncertain");
  const reconciled = reconcileUncertainIntent(uncertain.value, null);
  assert.equal(reconciled.ok, true);
  if (reconciled.ok) {
    assert.equal(reconciled.value.state, "uncertain");
    assert.equal(claimQueuedIntent(reconciled.value, "new-claim-token", now, claimExpiry).ok, false);
  }
});

test("stale workers, mismatched callbacks, and callbacks before acceptance cannot advance", () => {
  const claim = claimQueuedIntent(intent, "claim-token-001", now, claimExpiry);
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  assert.equal(
    recordProviderAccepted(
      claim.value,
      "wrong-claim-token",
      { providerMessageId: "synthetic-message-0001", state: "accepted" },
      now,
    ).ok,
    false,
  );
  assert.equal(
    applyProviderCallback(intent, {
      eventId: "callback-event-0001",
      idempotencyKey: intent.idempotencyKey,
      providerMessageId: "synthetic-message-0001",
      state: "delivered",
      occurredAt: now,
    }).ok,
    false,
  );
});

test("uncertain acceptance reconciles to submitted by stable provider identity", () => {
  const claim = claimQueuedIntent(intent, "claim-token-001", now, claimExpiry);
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  const uncertain = recordProviderOutcomeUnknown(claim.value, "claim-token-001", now);
  assert.equal(uncertain.ok, true);
  if (!uncertain.ok) return;
  const reconciled = reconcileUncertainIntent(uncertain.value, {
    providerMessageId: "synthetic-message-0001",
    state: "accepted",
  });
  assert.equal(reconciled.ok, true);
  if (reconciled.ok) assert.equal(reconciled.value.state, "submitted");
});
