import type { Pool } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UID = /^[0-9]+(?:\.[0-9]+)*$/;
const FENCE = /^[0-9]{1,19}$/;

export type StudyObservation = Readonly<{
  sourceId: string;
  deviceId: string;
  sourceGeneration: number;
  fencingToken: string;
  admissionKey: string;
  studyInstanceUid: string;
  orthancStudyId: string;
  patientId: string | null;
  patientIssuerOfPatientId: string | null;
  patientName: string | null;
  patientBirthDate: string | null;
  patientSex: string | null;
  studyDate: string | null;
  studyTime: string | null;
  studyDescription: string | null;
  accessionNumber: string | null;
  modalities: string | null;
}>;

export type StudyAdmission = Readonly<{
  reportId: string;
  studyInstanceUid: string;
  version: number;
  currentManifestRevision: number | null;
  currentManifestDigest: string | null;
  currentManifestGeneration: number | null;
}>;

export type CloudLease = Readonly<{
  sourceGeneration: number;
  fencingToken: string;
  leaseExpiresAt: string;
}>;

export type UploadRecord = Readonly<{
  uploadId: string;
  reportId: string;
  reportFileId: string;
  objectKey: string;
  expectedSha256: string;
  byteCount: number;
  status: "admitted" | "uploading" | "received" | "completed" | "aborted" | "expired";
  multipartUploadId: string | null;
  expiresAt: Date;
}>;

function mapUpload(row: Record<string, unknown> | undefined): UploadRecord {
  const byteCount = Number(row?.declared_size_bytes);
  const expiresAt = row?.expires_at;
  const status = row?.upload_status;
  if (
    typeof row?.upload_id !== "string" ||
    typeof row.report_id !== "string" ||
    typeof row.report_file_id !== "string" ||
    typeof row.object_key !== "string" ||
    typeof row.expected_sha256 !== "string" ||
    !Number.isSafeInteger(byteCount) ||
    byteCount < 1 ||
    !["admitted", "uploading", "received", "completed", "aborted", "expired"].includes(
      String(status),
    ) ||
    !(row.multipart_upload_id === null || typeof row.multipart_upload_id === "string") ||
    !(expiresAt instanceof Date) ||
    Number.isNaN(expiresAt.getTime())
  ) {
    throw new Error("Upload operation returned an invalid durable result.");
  }
  return Object.freeze({
    uploadId: row.upload_id,
    reportId: row.report_id,
    reportFileId: row.report_file_id,
    objectKey: row.object_key,
    expectedSha256: row.expected_sha256,
    byteCount,
    status: status as UploadRecord["status"],
    multipartUploadId: row.multipart_upload_id,
    expiresAt,
  });
}

function assertInput(input: StudyObservation): void {
  for (const [name, value] of [
    ["sourceId", input.sourceId],
    ["deviceId", input.deviceId],
    ["admissionKey", input.admissionKey],
  ] as const) {
    if (!UUID.test(value)) throw new TypeError(`${name} must be a UUID.`);
  }
  if (!Number.isSafeInteger(input.sourceGeneration) || input.sourceGeneration < 1) {
    throw new TypeError("Source generation must be a positive safe integer.");
  }
  if (!FENCE.test(input.fencingToken)) throw new TypeError("Fencing token is invalid.");
  if (!UID.test(input.studyInstanceUid) || input.studyInstanceUid.length > 64) {
    throw new TypeError("Study Instance UID is invalid.");
  }
  if (!input.orthancStudyId.trim() || input.orthancStudyId.length > 200) {
    throw new TypeError("Orthanc Study locator is invalid.");
  }
}

export function createIngestionRepository(pool: Pool) {
  return Object.freeze({
    async acquireLease(sourceId: string, deviceId: string, expiresAt: Date): Promise<CloudLease> {
      if (
        !UUID.test(sourceId) ||
        !UUID.test(deviceId) ||
        !(expiresAt instanceof Date) ||
        Number.isNaN(expiresAt.getTime())
      ) {
        throw new TypeError("Lease request is invalid.");
      }
      const result = await pool.query<{
        source_generation: unknown;
        fencing_token: unknown;
        lease_expires_at: unknown;
      }>("SELECT * FROM public.acquire_device_source_lease($1::uuid, $2::uuid, $3::timestamptz)", [
        sourceId,
        deviceId,
        expiresAt,
      ]);
      return mapLease(result.rows[0]);
    },

    async renewLease(
      sourceId: string,
      deviceId: string,
      sourceGeneration: number,
      fencingToken: string,
      expiresAt: Date,
    ): Promise<CloudLease> {
      if (
        !UUID.test(sourceId) ||
        !UUID.test(deviceId) ||
        !Number.isSafeInteger(sourceGeneration) ||
        sourceGeneration < 1 ||
        !FENCE.test(fencingToken) ||
        !(expiresAt instanceof Date) ||
        Number.isNaN(expiresAt.getTime())
      ) {
        throw new TypeError("Lease request is invalid.");
      }
      const result = await pool.query<{
        source_generation: unknown;
        fencing_token: unknown;
        lease_expires_at: unknown;
      }>(
        "SELECT * FROM public.renew_device_source_lease($1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::timestamptz)",
        [sourceId, deviceId, String(sourceGeneration), fencingToken, expiresAt],
      );
      return mapLease(result.rows[0]);
    },

    async admitStudy(input: StudyObservation): Promise<StudyAdmission> {
      assertInput(input);
      const values = [
        input.sourceId,
        input.deviceId,
        String(input.sourceGeneration),
        input.fencingToken,
        input.admissionKey,
        input.studyInstanceUid,
        input.orthancStudyId,
        input.patientId,
        input.patientIssuerOfPatientId,
        input.patientName,
        input.patientBirthDate,
        input.patientSex,
        input.studyDate,
        input.studyTime,
        input.studyDescription,
        input.accessionNumber,
        input.modalities,
      ];
      const result = await pool.query<{
        report_id: unknown;
        study_instance_uid: unknown;
        report_version: unknown;
        current_manifest_revision: unknown;
        current_manifest_digest: unknown;
        current_manifest_generation: unknown;
      }>(
        `SELECT * FROM public.upsert_observed_study(
          $1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::uuid,
          $6::text, $7::text, $8::text, $9::text, $10::text, $11::text,
          $12::text, $13::text, $14::text, $15::text, $16::text, $17::text
        )`,
        values,
      );
      const row = result.rows[0];
      const version = Number(row?.report_version);
      const manifestRevision = row?.current_manifest_revision;
      const manifestGeneration = row?.current_manifest_generation;
      const manifestDigest = row?.current_manifest_digest;
      const hasNoManifest =
        manifestRevision === null && manifestGeneration === null && manifestDigest === null;
      const hasManifest =
        Number.isSafeInteger(Number(manifestRevision)) &&
        Number(manifestRevision) > 0 &&
        Number.isSafeInteger(Number(manifestGeneration)) &&
        Number(manifestGeneration) > 0 &&
        typeof manifestDigest === "string" &&
        /^[a-f0-9]{64}$/.test(manifestDigest);
      if (
        typeof row?.report_id !== "string" ||
        row.study_instance_uid !== input.studyInstanceUid ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        (!hasNoManifest && !hasManifest)
      ) {
        throw new Error("Study admission returned an invalid durable result.");
      }
      return Object.freeze({
        reportId: row.report_id,
        studyInstanceUid: input.studyInstanceUid,
        version,
        currentManifestRevision: hasNoManifest ? null : Number(manifestRevision),
        currentManifestDigest: hasNoManifest ? null : String(manifestDigest),
        currentManifestGeneration: hasNoManifest ? null : Number(manifestGeneration),
      });
    },

    async admitUpload(
      input: Readonly<{
        sourceId: string;
        deviceId: string;
        sourceGeneration: number;
        fencingToken: string;
        admissionKey: string;
        uploadId: string;
        orthancInstanceId: string;
        studyInstanceUid: string;
        seriesInstanceUid: string;
        sopInstanceUid: string;
        byteCount: number;
        sha256: string;
        objectKey: string;
        expiresAt: Date;
      }>,
    ): Promise<UploadRecord> {
      const result = await pool.query<Record<string, unknown>>(
        `SELECT * FROM public.admit_ingestion_upload(
          $1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::uuid,$6::uuid,$7::text,
          $8::text,$9::text,$10::text,$11::bigint,$12::text,$13::text,$14::timestamptz)`,
        [
          input.sourceId,
          input.deviceId,
          String(input.sourceGeneration),
          input.fencingToken,
          input.admissionKey,
          input.uploadId,
          input.orthancInstanceId,
          input.studyInstanceUid,
          input.seriesInstanceUid,
          input.sopInstanceUid,
          input.byteCount,
          input.sha256,
          input.objectKey,
          input.expiresAt,
        ],
      );
      return mapUpload(
        result.rows[0]
          ? { ...result.rows[0], upload_status: result.rows[0].upload_status }
          : undefined,
      );
    },

    async attachMultipart(
      input: Readonly<{
        uploadId: string;
        deviceId: string;
        sourceGeneration: number;
        fencingToken: string;
        multipartUploadId: string;
      }>,
    ): Promise<boolean> {
      const result = await pool.query<{ attached: unknown }>(
        "SELECT public.attach_ingestion_multipart($1::uuid,$2::uuid,$3::bigint,$4::bigint,$5::text) AS attached",
        [
          input.uploadId,
          input.deviceId,
          String(input.sourceGeneration),
          input.fencingToken,
          input.multipartUploadId,
        ],
      );
      return result.rows[0]?.attached === true;
    },

    async completeUpload(
      input: Readonly<{
        uploadId: string;
        sourceId: string;
        deviceId: string;
        sourceGeneration: number;
        fencingToken: string;
        sha256: string;
        byteCount: number;
      }>,
    ): Promise<UploadRecord["status"]> {
      const result = await pool.query<{ status: unknown }>(
        "SELECT public.complete_ingestion_upload($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::bigint,$6::text,$7::bigint) AS status",
        [
          input.uploadId,
          input.sourceId,
          input.deviceId,
          String(input.sourceGeneration),
          input.fencingToken,
          input.sha256,
          input.byteCount,
        ],
      );
      if (!result.rows[0] || !["received", "completed"].includes(String(result.rows[0].status)))
        throw new Error("Upload completion returned an invalid status.");
      return result.rows[0].status as "received" | "completed";
    },

    async getUpload(
      uploadId: string,
      sourceId: string,
      deviceId: string,
    ): Promise<UploadRecord | null> {
      const result = await pool.query<Record<string, unknown>>(
        "SELECT * FROM public.read_ingestion_upload($1::uuid,$2::uuid,$3::uuid)",
        [uploadId, sourceId, deviceId],
      );
      return result.rows[0] ? mapUpload(result.rows[0]) : null;
    },

    async beginManifest(
      input: Readonly<{
        reportId: string;
        expectedCurrentRevision: number | null;
        expectedReportVersion: number;
        sourceGeneration: number;
        deviceId: string;
        fencingToken: string;
        attemptId: string;
      }>,
    ): Promise<number | null> {
      const result = await pool.query<{ revision: unknown }>(
        "SELECT public.begin_report_manifest_revision($1::uuid,$2::integer,$3::bigint,$4::bigint,$5::uuid,$6::bigint,$7::uuid) AS revision",
        [
          input.reportId,
          input.expectedCurrentRevision,
          String(input.expectedReportVersion),
          String(input.sourceGeneration),
          input.deviceId,
          input.fencingToken,
          input.attemptId,
        ],
      );
      const revision = result.rows[0]?.revision;
      if (revision === null || revision === undefined) return null;
      const number = Number(revision);
      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("Manifest begin returned an invalid revision.");
      return number;
    },

    async recordManifestPage(
      input: Readonly<{
        reportId: string;
        revision: number;
        expectedReportVersion: number;
        sourceGeneration: number;
        deviceId: string;
        fencingToken: string;
        members: readonly Readonly<{ sopInstanceUid: string; sha256: string }>[];
        attemptId: string;
      }>,
    ): Promise<number> {
      const result = await pool.query<{ accepted: unknown }>(
        "SELECT public.record_report_manifest_page($1::uuid,$2::integer,$3::bigint,$4::bigint,$5::uuid,$6::bigint,$7::jsonb,$8::uuid) AS accepted",
        [
          input.reportId,
          input.revision,
          String(input.expectedReportVersion),
          String(input.sourceGeneration),
          input.deviceId,
          input.fencingToken,
          JSON.stringify(input.members),
          input.attemptId,
        ],
      );
      const accepted = Number(result.rows[0]?.accepted);
      if (!Number.isSafeInteger(accepted) || accepted < 0)
        throw new Error("Manifest page returned an invalid accepted count.");
      return accepted;
    },

    async sealManifest(
      input: Readonly<{
        reportId: string;
        revision: number;
        expectedCurrentRevision: number | null;
        expectedReportVersion: number;
        sourceGeneration: number;
        deviceId: string;
        fencingToken: string;
        sourceObservedAt: Date;
        attemptId: string;
        digest: string;
      }>,
    ): Promise<boolean> {
      const result = await pool.query<{ sealed: unknown }>(
        "SELECT public.seal_observed_report_manifest($1::uuid,$2::integer,$3::integer,$4::bigint,$5::bigint,$6::uuid,$7::bigint,$8::timestamptz,true,true,$9::text,$10::uuid) AS sealed",
        [
          input.reportId,
          input.revision,
          input.expectedCurrentRevision,
          String(input.expectedReportVersion),
          String(input.sourceGeneration),
          input.deviceId,
          input.fencingToken,
          input.sourceObservedAt,
          input.digest,
          input.attemptId,
        ],
      );
      if (typeof result.rows[0]?.sealed !== "boolean")
        throw new Error("Manifest seal returned an invalid result.");
      return result.rows[0].sealed;
    },
  });
}

function mapLease(
  row:
    | {
        source_generation: unknown;
        fencing_token: unknown;
        lease_expires_at: unknown;
      }
    | undefined,
): CloudLease {
  const generation = Number(row?.source_generation);
  const expires = row?.lease_expires_at;
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    (typeof row?.fencing_token !== "string" && typeof row?.fencing_token !== "number") ||
    !(expires instanceof Date) ||
    Number.isNaN(expires.getTime())
  )
    throw new Error("Lease operation returned an invalid cloud fence.");
  return Object.freeze({
    sourceGeneration: generation,
    fencingToken: String(row.fencing_token),
    leaseExpiresAt: expires.toISOString(),
  });
}
