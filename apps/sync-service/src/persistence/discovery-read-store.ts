import type Database from "better-sqlite3";
import type { DiscoveredInstance, LogicalReport } from "../discovery/model.js";
import {
  mapInstance,
  mapReport,
  type InstanceRow,
  type ReportRow,
} from "./discovery-row-mappers.js";

/** Bounded read queries for local inventory and manifest construction. */
export class DiscoveryReadStore {
  constructor(private readonly db: Database.Database) {}

  getReport(sourceKey: string, studyInstanceUid: string): LogicalReport | null {
    const row = this.db
      .prepare("SELECT * FROM logical_report WHERE source_key = ? AND study_uid = ?")
      .get(sourceKey, studyInstanceUid) as ReportRow | undefined;
    return row ? mapReport(row) : null;
  }

  listReports(sourceKey: string): LogicalReport[] {
    return (
      this.db
        .prepare("SELECT * FROM logical_report WHERE source_key = ? ORDER BY study_uid")
        .all(sourceKey) as ReportRow[]
    ).map(mapReport);
  }

  listReportPage(sourceKey: string, afterStudyUid: string | null, limit: number): LogicalReport[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("report page size must be between 1 and 100");
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM logical_report WHERE source_key = ?
        AND (? IS NULL OR study_uid > ?) ORDER BY study_uid COLLATE BINARY LIMIT ?`,
      )
      .all(sourceKey, afterStudyUid, afterStudyUid, limit) as ReportRow[];
    return rows.map(mapReport);
  }

  listManifestMemberPage(
    sourceKey: string,
    studyInstanceUid: string,
    generation: number,
    offset: number,
    limit: number,
  ): {
    members: Array<{ sopInstanceUid: string; sha256: string }>;
    ready: boolean;
    scanned: number;
  } {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new Error("manifest member page bounds are invalid");
    }
    const rows = this.db
      .prepare(
        `SELECT i.sop_uid, u.sha256, u.state, u.generation FROM discovered_instance i
        LEFT JOIN local_instance_upload u ON u.source_key = i.source_key AND u.sop_uid = i.sop_uid
        WHERE i.source_key = ? AND i.study_uid = ? AND i.source_missing = 0
        ORDER BY i.sop_uid COLLATE BINARY LIMIT ? OFFSET ?`,
      )
      .all(sourceKey, studyInstanceUid, limit, offset) as Array<{
      sop_uid: string;
      sha256: string | null;
      state: string | null;
      generation: number | null;
    }>;
    const ready = rows.every(
      (row) => row.sha256 !== null && row.state === "received" && row.generation === generation,
    );
    return {
      members: ready
        ? rows.map((row) => ({ sopInstanceUid: row.sop_uid, sha256: row.sha256! }))
        : [],
      ready,
      scanned: rows.length,
    };
  }

  listInstances(sourceKey: string, studyInstanceUid: string): DiscoveredInstance[] {
    const rows = this.db
      .prepare(
        `SELECT i.*, r.orthanc_study_id FROM discovered_instance i
        JOIN logical_report r ON r.source_key = i.source_key AND r.study_uid = i.study_uid
        WHERE i.source_key = ? AND i.study_uid = ? ORDER BY i.sop_uid COLLATE BINARY`,
      )
      .all(sourceKey, studyInstanceUid) as Array<InstanceRow & { orthanc_study_id: string }>;
    return rows.map((row) => ({
      ...mapInstance(row, sourceKey),
      orthancStudyId: row.orthanc_study_id,
    }));
  }

  listDiscoveredInstances(
    sourceKey: string,
    afterSopUid: string | null,
    limit: number,
  ): DiscoveredInstance[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("discovered instance page size must be between 1 and 500");
    }
    const rows = this.db
      .prepare(
        `SELECT i.*, r.orthanc_study_id FROM discovered_instance i
        JOIN logical_report r ON r.source_key = i.source_key AND r.study_uid = i.study_uid
        WHERE i.source_key = ? AND (? IS NULL OR i.sop_uid > ?)
        ORDER BY i.sop_uid COLLATE BINARY LIMIT ?`,
      )
      .all(sourceKey, afterSopUid, afterSopUid, limit) as Array<
      InstanceRow & { orthanc_study_id: string }
    >;
    return rows.map((row) => ({
      ...mapInstance(row, sourceKey),
      orthancStudyId: row.orthanc_study_id,
    }));
  }
}
