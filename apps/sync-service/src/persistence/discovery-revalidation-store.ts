import type Database from "better-sqlite3";
import type { InventoryRun } from "../discovery/model.js";
import { mapInventoryRun, type InventoryRunRow } from "./discovery-row-mappers.js";
import { checkpointFor } from "./discovery-row-mappers.js";

export interface RevalidationTarget {
  sopInstanceUid: string;
  orthancInstanceId: string;
  studyInstanceUid: string;
}

export class DiscoveryRevalidationStore {
  constructor(private readonly db: Database.Database) {}

  start(runId: string): InventoryRun {
    const begin = this.db.transaction(() => {
      const run = this.#run(runId);
      this.#assertGeneration(run);
      const upper = this.db
        .prepare("SELECT MAX(sop_uid) AS uid FROM discovered_instance WHERE source_key = ?")
        .get(run.source_key) as { uid: string | null };
      this.db
        .prepare(
          `UPDATE inventory_run SET status = 'revalidating', revalidation_after_sop_uid = NULL,
             revalidation_upper_sop_uid = ? WHERE id = ?`,
        )
        .run(upper.uid, runId);
      return this.get(runId)!;
    });
    return begin();
  }

  list(runId: string, limit: number): RevalidationTarget[] {
    const run = this.#run(runId);
    if (run.status !== "revalidating") throw new Error("inventory run is not revalidating");
    if (run.revalidation_upper_sop_uid === null) return [];
    const rows = this.db
      .prepare(
        `SELECT i.sop_uid, i.orthanc_instance_id, i.study_uid
         FROM discovered_instance i WHERE i.source_key = ?
           AND i.sop_uid <= ? AND (? IS NULL OR i.sop_uid > ?)
         ORDER BY i.sop_uid LIMIT ?`,
      )
      .all(
        run.source_key,
        run.revalidation_upper_sop_uid,
        run.revalidation_after_sop_uid,
        run.revalidation_after_sop_uid,
        limit,
      ) as Array<{ sop_uid: string; orthanc_instance_id: string; study_uid: string }>;
    return rows.map((row) => ({
      sopInstanceUid: row.sop_uid,
      orthancInstanceId: row.orthanc_instance_id,
      studyInstanceUid: row.study_uid,
    }));
  }

  commit(
    runId: string,
    expectedAfter: string | null,
    outcomes: Array<{ target: RevalidationTarget; present: boolean }>,
  ): InventoryRun {
    const save = this.db.transaction(() => {
      const run = this.#run(runId);
      this.#assertGeneration(run);
      if (run.status !== "revalidating" || run.revalidation_after_sop_uid !== expectedAfter) {
        throw new Error("stale inventory revalidation batch");
      }
      for (const outcome of outcomes) {
        const { target, present } = outcome;
        if (target.sopInstanceUid <= (expectedAfter ?? "")) {
          throw new Error("revalidation UIDs must advance in lexical order");
        }
        if (
          run.revalidation_upper_sop_uid === null ||
          target.sopInstanceUid > run.revalidation_upper_sop_uid
        ) {
          throw new Error("revalidation target exceeds the frozen local UID bound");
        }
        this.db
          .prepare(
            `UPDATE discovered_instance SET source_missing = ?, updated_at = ?
             WHERE source_key = ? AND sop_uid = ? AND orthanc_instance_id = ?`,
          )
          .run(
            present ? 0 : 1,
            new Date().toISOString(),
            run.source_key,
            target.sopInstanceUid,
            target.orthancInstanceId,
          );
        this.db
          .prepare(
            `UPDATE logical_report SET source_missing = CASE WHEN EXISTS (
               SELECT 1 FROM discovered_instance i WHERE i.source_key = logical_report.source_key
                 AND i.study_uid = logical_report.study_uid AND i.source_missing = 0
             ) THEN 0 ELSE 1 END, updated_at = ?
             WHERE source_key = ? AND study_uid = ?`,
          )
          .run(new Date().toISOString(), run.source_key, target.studyInstanceUid);
      }
      const next = outcomes.at(-1)?.target.sopInstanceUid ?? expectedAfter;
      this.db
        .prepare("UPDATE inventory_run SET revalidation_after_sop_uid = ? WHERE id = ?")
        .run(next, runId);
      return this.get(runId)!;
    });
    return save();
  }

  finish(runId: string): InventoryRun {
    const finish = this.db.transaction(() => {
      const run = this.#run(runId);
      this.#assertGeneration(run);
      if (run.status !== "revalidating" || this.list(runId, 1).length > 0) {
        throw new Error("inventory revalidation is incomplete");
      }
      this.db
        .prepare("UPDATE inventory_run SET status = 'awaiting-replay' WHERE id = ?")
        .run(runId);
      return this.get(runId)!;
    });
    return finish();
  }

  private get(id: string): InventoryRun | null {
    const row = this.db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(id) as
      InventoryRunRow | undefined;
    return row ? mapInventoryRun(row) : null;
  }

  #run(id: string): InventoryRunRow {
    const row = this.db.prepare("SELECT * FROM inventory_run WHERE id = ?").get(id) as
      InventoryRunRow | undefined;
    if (!row) throw new Error("inventory run does not exist");
    return row;
  }

  #assertGeneration(run: InventoryRunRow): void {
    const checkpoint = checkpointFor(this.db, run.source_key);
    if (!checkpoint || checkpoint.generation !== run.generation) {
      throw new Error("inventory generation changed during revalidation");
    }
  }
}
