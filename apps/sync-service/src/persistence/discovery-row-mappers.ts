import type Database from "better-sqlite3";
import type { DiscoveredInstance, InventoryRun, LogicalReport } from "../discovery/model.js";

export interface InventoryRunRow {
  id: string;
  source_key: string;
  kind: "initial" | "periodic";
  generation: number;
  cursor_start: number;
  feed_horizon: number | null;
  feed_done_at_horizon: number | null;
  status:
    "scanning-studies" | "scanning-instances" | "revalidating" | "awaiting-replay" | "complete";
  next_study_offset: number;
  active_study_id: string | null;
  next_instance_offset: number;
  last_instance_id: string | null;
  upper_instance_id: string | null;
  upper_bound_captured: number;
  revalidation_after_sop_uid: string | null;
  revalidation_upper_sop_uid: string | null;
  reconcile_job_id: number | null;
  previous_pass_id: string | null;
  verified_snapshot: number;
  created_at: string;
  completed_at: string | null;
}

export interface RunCheckpointRow {
  cursor: number;
  generation: number;
}

export interface ReportRow {
  source_key: string;
  study_uid: string;
  orthanc_study_id: string;
  patient_id: string | null;
  patient_issuer_of_patient_id: string | null;
  patient_name: string | null;
  patient_birth_date: string | null;
  patient_sex: string | null;
  study_date: string | null;
  study_time: string | null;
  study_description: string | null;
  accession_number: string | null;
  modalities: string | null;
  source_missing: number;
}

export interface InstanceRow {
  source_key: string;
  study_uid: string;
  sop_uid: string;
  orthanc_instance_id: string;
  series_uid: string | null;
  source_missing: number;
}

export function mapInventoryRun(row: InventoryRunRow): InventoryRun {
  return {
    id: row.id,
    sourceKey: row.source_key,
    kind: row.kind,
    generation: row.generation,
    cursorAtStart: row.cursor_start,
    feedHorizon: row.feed_horizon,
    feedDoneAtHorizon: row.feed_done_at_horizon === null ? null : row.feed_done_at_horizon === 1,
    status: row.status,
    nextStudyOffset: row.next_study_offset,
    nextInstanceOffset: row.next_instance_offset,
    lastInstanceId: row.last_instance_id,
    upperInstanceId: row.upper_instance_id,
    upperBoundCaptured: row.upper_bound_captured === 1,
    revalidationAfterSopUid: row.revalidation_after_sop_uid,
    revalidationUpperSopUid: row.revalidation_upper_sop_uid,
    reconcileJobId: row.reconcile_job_id,
    completedAt: row.completed_at,
  };
}

export function mapReport(row: ReportRow): LogicalReport {
  return {
    sourceKey: row.source_key,
    studyInstanceUid: row.study_uid,
    orthancStudyId: row.orthanc_study_id,
    patientId: row.patient_id,
    patientIssuerOfPatientId: row.patient_issuer_of_patient_id,
    patientName: row.patient_name,
    patientBirthDate: row.patient_birth_date,
    patientSex: row.patient_sex,
    studyDate: row.study_date,
    studyTime: row.study_time,
    studyDescription: row.study_description,
    accessionNumber: row.accession_number,
    modalities: row.modalities,
    sourceMissing: row.source_missing === 1,
  };
}

export function mapInstance(row: InstanceRow, sourceKey: string): DiscoveredInstance {
  return {
    sourceKey,
    studyInstanceUid: row.study_uid,
    sopInstanceUid: row.sop_uid,
    orthancInstanceId: row.orthanc_instance_id,
    seriesInstanceUid: row.series_uid,
    orthancStudyId: "",
    sourceMissing: row.source_missing === 1,
  };
}

export function checkpointFor(
  db: Database.Database,
  sourceKey: string,
): RunCheckpointRow | undefined {
  return db
    .prepare("SELECT cursor, generation FROM source_checkpoint WHERE source_key = ?")
    .get(sourceKey) as RunCheckpointRow | undefined;
}
