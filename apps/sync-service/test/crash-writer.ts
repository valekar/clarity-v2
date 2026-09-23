import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const [databasePath, markerPath, mode, jobId] = process.argv.slice(2);
if (!databasePath || !markerPath) throw new Error("database path and marker path are required");
const db = new Database(databasePath);
db.exec("BEGIN IMMEDIATE");
if (mode === "report") {
  if (!jobId || !/^\d+$/.test(jobId))
    throw new Error("numeric queue job ID is required for report mode");
  db.prepare("UPDATE capture_job SET status = 'complete' WHERE id = ?").run(Number(jobId));
  db.prepare(
    `INSERT INTO logical_report
      (source_key, study_uid, orthanc_study_id, patient_id, patient_name,
       patient_birth_date, patient_sex, study_date, study_time, study_description,
       accession_number, modalities, source_missing, last_seen_run, updated_at)
     VALUES ('fixture', '2.25.50', 'study-crash', NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, 0, NULL, 'test')`,
  ).run();
} else {
  db.prepare("UPDATE source_checkpoint SET cursor = 99 WHERE source_key = 'fixture'").run();
  db.prepare(
    `INSERT INTO capture_job
      (source_key, generation, event_key, sequence, change_type, resource_type, orthanc_id, status, created_at)
     VALUES ('fixture', 0, 'sequence:99', 99, 'NewInstance', 'Instance', 'not-committed', 'pending', 'test')`,
  ).run();
}
writeFileSync(markerPath, "transaction-open");
setInterval(() => undefined, 60_000);
