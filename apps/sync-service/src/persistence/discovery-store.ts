import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  DiscoveredInstance,
  InstanceObservation,
  InstanceStudyPair,
  InventoryRun,
  LogicalReport,
  StudyObservation,
} from "../discovery/model.js";

import { discoverySchema } from "./discovery-schema.js";
import { migrateDiscoverySchema } from "./discovery-schema-migrations.js";
import {
  DiscoveryRevalidationStore,
  type RevalidationTarget,
} from "./discovery-revalidation-store.js";
import {
  checkpointFor,
  mapInventoryRun,
  type InventoryRunRow,
  type RunCheckpointRow,
} from "./discovery-row-mappers.js";
import { DiscoveryReadStore } from "./discovery-read-store.js";

export class DiscoveryStore {
  readonly #db: Database.Database;
  readonly #revalidation: DiscoveryRevalidationStore;
  readonly #reads: DiscoveryReadStore;

  constructor(database: Database.Database) {
    this.#db = database;
    this.#db.exec(discoverySchema);
    migrateDiscoverySchema(this.#db);
    this.#revalidation = new DiscoveryRevalidationStore(database);
    this.#reads = new DiscoveryReadStore(database);
  }

  startInventory(
    sourceKey: string,
    kind: "initial" | "periodic",
    reconcileJobId: number | null = null,
    upperInstanceId: string | null = null,
  ): InventoryRun {
    const current = this.#db
      .prepare("SELECT cursor, generation FROM source_checkpoint WHERE source_key = ?")
      .get(sourceKey) as RunCheckpointRow | undefined;
    if (!current) throw new Error("cannot start inventory before capturing an Orthanc cursor");
    const active = this.#db
      .prepare(
        `SELECT * FROM inventory_run WHERE source_key = ?
         AND status != 'complete' ORDER BY created_at LIMIT 1`,
      )
      .get(sourceKey) as InventoryRunRow | undefined;
    if (active) return mapInventoryRun(active);
    if (kind === "initial") {
      const completed = this.#db
        .prepare(
          "SELECT * FROM inventory_run WHERE source_key = ? AND kind = 'initial' AND status = 'complete' ORDER BY created_at DESC LIMIT 1",
        )
        .get(sourceKey) as InventoryRunRow | undefined;
      if (completed) return mapInventoryRun(completed);
    }
    const id = randomUUID();
    const start = this.#db.transaction(() => {
      if (kind === "initial") {
        // The snapshot inventory subsumes events through its captured cursor.
        this.#db
          .prepare(
            `UPDATE capture_job SET status = 'complete'
             WHERE source_key = ? AND generation = ? AND sequence <= ?
               AND change_type != 'reconcile-source'`,
          )
          .run(sourceKey, current.generation, current.cursor);
      }
      this.#db
        .prepare(
          `INSERT INTO inventory_run
            (id, source_key, kind, generation, cursor_start, status, upper_instance_id,
             upper_bound_captured, reconcile_job_id, created_at)
            VALUES (?, ?, ?, ?, ?, 'scanning-instances', ?, 1, ?, ?)`,
        )
        .run(
          id,
          sourceKey,
          kind,
          current.generation,
          current.cursor,
          upperInstanceId,
          reconcileJobId,
          new Date().toISOString(),
        );
    });
    start();
    return this.getInventoryRun(id)!;
  }

  getInventoryRun(id: string): InventoryRun | null {
    const row = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(id) as
      InventoryRunRow | undefined;
    return row ? mapInventoryRun(row) : null;
  }

  findInventoryRun(
    sourceKey: string,
    kind: "initial" | "periodic",
    includeCompleted = false,
  ): InventoryRun | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM inventory_run WHERE source_key = ? AND kind = ?
         ${includeCompleted ? "" : "AND status != 'complete'"}
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sourceKey, kind) as InventoryRunRow | undefined;
    return row ? mapInventoryRun(row) : null;
  }

  reconcileInventoryGeneration(runId: string): InventoryRun {
    const reconcile = this.#db.transaction(() => {
      const run = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(runId) as
        InventoryRunRow | undefined;
      if (!run) throw new Error("inventory run does not exist");
      const checkpoint = checkpointFor(this.#db, run.source_key);
      if (!checkpoint) throw new Error("inventory source checkpoint is missing");
      if (checkpoint.generation === run.generation) return mapInventoryRun(run);
      return this.#restartInventoryPass(run, checkpoint);
    });
    return reconcile();
  }

  captureInventoryUpperBound(runId: string, upperInstanceId: string | null): InventoryRun {
    const capture = this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(runId) as
        InventoryRunRow | undefined;
      if (!row || row.status === "complete") throw new Error("inventory run is not active");
      this.#assertCurrentGeneration(row);
      this.#db
        .prepare(
          `UPDATE inventory_run SET upper_instance_id = ?, upper_bound_captured = 1
           WHERE id = ?`,
        )
        .run(upperInstanceId, runId);
      return this.getInventoryRun(runId)!;
    });
    return capture();
  }

  repositionInventoryOffset(
    runId: string,
    expectedOffset: number,
    nextOffset: number,
  ): InventoryRun {
    const reposition = this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(runId) as
        InventoryRunRow | undefined;
      if (!row || row.status !== "scanning-instances")
        throw new Error("inventory run is not scanning instances");
      this.#assertCurrentGeneration(row);
      if (row.next_instance_offset !== expectedOffset || nextOffset >= expectedOffset) {
        throw new Error("stale or invalid inventory offset repair");
      }
      this.#db
        .prepare("UPDATE inventory_run SET next_instance_offset = ? WHERE id = ?")
        .run(nextOffset, runId);
      return this.getInventoryRun(runId)!;
    });
    return reposition();
  }

  recordAnchoredInstancePage(
    runId: string,
    expectedOffset: number,
    nextOffset: number,
    expectedAnchor: string | null,
    nextAnchor: string | null,
    pairs: readonly InstanceStudyPair[],
    complete: boolean,
  ): InventoryRun {
    const save = this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(runId) as
        InventoryRunRow | undefined;
      if (!row || row.status !== "scanning-instances")
        throw new Error("inventory run is not scanning instances");
      this.#assertCurrentGeneration(row);
      if (
        row.next_instance_offset !== expectedOffset ||
        row.last_instance_id !== expectedAnchor ||
        nextOffset < 0 ||
        (row.last_instance_id !== null && nextAnchor !== null && nextAnchor < row.last_instance_id)
      ) {
        throw new Error("stale or invalid anchored inventory page");
      }
      for (const pair of pairs) {
        if (
          pair.instance.studyInstanceUid !== pair.study.studyInstanceUid ||
          pair.instance.orthancStudyId !== pair.study.orthancStudyId
        ) {
          throw new Error("instance does not match its resolved StudyInstanceUID");
        }
        this.#upsertStudy(row.source_key, pair.study, runId);
        this.#upsertInstance(row.source_key, pair.instance, runId);
        this.#recordPassSeen(row.source_key, runId, "study", pair.study.studyInstanceUid);
        this.#recordPassSeen(row.source_key, runId, "instance", pair.instance.sopInstanceUid);
      }
      this.#db
        .prepare(
          `UPDATE inventory_run SET next_instance_offset = ?, last_instance_id = ?,
             status = CASE WHEN ? THEN 'revalidating' ELSE status END,
             revalidation_after_sop_uid = CASE WHEN ? THEN NULL ELSE revalidation_after_sop_uid END,
             revalidation_upper_sop_uid = CASE WHEN ? THEN
               (SELECT MAX(sop_uid) FROM discovered_instance WHERE source_key = ?)
               ELSE revalidation_upper_sop_uid END
           WHERE id = ?`,
        )
        .run(
          nextOffset,
          nextAnchor,
          complete ? 1 : 0,
          complete ? 1 : 0,
          complete ? 1 : 0,
          row.source_key,
          runId,
        );
      return this.getInventoryRun(runId)!;
    });
    return save();
  }

  startInventoryRevalidation(runId: string): InventoryRun {
    return this.#revalidation.start(runId);
  }

  listInventoryRevalidationBatch(runId: string, limit: number): RevalidationTarget[] {
    return this.#revalidation.list(runId, limit);
  }

  commitInventoryRevalidationBatch(
    runId: string,
    expectedAfter: string | null,
    outcomes: Array<{ target: RevalidationTarget; present: boolean }>,
  ): InventoryRun {
    return this.#revalidation.commit(runId, expectedAfter, outcomes);
  }

  finishInventoryRevalidation(runId: string): InventoryRun {
    return this.#revalidation.finish(runId);
  }

  restartInventoryAfterFeedChanges(runId: string): InventoryRun | null {
    const restart = this.#db.transaction(() => {
      const run = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(runId) as
        InventoryRunRow | undefined;
      if (!run || run.status !== "awaiting-replay") {
        throw new Error("inventory run is not awaiting replay");
      }
      const checkpoint = this.#db
        .prepare("SELECT cursor, generation FROM source_checkpoint WHERE source_key = ?")
        .get(run.source_key) as RunCheckpointRow | undefined;
      if (!checkpoint) throw new Error("inventory source checkpoint is missing");
      if (checkpoint.generation === run.generation) {
        return null;
      }
      return this.#restartInventoryPass(run, checkpoint);
    });
    return restart();
  }

  freezeInventoryFeedHorizon(runId: string, done: boolean): InventoryRun {
    const freeze = this.#db.transaction(() => {
      const run = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(runId) as
        InventoryRunRow | undefined;
      if (!run || run.status !== "awaiting-replay") {
        throw new Error("inventory run is not awaiting replay");
      }
      this.#assertCurrentGeneration(run);
      if (run.feed_horizon === null) {
        this.#db
          .prepare(
            `UPDATE inventory_run SET feed_horizon =
               (SELECT cursor FROM source_checkpoint WHERE source_key = ?),
               feed_done_at_horizon = ? WHERE id = ?`,
          )
          .run(run.source_key, done ? 1 : 0, runId);
      }
      return this.getInventoryRun(runId)!;
    });
    return freeze();
  }

  releaseDrainedInventoryFeedHorizon(runId: string): InventoryRun {
    const release = this.#db.transaction(() => {
      const run = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(runId) as
        InventoryRunRow | undefined;
      if (!run || run.status !== "awaiting-replay") {
        throw new Error("inventory run is not awaiting replay");
      }
      this.#assertCurrentGeneration(run);
      if (run.feed_horizon === null || run.feed_done_at_horizon !== 0) {
        throw new Error("only an unfinished feed horizon can be continued");
      }
      const pending = this.#db
        .prepare(
          `SELECT COUNT(*) AS count FROM capture_job
           WHERE source_key = ? AND generation = ? AND status != 'complete'
             AND change_type != 'reconcile-source' AND sequence <= ?`,
        )
        .get(run.source_key, run.generation, run.feed_horizon) as { count: number };
      if (pending.count !== 0) throw new Error("inventory feed horizon still has pending work");
      this.#db
        .prepare(
          `UPDATE inventory_run SET feed_horizon = NULL, feed_done_at_horizon = NULL
           WHERE id = ?`,
        )
        .run(runId);
      return this.getInventoryRun(runId)!;
    });
    return release();
  }

  advanceInventoryVerification(runId: string): InventoryRun {
    const advance = this.#db.transaction(() => {
      const run = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(runId) as
        InventoryRunRow | undefined;
      if (!run || run.status !== "awaiting-replay") {
        throw new Error("inventory run is not awaiting replay");
      }
      const checkpoint = checkpointFor(this.#db, run.source_key);
      if (!checkpoint || checkpoint.generation !== run.generation) {
        throw new Error("inventory generation changed during verification");
      }
      if (run.feed_horizon === null) {
        throw new Error("inventory feed horizon must be frozen before verification");
      }
      this.#db.prepare("UPDATE inventory_run SET verified_snapshot = 1 WHERE id = ?").run(runId);
      return this.getInventoryRun(runId)!;
    });
    return advance();
  }

  completeInventory(runId: string): InventoryRun {
    const finish = this.#db.transaction(() => {
      const run = this.#db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(runId) as
        InventoryRunRow | undefined;
      if (!run || run.status !== "awaiting-replay")
        throw new Error("inventory run is not awaiting replay");
      const checkpoint = this.#db
        .prepare("SELECT cursor, generation FROM source_checkpoint WHERE source_key = ?")
        .get(run.source_key) as RunCheckpointRow | undefined;
      if (!checkpoint) {
        throw new Error("inventory source checkpoint is missing");
      }
      if (checkpoint.generation !== run.generation) {
        return this.#restartInventoryPass(run, checkpoint);
      }
      const pendingWork = this.#db
        .prepare(
          `SELECT COUNT(*) AS count FROM capture_job
           WHERE source_key = ? AND generation = ? AND status != 'complete'
             AND change_type != 'reconcile-source' AND sequence <= ?`,
        )
        .get(run.source_key, run.generation, run.feed_horizon) as { count: number };
      if (pendingWork.count > 0) {
        throw new Error("inventory cannot complete while captured work remains pending");
      }
      if (run.verified_snapshot !== 1) {
        throw new Error("inventory requires a verified snapshot before completion");
      }
      this.#db
        .prepare("DELETE FROM inventory_pass_seen WHERE source_key = ? AND pass_id != ?")
        .run(run.source_key, run.id);
      this.#db
        .prepare("UPDATE inventory_run SET status = 'complete', completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), runId);
      if (run.reconcile_job_id !== null) this.#markJobComplete(run.reconcile_job_id);
      const currentCheckpoint = this.#db
        .prepare("SELECT generation FROM source_checkpoint WHERE source_key = ?")
        .get(run.source_key) as { generation: number } | undefined;
      if (currentCheckpoint?.generation === run.generation) {
        this.#db
          .prepare("UPDATE source_checkpoint SET reconciliation_required = 0 WHERE source_key = ?")
          .run(run.source_key);
      }
      return this.getInventoryRun(runId)!;
    });
    return finish();
  }

  commitQueueStudy(
    jobId: number,
    sourceKey: string,
    leaseOwner: string,
    study: StudyObservation,
    instance?: InstanceObservation,
  ): LogicalReport | null {
    const commit = this.#db.transaction(() => {
      if (!this.#isCurrentQueueJob(jobId, sourceKey, leaseOwner)) {
        return null;
      }
      const checkpoint = checkpointFor(this.#db, sourceKey)!;
      const active = this.#db
        .prepare(
          `SELECT id FROM inventory_run WHERE source_key = ? AND generation = ?
           AND status != 'complete' ORDER BY created_at LIMIT 1`,
        )
        .get(sourceKey, checkpoint.generation) as { id: string } | undefined;
      this.#upsertStudy(sourceKey, study, active?.id ?? null);
      if (instance) this.#upsertInstance(sourceKey, instance, active?.id ?? null);
      this.#markJobComplete(jobId);
      return this.getReport(sourceKey, study.studyInstanceUid)!;
    });
    return commit();
  }

  commitQueueDeletion(
    jobId: number,
    sourceKey: string,
    resourceType: string,
    orthancId: string,
    leaseOwner: string,
  ): void {
    const commit = this.#db.transaction(() => {
      if (!this.#isCurrentQueueJob(jobId, sourceKey, leaseOwner)) {
        return;
      }
      if (resourceType === "Instance") {
        this.#db
          .prepare(
            "UPDATE discovered_instance SET source_missing = 1 WHERE source_key = ? AND orthanc_instance_id = ?",
          )
          .run(sourceKey, orthancId);
      } else if (resourceType === "Study") {
        this.#db
          .prepare(
            "UPDATE logical_report SET source_missing = 1 WHERE source_key = ? AND orthanc_study_id = ?",
          )
          .run(sourceKey, orthancId);
        this.#db
          .prepare(
            "UPDATE discovered_instance SET source_missing = 1 WHERE source_key = ? AND study_uid IN (SELECT study_uid FROM logical_report WHERE source_key = ? AND orthanc_study_id = ?)",
          )
          .run(sourceKey, sourceKey, orthancId);
      }
      this.#markJobComplete(jobId);
    });
    commit();
  }

  commitMissingQueueObservation(
    jobId: number,
    sourceKey: string,
    resourceType: string,
    orthancId: string,
    leaseOwner: string,
  ): void {
    const commit = this.#db.transaction(() => {
      if (!this.#isCurrentQueueJob(jobId, sourceKey, leaseOwner)) {
        return;
      }
      if (resourceType === "Instance") {
        this.#db
          .prepare(
            "UPDATE discovered_instance SET source_missing = 1 WHERE source_key = ? AND orthanc_instance_id = ?",
          )
          .run(sourceKey, orthancId);
      } else if (resourceType === "Study") {
        this.#db
          .prepare(
            "UPDATE logical_report SET source_missing = 1 WHERE source_key = ? AND orthanc_study_id = ?",
          )
          .run(sourceKey, orthancId);
        this.#db
          .prepare(
            `UPDATE discovered_instance SET source_missing = 1
             WHERE source_key = ? AND study_uid IN
               (SELECT study_uid FROM logical_report WHERE source_key = ? AND orthanc_study_id = ?)`,
          )
          .run(sourceKey, sourceKey, orthancId);
      }
      this.#markJobComplete(jobId);
      const checkpoint = checkpointFor(this.#db, sourceKey);
      if (!checkpoint) return;
      const now = new Date().toISOString();
      this.#db
        .prepare("UPDATE source_checkpoint SET reconciliation_required = 1 WHERE source_key = ?")
        .run(sourceKey);
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO capture_job
            (source_key, generation, event_key, sequence, change_type, resource_type,
             orthanc_id, status, created_at)
           VALUES (?, ?, ?, NULL, 'reconcile-source', NULL, NULL, 'pending', ?)`,
        )
        .run(sourceKey, checkpoint.generation, `reconcile:missing:${jobId}`, now);
    });
    commit();
  }

  completeIgnoredQueueJob(jobId: number, sourceKey: string, leaseOwner: string): void {
    const complete = this.#db.transaction(() => {
      if (!this.#isCurrentQueueJob(jobId, sourceKey, leaseOwner)) return;
      this.#markJobComplete(jobId);
    });
    complete();
  }

  getReport(sourceKey: string, studyInstanceUid: string): LogicalReport | null {
    return this.#reads.getReport(sourceKey, studyInstanceUid);
  }

  listReports(sourceKey: string): LogicalReport[] {
    return this.#reads.listReports(sourceKey);
  }

  listReportPage(sourceKey: string, afterStudyUid: string | null, limit: number): LogicalReport[] {
    return this.#reads.listReportPage(sourceKey, afterStudyUid, limit);
  }

  listManifestMemberPage(
    sourceKey: string,
    studyInstanceUid: string,
    generation: number,
    offset: number,
    limit: number,
  ) {
    return this.#reads.listManifestMemberPage(
      sourceKey,
      studyInstanceUid,
      generation,
      offset,
      limit,
    );
  }

  listInstances(sourceKey: string, studyInstanceUid: string): DiscoveredInstance[] {
    return this.#reads.listInstances(sourceKey, studyInstanceUid);
  }

  listDiscoveredInstances(
    sourceKey: string,
    afterSopUid: string | null,
    limit: number,
  ): DiscoveredInstance[] {
    return this.#reads.listDiscoveredInstances(sourceKey, afterSopUid, limit);
  }

  #upsertStudy(sourceKey: string, study: StudyObservation, runId: string | null): void {
    this.#db
      .prepare(
        `INSERT INTO logical_report
          (source_key, study_uid, orthanc_study_id, patient_id, patient_issuer_of_patient_id, patient_name,
           patient_birth_date, patient_sex, study_date, study_time, study_description,
           accession_number, modalities, source_missing, last_seen_run, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(source_key, study_uid) DO UPDATE SET
           orthanc_study_id = excluded.orthanc_study_id,
           patient_id = excluded.patient_id,
           patient_issuer_of_patient_id = excluded.patient_issuer_of_patient_id,
           patient_name = excluded.patient_name,
           patient_birth_date = excluded.patient_birth_date,
           patient_sex = excluded.patient_sex,
           study_date = excluded.study_date,
           study_time = excluded.study_time,
           study_description = excluded.study_description,
           accession_number = excluded.accession_number,
           modalities = excluded.modalities,
           source_missing = 0,
           last_seen_run = COALESCE(excluded.last_seen_run, logical_report.last_seen_run),
           updated_at = excluded.updated_at`,
      )
      .run(
        sourceKey,
        study.studyInstanceUid,
        study.orthancStudyId,
        study.patientId,
        study.patientIssuerOfPatientId,
        study.patientName,
        study.patientBirthDate,
        study.patientSex,
        study.studyDate,
        study.studyTime,
        study.studyDescription,
        study.accessionNumber,
        study.modalities,
        runId,
        new Date().toISOString(),
      );
  }

  #assertCurrentGeneration(run: InventoryRunRow): void {
    const checkpoint = checkpointFor(this.#db, run.source_key);
    if (!checkpoint || checkpoint.generation !== run.generation) {
      throw new Error("inventory generation changed during observation");
    }
  }

  #restartInventoryPass(run: InventoryRunRow, checkpoint: RunCheckpointRow): InventoryRun {
    const nextRunId = randomUUID();
    this.#db
      .prepare("DELETE FROM inventory_pass_seen WHERE source_key = ? AND pass_id = ?")
      .run(run.source_key, run.id);
    this.#db
      .prepare(
        `UPDATE inventory_run SET id = ?, generation = ?, cursor_start = ?, previous_pass_id = NULL,
           verified_snapshot = 0, status = 'scanning-instances', next_study_offset = 0,
           next_instance_offset = 0, last_instance_id = NULL, upper_instance_id = NULL,
           upper_bound_captured = 0, feed_horizon = NULL, feed_done_at_horizon = NULL,
           created_at = ?, completed_at = NULL WHERE id = ?`,
      )
      .run(nextRunId, checkpoint.generation, checkpoint.cursor, new Date().toISOString(), run.id);
    return this.getInventoryRun(nextRunId)!;
  }

  #recordPassSeen(
    sourceKey: string,
    passId: string,
    resourceKind: "study" | "instance",
    resourceUid: string,
  ): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO inventory_pass_seen
           (source_key, pass_id, resource_kind, resource_uid)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sourceKey, passId, resourceKind, resourceUid);
  }

  #isCurrentQueueJob(jobId: number, sourceKey: string, leaseOwner: string): boolean {
    const job = this.#db
      .prepare("SELECT source_key, generation, status FROM capture_job WHERE id = ?")
      .get(jobId) as
      | { source_key: string; generation: number; status: "pending" | "processing" | "complete" }
      | undefined;
    const checkpoint = checkpointFor(this.#db, sourceKey);
    const lease = this.#db
      .prepare(
        "SELECT 1 AS owned FROM capture_queue_lease WHERE source_key = ? AND owner_id = ? AND expires_at > ?",
      )
      .get(sourceKey, leaseOwner, Date.now()) as { owned: number } | undefined;
    return Boolean(
      job &&
      job.source_key === sourceKey &&
      job.status !== "complete" &&
      checkpoint &&
      checkpoint.generation === job.generation &&
      lease,
    );
  }

  #markJobComplete(jobId: number): void {
    this.#db.prepare("UPDATE capture_job SET status = 'complete' WHERE id = ?").run(jobId);
  }

  #upsertInstance(sourceKey: string, instance: InstanceObservation, runId: string | null): void {
    const existing = this.#db
      .prepare("SELECT study_uid FROM discovered_instance WHERE source_key = ? AND sop_uid = ?")
      .get(sourceKey, instance.sopInstanceUid) as { study_uid: string } | undefined;
    if (existing && existing.study_uid !== instance.studyInstanceUid) {
      throw new Error("SOPInstanceUID is already assigned to a different logical Report");
    }
    this.#db
      .prepare(
        `INSERT INTO discovered_instance
          (source_key, study_uid, sop_uid, orthanc_instance_id, series_uid,
           source_missing, last_seen_run, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(source_key, sop_uid) DO UPDATE SET
           orthanc_instance_id = excluded.orthanc_instance_id,
           series_uid = excluded.series_uid,
           source_missing = 0,
           last_seen_run = COALESCE(excluded.last_seen_run, discovered_instance.last_seen_run),
           updated_at = excluded.updated_at`,
      )
      .run(
        sourceKey,
        instance.studyInstanceUid,
        instance.sopInstanceUid,
        instance.orthancInstanceId,
        instance.seriesInstanceUid,
        runId,
        new Date().toISOString(),
      );
  }
}
