import type { Pool, QueryResultRow } from "pg";

export type StudyStatus = "discovered" | "syncing" | "processing" | "ready" | "needs_attention";

export type StudySummary = Readonly<{
  reportId: string;
  studyInstanceUid: string;
  patientId: string | null;
  patientName: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  accessionNumber: string | null;
  modalities: readonly string[];
  status: StudyStatus;
  sourceStatus: "active" | "disabled";
  currentRevision: number | null;
  memberCount: number;
  indexedCount: number;
  updatedAt: string;
  canView: boolean;
}>;

export type StudyPage = Readonly<{
  items: readonly StudySummary[];
  nextCursor: string | null;
}>;

export type ViewableStudy = Readonly<{
  reportId: string;
  sourceId: string;
  orthancStudyId: string;
  studyInstanceUid: string;
  patientName: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  modalities: readonly string[];
}>;

type Cursor = Readonly<{ createdAt: string; reportId: string }>;

type StudyRow = QueryResultRow & {
  report_id: unknown;
  source_id: unknown;
  orthanc_study_id: unknown;
  study_instance_uid: unknown;
  patient_id: unknown;
  patient_name: unknown;
  study_date: unknown;
  study_description: unknown;
  accession_number: unknown;
  modalities: unknown;
  state: unknown;
  source_status: unknown;
  current_manifest_revision: unknown;
  member_count: unknown;
  indexed_count: unknown;
  updated_at: unknown;
  created_at: unknown;
  manifest_is_valid: unknown;
};

const REPORTS_SQL = `
  SELECT r.id AS report_id, r.study_instance_uid, r.patient_id, r.patient_name,
         r.study_date, r.study_description, r.accession_number, r.modalities,
         r.state, s.status AS source_status, r.current_manifest_revision,
         coalesce(manifest.member_count, 0)::int AS member_count,
         coalesce(manifest.indexed_count, 0)::int AS indexed_count,
         r.updated_at, r.created_at,
         (b.state = 'sealed' AND p.source_stable AND p.inventory_complete
           AND p.source_generation = s.generation
           AND coalesce(manifest.member_count, 0) > 0
           AND manifest.member_count = manifest.indexed_count
           AND NOT r.has_unresolved_conflict) AS manifest_is_valid
    FROM public.reports r
    JOIN public.orthanc_sources s ON s.id = r.source_id
    JOIN public.staff_users u ON u.id = $1 AND u.active
    JOIN public.staff_memberships m ON m.staff_user_id = u.id
                                    AND m.status = 'active'
    LEFT JOIN public.ingestion_batches b
      ON b.report_id = r.id AND b.source_id = r.source_id
     AND b.revision = r.current_manifest_revision
    LEFT JOIN public.report_manifest_proofs p
      ON p.report_id = r.id AND p.source_id = r.source_id
     AND p.revision = r.current_manifest_revision
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS member_count,
             count(*) FILTER (WHERE f.state = 'indexed'
                                AND f.cloud_orthanc_instance_id IS NOT NULL)::int AS indexed_count
        FROM public.ingestion_batch_files member
        LEFT JOIN public.report_files f
          ON f.report_id = member.report_id AND f.source_id = member.source_id
         AND f.sop_instance_uid = member.sop_instance_uid
         AND f.sha256 = member.sha256
       WHERE member.report_id = r.id AND member.source_id = r.source_id
         AND member.revision = r.current_manifest_revision
    ) manifest ON true
   WHERE ($2 = '' OR r.study_instance_uid ILIKE $2
          OR coalesce(r.patient_id, '') ILIKE $2
          OR coalesce(r.patient_name, '') ILIKE $2
          OR coalesce(r.accession_number, '') ILIKE $2
          OR coalesce(r.study_description, '') ILIKE $2)
     AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
   ORDER BY r.created_at DESC, r.id DESC
   LIMIT $5
`;

const VIEWABLE_STUDY_SQL = `
  SELECT r.id AS report_id, r.source_id, r.source_study_id AS orthanc_study_id,
         r.study_instance_uid, r.patient_name, r.study_date, r.study_description, r.modalities
    FROM public.reports r
    JOIN public.orthanc_sources s ON s.id = r.source_id
    JOIN public.staff_users u ON u.id = $1 AND u.active
    JOIN public.staff_memberships m ON m.staff_user_id = u.id AND m.status = 'active'
    JOIN public.ingestion_batches b
      ON b.report_id = r.id AND b.source_id = r.source_id
     AND b.revision = r.current_manifest_revision AND b.state = 'sealed'
    JOIN public.report_manifest_proofs p
      ON p.report_id = r.id AND p.source_id = r.source_id
     AND p.revision = r.current_manifest_revision
     AND p.source_generation = s.generation AND p.source_stable AND p.inventory_complete
   WHERE r.id = $2 AND r.state = 'ready' AND NOT r.has_unresolved_conflict
     AND EXISTS (
       SELECT 1 FROM public.ingestion_batch_files member
        WHERE member.report_id = r.id AND member.source_id = r.source_id
          AND member.revision = r.current_manifest_revision
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.ingestion_batch_files member
       LEFT JOIN public.report_files f
         ON f.report_id = member.report_id AND f.source_id = member.source_id
        AND f.sop_instance_uid = member.sop_instance_uid AND f.sha256 = member.sha256
       WHERE member.report_id = r.id AND member.source_id = r.source_id
         AND member.revision = r.current_manifest_revision
         AND (f.id IS NULL OR f.state <> 'indexed' OR f.cloud_orthanc_instance_id IS NULL)
     )
   LIMIT 2
`;

const VIEW_MEMBERSHIP_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM public.reports r
    JOIN public.staff_users u ON u.id = $1 AND u.active
    JOIN public.staff_memberships m ON m.staff_user_id = u.id AND m.status = 'active'
    JOIN public.ingestion_batches b
      ON b.report_id = r.id AND b.source_id = r.source_id
     AND b.revision = r.current_manifest_revision AND b.state = 'sealed'
    JOIN public.report_manifest_proofs p
      ON p.report_id = r.id AND p.source_id = r.source_id
     AND p.revision = r.current_manifest_revision
    JOIN public.orthanc_sources s ON s.id = r.source_id AND p.source_generation = s.generation
   WHERE r.id = $2 AND r.state = 'ready' AND NOT r.has_unresolved_conflict
     AND p.source_stable AND p.inventory_complete
     AND EXISTS (
       SELECT 1 FROM public.ingestion_batch_files member
        WHERE member.report_id = r.id AND member.source_id = r.source_id
          AND member.revision = r.current_manifest_revision
          AND ($3::text IS NULL OR EXISTS (
            SELECT 1 FROM public.report_files f WHERE f.report_id = r.id AND f.source_id = r.source_id
             AND f.series_instance_uid = $3 AND f.sop_instance_uid = member.sop_instance_uid
             AND f.sha256 = member.sha256 AND f.state = 'indexed'
             AND f.cloud_orthanc_instance_id IS NOT NULL
             AND ($4::text IS NULL OR f.sop_instance_uid = $4)
          ))
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.ingestion_batch_files member
       LEFT JOIN public.report_files f ON f.report_id = member.report_id
         AND f.source_id = member.source_id AND f.sop_instance_uid = member.sop_instance_uid
         AND f.sha256 = member.sha256
       WHERE member.report_id = r.id AND member.source_id = r.source_id
         AND member.revision = r.current_manifest_revision
         AND (f.id IS NULL OR f.state <> 'indexed' OR f.cloud_orthanc_instance_id IS NULL)
     )
  ) AS allowed
`;

const VIEWABLE_BY_STUDY_UID_SQL = VIEWABLE_STUDY_SQL.replace(
  "WHERE r.id = $2",
  "WHERE r.study_instance_uid = $2",
);

const VIEWABLE_MEMBERS_SQL = `
  SELECT f.series_instance_uid, f.sop_instance_uid
    FROM public.reports r
    JOIN public.staff_users u ON u.id = $1 AND u.active
    JOIN public.staff_memberships m ON m.staff_user_id = u.id AND m.status = 'active'
    JOIN public.ingestion_batches b ON b.report_id = r.id AND b.source_id = r.source_id
      AND b.revision = r.current_manifest_revision AND b.state = 'sealed'
    JOIN public.report_manifest_proofs p ON p.report_id = r.id AND p.source_id = r.source_id
      AND p.revision = r.current_manifest_revision
    JOIN public.orthanc_sources s ON s.id = r.source_id AND p.source_generation = s.generation
    JOIN public.ingestion_batch_files member ON member.report_id = r.id
      AND member.source_id = r.source_id AND member.revision = r.current_manifest_revision
    JOIN public.report_files f ON f.report_id = member.report_id AND f.source_id = member.source_id
      AND f.sop_instance_uid = member.sop_instance_uid AND f.sha256 = member.sha256
      AND f.state = 'indexed' AND f.cloud_orthanc_instance_id IS NOT NULL
   WHERE r.id = $2 AND r.state = 'ready' AND NOT r.has_unresolved_conflict
     AND p.source_stable AND p.inventory_complete
     AND EXISTS (SELECT 1 FROM public.ingestion_batch_files member
       WHERE member.report_id = r.id AND member.source_id = r.source_id
         AND member.revision = r.current_manifest_revision)
     AND NOT EXISTS (
       SELECT 1 FROM public.ingestion_batch_files member
       LEFT JOIN public.report_files exact_file ON exact_file.report_id = member.report_id
         AND exact_file.source_id = member.source_id
         AND exact_file.sop_instance_uid = member.sop_instance_uid AND exact_file.sha256 = member.sha256
       WHERE member.report_id = r.id AND member.source_id = r.source_id
         AND member.revision = r.current_manifest_revision
         AND (exact_file.id IS NULL OR exact_file.state <> 'indexed'
              OR exact_file.cloud_orthanc_instance_id IS NULL)
     )
   ORDER BY f.sop_instance_uid
   LIMIT 100001
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UID = /^[0-9]+(?:\.[0-9]+)*$/;

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined || value === "") return null;
  if (value.length > 512) throw new TypeError("Study page cursor is invalid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new TypeError("Study page cursor is invalid.");
  }
  if (!parsed || typeof parsed !== "object") throw new TypeError("Study page cursor is invalid.");
  const fields = parsed as Record<string, unknown>;
  if (
    typeof fields.createdAt !== "string" ||
    Number.isNaN(Date.parse(fields.createdAt)) ||
    typeof fields.reportId !== "string" ||
    !UUID.test(fields.reportId)
  )
    throw new TypeError("Study page cursor is invalid.");
  return { createdAt: new Date(fields.createdAt).toISOString(), reportId: fields.reportId };
}

function encodeCursor(row: StudyRow): string {
  const value = JSON.stringify({
    createdAt: new Date(String(row.created_at)).toISOString(),
    reportId: String(row.report_id),
  });
  return Buffer.from(value).toString("base64url");
}

function parseModalities(value: unknown): readonly string[] {
  if (typeof value !== "string") return Object.freeze([]);
  return Object.freeze(
    value
      .split(/[\\,\s]+/)
      .map((part) => part.trim().toUpperCase())
      .filter((part) => /^[A-Z0-9]{1,16}$/.test(part))
      .slice(0, 16),
  );
}

function mapSummary(row: StudyRow): StudySummary {
  const id = row.report_id;
  const state = row.state;
  const source = row.source_status;
  const revision = row.current_manifest_revision;
  const members = Number(row.member_count);
  const indexed = Number(row.indexed_count);
  if (
    typeof id !== "string" ||
    typeof row.study_instance_uid !== "string" ||
    !UID.test(row.study_instance_uid) ||
    !["discovered", "syncing", "processing", "ready", "needs_attention"].includes(String(state)) ||
    !["active", "disabled"].includes(String(source)) ||
    !Number.isSafeInteger(members) ||
    members < 0 ||
    !Number.isSafeInteger(indexed) ||
    indexed < 0 ||
    !(row.updated_at instanceof Date)
  )
    throw new Error("Study query returned an invalid row.");
  return Object.freeze({
    reportId: id,
    studyInstanceUid: row.study_instance_uid,
    patientId: typeof row.patient_id === "string" ? row.patient_id : null,
    patientName: typeof row.patient_name === "string" ? row.patient_name : null,
    studyDate: typeof row.study_date === "string" ? row.study_date : null,
    studyDescription: typeof row.study_description === "string" ? row.study_description : null,
    accessionNumber: typeof row.accession_number === "string" ? row.accession_number : null,
    modalities: parseModalities(row.modalities),
    status: state as StudyStatus,
    sourceStatus: source as "active" | "disabled",
    currentRevision: Number.isSafeInteger(Number(revision)) ? Number(revision) : null,
    memberCount: members,
    indexedCount: indexed,
    updatedAt: row.updated_at.toISOString(),
    canView: state === "ready" && row.manifest_is_valid === true,
  });
}

export type StaffStudyRepository = Readonly<{
  list(
    input: Readonly<{
      staffUserId: string;
      search?: string;
      cursor?: string;
      limit?: number;
    }>,
  ): Promise<StudyPage>;
  findViewableReport(staffUserId: string, reportId: string): Promise<ViewableStudy | null>;
  findViewableReportByStudyUid(
    staffUserId: string,
    studyInstanceUid: string,
  ): Promise<ViewableStudy | null>;
  listViewableMembers(
    staffUserId: string,
    reportId: string,
  ): Promise<
    | readonly Readonly<{
        seriesInstanceUid: string;
        sopInstanceUid: string;
      }>[]
    | null
  >;
  authorizeDicomwebRequest(
    input: Readonly<{
      staffUserId: string;
      reportId: string;
      seriesInstanceUid: string | null;
      sopInstanceUid: string | null;
    }>,
  ): Promise<boolean>;
}>;

export function createStaffStudyRepository(pool: Pool): StaffStudyRepository {
  return Object.freeze({
    async list(input): Promise<StudyPage> {
      if (!UUID.test(input.staffUserId)) throw new TypeError("Staff user ID is invalid.");
      const search = input.search?.trim() ?? "";
      if (search.length > 120) throw new TypeError("Study search is too long.");
      const limit = input.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError("Study page size is invalid.");
      }
      const cursor = decodeCursor(input.cursor);
      const escapedSearch = search.replace(/[\\%_]/g, "\\$&");
      const result = await pool.query<StudyRow>(REPORTS_SQL, [
        input.staffUserId,
        search ? `%${escapedSearch}%` : "",
        cursor?.createdAt ?? null,
        cursor?.reportId ?? null,
        limit + 1,
      ]);
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      return Object.freeze({
        items: Object.freeze(rows.map(mapSummary)),
        nextCursor: hasMore ? encodeCursor(rows[rows.length - 1]!) : null,
      });
    },

    async findViewableReport(staffUserId, reportId): Promise<ViewableStudy | null> {
      if (!UUID.test(staffUserId) || !UUID.test(reportId))
        throw new TypeError("Study identity is invalid.");
      const result = await pool.query<StudyRow>(VIEWABLE_STUDY_SQL, [staffUserId, reportId]);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error("A Report identity is not unique.");
      const row = result.rows[0]!;
      if (
        typeof row.report_id !== "string" ||
        typeof row.source_id !== "string" ||
        typeof row.orthanc_study_id !== "string" ||
        typeof row.study_instance_uid !== "string" ||
        !UID.test(row.study_instance_uid)
      )
        throw new Error("Viewable Report query returned an invalid row.");
      return Object.freeze({
        reportId: row.report_id,
        sourceId: row.source_id,
        orthancStudyId: row.orthanc_study_id,
        studyInstanceUid: row.study_instance_uid,
        patientName: typeof row.patient_name === "string" ? row.patient_name : null,
        studyDate: typeof row.study_date === "string" ? row.study_date : null,
        studyDescription: typeof row.study_description === "string" ? row.study_description : null,
        modalities: parseModalities(row.modalities),
      });
    },

    async findViewableReportByStudyUid(
      staffUserId,
      studyInstanceUid,
    ): Promise<ViewableStudy | null> {
      if (!UUID.test(staffUserId) || !UID.test(studyInstanceUid) || studyInstanceUid.length > 64) {
        throw new TypeError("Study identity is invalid.");
      }
      const result = await pool.query<StudyRow>(VIEWABLE_BY_STUDY_UID_SQL, [
        staffUserId,
        studyInstanceUid,
      ]);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error("A Study UID maps to multiple Reports.");
      const row = result.rows[0]!;
      if (
        typeof row.report_id !== "string" ||
        typeof row.source_id !== "string" ||
        typeof row.orthanc_study_id !== "string" ||
        typeof row.study_instance_uid !== "string"
      )
        throw new Error("Viewable Study query returned an invalid row.");
      return Object.freeze({
        reportId: row.report_id,
        sourceId: row.source_id,
        orthancStudyId: row.orthanc_study_id,
        studyInstanceUid: row.study_instance_uid,
        patientName: typeof row.patient_name === "string" ? row.patient_name : null,
        studyDate: typeof row.study_date === "string" ? row.study_date : null,
        studyDescription: typeof row.study_description === "string" ? row.study_description : null,
        modalities: parseModalities(row.modalities),
      });
    },

    async listViewableMembers(staffUserId, reportId) {
      if (!UUID.test(staffUserId) || !UUID.test(reportId))
        throw new TypeError("Report identity is invalid.");
      const result = await pool.query<
        {
          series_instance_uid: unknown;
          sop_instance_uid: unknown;
        } & QueryResultRow
      >(VIEWABLE_MEMBERS_SQL, [staffUserId, reportId]);
      if (result.rows.length > 100_000) return null;
      const members = result.rows.map((row) => {
        if (
          typeof row.series_instance_uid !== "string" ||
          !UID.test(row.series_instance_uid) ||
          typeof row.sop_instance_uid !== "string" ||
          !UID.test(row.sop_instance_uid)
        )
          throw new Error("Viewable manifest member query returned an invalid UID.");
        return Object.freeze({
          seriesInstanceUid: row.series_instance_uid,
          sopInstanceUid: row.sop_instance_uid,
        });
      });
      return Object.freeze(members);
    },

    async authorizeDicomwebRequest(input): Promise<boolean> {
      if (
        !UUID.test(input.staffUserId) ||
        !UUID.test(input.reportId) ||
        (input.seriesInstanceUid !== null && !UID.test(input.seriesInstanceUid)) ||
        (input.sopInstanceUid !== null && !UID.test(input.sopInstanceUid)) ||
        (input.sopInstanceUid !== null && input.seriesInstanceUid === null)
      )
        throw new TypeError("DICOMweb resource identity is invalid.");
      const result = await pool.query<{ allowed: unknown } & QueryResultRow>(VIEW_MEMBERSHIP_SQL, [
        input.staffUserId,
        input.reportId,
        input.seriesInstanceUid,
        input.sopInstanceUid,
      ]);
      return result.rows[0]?.allowed === true;
    },
  });
}
