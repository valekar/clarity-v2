import type { Pool, QueryResultRow } from "pg";

export type SourceHealthItem = Readonly<{
  sourceId: string;
  sourceName: string;
  sourceReachable: boolean | null;
  syncState: "idle" | "syncing" | "attention" | null;
  lastErrorCode: string | null;
  queuedStudies: number;
  queuedUploads: number;
  spoolFreeBytes: number | null;
  spoolCapacityBytes: number | null;
  lastSuccessfulSyncAt: string | null;
  reportedAt: string | null;
}>;

type Row = QueryResultRow & {
  source_id: unknown;
  source_name: unknown;
  source_reachable: unknown;
  sync_state: unknown;
  last_error_code: unknown;
  queued_studies: unknown;
  queued_uploads: unknown;
  spool_free_bytes: unknown;
  spool_capacity_bytes: unknown;
  last_successful_sync_at: unknown;
  reported_at: unknown;
};

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError("Staff user ID must be a UUID.");
  }
  return value.toLowerCase();
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error("Health query returned an invalid count.");
  return number;
}

function dateString(value: unknown): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new Error("Health query returned an invalid timestamp.");
  return value.toISOString();
}

function map(row: Row): SourceHealthItem {
  if (
    typeof row.source_id !== "string" ||
    typeof row.source_name !== "string" ||
    !(row.source_reachable === null || typeof row.source_reachable === "boolean") ||
    !(
      row.sync_state === null || ["idle", "syncing", "attention"].includes(String(row.sync_state))
    ) ||
    !(row.last_error_code === null || typeof row.last_error_code === "string")
  )
    throw new Error("Health query returned an invalid source row.");
  const queuedStudies = nullableNumber(row.queued_studies) ?? 0;
  const queuedUploads = nullableNumber(row.queued_uploads) ?? 0;
  return Object.freeze({
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceReachable: row.source_reachable,
    syncState: row.sync_state as SourceHealthItem["syncState"],
    lastErrorCode: row.last_error_code,
    queuedStudies,
    queuedUploads,
    spoolFreeBytes: nullableNumber(row.spool_free_bytes),
    spoolCapacityBytes: nullableNumber(row.spool_capacity_bytes),
    lastSuccessfulSyncAt: dateString(row.last_successful_sync_at),
    reportedAt: dateString(row.reported_at),
  });
}

export function createSourceHealthRepository(pool: Pool) {
  return Object.freeze({
    async listForStaff(staffUserId: string): Promise<readonly SourceHealthItem[]> {
      const result = await pool.query<Row>({
        text: "SELECT * FROM public.read_source_health($1)",
        values: [uuid(staffUserId)],
      });
      if (result.rows.length > 100) throw new Error("Health query exceeded its source bound.");
      return Object.freeze(result.rows.map(map));
    },
  });
}
