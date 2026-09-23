export const discoverySchema = `
  CREATE TABLE IF NOT EXISTS logical_report (
    source_key TEXT NOT NULL,
    study_uid TEXT NOT NULL,
    orthanc_study_id TEXT NOT NULL,
    patient_id TEXT,
    patient_issuer_of_patient_id TEXT,
    patient_name TEXT,
    patient_birth_date TEXT,
    patient_sex TEXT,
    study_date TEXT,
    study_time TEXT,
    study_description TEXT,
    accession_number TEXT,
    modalities TEXT,
    source_missing INTEGER NOT NULL DEFAULT 0 CHECK (source_missing IN (0, 1)),
    last_seen_run TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_key, study_uid),
    FOREIGN KEY (source_key) REFERENCES source_checkpoint(source_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS discovered_instance (
    source_key TEXT NOT NULL,
    study_uid TEXT NOT NULL,
    sop_uid TEXT NOT NULL,
    orthanc_instance_id TEXT NOT NULL,
    series_uid TEXT,
    source_missing INTEGER NOT NULL DEFAULT 0 CHECK (source_missing IN (0, 1)),
    last_seen_run TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_key, sop_uid),
    FOREIGN KEY (source_key, study_uid) REFERENCES logical_report(source_key, study_uid)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS discovered_instance_report
    ON discovered_instance(source_key, study_uid);
  CREATE TABLE IF NOT EXISTS inventory_run (
    id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'periodic')),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    cursor_start INTEGER NOT NULL CHECK (cursor_start >= 0),
    feed_horizon INTEGER CHECK (feed_horizon IS NULL OR feed_horizon >= 0),
    feed_done_at_horizon INTEGER CHECK (feed_done_at_horizon IS NULL OR feed_done_at_horizon IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('scanning-studies', 'scanning-instances', 'revalidating', 'awaiting-replay', 'complete')),
    next_study_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_study_offset >= 0),
    active_study_id TEXT,
    next_instance_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_instance_offset >= 0),
    last_instance_id TEXT,
    upper_instance_id TEXT,
    upper_bound_captured INTEGER NOT NULL DEFAULT 0 CHECK (upper_bound_captured IN (0, 1)),
    revalidation_after_sop_uid TEXT,
    revalidation_upper_sop_uid TEXT,
    reconcile_job_id INTEGER,
    previous_pass_id TEXT,
    verified_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (verified_snapshot IN (0, 1)),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (source_key) REFERENCES source_checkpoint(source_key),
    FOREIGN KEY (reconcile_job_id) REFERENCES capture_job(id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS inventory_run_active
    ON inventory_run(source_key, kind, status);
  CREATE TABLE IF NOT EXISTS inventory_pass_seen (
    source_key TEXT NOT NULL,
    pass_id TEXT NOT NULL,
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('study', 'instance')),
    resource_uid TEXT NOT NULL,
    PRIMARY KEY (source_key, pass_id, resource_kind, resource_uid),
    FOREIGN KEY (source_key) REFERENCES source_checkpoint(source_key)
  ) STRICT;
`;
