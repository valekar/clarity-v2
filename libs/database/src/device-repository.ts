import { Pool, type QueryResultRow } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_POOL_CONNECTIONS = 4;

export type DeviceCredential = Readonly<{
  deviceId: string;
  sourceId: string;
  verifier: Uint8Array;
  status: "paired" | "revoked";
  version: string;
  sourceStatus: "active" | "disabled";
  leaseDeviceId: string | null;
  fencingToken: string;
  leaseExpiresAt: Date | null;
  generation: string;
}>;

export type DeviceAdminRepository = Readonly<{
  createPairing(
    input: Readonly<{
      actorUserId: string;
      sourceId: string;
      pairingId: string;
      verifier: Uint8Array;
      expiresAt: Date;
    }>,
  ): Promise<string>;
  revokeDevice(
    input: Readonly<{
      actorUserId: string;
      deviceId: string;
      expectedVersion: string;
    }>,
  ): Promise<boolean>;
  close(): Promise<void>;
}>;

export type DeviceAuthRepository = Readonly<{
  findDeviceCredential(deviceId: string): Promise<DeviceCredential | null>;
  consumePairing(
    input: Readonly<{
      verifier: Uint8Array;
      deviceId: string;
      displayName: string;
      deviceVerifier: Uint8Array;
    }>,
  ): Promise<Readonly<{ deviceId: string; sourceId: string }>>;
  acquireLease(
    input: Readonly<{
      sourceId: string;
      deviceId: string;
      expiresAt: Date;
    }>,
  ): Promise<Readonly<{ sourceGeneration: string; fencingToken: string; leaseExpiresAt: Date }>>;
  releaseLease(
    input: Readonly<{
      sourceId: string;
      deviceId: string;
      fencingToken: string;
    }>,
  ): Promise<boolean>;
  reportHealth(
    input: Readonly<{
      sourceId: string;
      deviceId: string;
      sourceGeneration: string;
      fencingToken: string;
      sourceReachable: boolean;
      syncState: "idle" | "syncing" | "attention";
      lastErrorCode:
        "orthanc_unavailable" | "low_spool_space" | "source_changed" | "sync_failed" | null;
      queuedStudies: number;
      queuedUploads: number;
      spoolFreeBytes: number | null;
      spoolCapacityBytes: number | null;
      lastSuccessfulSyncAt: Date | null;
    }>,
  ): Promise<Date>;
  close(): Promise<void>;
}>;

export type DevicePoolOptions = Readonly<{
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  queryTimeoutMs?: number;
}>;

type CredentialRow = QueryResultRow & {
  device_id: unknown;
  source_id: unknown;
  verifier: unknown;
  device_status: unknown;
  version: unknown;
  source_status: unknown;
  lease_device_id: unknown;
  fencing_token: unknown;
  lease_expires_at: unknown;
  generation: unknown;
};

function uuid(name: string, value: string): string {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a UUID.`);
  return value.toLowerCase();
}

function verifier(name: string, value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError(`${name} must be a 32-byte verifier.`);
  }
  return Buffer.from(value);
}

function requiredText(name: string, value: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function mapCredential(row: CredentialRow): DeviceCredential {
  if (
    typeof row.device_id !== "string" ||
    typeof row.source_id !== "string" ||
    !Buffer.isBuffer(row.verifier) ||
    !["paired", "revoked"].includes(String(row.device_status)) ||
    (typeof row.version !== "string" && typeof row.version !== "number") ||
    !["active", "disabled"].includes(String(row.source_status)) ||
    (row.lease_device_id !== null && typeof row.lease_device_id !== "string") ||
    (typeof row.fencing_token !== "string" && typeof row.fencing_token !== "number") ||
    !(row.lease_expires_at === null || row.lease_expires_at instanceof Date) ||
    (typeof row.generation !== "string" && typeof row.generation !== "number")
  ) {
    throw new Error("Device credential query returned an invalid row.");
  }
  return Object.freeze({
    deviceId: row.device_id,
    sourceId: row.source_id,
    verifier: Buffer.from(row.verifier),
    status: row.device_status as "paired" | "revoked",
    version: String(row.version),
    sourceStatus: row.source_status as "active" | "disabled",
    leaseDeviceId: row.lease_device_id,
    fencingToken: String(row.fencing_token),
    leaseExpiresAt: row.lease_expires_at,
    generation: String(row.generation),
  });
}

export function createDevicePool(options: DevicePoolOptions): Pool {
  if (typeof options.connectionString !== "string" || options.connectionString.trim() === "") {
    throw new TypeError("PostgreSQL connection string is required.");
  }
  const max = options.maxConnections ?? 2;
  const connectionTimeoutMillis = options.connectionTimeoutMs ?? 2_000;
  const idleTimeoutMillis = options.idleTimeoutMs ?? 10_000;
  const query_timeout = options.queryTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_POOL_CONNECTIONS) {
    throw new TypeError("Device-auth pool maxConnections must be from 1 through 4.");
  }
  for (const [name, value, limit] of [
    ["connectionTimeoutMs", connectionTimeoutMillis, 5_000],
    ["idleTimeoutMs", idleTimeoutMillis, 30_000],
    ["queryTimeoutMs", query_timeout, 5_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) {
      throw new TypeError(`${name} is outside its allowed bound.`);
    }
  }
  return new Pool({
    connectionString: options.connectionString,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    query_timeout,
    application_name: "clarity-v2-device-auth",
  });
}

function createDeviceRepositoryOperations(
  pool: Pool,
): DeviceAdminRepository & DeviceAuthRepository {
  return {
    async findDeviceCredential(deviceId) {
      const result = await pool.query<CredentialRow>({
        text: `
          SELECT d.id AS device_id, d.source_id, d.credential_verifier AS verifier,
                 d.status AS device_status, d.version,
                 s.status AS source_status, s.lease_device_id,
                 s.current_fencing_token AS fencing_token, s.lease_expires_at, s.generation
            FROM public.device_installations d
            JOIN public.orthanc_sources s ON s.id = d.source_id
           WHERE d.id = $1
           LIMIT 2
        `,
        values: [uuid("Device ID", deviceId)],
      });
      if (result.rows.length > 1) throw new Error("Device credential lookup was ambiguous.");
      return result.rows[0] ? mapCredential(result.rows[0]) : null;
    },

    async createPairing(input) {
      const result = await pool.query<{ pairing_id: unknown } & QueryResultRow>({
        text: "SELECT public.create_source_pairing($1, $2, $3, $4, $5) AS pairing_id",
        values: [
          uuid("Actor ID", input.actorUserId),
          uuid("Source ID", input.sourceId),
          uuid("Pairing ID", input.pairingId),
          verifier("Pairing verifier", input.verifier),
          input.expiresAt,
        ],
      });
      const id = result.rows[0]?.pairing_id;
      if (typeof id !== "string") throw new Error("Pairing creation returned an invalid ID.");
      return id;
    },

    async consumePairing(input) {
      const result = await pool.query<
        {
          device_id: unknown;
          source_id: unknown;
        } & QueryResultRow
      >({
        text: "SELECT * FROM public.consume_source_pairing($1, $2, $3, $4)",
        values: [
          verifier("Pairing verifier", input.verifier),
          uuid("Device ID", input.deviceId),
          requiredText("Device name", input.displayName, 120).trim(),
          verifier("Device verifier", input.deviceVerifier),
        ],
      });
      const row = result.rows[0];
      if (!row || typeof row.device_id !== "string" || typeof row.source_id !== "string") {
        throw new Error("Pairing consumption returned an invalid result.");
      }
      return Object.freeze({
        deviceId: row.device_id,
        sourceId: row.source_id,
      });
    },

    async revokeDevice(input) {
      const result = await pool.query<{ revoked: unknown } & QueryResultRow>({
        text: "SELECT public.revoke_source_device($1, $2, $3::bigint) AS revoked",
        values: [
          uuid("Actor ID", input.actorUserId),
          uuid("Device ID", input.deviceId),
          requiredText("Expected device version", input.expectedVersion, 20),
        ],
      });
      if (typeof result.rows[0]?.revoked !== "boolean") {
        throw new Error("Device revocation returned an invalid result.");
      }
      return result.rows[0].revoked;
    },

    async acquireLease(input) {
      const result = await pool.query<
        {
          source_generation: unknown;
          fencing_token: unknown;
          lease_expires_at: unknown;
        } & QueryResultRow
      >({
        text: "SELECT * FROM public.acquire_device_source_lease($1, $2, $3)",
        values: [
          uuid("Source ID", input.sourceId),
          uuid("Device ID", input.deviceId),
          input.expiresAt,
        ],
      });
      const row = result.rows[0];
      if (
        !row ||
        (typeof row.source_generation !== "string" && typeof row.source_generation !== "number") ||
        (typeof row.fencing_token !== "string" && typeof row.fencing_token !== "number") ||
        !(row.lease_expires_at instanceof Date)
      )
        throw new Error("Lease acquisition returned an invalid cloud fence.");
      return Object.freeze({
        sourceGeneration: String(row.source_generation),
        fencingToken: String(row.fencing_token),
        leaseExpiresAt: row.lease_expires_at,
      });
    },

    async releaseLease(input) {
      const result = await pool.query<{ released: unknown } & QueryResultRow>({
        text: "SELECT public.release_source_lease($1, $2, $3::bigint) AS released",
        values: [
          uuid("Source ID", input.sourceId),
          uuid("Device ID", input.deviceId),
          requiredText("Fencing token", input.fencingToken, 20),
        ],
      });
      if (typeof result.rows[0]?.released !== "boolean") {
        throw new Error("Lease release returned an invalid result.");
      }
      return result.rows[0].released;
    },

    async reportHealth(input) {
      const result = await pool.query<{ reported_at: unknown } & QueryResultRow>({
        text: `SELECT public.record_source_health(
          $1, $2, $3::bigint, $4::bigint, $5, $6, $7, $8, $9,
          $10::bigint, $11::bigint, $12
        ) AS reported_at`,
        values: [
          uuid("Source ID", input.sourceId),
          uuid("Device ID", input.deviceId),
          requiredText("Source generation", input.sourceGeneration, 20),
          requiredText("Fencing token", input.fencingToken, 20),
          input.sourceReachable,
          input.syncState,
          input.lastErrorCode,
          input.queuedStudies,
          input.queuedUploads,
          input.spoolFreeBytes,
          input.spoolCapacityBytes,
          input.lastSuccessfulSyncAt,
        ],
      });
      const reportedAt = result.rows[0]?.reported_at;
      if (!(reportedAt instanceof Date)) throw new Error("Health report returned an invalid time.");
      return reportedAt;
    },

    async close() {
      await pool.end();
    },
  };
}

export function createDeviceAdminRepository(pool: Pool): DeviceAdminRepository {
  const operations = createDeviceRepositoryOperations(pool);
  return Object.freeze({
    createPairing: operations.createPairing,
    revokeDevice: operations.revokeDevice,
    close: operations.close,
  });
}

export function createDeviceAuthRepository(pool: Pool): DeviceAuthRepository {
  const operations = createDeviceRepositoryOperations(pool);
  return Object.freeze({
    findDeviceCredential: operations.findDeviceCredential,
    consumePairing: operations.consumePairing,
    acquireLease: operations.acquireLease,
    releaseLease: operations.releaseLease,
    reportHealth: operations.reportHealth,
    close: operations.close,
  });
}
