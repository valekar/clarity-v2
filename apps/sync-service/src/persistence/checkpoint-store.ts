import Database from "better-sqlite3";
import { DiscoveryStore } from "./discovery-store.js";
import { UploadSpoolStore } from "./upload-spool-store.js";
import { ManifestStateStore } from "./manifest-state-store.js";

export interface OrthancChange {
  sequence: number;
  changeType: string;
  resourceType: string;
  orthancId: string;
  date?: string;
}

export interface SourceIdentity {
  databaseServerIdentifier: string | null;
  databaseVersion: number | null;
}

export interface ChangePage {
  last: number;
  done: boolean;
  changes: OrthancChange[];
}

export interface Checkpoint {
  sourceKey: string;
  cursor: number;
  generation: number;
  databaseServerIdentifier: string | null;
  databaseVersion: number | null;
  reconciliationRequired: boolean;
}

export interface QueueJob {
  id: number;
  sourceKey: string;
  generation: number;
  sequence: number | null;
  changeType: string;
  resourceType: string | null;
  orthancId: string | null;
  status: "pending" | "processing" | "complete";
  attempts: number;
}

interface CheckpointRow {
  source_key: string;
  cursor: number;
  generation: number;
  server_identifier: string | null;
  database_version: number | null;
  reconciliation_required: number;
}

interface JobRow {
  id: number;
  source_key: string;
  generation: number;
  sequence: number | null;
  change_type: string;
  resource_type: string | null;
  orthanc_id: string | null;
  status: "pending" | "processing" | "complete";
  attempts: number;
}

const schema = `
  CREATE TABLE IF NOT EXISTS source_checkpoint (
    source_key TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL CHECK (cursor >= 0),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    server_identifier TEXT,
    database_version INTEGER,
    reconciliation_required INTEGER NOT NULL CHECK (reconciliation_required IN (0, 1)),
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS capture_job (
    id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    event_key TEXT NOT NULL,
    sequence INTEGER,
    change_type TEXT NOT NULL,
    resource_type TEXT,
    orthanc_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (source_key, generation, event_key),
    FOREIGN KEY (source_key) REFERENCES source_checkpoint(source_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS capture_job_pending
    ON capture_job(source_key, status, id);
  CREATE TABLE IF NOT EXISTS capture_queue_lease (
    source_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
    FOREIGN KEY (source_key) REFERENCES source_checkpoint(source_key)
  ) STRICT;
`;

function mapCheckpoint(row: CheckpointRow | undefined, sourceKey: string): Checkpoint | null {
  if (!row) return null;
  return {
    sourceKey,
    cursor: row.cursor,
    generation: row.generation,
    databaseServerIdentifier: row.server_identifier,
    databaseVersion: row.database_version,
    reconciliationRequired: row.reconciliation_required === 1,
  };
}

function mapJob(row: JobRow): QueueJob {
  return {
    id: row.id,
    sourceKey: row.source_key,
    generation: row.generation,
    sequence: row.sequence,
    changeType: row.change_type,
    resourceType: row.resource_type,
    orthancId: row.orthanc_id,
    status: row.status,
    attempts: row.attempts,
  };
}

function assertSequence(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

/** Durable local queue and feed checkpoint. Calls are intentionally synchronous and short. */
export class CheckpointStore {
  readonly #db: Database.Database;
  readonly discovery: DiscoveryStore;
  readonly uploads: UploadSpoolStore;
  readonly manifests: ManifestStateStore;

  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("busy_timeout = 5000");
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.exec(schema);
    this.discovery = new DiscoveryStore(this.#db);
    this.uploads = new UploadSpoolStore(this.#db);
    this.manifests = new ManifestStateStore(this.#db);
  }

  getCheckpoint(sourceKey: string): Checkpoint | null {
    const row = this.#db
      .prepare("SELECT * FROM source_checkpoint WHERE source_key = ?")
      .get(sourceKey) as CheckpointRow | undefined;
    return mapCheckpoint(row, sourceKey);
  }

  getHealthCounts(sourceKey: string): Readonly<{ queuedStudies: number; queuedUploads: number }> {
    const result = this.#db
      .prepare(
        `
      SELECT
        min(1000000, (
          SELECT count(*) FROM capture_job
           WHERE source_key = ? AND status != 'complete' AND resource_type = 'Study'
        ) + (
          SELECT count(DISTINCT study_uid) FROM local_instance_upload
           WHERE source_key = ? AND state != 'received'
        )) AS queued_studies,
        min(1000000, (SELECT count(*) FROM local_instance_upload
           WHERE source_key = ? AND state != 'received')) AS queued_uploads
    `,
      )
      .get(sourceKey, sourceKey, sourceKey) as { queued_studies: number; queued_uploads: number };
    return Object.freeze({
      queuedStudies: result.queued_studies,
      queuedUploads: result.queued_uploads,
    });
  }

  /**
   * Enqueue a feed page and advance its cursor in one SQLite transaction.
   * A changed Orthanc database identity or a cursor regression starts a local
   * generation and schedules a full source reconciliation. The caller must
   * fetch from zero when `resetDetected` is true.
   */
  capturePage(
    sourceKey: string,
    identity: SourceIdentity,
    requestedSince: number,
    page: ChangePage,
  ): { checkpoint: Checkpoint; resetDetected: boolean } {
    assertSequence(requestedSince, "requestedSince");
    assertSequence(page.last, "page.last");
    for (const change of page.changes) assertSequence(change.sequence, "change.sequence");
    if (page.changes.length > 0 && page.last < page.changes.at(-1)!.sequence) {
      throw new Error("page.last cannot precede the last returned change");
    }
    const commit = this.#db.transaction(() => {
      const currentRow = this.#db
        .prepare("SELECT * FROM source_checkpoint WHERE source_key = ?")
        .get(sourceKey) as CheckpointRow | undefined;
      const current = mapCheckpoint(currentRow, sourceKey);
      const identityChanged = Boolean(
        current &&
        ((identity.databaseServerIdentifier !== null &&
          current.databaseServerIdentifier !== null &&
          identity.databaseServerIdentifier !== current.databaseServerIdentifier) ||
          (identity.databaseVersion !== null &&
            current.databaseVersion !== null &&
            identity.databaseVersion !== current.databaseVersion)),
      );
      const committedPageReplay = Boolean(
        current &&
        !identityChanged &&
        requestedSince < current.cursor &&
        page.last === current.cursor,
      );
      if (
        current &&
        !identityChanged &&
        requestedSince !== current.cursor &&
        !committedPageReplay
      ) {
        throw new Error(
          `stale Orthanc page: requested cursor ${requestedSince} does not match checkpoint ${current.cursor}`,
        );
      }
      const cursorRegressed = Boolean(
        current && !identityChanged && !committedPageReplay && page.last < current.cursor,
      );
      const resetDetected = !current || identityChanged || cursorRegressed;
      const generation = current
        ? current.generation + (identityChanged || cursorRegressed ? 1 : 0)
        : 0;
      // Do not commit a stale/regressed page. The adapter re-reads from zero
      // after this transaction has opened the new generation.
      const cursor = cursorRegressed ? 0 : page.last;
      const reconciliationRequired = resetDetected || current?.reconciliationRequired === true;
      const now = new Date().toISOString();

      if (current && resetDetected) {
        this.#db
          .prepare(
            `UPDATE capture_job SET status = 'complete'
             WHERE source_key = ? AND generation < ? AND status != 'complete'`,
          )
          .run(sourceKey, generation);
      }

      this.#db
        .prepare(
          `INSERT INTO source_checkpoint
            (source_key, cursor, generation, server_identifier, database_version,
             reconciliation_required, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_key) DO UPDATE SET
             cursor = excluded.cursor,
             generation = excluded.generation,
             server_identifier = excluded.server_identifier,
             database_version = excluded.database_version,
             reconciliation_required = excluded.reconciliation_required,
             updated_at = excluded.updated_at`,
        )
        .run(
          sourceKey,
          cursor,
          generation,
          identity.databaseServerIdentifier,
          identity.databaseVersion,
          reconciliationRequired ? 1 : 0,
          now,
        );

      const insert = this.#db.prepare(
        `INSERT OR IGNORE INTO capture_job
          (source_key, generation, event_key, sequence, change_type, resource_type,
           orthanc_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      );
      if (resetDetected) {
        insert.run(
          sourceKey,
          generation,
          `reconcile:${generation}`,
          null,
          "reconcile-source",
          null,
          null,
          now,
        );
      }
      for (const change of cursorRegressed ? [] : page.changes) {
        insert.run(
          sourceKey,
          generation,
          `sequence:${change.sequence}`,
          change.sequence,
          change.changeType,
          change.resourceType,
          change.orthancId,
          now,
        );
      }
      return {
        checkpoint: mapCheckpoint(
          this.#db
            .prepare("SELECT * FROM source_checkpoint WHERE source_key = ?")
            .get(sourceKey) as CheckpointRow,
          sourceKey,
        )!,
        resetDetected,
      };
    });
    return commit();
  }

  listPending(sourceKey: string, limit = 100): QueueJob[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("limit must be an integer between 1 and 500");
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM capture_job
         WHERE source_key = ? AND status != 'complete'
         ORDER BY id LIMIT ?`,
      )
      .all(sourceKey, limit) as JobRow[];
    return rows.map(mapJob);
  }

  listPendingWork(sourceKey: string, limit = 100, throughSequence?: number): QueueJob[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("limit must be an integer between 1 and 500");
    }
    if (throughSequence !== undefined) assertSequence(throughSequence, "throughSequence");
    const rows = this.#db
      .prepare(
        `SELECT * FROM capture_job
         WHERE source_key = ? AND status != 'complete' AND change_type != 'reconcile-source'
           AND (? IS NULL OR sequence <= ?)
         ORDER BY id LIMIT ?`,
      )
      .all(sourceKey, throughSequence ?? null, throughSequence ?? null, limit) as JobRow[];
    return rows.map(mapJob);
  }

  markProcessing(jobId: number): void {
    this.#db
      .prepare(
        `UPDATE capture_job SET status = 'processing', attempts = attempts + 1
         WHERE id = ? AND status != 'complete'`,
      )
      .run(jobId);
  }

  acquireQueueLease(
    sourceKey: string,
    ownerId: string,
    leaseMilliseconds = 60_000,
    now = Date.now(),
  ): boolean {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000) {
      throw new Error("leaseMilliseconds must be a safe integer of at least 1000");
    }
    const acquire = this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO capture_queue_lease (source_key, owner_id, expires_at)
           VALUES (?, ?, 0)`,
        )
        .run(sourceKey, ownerId);
      this.#db
        .prepare(
          `UPDATE capture_queue_lease SET owner_id = ?, expires_at = ?
           WHERE source_key = ? AND (owner_id = ? OR expires_at <= ?)`,
        )
        .run(ownerId, now + leaseMilliseconds, sourceKey, ownerId, now);
      const row = this.#db
        .prepare("SELECT owner_id FROM capture_queue_lease WHERE source_key = ?")
        .get(sourceKey) as { owner_id: string } | undefined;
      return row?.owner_id === ownerId;
    });
    return acquire();
  }

  renewQueueLease(
    sourceKey: string,
    ownerId: string,
    leaseMilliseconds = 60_000,
    now = Date.now(),
  ): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE capture_queue_lease SET expires_at = ?
           WHERE source_key = ? AND owner_id = ? AND expires_at > ?`,
        )
        .run(now + leaseMilliseconds, sourceKey, ownerId, now).changes === 1
    );
  }

  releaseQueueLease(sourceKey: string, ownerId: string): void {
    this.#db
      .prepare("DELETE FROM capture_queue_lease WHERE source_key = ? AND owner_id = ?")
      .run(sourceKey, ownerId);
  }

  /** Clear crash residue only after the service's exclusive process lock is held. */
  clearQueueLeaseAfterExclusiveServiceLock(sourceKey: string): void {
    this.#db.prepare("DELETE FROM capture_queue_lease WHERE source_key = ?").run(sourceKey);
  }

  markComplete(jobId: number): void {
    this.#db.prepare("UPDATE capture_job SET status = 'complete' WHERE id = ?").run(jobId);
  }

  close(): void {
    this.#db.close();
  }
}
