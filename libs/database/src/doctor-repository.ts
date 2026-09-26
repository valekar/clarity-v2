import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  decideDoctorCreation,
  doctorIdentityName,
  normalizeDoctorName,
  validIndianMobileE164,
  type DoctorRecord,
} from "@clarity/domain/doctors";

export type CreateDoctorResult =
  | Readonly<{ outcome: "created" | "reused"; doctor: DoctorRecord }>
  | Readonly<{ outcome: "inactive_exact_match"; doctor: DoctorRecord }>
  | Readonly<{ outcome: "confirm_shared_phone"; matches: readonly DoctorRecord[] }>;

export type DoctorRepository = Readonly<{
  search(query: string, limit?: number): Promise<readonly DoctorRecord[]>;
  findById(id: string): Promise<DoctorRecord | null>;
  create(
    input: Readonly<{
      displayName: string;
      phoneE164: string;
      confirmedSharedPhone: boolean;
      actorStaffUserId: string;
    }>,
  ): Promise<CreateDoctorResult>;
  close(): Promise<void>;
}>;

type DoctorRow = QueryResultRow & {
  id: unknown;
  display_name: unknown;
  normalized_name: unknown;
  phone_e164: unknown;
  active: unknown;
  version: unknown;
};

const fields = "id, display_name, normalized_name, phone_e164, active, version";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(row: DoctorRow): DoctorRecord {
  if (
    typeof row.id !== "string" ||
    typeof row.display_name !== "string" ||
    typeof row.normalized_name !== "string" ||
    typeof row.phone_e164 !== "string" ||
    typeof row.active !== "boolean" ||
    !Number.isSafeInteger(Number(row.version))
  ) {
    throw new Error("Doctor query returned an invalid row.");
  }
  return Object.freeze({
    id: row.id,
    displayName: row.display_name,
    normalizedName: row.normalized_name,
    phoneE164: row.phone_e164,
    active: row.active,
    version: Number(row.version),
  });
}

async function exactAndShared(client: PoolClient, normalizedName: string, phoneE164: string) {
  const exactRows = await client.query<DoctorRow>(
    `SELECT ${fields} FROM public.doctors WHERE phone_e164 = $1 AND normalized_name = $2`,
    [phoneE164, normalizedName],
  );
  const sharedRows = await client.query<DoctorRow>(
    `SELECT ${fields} FROM public.doctors WHERE phone_e164 = $1 AND normalized_name <> $2
       ORDER BY normalized_name, id LIMIT 20`,
    [phoneE164, normalizedName],
  );
  return {
    exact: exactRows.rows[0] ? record(exactRows.rows[0]) : null,
    shared: sharedRows.rows.map(record),
  };
}

export function createDoctorPool(connectionString: string): Pool {
  if (!connectionString.trim()) throw new Error("Doctor database URL is required.");
  return new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 5_000,
  });
}

export function createDoctorRepository(pool: Pool): DoctorRepository {
  return Object.freeze({
    async search(query: string, limit = 20): Promise<readonly DoctorRecord[]> {
      const normalized = doctorIdentityName(query);
      const phoneQuery = normalized.replace(/[\s()-]/g, "");
      if (
        normalized.length > 80 ||
        /[\x00-\x1f\x7f]/.test(normalized) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 50
      ) {
        throw new TypeError("Invalid doctor search.");
      }
      const rows = await pool.query<DoctorRow>(
        `SELECT ${fields} FROM public.doctors
          WHERE active AND ($1 = '' OR position($1 in normalized_name) > 0 OR position($2 in phone_e164) > 0)
          ORDER BY normalized_name, id LIMIT $3`,
        [normalized, phoneQuery, limit],
      );
      return rows.rows.map(record);
    },

    async findById(id: string): Promise<DoctorRecord | null> {
      if (!uuid.test(id)) throw new TypeError("Invalid doctor ID.");
      const rows = await pool.query<DoctorRow>(
        `SELECT ${fields} FROM public.doctors WHERE id = $1`,
        [id],
      );
      return rows.rows[0] ? record(rows.rows[0]) : null;
    },

    async create(input): Promise<CreateDoctorResult> {
      const displayName = normalizeDoctorName(input.displayName);
      const normalizedName = doctorIdentityName(displayName);
      if (
        !displayName ||
        displayName.length > 160 ||
        /[\x00-\x1f\x7f]/.test(displayName) ||
        !validIndianMobileE164(input.phoneE164) ||
        !uuid.test(input.actorStaffUserId)
      ) {
        throw new TypeError("Invalid doctor details.");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const actor = await client.query<{ allowed: boolean }>(
          "SELECT public.require_active_doctor_staff($1) AS allowed",
          [input.actorStaffUserId],
        );
        if (actor.rows[0]?.allowed !== true) {
          throw Object.assign(new Error("Staff access is inactive."), { code: "42501" });
        }
        // Serializes names sharing one phone, including concurrent first inserts.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          input.phoneE164,
        ]);
        const matches = await exactAndShared(client, normalizedName, input.phoneE164);
        const decision = decideDoctorCreation({
          normalizedName,
          phoneE164: input.phoneE164,
          confirmedSharedPhone: input.confirmedSharedPhone,
          exactMatch: matches.exact,
          sharedPhoneMatches: matches.shared,
        });
        if (decision.outcome !== "create") {
          await client.query("COMMIT");
          if (decision.outcome === "reuse") return { outcome: "reused", doctor: decision.doctor };
          return decision;
        }
        const inserted = await client.query<DoctorRow>(
          `SELECT ${fields} FROM public.insert_doctor_record($1, $2, $3, $4, $5)`,
          [randomUUID(), displayName, normalizedName, input.phoneE164, input.actorStaffUserId],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("Doctor insert returned no row.");
        await client.query("COMMIT");
        return { outcome: "created", doctor: record(row) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  });
}
