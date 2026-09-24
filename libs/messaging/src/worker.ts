import type { ProviderReceipt } from "./outbox.ts";
import type { DeliveryIntent } from "./synthetic-provider.ts";

export type DispatchClaim = Readonly<{
  outboxId: string;
  idempotencyKey: string;
  destinationPhoneE164: string;
  messageText: string;
  attemptCount: number;
  claimExpiresAt: string;
}>;

export type DispatchWorkerStore = Readonly<{
  claim(claimToken: string, claimSeconds: number): Promise<DispatchClaim | null>;
  recordOutcome(
    input: Readonly<{
      outboxId: string;
      claimToken: string;
      outcome: "accepted" | "unknown";
      providerMessageId: string | null;
      errorCode: string | null;
    }>,
  ): Promise<"submitted" | "uncertain">;
  listUncertain(limit: number): Promise<readonly Readonly<{ idempotencyKey: string }>[]>;
  reconcile(
    idempotencyKey: string,
    providerMessageId: string | null,
  ): Promise<"submitted" | "uncertain">;
}>;

export type DispatchTransport = Readonly<{
  send(intent: DeliveryIntent): Promise<ProviderReceipt>;
  reconcile(idempotencyKey: string): Promise<ProviderReceipt | null>;
}>;

export type DispatchTickResult = Readonly<{
  claimed: number;
  submitted: number;
  uncertain: number;
  reconciled: number;
  busy: boolean;
}>;

/**
 * Creates a manually scheduled, single-flight tick. All effects and claim IDs
 * are injected; callers choose a scheduler and a delivery-role repository.
 * The cap applies to the combined reconcile and claim work for each tick.
 */
export function createDispatchWorker(
  input: Readonly<{
    store: DispatchWorkerStore;
    transport: DispatchTransport;
    nextClaimToken: () => string;
    maxWorkPerTick: number;
    claimSeconds: number;
  }>,
): Readonly<{ tick(): Promise<DispatchTickResult> }> {
  if (
    !Number.isSafeInteger(input.maxWorkPerTick) ||
    input.maxWorkPerTick < 1 ||
    input.maxWorkPerTick > 100
  ) {
    throw new TypeError("Dispatch tick work limit must be between 1 and 100.");
  }
  if (
    !Number.isSafeInteger(input.claimSeconds) ||
    input.claimSeconds < 1 ||
    input.claimSeconds > 300
  ) {
    throw new TypeError("Dispatch claim duration must be between 1 and 300 seconds.");
  }
  let running = false;
  let reconcileFirstWhenSingleSlot = true;

  async function reconcilePending(limit: number): Promise<{ reconciled: number; submitted: number; uncertain: number }> {
    const pending = await input.store.listUncertain(limit);
    let reconciled = 0;
    let submitted = 0;
    let uncertain = 0;
    for (const item of pending.slice(0, limit)) {
      const receipt = await input.transport.reconcile(item.idempotencyKey);
      const state = await input.store.reconcile(item.idempotencyKey, receipt?.providerMessageId ?? null);
      reconciled += 1;
      if (state === "submitted") submitted += 1;
      else uncertain += 1;
    }
    return { reconciled, submitted, uncertain };
  }

  async function claimOne(): Promise<{ claimed: number; submitted: number; uncertain: number }> {
    const claimToken = input.nextClaimToken();
    const item = await input.store.claim(claimToken, input.claimSeconds);
    if (!item) return { claimed: 0, submitted: 0, uncertain: 0 };
    try {
      const receipt = await input.transport.send({
        idempotencyKey: item.idempotencyKey,
        destinationPhoneE164: item.destinationPhoneE164,
        messageText: item.messageText,
      });
      const state = await input.store.recordOutcome({
        outboxId: item.outboxId,
        claimToken,
        outcome: "accepted",
        providerMessageId: receipt.providerMessageId,
        errorCode: null,
      });
      return { claimed: 1, submitted: state === "submitted" ? 1 : 0, uncertain: state === "uncertain" ? 1 : 0 };
    } catch {
      // A transport exception cannot prove rejection; persist uncertainty.
      const state = await input.store.recordOutcome({
        outboxId: item.outboxId,
        claimToken,
        outcome: "unknown",
        providerMessageId: null,
        errorCode: "provider_outcome_unknown",
      });
      return { claimed: 1, submitted: state === "submitted" ? 1 : 0, uncertain: state === "uncertain" ? 1 : 0 };
    }
  }

  return Object.freeze({
    async tick(): Promise<DispatchTickResult> {
      if (running)
        return Object.freeze({ claimed: 0, submitted: 0, uncertain: 0, reconciled: 0, busy: true });
      running = true;
      let claimed = 0;
      let submitted = 0;
      let uncertain = 0;
      let reconciled = 0;
      try {
        if (input.maxWorkPerTick === 1) {
          const reconcileFirst = reconcileFirstWhenSingleSlot;
          reconcileFirstWhenSingleSlot = !reconcileFirstWhenSingleSlot;
          if (reconcileFirst) {
            const result = await reconcilePending(1);
            reconciled += result.reconciled;
            submitted += result.submitted;
            uncertain += result.uncertain;
            if (reconciled === 0) {
              const result = await claimOne();
              claimed += result.claimed;
              submitted += result.submitted;
              uncertain += result.uncertain;
            }
          } else {
            const result = await claimOne();
            claimed += result.claimed;
            submitted += result.submitted;
            uncertain += result.uncertain;
          }
          return Object.freeze({ claimed, submitted, uncertain, reconciled, busy: false });
        }

        // Reserve one slot for fresh work so a persistent uncertain backlog
        // cannot consume every tick's entire budget.
        const reconciliationBudget = input.maxWorkPerTick - 1;
        const reconciliation = await reconcilePending(reconciliationBudget);
        reconciled += reconciliation.reconciled;
        submitted += reconciliation.submitted;
        uncertain += reconciliation.uncertain;
        let remaining = input.maxWorkPerTick - reconciled;
        while (remaining > 0) {
          const result = await claimOne();
          if (result.claimed === 0) break;
          claimed += result.claimed;
          remaining -= 1;
          submitted += result.submitted;
          uncertain += result.uncertain;
        }
        return Object.freeze({ claimed, submitted, uncertain, reconciled, busy: false });
      } finally {
        running = false;
      }
    },
  });
}
