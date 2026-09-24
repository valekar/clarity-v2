import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  createDispatchDeliveryRepository,
  createDispatchPreparationRepository,
  createDispatchWorkerStore,
} from "../src/dispatch-repository.ts";

function fakePool(responseRows: readonly unknown[] = []) {
  const calls: Array<Readonly<{ text: string; values?: readonly unknown[] }>> = [];
  const pool = {
    async query(text: string, values?: readonly unknown[]) {
      calls.push({ text, values });
      return { rows: responseRows };
    },
    async end() {},
  } as unknown as Pool;
  return { pool, calls };
}

const dispatchInput = {
  dispatchId: "92000000-0000-4000-8000-000000000001",
  idempotencyKey: "93000000-0000-4000-8000-000000000001",
  reportId: "40000000-0000-4000-8000-000000000001",
  expectedReportVersion: 4,
  expectedManifestRevision: 2,
  actorStaffUserId: "90000000-0000-4000-8000-000000000001",
  patientPhoneE164: "+919876543210",
  doctorId: "91000000-0000-4000-8000-000000000001",
  expectedDoctorVersion: 1,
};

test("dispatch preparation calls only the immutable snapshot function", async () => {
  const { pool, calls } = fakePool([
    {
      out_dispatch_id: dispatchInput.dispatchId,
      out_state: "blocked_policy",
      out_recipient_count: 2,
    },
  ]);
  const repository = createDispatchPreparationRepository(pool);
  assert.deepEqual(await repository.prepare(dispatchInput), {
    dispatchId: dispatchInput.dispatchId,
    state: "blocked_policy",
    recipientCount: 2,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /create_share_dispatch/);
  assert.deepEqual(calls[0]!.values, [
    dispatchInput.dispatchId,
    dispatchInput.idempotencyKey,
    dispatchInput.reportId,
    4,
    2,
    dispatchInput.actorStaffUserId,
    true,
    "+919876543210",
    true,
    dispatchInput.doctorId,
    1,
  ]);
});

test("dispatch preparation rejects malformed phone before database access", async () => {
  const { pool, calls } = fakePool();
  const repository = createDispatchPreparationRepository(pool);
  await assert.rejects(
    repository.prepare({ ...dispatchInput, patientPhoneE164: "+abc" }),
    TypeError,
  );
  assert.equal(calls.length, 0);
});

test("delivery role adapter keeps claim, callback and reconciliation calls narrow", async () => {
  const { pool, calls } = fakePool([
    {
      outbox_id: "96000000-0000-4000-8000-000000000001",
      idempotency_key: "93000000-0000-4000-8000-000000000001",
      destination_phone_e164: "+919876543210",
      message_text: "Synthetic message",
      attempt_count: 1,
      claim_expires_at: "2026-09-23T12:01:00.000Z",
    },
  ]);
  const repository = createDispatchDeliveryRepository(pool);
  const result = await repository.claim("94000000-0000-4000-8000-000000000001", 60);
  assert.equal(result?.attemptCount, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /claim_dispatch_outbox/);
  assert.doesNotMatch(calls[0]!.text, /SELECT.+dispatch_outbox\b/i);
});

test("uncertain listing calls the bounded rotation function and validates returned keys", async () => {
  const key = "93000000-0000-4000-8000-000000000001";
  const { pool, calls } = fakePool([{ idempotency_key: key }]);
  const repository = createDispatchDeliveryRepository(pool);
  assert.deepEqual(await repository.listUncertain(20), [{ idempotencyKey: key }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /list_uncertain_dispatch_outbox/);
  assert.deepEqual(calls[0]!.values, [20]);
});

test("uncertain listing rejects unbounded limits and malformed repository rows", async () => {
  const { pool, calls } = fakePool([{ idempotency_key: "not-a-uuid" }]);
  const repository = createDispatchDeliveryRepository(pool);
  await assert.rejects(repository.listUncertain(101), TypeError);
  assert.equal(calls.length, 0);
  await assert.rejects(repository.listUncertain(1), /invalid uncertain key/);
  assert.equal(calls.length, 1);
});

test("worker adapter narrows unexpected database delivery states", async () => {
  const { pool } = fakePool([{ state: "failed" }]);
  const repository = createDispatchDeliveryRepository(pool);
  const workerStore = createDispatchWorkerStore(repository);
  await assert.rejects(
    workerStore.recordOutcome({
      outboxId: "96000000-0000-4000-8000-000000000001",
      claimToken: "94000000-0000-4000-8000-000000000001",
      outcome: "unknown",
      providerMessageId: null,
      errorCode: "synthetic_rejection",
    }),
    /unsupported state/,
  );
  await assert.rejects(
    workerStore.reconcile("93000000-0000-4000-8000-000000000001", null),
    /unsupported state/,
  );
});
