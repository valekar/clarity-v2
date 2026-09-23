import type Database from "better-sqlite3";

export type LocalUploadState =
  "spooled" | "authorized" | "uploading" | "completion-unknown" | "received" | "needs-attention";

export interface LocalUpload {
  admissionKey: string;
  sourceKey: string;
  generation: number;
  orthancInstanceId: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  spoolPath: string | null;
  byteCount: number;
  sha256: string;
  state: LocalUploadState;
  uploadId: string | null;
  expiresAt: string | null;
  attentionReason: string | null;
}

export interface LocalPartReceipt {
  partNumber: number;
  offset: number;
  byteCount: number;
  sha256: string;
  etag: string;
}

interface UploadRow {
  admission_key: string;
  source_key: string;
  generation: number;
  orthanc_instance_id: string;
  study_uid: string;
  series_uid: string;
  sop_uid: string;
  spool_path: string | null;
  byte_count: number;
  sha256: string;
  state: LocalUploadState;
  upload_id: string | null;
  expires_at: string | null;
  attention_reason: string | null;
}

interface PartRow {
  admission_key: string;
  part_number: number;
  byte_offset: number;
  byte_count: number;
  sha256: string;
  etag: string;
}

const schema = `
  CREATE TABLE IF NOT EXISTS local_instance_upload (
    admission_key TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    orthanc_instance_id TEXT NOT NULL,
    study_uid TEXT NOT NULL,
    series_uid TEXT NOT NULL,
    sop_uid TEXT NOT NULL,
    spool_path TEXT,
    byte_count INTEGER NOT NULL CHECK (byte_count > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    state TEXT NOT NULL CHECK (state IN
      ('spooled', 'authorized', 'uploading', 'completion-unknown', 'received', 'needs-attention')),
    upload_id TEXT,
    expires_at TEXT,
    attention_reason TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (source_key, sop_uid),
    FOREIGN KEY (source_key) REFERENCES source_checkpoint(source_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS local_upload_part (
    admission_key TEXT NOT NULL,
    part_number INTEGER NOT NULL CHECK (part_number > 0),
    byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
    byte_count INTEGER NOT NULL CHECK (byte_count > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    etag TEXT NOT NULL CHECK (length(etag) > 0),
    PRIMARY KEY (admission_key, part_number),
    FOREIGN KEY (admission_key) REFERENCES local_instance_upload(admission_key)
      ON DELETE CASCADE
  ) STRICT;
`;

export class UploadSpoolStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(schema);
  }

  insertSpool(
    upload: Omit<LocalUpload, "state" | "uploadId" | "expiresAt" | "attentionReason">,
  ): LocalUpload {
    const save = this.db.transaction(() => {
      this.#assertGeneration(upload.sourceKey, upload.generation);
      const existing = this.db
        .prepare("SELECT * FROM local_instance_upload WHERE source_key = ? AND sop_uid = ?")
        .get(upload.sourceKey, upload.sopInstanceUid) as UploadRow | undefined;
      if (existing) {
        if (existing.sha256 !== upload.sha256 || existing.byte_count !== upload.byteCount) {
          throw new Error("SOPInstanceUID bytes changed from the durable local upload reservation");
        }
        return this.#map(existing);
      }
      this.db
        .prepare(
          `INSERT INTO local_instance_upload
             (admission_key, source_key, generation, orthanc_instance_id, study_uid,
              series_uid, sop_uid, spool_path, byte_count, sha256, state, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'spooled', ?)`,
        )
        .run(
          upload.admissionKey,
          upload.sourceKey,
          upload.generation,
          upload.orthancInstanceId,
          upload.studyInstanceUid,
          upload.seriesInstanceUid,
          upload.sopInstanceUid,
          upload.spoolPath,
          upload.byteCount,
          upload.sha256,
          new Date().toISOString(),
        );
      return this.get(upload.admissionKey)!;
    });
    return save();
  }

  supersedeUnadmittedSpool(
    upload: Omit<LocalUpload, "state" | "uploadId" | "expiresAt" | "attentionReason">,
  ): { upload: LocalUpload; previousSpoolPath: string | null } {
    const save = this.db.transaction(() => {
      this.#assertGeneration(upload.sourceKey, upload.generation);
      const existing = this.db
        .prepare("SELECT * FROM local_instance_upload WHERE source_key = ? AND sop_uid = ?")
        .get(upload.sourceKey, upload.sopInstanceUid) as UploadRow | undefined;
      if (!existing) throw new Error("stale spool disappeared before it could be superseded");
      if (existing.generation === upload.generation) {
        if (existing.sha256 !== upload.sha256 || existing.byte_count !== upload.byteCount) {
          throw new Error("SOPInstanceUID bytes changed from the durable local upload reservation");
        }
        return { upload: this.#map(existing), previousSpoolPath: upload.spoolPath };
      }
      if (
        existing.upload_id !== null ||
        (existing.state !== "spooled" && existing.state !== "needs-attention")
      ) {
        throw new Error("stale spool already has cloud state and cannot be superseded locally");
      }
      if (
        existing.study_uid !== upload.studyInstanceUid ||
        existing.series_uid !== upload.seriesInstanceUid
      ) {
        throw new Error("SOPInstanceUID identity changed across source generations");
      }
      if (existing.sha256 !== upload.sha256 || existing.byte_count !== upload.byteCount) {
        throw new Error("SOPInstanceUID bytes changed across source generations");
      }
      this.db
        .prepare("DELETE FROM local_upload_part WHERE admission_key = ?")
        .run(upload.admissionKey);
      this.db
        .prepare(
          `UPDATE local_instance_upload SET generation = ?, orthanc_instance_id = ?, spool_path = ?,
           state = 'spooled', upload_id = NULL, expires_at = NULL, attention_reason = NULL,
           updated_at = ? WHERE admission_key = ?`,
        )
        .run(
          upload.generation,
          upload.orthancInstanceId,
          upload.spoolPath,
          new Date().toISOString(),
          existing.admission_key,
        );
      return {
        upload: this.get(existing.admission_key)!,
        previousSpoolPath: existing.spool_path,
      };
    });
    return save();
  }

  markGenerationConflict(admissionKey: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE local_instance_upload SET state = 'needs-attention', attention_reason = ?,
           updated_at = ? WHERE admission_key = ?`,
      )
      .run(reason.slice(0, 500), new Date().toISOString(), admissionKey);
  }

  get(admissionKey: string): LocalUpload | null {
    const row = this.db
      .prepare("SELECT * FROM local_instance_upload WHERE admission_key = ?")
      .get(admissionKey) as UploadRow | undefined;
    return row ? this.#map(row) : null;
  }

  findBySop(sourceKey: string, sopUid: string): LocalUpload | null {
    const row = this.db
      .prepare("SELECT * FROM local_instance_upload WHERE source_key = ? AND sop_uid = ?")
      .get(sourceKey, sopUid) as UploadRow | undefined;
    return row ? this.#map(row) : null;
  }

  listSpoolPaths(): string[] {
    return (
      this.db
        .prepare("SELECT spool_path FROM local_instance_upload WHERE spool_path IS NOT NULL")
        .all() as Array<{ spool_path: string }>
    ).map((row) => row.spool_path);
  }

  recordAuthorization(
    admissionKey: string,
    generation: number,
    uploadId: string,
    expiresAt: string,
  ): LocalUpload {
    const save = this.db.transaction(() => {
      const row = this.#row(admissionKey);
      this.#assertGeneration(row.source_key, generation);
      if (row.generation !== generation || row.state === "received") {
        throw new Error("upload authorization is stale or already received");
      }
      if (row.upload_id !== null && row.upload_id !== uploadId) {
        this.db.prepare("DELETE FROM local_upload_part WHERE admission_key = ?").run(admissionKey);
      }
      this.db
        .prepare(
          `UPDATE local_instance_upload SET upload_id = ?, expires_at = ?, state = 'authorized',
             attention_reason = NULL, updated_at = ? WHERE admission_key = ?`,
        )
        .run(uploadId, expiresAt, new Date().toISOString(), admissionKey);
      return this.get(admissionKey)!;
    });
    return save();
  }

  recordPart(admissionKey: string, generation: number, receipt: LocalPartReceipt): void {
    const save = this.db.transaction(() => {
      const row = this.#row(admissionKey);
      this.#assertGeneration(row.source_key, generation);
      if (row.generation !== generation || row.state === "received") {
        throw new Error("cannot persist a part receipt for a stale upload");
      }
      const existing = this.db
        .prepare("SELECT * FROM local_upload_part WHERE admission_key = ? AND part_number = ?")
        .get(admissionKey, receipt.partNumber) as PartRow | undefined;
      if (
        existing &&
        (existing.byte_offset !== receipt.offset ||
          existing.byte_count !== receipt.byteCount ||
          existing.sha256 !== receipt.sha256 ||
          existing.etag !== receipt.etag)
      ) {
        throw new Error("provider part acknowledgment changed for a durable part number");
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO local_upload_part
             (admission_key, part_number, byte_offset, byte_count, sha256, etag)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          admissionKey,
          receipt.partNumber,
          receipt.offset,
          receipt.byteCount,
          receipt.sha256,
          receipt.etag,
        );
      this.db
        .prepare(
          "UPDATE local_instance_upload SET state = 'uploading', updated_at = ? WHERE admission_key = ?",
        )
        .run(new Date().toISOString(), admissionKey);
    });
    save();
  }

  listParts(admissionKey: string): LocalPartReceipt[] {
    return this.db
      .prepare(
        `SELECT part_number AS partNumber, byte_offset AS offset, byte_count AS byteCount,
                sha256, etag FROM local_upload_part WHERE admission_key = ? ORDER BY part_number`,
      )
      .all(admissionKey) as LocalPartReceipt[];
  }

  markCompletionUnknown(admissionKey: string, generation: number): void {
    this.#updateState(admissionKey, generation, "completion-unknown", null);
  }

  markReceived(admissionKey: string, generation: number): LocalUpload {
    const update = this.db.transaction(() => {
      const row = this.#row(admissionKey);
      this.#assertGeneration(row.source_key, generation);
      if (row.generation !== generation)
        throw new Error("cannot acknowledge an upload from an old source generation");
      this.db
        .prepare(
          `UPDATE local_instance_upload SET state = 'received',
             attention_reason = NULL, updated_at = ? WHERE admission_key = ?`,
        )
        .run(new Date().toISOString(), admissionKey);
      return this.get(admissionKey)!;
    });
    return update();
  }

  clearReceivedSpoolPath(admissionKey: string): void {
    const clear = this.db.transaction(() => {
      const row = this.#row(admissionKey);
      if (row.state !== "received")
        throw new Error("only received uploads can release their spool path");
      this.db
        .prepare(
          "UPDATE local_instance_upload SET spool_path = NULL, updated_at = ? WHERE admission_key = ?",
        )
        .run(new Date().toISOString(), admissionKey);
    });
    clear();
  }

  markAttention(admissionKey: string, generation: number, reason: string): void {
    this.#updateState(admissionKey, generation, "needs-attention", reason.slice(0, 500));
  }

  #updateState(
    admissionKey: string,
    generation: number,
    state: LocalUploadState,
    reason: string | null,
  ): void {
    const update = this.db.transaction(() => {
      const row = this.#row(admissionKey);
      this.#assertGeneration(row.source_key, generation);
      if (row.generation !== generation)
        throw new Error("cannot change an upload from an old source generation");
      this.db
        .prepare(
          "UPDATE local_instance_upload SET state = ?, attention_reason = ?, updated_at = ? WHERE admission_key = ?",
        )
        .run(state, reason, new Date().toISOString(), admissionKey);
    });
    update();
  }

  #assertGeneration(sourceKey: string, generation: number): void {
    const row = this.db
      .prepare("SELECT generation FROM source_checkpoint WHERE source_key = ?")
      .get(sourceKey) as { generation: number } | undefined;
    if (!row || row.generation !== generation)
      throw new Error("source generation changed during upload");
  }

  #row(admissionKey: string): UploadRow {
    const row = this.db
      .prepare("SELECT * FROM local_instance_upload WHERE admission_key = ?")
      .get(admissionKey) as UploadRow | undefined;
    if (!row) throw new Error("local upload reservation does not exist");
    return row;
  }

  #map(row: UploadRow): LocalUpload {
    return {
      admissionKey: row.admission_key,
      sourceKey: row.source_key,
      generation: row.generation,
      orthancInstanceId: row.orthanc_instance_id,
      studyInstanceUid: row.study_uid,
      seriesInstanceUid: row.series_uid,
      sopInstanceUid: row.sop_uid,
      spoolPath: row.spool_path,
      byteCount: row.byte_count,
      sha256: row.sha256,
      state: row.state,
      uploadId: row.upload_id,
      expiresAt: row.expires_at,
      attentionReason: row.attention_reason,
    };
  }
}
