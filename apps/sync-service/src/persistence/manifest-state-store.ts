import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

interface ManifestRow {
  source_key: string;
  study_uid: string;
  current_revision: number | null;
  current_digest: string | null;
  current_version: number | null;
  current_generation: number | null;
  current_cloud_generation: number | null;
  attempt_id: string | null;
  expected_revision: number | null;
  expected_version: number | null;
  generation: number | null;
  cloud_generation: number | null;
  digest: string | null;
  observed_at: string | null;
  revision: number | null;
  next_member: number;
}

export interface LocalManifestAttempt {
  sourceKey: string;
  studyInstanceUid: string;
  currentRevision: number | null;
  currentDigest: string | null;
  currentVersion: number | null;
  currentGeneration: number | null;
  currentCloudGeneration: number | null;
  attemptId: string | null;
  expectedCurrentRevision: number | null;
  expectedReportVersion: number | null;
  generation: number | null;
  cloudGeneration: number | null;
  digest: string | null;
  observedAt: string | null;
  revision: number | null;
  nextMember: number;
}

export interface CloudManifestProof {
  currentRevision: number | null;
  currentDigest: string | null;
  currentGeneration: number | null;
  reportVersion: number;
}

const schema = `
  CREATE TABLE IF NOT EXISTS local_schema_migration (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    applied_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS local_manifest_state (
    source_key TEXT NOT NULL,
    study_uid TEXT NOT NULL,
    current_revision INTEGER,
    current_digest TEXT,
    current_version INTEGER,
    current_generation INTEGER,
    current_cloud_generation INTEGER,
    attempt_id TEXT,
    expected_revision INTEGER,
    expected_version INTEGER,
    generation INTEGER,
    cloud_generation INTEGER,
    digest TEXT,
    observed_at TEXT,
    revision INTEGER,
    next_member INTEGER NOT NULL DEFAULT 0 CHECK (next_member >= 0),
    PRIMARY KEY (source_key, study_uid)
  ) STRICT;
`;

/** Durable CAS/retry state for cloud manifest attempts, kept separate from source discovery. */
export class ManifestStateStore {
  constructor(private readonly db: Database.Database) {
    this.db.transaction(() => {
      this.db.exec(schema);
      this.db
        .prepare("INSERT OR IGNORE INTO local_schema_migration (version, applied_at) VALUES (3, ?)")
        .run(new Date().toISOString());
      const columns = this.db.prepare("PRAGMA table_info(local_manifest_state)").all() as Array<{
        name: string;
      }>;
      for (const name of ["current_generation", "current_cloud_generation", "cloud_generation"]) {
        if (!columns.some((column) => column.name === name)) {
          this.db.exec(`ALTER TABLE local_manifest_state ADD COLUMN ${name} INTEGER`);
        }
      }
      this.db
        .prepare("INSERT OR IGNORE INTO local_schema_migration (version, applied_at) VALUES (4, ?)")
        .run(new Date().toISOString());
    })();
  }

  get(sourceKey: string, studyInstanceUid: string): LocalManifestAttempt | null {
    const row = this.db
      .prepare("SELECT * FROM local_manifest_state WHERE source_key = ? AND study_uid = ?")
      .get(sourceKey, studyInstanceUid) as ManifestRow | undefined;
    return row ? this.#map(row) : null;
  }

  startAttempt(input: {
    sourceKey: string;
    studyInstanceUid: string;
    generation: number;
    cloudGeneration: number;
    expectedReportVersion: number;
    digest: string;
    observedAt: string;
  }): LocalManifestAttempt {
    const save = this.db.transaction(() => {
      const existing = this.get(input.sourceKey, input.studyInstanceUid);
      if (
        existing?.attemptId === null &&
        existing.currentDigest === input.digest &&
        existing.currentGeneration === input.generation &&
        existing.currentCloudGeneration === input.cloudGeneration
      ) {
        return existing;
      }
      if (
        existing?.attemptId &&
        existing.generation === input.generation &&
        existing.cloudGeneration === input.cloudGeneration &&
        existing.expectedReportVersion === input.expectedReportVersion &&
        existing.digest === input.digest &&
        existing.observedAt !== null &&
        Date.now() - Date.parse(existing.observedAt) < 9 * 60_000
      ) {
        return existing;
      }
      const attemptId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO local_manifest_state
            (source_key, study_uid, current_revision, current_digest, current_version, current_generation,
             current_cloud_generation,
             attempt_id, expected_revision,
             expected_version, generation, cloud_generation, digest, observed_at, revision, next_member)
           VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
           ON CONFLICT(source_key, study_uid) DO UPDATE SET
             attempt_id = excluded.attempt_id,
             expected_revision = local_manifest_state.current_revision,
             expected_version = excluded.expected_version,
             generation = excluded.generation,
             cloud_generation = excluded.cloud_generation,
             digest = excluded.digest,
             observed_at = excluded.observed_at,
             revision = NULL,
             next_member = 0`,
        )
        .run(
          input.sourceKey,
          input.studyInstanceUid,
          existing?.currentRevision ?? null,
          attemptId,
          existing?.currentRevision ?? null,
          input.expectedReportVersion,
          input.generation,
          input.cloudGeneration,
          input.digest,
          input.observedAt,
        );
      return this.get(input.sourceKey, input.studyInstanceUid)!;
    });
    return save();
  }

  recordRevision(
    sourceKey: string,
    studyInstanceUid: string,
    attemptId: string,
    revision: number,
  ): void {
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new Error("manifest revision is invalid");
    const result = this.db
      .prepare(
        `UPDATE local_manifest_state SET revision = ?
         WHERE source_key = ? AND study_uid = ? AND attempt_id = ?`,
      )
      .run(revision, sourceKey, studyInstanceUid, attemptId);
    if (result.changes !== 1) throw new Error("manifest attempt changed before revision commit");
  }

  reconcileCloudProof(
    sourceKey: string,
    studyInstanceUid: string,
    proof: CloudManifestProof,
  ): "sealed-attempt" | "draft-current" | "refreshed" {
    if (!Number.isSafeInteger(proof.reportVersion) || proof.reportVersion < 1) {
      throw new Error("cloud Report version is invalid");
    }
    const noRevision =
      proof.currentRevision === null &&
      proof.currentDigest === null &&
      proof.currentGeneration === null;
    const sealedRevision =
      proof.currentRevision !== null &&
      Number.isSafeInteger(proof.currentRevision) &&
      proof.currentRevision > 0 &&
      proof.currentDigest !== null &&
      /^[a-f0-9]{64}$/.test(proof.currentDigest) &&
      proof.currentGeneration !== null &&
      Number.isSafeInteger(proof.currentGeneration) &&
      proof.currentGeneration > 0;
    if (!noRevision && !sealedRevision) throw new Error("cloud manifest proof is incomplete");

    return this.db.transaction(() => {
      const existing = this.get(sourceKey, studyInstanceUid);
      if (
        existing?.attemptId &&
        existing.revision !== null &&
        existing.revision === proof.currentRevision &&
        existing.digest === proof.currentDigest &&
        existing.cloudGeneration === proof.currentGeneration
      ) {
        this.db
          .prepare(
            `UPDATE local_manifest_state SET current_revision = ?, current_digest = ?,
               current_version = ?, current_generation = generation,
               current_cloud_generation = ?, attempt_id = NULL, expected_revision = NULL,
               expected_version = NULL, generation = NULL, cloud_generation = NULL,
               digest = NULL, observed_at = NULL, revision = NULL, next_member = 0
             WHERE source_key = ? AND study_uid = ? AND attempt_id = ?`,
          )
          .run(
            proof.currentRevision,
            proof.currentDigest,
            proof.reportVersion,
            proof.currentGeneration,
            sourceKey,
            studyInstanceUid,
            existing.attemptId,
          );
        return "sealed-attempt";
      }

      if (
        existing?.attemptId &&
        proof.currentRevision === existing.expectedCurrentRevision &&
        proof.reportVersion === existing.expectedReportVersion
      ) {
        return "draft-current";
      }

      const alreadyReflected =
        existing?.currentRevision === proof.currentRevision &&
        existing.currentDigest === proof.currentDigest &&
        existing.currentCloudGeneration === proof.currentGeneration;
      this.db
        .prepare(
          `INSERT INTO local_manifest_state
             (source_key, study_uid, current_revision, current_digest, current_version,
              current_generation, current_cloud_generation)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_key, study_uid) DO UPDATE SET
             current_revision = excluded.current_revision,
             current_digest = excluded.current_digest,
             current_version = excluded.current_version,
             current_generation = CASE WHEN ? THEN local_manifest_state.current_generation ELSE NULL END,
             current_cloud_generation = excluded.current_cloud_generation,
             attempt_id = NULL, expected_revision = NULL, expected_version = NULL,
             generation = NULL, cloud_generation = NULL, digest = NULL, observed_at = NULL,
             revision = NULL, next_member = 0`,
        )
        .run(
          sourceKey,
          studyInstanceUid,
          proof.currentRevision,
          proof.currentDigest,
          proof.reportVersion,
          alreadyReflected ? existing.currentGeneration : null,
          proof.currentGeneration,
          alreadyReflected ? 1 : 0,
        );
      return "refreshed";
    })();
  }

  advancePage(
    sourceKey: string,
    studyInstanceUid: string,
    attemptId: string,
    expectedCursor: number,
    nextCursor: number,
  ): void {
    if (
      !Number.isSafeInteger(expectedCursor) ||
      expectedCursor < 0 ||
      !Number.isSafeInteger(nextCursor) ||
      nextCursor <= expectedCursor
    ) {
      throw new Error("manifest page cursor must advance by a positive bounded amount");
    }
    const result = this.db
      .prepare(
        `UPDATE local_manifest_state SET next_member = ?
         WHERE source_key = ? AND study_uid = ? AND attempt_id = ? AND next_member = ?`,
      )
      .run(nextCursor, sourceKey, studyInstanceUid, attemptId, expectedCursor);
    if (result.changes !== 1) throw new Error("manifest page cursor changed concurrently");
  }

  finishAttempt(sourceKey: string, studyInstanceUid: string, attemptId: string): void {
    const result = this.db
      .prepare(
        `UPDATE local_manifest_state
         SET current_revision = revision, current_digest = digest, current_version = expected_version + 1,
             current_generation = generation, current_cloud_generation = cloud_generation,
             attempt_id = NULL, expected_revision = NULL,
             expected_version = NULL, generation = NULL, digest = NULL, observed_at = NULL,
             revision = NULL, next_member = 0
         WHERE source_key = ? AND study_uid = ? AND attempt_id = ? AND revision IS NOT NULL`,
      )
      .run(sourceKey, studyInstanceUid, attemptId);
    if (result.changes !== 1) throw new Error("manifest attempt cannot be completed");
  }

  #map(row: ManifestRow): LocalManifestAttempt {
    return {
      sourceKey: row.source_key,
      studyInstanceUid: row.study_uid,
      currentRevision: row.current_revision,
      currentDigest: row.current_digest,
      currentVersion: row.current_version,
      currentGeneration: row.current_generation,
      currentCloudGeneration: row.current_cloud_generation,
      attemptId: row.attempt_id,
      expectedCurrentRevision: row.expected_revision,
      expectedReportVersion: row.expected_version,
      generation: row.generation,
      cloudGeneration: row.cloud_generation,
      digest: row.digest,
      observedAt: row.observed_at,
      revision: row.revision,
      nextMember: row.next_member,
    };
  }
}
