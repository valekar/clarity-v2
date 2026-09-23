import type { Pool } from "pg";
import type { ReceivedUpload, WorkerRepository } from "./contracts.js";

type UploadRow = Readonly<Record<string, unknown>>;

function toUpload(row: UploadRow): ReceivedUpload {
  const byteCount = Number(row.declared_size_bytes);
  if (!Number.isSafeInteger(byteCount) || byteCount < 1)
    throw new Error("Upload has an invalid declared size.");
  return {
    uploadId: String(row.upload_id),
    reportId: String(row.report_id),
    sourceId: String(row.source_id),
    reportFileId: String(row.report_file_id),
    objectKey: String(row.object_key),
    expectedSha256: String(row.expected_sha256),
    byteCount,
    studyInstanceUid: String(row.study_instance_uid),
    seriesInstanceUid: String(row.series_instance_uid),
    sopInstanceUid: String(row.sop_instance_uid),
  };
}

export class PostgresWorkerRepository implements WorkerRepository {
  constructor(private readonly pool: Pool) {}

  async listReceived(limit: number): Promise<readonly ReceivedUpload[]> {
    const result = await this.pool.query<UploadRow>(
      `SELECT u.id AS upload_id, u.report_id, u.source_id, u.report_file_id, u.object_key,
              u.expected_sha256, u.declared_size_bytes, r.study_instance_uid,
              f.series_instance_uid, f.sop_instance_uid
         FROM public.ingestion_uploads u
         JOIN public.reports r ON r.id = u.report_id AND r.source_id = u.source_id
         JOIN public.report_files f ON f.id = u.report_file_id
                                   AND f.report_id = u.report_id AND f.source_id = u.source_id
        WHERE u.status = 'received'
          AND f.state <> 'needs_attention'
        ORDER BY u.created_at, u.id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(toUpload);
  }

  async listCleanupPending(limit: number): Promise<readonly ReceivedUpload[]> {
    const result = await this.pool.query<UploadRow>(
      `SELECT u.id AS upload_id, u.report_id, u.source_id, u.report_file_id, u.object_key,
              u.expected_sha256, u.declared_size_bytes, r.study_instance_uid,
              f.series_instance_uid, f.sop_instance_uid
         FROM public.ingestion_uploads u
         JOIN public.reports r ON r.id = u.report_id AND r.source_id = u.source_id
         JOIN public.report_files f ON f.id = u.report_file_id
                                   AND f.report_id = u.report_id AND f.source_id = u.source_id
        WHERE u.status = 'completed' AND u.intake_cleaned_at IS NULL
        ORDER BY u.created_at, u.id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(toUpload);
  }

  async assertUidOwnership(upload: ReceivedUpload): Promise<boolean> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.dicom_uid_registry
        WHERE (uid_type = 'study' AND uid_value = $1 AND source_id = $2 AND report_id = $3)
           OR (uid_type = 'series' AND uid_value = $4 AND source_id = $2 AND report_id = $3)
           OR (uid_type = 'sop' AND uid_value = $5 AND source_id = $2 AND report_id = $3
               AND report_file_id = $6 AND sha256 = $7)`,
      [
        upload.studyInstanceUid,
        upload.sourceId,
        upload.reportId,
        upload.seriesInstanceUid,
        upload.sopInstanceUid,
        upload.reportFileId,
        upload.expectedSha256,
      ],
    );
    return result.rows[0]?.count === "3";
  }

  async authorizeImport(upload: ReceivedUpload): Promise<boolean> {
    const result = await this.pool.query<{ authorize_ingestion_import: boolean }>(
      "SELECT public.authorize_ingestion_import($1) AS authorize_ingestion_import",
      [upload.uploadId],
    );
    if (typeof result.rows[0]?.authorize_ingestion_import !== "boolean") {
      throw new Error("Worker import authorization returned an invalid result.");
    }
    return result.rows[0].authorize_ingestion_import;
  }

  async completeIndexed(upload: ReceivedUpload, instanceId: string): Promise<void> {
    const result = await this.pool.query<{ complete_ingestion_import_fenced: boolean }>(
      "SELECT public.complete_ingestion_import_fenced($1, $2, $3) AS complete_ingestion_import_fenced",
      [upload.uploadId, upload.expectedSha256, instanceId],
    );
    if (result.rows[0]?.complete_ingestion_import_fenced !== true) {
      throw new Error("Worker completion was not committed.");
    }
  }

  async markIntakeCleaned(upload: ReceivedUpload): Promise<void> {
    const result = await this.pool.query<{ mark_ingestion_intake_cleaned: boolean }>(
      "SELECT public.mark_ingestion_intake_cleaned($1) AS mark_ingestion_intake_cleaned",
      [upload.uploadId],
    );
    if (result.rows[0]?.mark_ingestion_intake_cleaned !== true) {
      throw new Error("Worker intake cleanup state was not committed.");
    }
  }

  async markAttention(upload: ReceivedUpload): Promise<void> {
    const result = await this.pool.query<{ flag_ingestion_attention: boolean }>(
      "SELECT public.flag_ingestion_attention($1) AS flag_ingestion_attention",
      [upload.uploadId],
    );
    if (result.rows[0]?.flag_ingestion_attention !== true) {
      throw new Error("Worker attention state was not committed.");
    }
  }
}
