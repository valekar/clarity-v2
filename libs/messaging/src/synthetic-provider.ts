import { createHash } from "node:crypto";

export type DeliveryIntent = Readonly<{
  idempotencyKey: string;
  destinationPhoneE164: string;
  messageText: string;
}>;

export type ProviderReceipt = Readonly<{
  providerMessageId: string;
  state: "accepted";
}>;

export class ProviderOutcomeUnknownError extends Error {
  constructor() {
    super("Provider acceptance is uncertain; reconcile before retrying.");
  }
}

export class SyntheticMessageProvider {
  private readonly accepted = new Map<
    string,
    Readonly<{ fingerprint: string; receipt: ProviderReceipt }>
  >();
  private loseNextAcceptanceReply = false;

  loseReplyAfterNextAcceptance(): void {
    this.loseNextAcceptanceReply = true;
  }

  async send(intent: DeliveryIntent): Promise<ProviderReceipt> {
    if (
      !/^[a-zA-Z0-9_-]{8,128}$/.test(intent.idempotencyKey) ||
      !/^\+[1-9][0-9]{7,14}$/.test(intent.destinationPhoneE164) ||
      !intent.messageText.trim() ||
      intent.messageText.length > 2_000
    ) {
      throw new TypeError("Invalid synthetic delivery intent.");
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([intent.destinationPhoneE164, intent.messageText]))
      .digest("hex");
    const prior = this.accepted.get(intent.idempotencyKey);
    if (prior && prior.fingerprint !== fingerprint) {
      throw new Error("Delivery idempotency key was reused for different content.");
    }
    const receipt =
      prior?.receipt ??
      Object.freeze({
        providerMessageId: `synthetic-${createHash("sha256").update(intent.idempotencyKey).digest("hex").slice(0, 32)}`,
        state: "accepted" as const,
      });
    this.accepted.set(intent.idempotencyKey, { fingerprint, receipt });
    if (this.loseNextAcceptanceReply) {
      this.loseNextAcceptanceReply = false;
      throw new ProviderOutcomeUnknownError();
    }
    return receipt;
  }

  async reconcile(idempotencyKey: string): Promise<ProviderReceipt | null> {
    return this.accepted.get(idempotencyKey)?.receipt ?? null;
  }
}
