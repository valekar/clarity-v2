import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderOutcomeUnknownError,
  SyntheticMessageProvider,
} from "../src/synthetic-provider.ts";

test("uncertain acceptance is reconciled before any retry and duplicate send is idempotent", async () => {
  const provider = new SyntheticMessageProvider();
  const intent = {
    idempotencyKey: "synthetic-intent-001",
    destinationPhoneE164: "+919876543210",
    messageText: "Synthetic report link for a test recipient",
  };
  provider.loseReplyAfterNextAcceptance();
  await assert.rejects(provider.send(intent), ProviderOutcomeUnknownError);
  const recovered = await provider.reconcile(intent.idempotencyKey);
  assert.equal(recovered?.state, "accepted");
  assert.deepEqual(await provider.send(intent), recovered);
  await assert.rejects(provider.send({ ...intent, messageText: "Changed content" }));
  assert.equal(await provider.reconcile("unknown-intent"), null);
});
