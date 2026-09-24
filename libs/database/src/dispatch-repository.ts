import { Pool, type QueryResultRow } from "pg";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const phoneE164 = /^\+[1-9][0-9]{7,14}$/;
const callbackId = /^[A-Za-z0-9_-]{8,128}$/;
const sha256 = /^[a-f0-9]{64}$/;

export type PrepareShareDispatchInput = Readonly<{
  dispatchId: string;
  idempotencyKey: string;
  reportId: string;
  expectedReportVersion: number;
  expectedManifestRevision: number;
  actorStaffUserId: string;
  patientPhoneE164: string | null;
  doctorId: string | null;
  expectedDoctorVersion: number | null;
}>;

export type PreparedShareDispatch = Readonly<{
  dispatchId: string;
  state: "blocked_policy";
  recipientCount: number;
}>;

export type DispatchOutboxState = "queued" | "submitted" | "delivered" | "failed" | "uncertain";

export type ClaimedDispatch = Readonly<{
  outboxId: string;
  idempotencyKey: string;
  destinationPhoneE164: string;
  messageText: string;
  attemptCount: number;
  claimExpiresAt: string;
}>;

export type DispatchPreparationRepository = Readonly<{
  /**
   * Persist an immutable recipient selection. The current migration always
   * returns blocked_policy and never writes a message or link.
   */
  prepare(input: PrepareShareDispatchInput): Promise<PreparedShareDispatch>;
  close(): Promise<void>;
}>;

export type DispatchDeliveryRepository = Readonly<{
  /** A database role with reviewed delivery-function grants is required. */
  claim(claimToken: string, claimSeconds: number): Promise<ClaimedDispatch | null>;
  recordOutcome(
    input: Readonly<{
      outboxId: string;
      claimToken: string;
      outcome: "accepted" | "unknown" | "rejected";
      providerMessageId: string | null;
      errorCode: string | null;
    }>,
  ): Promise<DispatchOutboxState>;
  reconcile(idempotencyKey: string, providerMessageId: string | null): Promise<DispatchOutboxState>;
  applyVerifiedCallback(
    input: Readonly<{
      eventId: string;
      idempotencyKey: string;
      providerMessageId: string;
      state: "submitted" | "delivered" | "failed";
      occurredAt: string;
      payloadSha256: string;
    }>,
  ): Promise<DispatchOutboxState>;
  close(): Promise<void>;
}>;

type PreparedRow = QueryResultRow & {
  out_dispatch_id: unknown;
  out_state: unknown;
  out_recipient_count: unknown;
};

type ClaimRow = QueryResultRow & {
  outbox_id: unknown;
  idempotency_key: unknown;
  destination_phone_e164: unknown;
  message_text: unknown;
  attempt_count: unknown;
  claim_expires_at: unknown;
};

type StateRow = QueryResultRow & { state: unknown };

function assertUuid(value: string, field: string): void {
  if (!uuid.test(value)) throw new TypeError(`${field} must be a UUID.`);
}

function state(row: StateRow | undefined): DispatchOutboxState {
  if (
    !row ||
    (row.state !== "queued" &&
      row.state !== "submitted" &&
      row.state !== "delivered" &&
      row.state !== "failed" &&
      row.state !== "uncertain")
  ) {
    throw new Error("Dispatch repository returned an invalid state.");
  }
  return row.state;
}

function claimed(row: ClaimRow): ClaimedDispatch {
  const expiry =
    row.claim_expires_at instanceof Date
      ? row.claim_expires_at.toISOString()
      : typeof row.claim_expires_at === "string"
        ? row.claim_expires_at
        : null;
  if (
    typeof row.outbox_id !== "string" ||
    typeof row.idempotency_key !== "string" ||
    typeof row.destination_phone_e164 !== "string" ||
    !phoneE164.test(row.destination_phone_e164) ||
    typeof row.message_text !== "string" ||
    row.message_text.trim().length === 0 ||
    row.message_text.length > 2_000 ||
    !Number.isSafeInteger(Number(row.attempt_count)) ||
    !expiry ||
    Number.isNaN(Date.parse(expiry))
  ) {
    throw new Error("Dispatch repository returned an invalid claimed row.");
  }
  return Object.freeze({
    outboxId: row.outbox_id,
    idempotencyKey: row.idempotency_key,
    destinationPhoneE164: row.destination_phone_e164,
    messageText: row.message_text,
    attemptCount: Number(row.attempt_count),
    claimExpiresAt: expiry,
  });
}

/** Use only from a future staff-authorized service boundary; no web grant exists yet. */
export function createDispatchPreparationRepository(pool: Pool): DispatchPreparationRepository {
  return Object.freeze({
    async prepare(input): Promise<PreparedShareDispatch> {
      assertUuid(input.dispatchId, "Dispatch ID");
      assertUuid(input.idempotencyKey, "Dispatch idempotency key");
      assertUuid(input.reportId, "Report ID");
      assertUuid(input.actorStaffUserId, "Actor ID");
      if (
        !Number.isSafeInteger(input.expectedReportVersion) ||
        input.expectedReportVersion < 1 ||
        !Number.isSafeInteger(input.expectedManifestRevision) ||
        input.expectedManifestRevision < 1 ||
        (input.patientPhoneE164 !== null && !phoneE164.test(input.patientPhoneE164)) ||
        (input.doctorId !== null && !uuid.test(input.doctorId)) ||
        (input.expectedDoctorVersion !== null &&
          (!Number.isSafeInteger(input.expectedDoctorVersion) ||
            input.expectedDoctorVersion < 1)) ||
        (input.doctorId === null) !== (input.expectedDoctorVersion === null) ||
        (input.patientPhoneE164 === null && input.doctorId === null)
      ) {
        throw new TypeError("Invalid dispatch snapshot request.");
      }
      const result = await pool.query<PreparedRow>(
        `SELECT out_dispatch_id, out_state, out_recipient_count
           FROM public.create_share_dispatch($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          input.dispatchId,
          input.idempotencyKey,
          input.reportId,
          input.expectedReportVersion,
          input.expectedManifestRevision,
          input.actorStaffUserId,
          input.patientPhoneE164 !== null,
          input.patientPhoneE164,
          input.doctorId !== null,
          input.doctorId,
          input.expectedDoctorVersion,
        ],
      );
      const row = result.rows[0];
      if (
        !row ||
        typeof row.out_dispatch_id !== "string" ||
        row.out_state !== "blocked_policy" ||
        !Number.isSafeInteger(Number(row.out_recipient_count)) ||
        Number(row.out_recipient_count) < 0
      ) {
        throw new Error("Dispatch repository returned an invalid prepared result.");
      }
      return Object.freeze({
        dispatchId: row.out_dispatch_id,
        state: "blocked_policy",
        recipientCount: Number(row.out_recipient_count),
      });
    },

    close: async () => pool.end(),
  });
}

/** Separate interface/pool from staff preparation; grants are intentionally absent today. */
export function createDispatchDeliveryRepository(pool: Pool): DispatchDeliveryRepository {
  return Object.freeze({
    async claim(claimToken, claimSeconds): Promise<ClaimedDispatch | null> {
      assertUuid(claimToken, "Claim token");
      if (!Number.isSafeInteger(claimSeconds) || claimSeconds < 1 || claimSeconds > 300) {
        throw new TypeError("Claim duration must be between 1 and 300 seconds.");
      }
      const result = await pool.query<ClaimRow>(
        `SELECT outbox_id, idempotency_key, destination_phone_e164, message_text,
                attempt_count, claim_expires_at
           FROM public.claim_dispatch_outbox($1,$2)`,
        [claimToken, claimSeconds],
      );
      return result.rows[0] ? claimed(result.rows[0]) : null;
    },

    async recordOutcome(input): Promise<DispatchOutboxState> {
      assertUuid(input.outboxId, "Outbox ID");
      assertUuid(input.claimToken, "Claim token");
      if (
        input.providerMessageId !== null &&
        (input.providerMessageId.trim().length === 0 || input.providerMessageId.length > 200)
      )
        throw new TypeError("Provider message ID is invalid.");
      if (input.errorCode !== null && !/^[a-z0-9_]{1,64}$/.test(input.errorCode)) {
        throw new TypeError("Provider error code is invalid.");
      }
      const result = await pool.query<StateRow>(
        `SELECT public.record_dispatch_provider_outcome($1,$2,$3,$4,$5) AS state`,
        [input.outboxId, input.claimToken, input.outcome, input.providerMessageId, input.errorCode],
      );
      return state(result.rows[0]);
    },

    async reconcile(idempotencyKey, providerMessageId): Promise<DispatchOutboxState> {
      assertUuid(idempotencyKey, "Dispatch idempotency key");
      if (
        providerMessageId !== null &&
        (providerMessageId.trim().length === 0 || providerMessageId.length > 200)
      ) {
        throw new TypeError("Provider message ID is invalid.");
      }
      const result = await pool.query<StateRow>(
        `SELECT public.reconcile_dispatch_outbox($1,$2) AS state`,
        [idempotencyKey, providerMessageId],
      );
      return state(result.rows[0]);
    },

    async applyVerifiedCallback(input): Promise<DispatchOutboxState> {
      if (!callbackId.test(input.eventId)) throw new TypeError("Callback event ID is invalid.");
      assertUuid(input.idempotencyKey, "Dispatch idempotency key");
      if (
        input.providerMessageId.trim().length === 0 ||
        input.providerMessageId.length > 200 ||
        !sha256.test(input.payloadSha256) ||
        Number.isNaN(Date.parse(input.occurredAt))
      )
        throw new TypeError("Verified callback fields are invalid.");
      const result = await pool.query<StateRow>(
        `SELECT public.apply_dispatch_provider_callback($1,$2,$3,$4,$5,$6) AS state`,
        [
          input.eventId,
          input.idempotencyKey,
          input.providerMessageId,
          input.state,
          input.occurredAt,
          input.payloadSha256,
        ],
      );
      return state(result.rows[0]);
    },

    close: async () => pool.end(),
  });
}

/** Explicitly bounded pool constructor; use separate DB URLs/roles for each API. */
export function createDispatchPool(connectionString: string): Pool {
  if (!connectionString.trim()) throw new Error("Dispatch database URL is required.");
  return new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 5_000,
  });
}
