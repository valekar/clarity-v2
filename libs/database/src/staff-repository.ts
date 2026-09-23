import { Pool, type QueryResultRow } from "pg";

export type StaffRole = "admin" | "staff";
export type StaffMembershipStatus = "active" | "disabled";

export type HankoStaffIdentity = Readonly<{
  issuer: string;
  subject: string;
}>;

export type CurrentStaffAccess = Readonly<{
  staffUserId: string;
  active: boolean;
  membership: Readonly<{
    role: StaffRole;
    status: StaffMembershipStatus;
    version: string;
  }> | null;
}>;

export type StaffDirectoryEntry = CurrentStaffAccess & Readonly<{ displayName: string }>;
export type StaffDirectoryPage = Readonly<{
  entries: readonly StaffDirectoryEntry[];
  nextCursor: string | null;
}>;

export type StaffRepository = Readonly<{
  findCurrentByHankoIdentity(identity: HankoStaffIdentity): Promise<CurrentStaffAccess | null>;
  findStaffUserById(staffUserId: string): Promise<StaffDirectoryEntry | null>;
  listStaffUsers(input: Readonly<{ limit: number; afterId?: string }>): Promise<StaffDirectoryPage>;
  enrollPendingHankoIdentity(
    input: Readonly<{
      staffUserId: string;
      identityId: string;
      displayName: string;
      issuer: string;
      subject: string;
    }>,
  ): Promise<string>;
  changeMembership(
    input: Readonly<{
      actorUserId: string;
      targetUserId: string;
      expectedVersion: string | number;
      role: StaffRole;
      status: StaffMembershipStatus;
    }>,
  ): Promise<boolean>;
  changeUserActive(
    input: Readonly<{
      actorUserId: string;
      targetUserId: string;
      expectedVersion: string | number;
      expectedActive: boolean;
      active: boolean;
    }>,
  ): Promise<boolean>;
  close(): Promise<void>;
}>;

export type StaffPoolOptions = Readonly<{
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  queryTimeoutMs?: number;
}>;

const MAX_POOL_CONNECTIONS = 8;
const MAX_CONNECTION_TIMEOUT_MS = 5_000;
const MAX_IDLE_TIMEOUT_MS = 30_000;
const MAX_QUERY_TIMEOUT_MS = 5_000;
const IDENTITY_SQL = `
  SELECT u.id AS staff_user_id, u.active,
         m.role, m.status, m.version
    FROM public.staff_identities i
    JOIN public.staff_users u ON u.id = i.staff_user_id
    LEFT JOIN public.staff_memberships m ON m.staff_user_id = u.id
   WHERE i.provider = 'hanko' AND i.issuer = $1 AND i.subject = $2
   LIMIT 2
`;
const STAFF_DIRECTORY_SQL = `
  SELECT u.id AS staff_user_id, u.display_name, u.active,
         m.role, m.status, m.version
    FROM public.staff_users u
    LEFT JOIN public.staff_memberships m ON m.staff_user_id = u.id
   WHERE ($1::uuid IS NULL OR u.id > $1::uuid)
   ORDER BY u.id
   LIMIT $2
`;
const STAFF_BY_ID_SQL = `
  SELECT u.id AS staff_user_id, u.display_name, u.active,
         m.role, m.status, m.version
    FROM public.staff_users u
    LEFT JOIN public.staff_memberships m ON m.staff_user_id = u.id
   WHERE u.id = $1
`;

type IdentityRow = QueryResultRow & {
  staff_user_id: unknown;
  active: unknown;
  role: unknown;
  status: unknown;
  version: unknown;
};
type DirectoryRow = IdentityRow & { display_name: unknown };

function boundedInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function requiredText(name: string, value: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function mapIdentityRow(row: IdentityRow): CurrentStaffAccess {
  if (typeof row.staff_user_id !== "string" || typeof row.active !== "boolean") {
    throw new Error("Staff identity query returned an invalid row.");
  }
  if (row.role === null && row.status === null && row.version === null) {
    return Object.freeze({ staffUserId: row.staff_user_id, active: row.active, membership: null });
  }
  if (
    (row.role !== "admin" && row.role !== "staff") ||
    (row.status !== "active" && row.status !== "disabled") ||
    (typeof row.version !== "string" && typeof row.version !== "number")
  ) {
    throw new Error("Staff identity query returned invalid membership state.");
  }
  return Object.freeze({
    staffUserId: row.staff_user_id,
    active: row.active,
    membership: Object.freeze({
      role: row.role,
      status: row.status,
      version: String(row.version),
    }),
  });
}

function mapDirectoryRow(row: DirectoryRow): StaffDirectoryEntry {
  if (typeof row.display_name !== "string")
    throw new Error("Staff directory query returned an invalid row.");
  return Object.freeze({ ...mapIdentityRow(row), displayName: row.display_name });
}

export function createStaffPool(options: StaffPoolOptions): Pool {
  if (typeof options.connectionString !== "string" || options.connectionString.trim() === "") {
    throw new TypeError("PostgreSQL connection string is required.");
  }
  const max = boundedInteger("maxConnections", options.maxConnections ?? 4, MAX_POOL_CONNECTIONS);
  const connectionTimeoutMillis = boundedInteger(
    "connectionTimeoutMs",
    options.connectionTimeoutMs ?? 2_000,
    MAX_CONNECTION_TIMEOUT_MS,
  );
  const idleTimeoutMillis = boundedInteger(
    "idleTimeoutMs",
    options.idleTimeoutMs ?? 10_000,
    MAX_IDLE_TIMEOUT_MS,
  );
  const query_timeout = boundedInteger(
    "queryTimeoutMs",
    options.queryTimeoutMs ?? 2_000,
    MAX_QUERY_TIMEOUT_MS,
  );
  return new Pool({
    connectionString: options.connectionString,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    query_timeout,
    application_name: "clarity-v2-server",
  });
}

export function createStaffRepository(pool: Pool): StaffRepository {
  return Object.freeze({
    async findCurrentByHankoIdentity(
      identity: HankoStaffIdentity,
    ): Promise<CurrentStaffAccess | null> {
      const issuer = requiredText("Hanko issuer", identity.issuer, 2_048);
      const subject = requiredText("Hanko subject", identity.subject, 512);
      const result = await pool.query<IdentityRow>({
        text: IDENTITY_SQL,
        values: [issuer, subject],
      });
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1)
        throw new Error("Hanko identity resolved to multiple staff users.");
      return mapIdentityRow(result.rows[0]!);
    },

    async findStaffUserById(staffUserId: string): Promise<StaffDirectoryEntry | null> {
      const result = await pool.query<DirectoryRow>({
        text: STAFF_BY_ID_SQL,
        values: [requiredText("Staff user ID", staffUserId, 64)],
      });
      return result.rows[0] ? mapDirectoryRow(result.rows[0]) : null;
    },

    async listStaffUsers(input): Promise<StaffDirectoryPage> {
      const limit = boundedInteger("directory limit", input.limit, 100);
      const result = await pool.query<DirectoryRow>({
        text: STAFF_DIRECTORY_SQL,
        values: [input.afterId ? requiredText("Staff cursor", input.afterId, 64) : null, limit + 1],
      });
      const hasMore = result.rows.length > limit;
      const entries = result.rows.slice(0, limit).map(mapDirectoryRow);
      return Object.freeze({
        entries: Object.freeze(entries),
        nextCursor: hasMore ? (entries[entries.length - 1]?.staffUserId ?? null) : null,
      });
    },

    async enrollPendingHankoIdentity(input): Promise<string> {
      const result = await pool.query<{ staff_user_id: unknown } & QueryResultRow>({
        text: "SELECT public.enroll_pending_hanko_identity($1, $2, $3, $4, $5) AS staff_user_id",
        values: [
          requiredText("Staff user ID", input.staffUserId, 64),
          requiredText("Hanko identity ID", input.identityId, 64),
          requiredText("Display name", input.displayName, 320),
          requiredText("Hanko issuer", input.issuer, 2_048),
          requiredText("Hanko subject", input.subject, 512),
        ],
      });
      const staffUserId = result.rows[0]?.staff_user_id;
      if (typeof staffUserId !== "string")
        throw new Error("Identity enrollment returned an invalid staff user ID.");
      return staffUserId;
    },

    async changeMembership(input): Promise<boolean> {
      if (
        !Number.isSafeInteger(Number(input.expectedVersion)) ||
        Number(input.expectedVersion) < 0
      ) {
        throw new TypeError("Expected membership version is invalid.");
      }
      const result = await pool.query<{ changed: unknown } & QueryResultRow>({
        text: "SELECT public.change_staff_membership($1, $2, $3, $4, $5) AS changed",
        values: [
          input.actorUserId,
          input.targetUserId,
          input.expectedVersion,
          input.role,
          input.status,
        ],
      });
      if (typeof result.rows[0]?.changed !== "boolean")
        throw new Error("Membership change returned an invalid result.");
      return result.rows[0].changed;
    },

    async changeUserActive(input): Promise<boolean> {
      if (
        !Number.isSafeInteger(Number(input.expectedVersion)) ||
        Number(input.expectedVersion) < 1
      ) {
        throw new TypeError("Expected membership version is invalid.");
      }
      const result = await pool.query<{ changed: unknown } & QueryResultRow>({
        text: "SELECT public.change_staff_user_active($1, $2, $3, $4, $5) AS changed",
        values: [
          input.actorUserId,
          input.targetUserId,
          input.expectedVersion,
          input.expectedActive,
          input.active,
        ],
      });
      if (typeof result.rows[0]?.changed !== "boolean")
        throw new Error("User active change returned an invalid result.");
      return result.rows[0].changed;
    },

    close: () => pool.end(),
  });
}
