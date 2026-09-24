import assert from "node:assert/strict";
import test from "node:test";
import {
  createDispatchWorker,
  type DispatchClaim,
  type DispatchWorkerStore,
} from "../src/worker.ts";
import { SyntheticMessageProvider } from "../src/synthetic-provider.ts";

class DurableStore implements DispatchWorkerStore {
  readonly queued: DispatchClaim[] = [];
  readonly uncertainKeys = new Set<string>();
  readonly states = new Map<string, string>();
  private readonly claimed = new Map<string, DispatchClaim>();
  async claim(): Promise<DispatchClaim | null> {
    const next = this.queued.shift() ?? null;
    if (next) this.claimed.set(next.outboxId, next);
    return next;
  }
  async recordOutcome(
    input: Parameters<DispatchWorkerStore["recordOutcome"]>[0],
  ): Promise<"submitted" | "uncertain"> {
    const state = input.outcome === "accepted" ? "submitted" : "uncertain";
    this.states.set(input.outboxId, state);
    const item = this.claimed.get(input.outboxId);
    if (state === "uncertain" && item) this.uncertainKeys.add(item.idempotencyKey);
    return state;
  }
  async listUncertain(limit: number): Promise<readonly { idempotencyKey: string }[]> {
    return [...this.uncertainKeys].slice(0, limit).map((idempotencyKey) => ({ idempotencyKey }));
  }
  async reconcile(
    key: string,
    providerMessageId: string | null,
  ): Promise<"submitted" | "uncertain"> {
    if (!providerMessageId) return "uncertain";
    this.uncertainKeys.delete(key);
    return "submitted";
  }
}

function claim(id: string): DispatchClaim {
  return {
    outboxId: id,
    idempotencyKey: `intent-key-${id}`,
    destinationPhoneE164: "+919876543210",
    messageText: "Synthetic only",
    attemptCount: 1,
    claimExpiresAt: "2026-09-24T00:01:00.000Z",
  };
}

test("a recreated worker reconciles lost acceptance before claiming more work", async () => {
  const store = new DurableStore();
  const provider = new SyntheticMessageProvider();
  store.queued.push(claim("outbox-0001"));
  provider.loseReplyAfterNextAcceptance();
  const makeWorker = () =>
    createDispatchWorker({
      store,
      transport: provider,
      nextClaimToken: () => "claim-token-0001",
      maxWorkPerTick: 3,
      claimSeconds: 30,
    });
  const first = await makeWorker().tick();
  assert.deepEqual(first, { claimed: 1, submitted: 0, uncertain: 1, reconciled: 0, busy: false });
  assert.equal(store.states.get("outbox-0001"), "uncertain");

  const restarted = await makeWorker().tick();
  assert.deepEqual(restarted, {
    claimed: 0,
    submitted: 1,
    uncertain: 0,
    reconciled: 1,
    busy: false,
  });
  assert.equal(store.states.get("outbox-0001"), "uncertain");
  assert.equal(
    await provider.reconcile("intent-key-outbox-0001").then((receipt) => receipt?.state),
    "accepted",
  );
  await assert.rejects(
    provider.send({
      idempotencyKey: "intent-key-outbox-0001",
      destinationPhoneE164: "+919876543210",
      messageText: "changed",
    }),
  );
});

test("tick bounds total reconciliation plus claims and prevents overlapping runs", async () => {
  const store = new DurableStore();
  for (let index = 0; index < 5; index += 1)
    store.queued.push(claim(`outbox-${String(index).padStart(4, "0")}`));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = new SyntheticMessageProvider();
  const blockedTransport = {
    send: async (intent: Parameters<typeof provider.send>[0]) => {
      await gate;
      return provider.send(intent);
    },
    reconcile: (key: string) => provider.reconcile(key),
  };
  const worker = createDispatchWorker({
    store,
    transport: blockedTransport,
    nextClaimToken: () => "claim-token-0001",
    maxWorkPerTick: 2,
    claimSeconds: 30,
  });
  const firstTick = worker.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await worker.tick()).busy, true);
  release();
  assert.equal((await firstTick).claimed, 2);
  assert.equal(store.queued.length, 3);
});

test("transport exceptions never become automatic resend authorization", async () => {
  const store = new DurableStore();
  store.queued.push(claim("outbox-0002"));
  const provider = new SyntheticMessageProvider();
  provider.loseReplyAfterNextAcceptance();
  const worker = createDispatchWorker({
    store,
    transport: provider,
    nextClaimToken: () => "claim-token-0002",
    maxWorkPerTick: 1,
    claimSeconds: 30,
  });
  assert.equal((await worker.tick()).uncertain, 1);
  assert.equal(store.queued.length, 0);
});
