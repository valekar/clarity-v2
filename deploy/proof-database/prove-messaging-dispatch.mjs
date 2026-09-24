#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
if (!process.env.PGDATABASE?.startsWith("clarity_v2_")) {
  throw new Error("Set PGDATABASE to an isolated clarity_v2_* database.");
}

const databaseRequire = createRequire(resolve(repositoryRoot, "libs/database/package.json"));
const { Pool } = databaseRequire("pg");
const databaseRepository = await import(
  pathToFileURL(resolve(repositoryRoot, "libs/database/dist/dispatch-repository.js"))
);
const messagingDirectory = resolve(repositoryRoot, "libs/messaging/dist");
const [
  { createDispatchWorker },
  { SyntheticMessageProvider },
  { handleProviderCallback },
  { signSyntheticCallback },
] = await Promise.all([
  import(pathToFileURL(resolve(messagingDirectory, "worker.js"))),
  import(pathToFileURL(resolve(messagingDirectory, "synthetic-provider.js"))),
  import(pathToFileURL(resolve(messagingDirectory, "callback-handler.js"))),
  import(pathToFileURL(resolve(messagingDirectory, "signed-callback.js"))),
]);

const pool = new Pool({ max: 1, connectionTimeoutMillis: 5_000 });
const client = await pool.connect();
const dispatchId = "92000000-0000-4000-8000-000000000011";
const secondDispatchId = "92000000-0000-4000-8000-000000000012";
const idempotencyKey = "93000000-0000-4000-8000-000000000011";
const actorId = "90000000-0000-4000-8000-000000000011";
const claimToken = "94000000-0000-4000-8000-000000000011";
const authorizationRef = "95000000-0000-4000-8000-000000000011";
const eventId = "synthetic-dispatch-event-0011";
const patientPhone = "+919876543210";
const reportId = "40000000-0000-4000-8000-000000000001";

try {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO public.staff_users (id, display_name, active)
     VALUES ($1, 'Synthetic Dispatch Proof', true)`,
    [actorId],
  );
  await client.query(
    `INSERT INTO public.staff_memberships (staff_user_id, role, status)
     VALUES ($1, 'admin', 'active')`,
    [actorId],
  );

  const reportResult = await client.query(
    `SELECT version, current_manifest_revision
       FROM public.reports WHERE id = $1`,
    [reportId],
  );
  const report = reportResult.rows[0];
  assert.ok(report, "synthetic Ready Report fixture is required");
  assert.ok(Number(report.current_manifest_revision) > 0);

  const preparation = databaseRepository.createDispatchPreparationRepository(client);
  const prepared = await preparation.prepare({
    dispatchId,
    idempotencyKey,
    reportId,
    expectedReportVersion: Number(report.version),
    expectedManifestRevision: Number(report.current_manifest_revision),
    actorStaffUserId: actorId,
    patientPhoneE164: patientPhone,
    doctorId: null,
    expectedDoctorVersion: null,
  });
  assert.equal(prepared.state, "blocked_policy");
  assert.equal(prepared.recipientCount, 1);

  const blocked = await preparation.prepare({
    dispatchId: secondDispatchId,
    idempotencyKey: "93000000-0000-4000-8000-000000000012",
    reportId,
    expectedReportVersion: Number(report.version),
    expectedManifestRevision: Number(report.current_manifest_revision),
    actorStaffUserId: actorId,
    patientPhoneE164: patientPhone,
    doctorId: null,
    expectedDoctorVersion: null,
  });
  assert.equal(blocked.state, "blocked_policy");

  const outboxResult = await client.query(
    `SELECT id, idempotency_key, state FROM public.dispatch_outbox
      WHERE dispatch_id = $1`,
    [dispatchId],
  );
  assert.equal(outboxResult.rows.length, 1);
  const outbox = outboxResult.rows[0];
  assert.equal(outbox.state, "blocked_policy");
  const outboxIdempotencyKey = outbox.idempotency_key;
  assert.equal(typeof outboxIdempotencyKey, "string");

  // This transaction-local activation is a synthetic fixture only. The real
  // create_share_dispatch function continues to create blocked_policy rows.
  const activated = await client.query(
    `UPDATE public.dispatch_outbox
        SET state = 'queued', authorization_ref = $2,
            message_text = 'Synthetic proof only; no share link or delivery.'
      WHERE id = $1 AND state = 'blocked_policy'
      RETURNING id`,
    [outbox.id, authorizationRef],
  );
  assert.equal(activated.rows.length, 1);

  const repository = databaseRepository.createDispatchDeliveryRepository(client);
  const store = databaseRepository.createDispatchWorkerStore(repository);
  const provider = new SyntheticMessageProvider();
  provider.loseReplyAfterNextAcceptance();
  const worker = createDispatchWorker({
    store,
    transport: provider,
    nextClaimToken: () => claimToken,
    maxWorkPerTick: 2,
    claimSeconds: 60,
  });

  const firstTick = await worker.tick();
  assert.deepEqual(firstTick, {
    claimed: 1,
    submitted: 0,
    uncertain: 1,
    reconciled: 0,
    busy: false,
  });
  const uncertain = await client.query(
    `SELECT state, provider_message_id FROM public.dispatch_outbox WHERE id = $1`,
    [outbox.id],
  );
  assert.equal(uncertain.rows[0]?.state, "uncertain");
  assert.equal(uncertain.rows[0]?.provider_message_id, null);

  const secondTick = await worker.tick();
  assert.equal(secondTick.reconciled, 1);
  assert.equal(secondTick.submitted, 1);
  assert.equal(secondTick.claimed, 0);
  const submitted = await client.query(
    `SELECT state, provider_message_id FROM public.dispatch_outbox WHERE id = $1`,
    [outbox.id],
  );
  assert.equal(submitted.rows[0]?.state, "submitted");
  const providerMessageId = submitted.rows[0]?.provider_message_id;
  assert.equal(typeof providerMessageId, "string");

  const timestamp = new Date().toISOString();
  const secret = "synthetic-callback-secret-for-disposable-proof";
  const rawBody = JSON.stringify({
    eventId,
    idempotencyKey: outboxIdempotencyKey,
    providerMessageId,
    state: "delivered",
    occurredAt: timestamp,
  });
  const signature = signSyntheticCallback(secret, timestamp, rawBody);
  const callbackInput = { store: repository, secret, signature, timestamp, rawBody };
  const callback = await handleProviderCallback(callbackInput);
  const duplicateCallback = await handleProviderCallback(callbackInput);
  assert.deepEqual(callback, { ok: true, state: "delivered" });
  assert.deepEqual(duplicateCallback, { ok: true, state: "delivered" });

  const finalRows = await client.query(
    `SELECT o.state, d.state AS dispatch_state,
            (SELECT count(*) FROM public.dispatch_callback_events e WHERE e.event_id = $1) AS callback_count
       FROM public.dispatch_outbox o
       JOIN public.share_dispatches d ON d.id = o.dispatch_id
      WHERE o.id = $2`,
    [eventId, outbox.id],
  );
  assert.equal(finalRows.rows[0]?.state, "delivered");
  assert.equal(finalRows.rows[0]?.dispatch_state, "blocked_policy");
  assert.equal(Number(finalRows.rows[0]?.callback_count), 1);
  const remainingPolicyRows = await client.query(
    `SELECT state, authorization_ref, message_text, attempt_count
       FROM public.dispatch_outbox WHERE dispatch_id = $1`,
    [secondDispatchId],
  );
  assert.equal(remainingPolicyRows.rows[0]?.state, "blocked_policy");
  assert.equal(remainingPolicyRows.rows[0]?.authorization_ref, null);
  assert.equal(remainingPolicyRows.rows[0]?.message_text, null);
  assert.equal(Number(remainingPolicyRows.rows[0]?.attempt_count), 0);

  const grants = await client.query(
    `SELECT has_function_privilege('clarity_v2_runtime', 'public.claim_dispatch_outbox(uuid,integer)', 'EXECUTE')
              OR has_function_privilege('clarity_v2_worker', 'public.claim_dispatch_outbox(uuid,integer)', 'EXECUTE')
              OR has_function_privilege('clarity_v2_device_auth_login', 'public.claim_dispatch_outbox(uuid,integer)', 'EXECUTE')
              OR EXISTS (
                SELECT 1 FROM pg_proc p
                CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a
                WHERE p.oid='public.claim_dispatch_outbox(uuid,integer)'::regprocedure
                  AND a.grantee=0 AND a.privilege_type='EXECUTE'
              ) AS has_delivery_grant`,
  );
  assert.equal(grants.rows[0]?.has_delivery_grant, false);
  await client.query("ROLLBACK");
  console.log(
    "Synthetic PostgreSQL worker/reconciliation/callback proof passed; fixture rolled back.",
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
