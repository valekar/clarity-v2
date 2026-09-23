CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE report_manifest_proofs (
  report_id uuid NOT NULL,
  source_id uuid NOT NULL,
  revision integer NOT NULL,
  source_generation bigint NOT NULL CHECK (source_generation > 0),
  observed_manifest_digest text NOT NULL CHECK (observed_manifest_digest ~ '^[a-f0-9]{64}$'),
  source_observed_at timestamptz NOT NULL,
  source_stable boolean NOT NULL CHECK (source_stable),
  inventory_complete boolean NOT NULL CHECK (inventory_complete),
  sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (report_id, revision),
  FOREIGN KEY (report_id, source_id, revision)
    REFERENCES ingestion_batches(report_id, source_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (source_id, source_generation)
    REFERENCES source_generations(source_id, generation) ON DELETE RESTRICT
);

CREATE FUNCTION guard_manifest_proof_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'sealed source inventory proofs are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER report_manifest_proofs_immutable
  BEFORE UPDATE OR DELETE ON report_manifest_proofs
  FOR EACH ROW EXECUTE FUNCTION guard_manifest_proof_immutable();

CREATE FUNCTION reopen_reports_after_source_generation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE reports r
     SET state = CASE
       WHEN r.has_unresolved_conflict OR r.state = 'needs_attention'
         OR EXISTS (SELECT 1 FROM report_files f WHERE f.report_id = r.id AND f.source_id = r.source_id AND f.state = 'needs_attention')
       THEN 'needs_attention'
       ELSE 'syncing'
     END,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE r.source_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_generation_reopens_reports
  AFTER UPDATE OF generation ON orthanc_sources
  FOR EACH ROW WHEN (OLD.generation IS DISTINCT FROM NEW.generation)
  EXECUTE FUNCTION reopen_reports_after_source_generation();

CREATE OR REPLACE FUNCTION guard_report_ready_state() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_state text;
  v_member_count bigint;
  v_unready_count bigint;
BEGIN
  IF NEW.state = 'ready' THEN
    IF NEW.current_manifest_revision IS NULL OR NEW.has_unresolved_conflict THEN
      RAISE EXCEPTION 'Ready requires a current conflict-free manifest' USING ERRCODE = '23514';
    END IF;
    SELECT state INTO v_batch_state FROM ingestion_batches
     WHERE report_id = NEW.id AND source_id = NEW.source_id
       AND revision = NEW.current_manifest_revision;
    IF v_batch_state IS DISTINCT FROM 'sealed' THEN
      RAISE EXCEPTION 'a Report current manifest must be sealed before Ready' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM report_manifest_proofs p
       WHERE p.report_id = NEW.id AND p.source_id = NEW.source_id
         AND p.revision = NEW.current_manifest_revision
         AND p.source_generation = (SELECT generation FROM orthanc_sources WHERE id = NEW.source_id)
         AND p.source_stable AND p.inventory_complete
    ) THEN
      RAISE EXCEPTION 'Ready requires a current verified source inventory proof' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_member_count FROM ingestion_batch_files
     WHERE report_id = NEW.id AND source_id = NEW.source_id
       AND revision = NEW.current_manifest_revision;
    IF v_member_count = 0 THEN
      RAISE EXCEPTION 'a Report current manifest must be nonempty before Ready' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_unready_count
      FROM ingestion_batch_files m
      LEFT JOIN report_files f
        ON f.report_id = m.report_id AND f.source_id = m.source_id
       AND f.sop_instance_uid = m.sop_instance_uid AND f.sha256 = m.sha256
     WHERE m.report_id = NEW.id AND m.source_id = NEW.source_id
       AND m.revision = NEW.current_manifest_revision
       AND (f.id IS NULL OR f.state <> 'indexed' OR f.cloud_orthanc_instance_id IS NULL);
    IF v_unready_count > 0 THEN
      RAISE EXCEPTION 'every current manifest member must be indexed and conflict-free before Ready' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION require_current_manifest_fence(
  p_source_id uuid,
  p_device_id uuid,
  p_fencing_token bigint,
  p_generation bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source orthanc_sources%ROWTYPE;
  v_device_status text;
BEGIN
  SELECT * INTO v_source FROM orthanc_sources WHERE id = p_source_id FOR SHARE;
  SELECT status INTO v_device_status FROM device_installations
   WHERE source_id = p_source_id AND id = p_device_id FOR SHARE;
  IF v_source.id IS NULL OR v_device_status <> 'paired' OR v_source.status <> 'active'
     OR v_source.generation <> p_generation OR v_source.lease_device_id <> p_device_id
     OR v_source.current_fencing_token <> p_fencing_token
     OR v_source.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'manifest operation has a stale source fence' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION begin_report_manifest_revision(
  p_report_id uuid,
  p_expected_current_revision integer,
  p_expected_report_version bigint,
  p_source_generation bigint,
  p_device_id uuid,
  p_fencing_token bigint
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_report reports%ROWTYPE;
  v_revision integer;
  v_batch ingestion_batches%ROWTYPE;
BEGIN
  SELECT * INTO v_report FROM reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report does not exist' USING ERRCODE = '23503'; END IF;
  PERFORM require_current_manifest_fence(v_report.source_id, p_device_id, p_fencing_token, p_source_generation);
  IF v_report.current_manifest_revision IS DISTINCT FROM p_expected_current_revision
     OR v_report.version <> p_expected_report_version THEN RETURN NULL; END IF;
  v_revision := COALESCE(p_expected_current_revision, 0) + 1;
  SELECT * INTO v_batch FROM ingestion_batches
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = v_revision
   FOR UPDATE;
  IF FOUND THEN
    IF v_batch.state = 'draft' AND v_batch.base_revision IS NOT DISTINCT FROM p_expected_current_revision THEN
      RETURN v_revision;
    END IF;
    RAISE EXCEPTION 'next manifest revision already exists in another state' USING ERRCODE = '23514';
  END IF;
  INSERT INTO ingestion_batches (report_id, source_id, revision, base_revision)
  VALUES (p_report_id, v_report.source_id, v_revision, p_expected_current_revision);
  RETURN v_revision;
END;
$$;

CREATE FUNCTION record_report_manifest_page(
  p_report_id uuid,
  p_revision integer,
  p_expected_report_version bigint,
  p_source_generation bigint,
  p_device_id uuid,
  p_fencing_token bigint,
  p_members jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_report reports%ROWTYPE;
  v_batch ingestion_batches%ROWTYPE;
  v_member_count integer;
  v_matching_count integer;
BEGIN
  IF jsonb_typeof(p_members) <> 'array' OR jsonb_array_length(p_members) < 1
     OR jsonb_array_length(p_members) > 500 THEN
    RAISE EXCEPTION 'manifest pages must contain 1 to 500 members' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_report FROM reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report does not exist' USING ERRCODE = '23503'; END IF;
  PERFORM require_current_manifest_fence(v_report.source_id, p_device_id, p_fencing_token, p_source_generation);
  IF v_report.version <> p_expected_report_version THEN RETURN 0; END IF;
  SELECT * INTO v_batch FROM ingestion_batches
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = p_revision
   FOR UPDATE;
  IF NOT FOUND OR v_batch.state <> 'draft'
     OR v_batch.base_revision IS DISTINCT FROM v_report.current_manifest_revision THEN
    RAISE EXCEPTION 'manifest page does not target the current draft revision' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_member_count FROM jsonb_to_recordset(p_members)
    AS x("sopInstanceUid" text, sha256 text);
  IF v_member_count <> jsonb_array_length(p_members)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_members) e WHERE jsonb_typeof(e) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 2) THEN
    RAISE EXCEPTION 'manifest page member shape is invalid' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_matching_count
    FROM jsonb_to_recordset(p_members) AS x("sopInstanceUid" text, sha256 text)
    JOIN report_files f ON f.report_id = p_report_id AND f.source_id = v_report.source_id
      AND f.sop_instance_uid = x."sopInstanceUid" AND f.sha256 = x.sha256
    JOIN dicom_uid_registry u ON u.uid_value = f.sop_instance_uid AND u.uid_type = 'sop'
      AND u.source_id = f.source_id AND u.report_id = f.report_id
      AND u.report_file_id = f.id AND u.sha256 = f.sha256
   WHERE x."sopInstanceUid" ~ '^[0-9]+([.][0-9]+)*$'
     AND x.sha256 ~ '^[a-f0-9]{64}$' AND f.state <> 'needs_attention';
  IF v_matching_count <> v_member_count THEN
    RAISE EXCEPTION 'manifest page differs from reserved source files' USING ERRCODE = '23514';
  END IF;
  INSERT INTO ingestion_batch_files (report_id, source_id, revision, sop_instance_uid, sha256)
    SELECT p_report_id, v_report.source_id, p_revision, x."sopInstanceUid", x.sha256
      FROM jsonb_to_recordset(p_members) AS x("sopInstanceUid" text, sha256 text)
    ON CONFLICT (report_id, revision, sop_instance_uid) DO NOTHING;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_members) AS x("sopInstanceUid" text, sha256 text)
    LEFT JOIN ingestion_batch_files m ON m.report_id = p_report_id AND m.revision = p_revision
      AND m.sop_instance_uid = x."sopInstanceUid" AND m.sha256 = x.sha256
    WHERE m.report_id IS NULL
  ) THEN RAISE EXCEPTION 'manifest retry conflicts with existing member' USING ERRCODE = '23514'; END IF;
  RETURN v_member_count;
END;
$$;

CREATE FUNCTION seal_observed_report_manifest(
  p_report_id uuid,
  p_revision integer,
  p_expected_current_revision integer,
  p_expected_report_version bigint,
  p_source_generation bigint,
  p_device_id uuid,
  p_fencing_token bigint,
  p_source_observed_at timestamptz,
  p_source_stable boolean,
  p_inventory_complete boolean,
  p_observed_manifest_digest text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_report reports%ROWTYPE;
  v_batch ingestion_batches%ROWTYPE;
  v_manifest_json text;
  v_digest text;
  v_count bigint;
  v_sealed boolean;
BEGIN
  IF p_source_stable IS DISTINCT FROM true OR p_inventory_complete IS DISTINCT FROM true
     OR p_source_observed_at IS NULL OR p_source_observed_at > clock_timestamp()
     OR p_source_observed_at < clock_timestamp() - interval '10 minutes'
     OR p_observed_manifest_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'sealing requires fresh stable complete inventory evidence' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_report FROM reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report does not exist' USING ERRCODE = '23503'; END IF;
  PERFORM require_current_manifest_fence(v_report.source_id, p_device_id, p_fencing_token, p_source_generation);
  IF v_report.current_manifest_revision IS DISTINCT FROM p_expected_current_revision
     OR v_report.version <> p_expected_report_version THEN RETURN false; END IF;
  SELECT * INTO v_batch FROM ingestion_batches
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = p_revision
   FOR UPDATE;
  IF NOT FOUND OR v_batch.state <> 'draft'
     OR v_batch.base_revision IS DISTINCT FROM p_expected_current_revision
     OR p_revision <> COALESCE(p_expected_current_revision, 0) + 1 THEN RETURN false; END IF;
  SELECT count(*), '[' || string_agg(
      format('{"sopInstanceUid":"%s","sha256":"%s"}', sop_instance_uid, sha256),
      ',' ORDER BY sop_instance_uid COLLATE "C") || ']'
    INTO v_count, v_manifest_json
    FROM ingestion_batch_files
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = p_revision;
  IF v_count = 0 THEN RAISE EXCEPTION 'cannot seal an empty observed manifest' USING ERRCODE = '23514'; END IF;
  v_digest := encode(digest(convert_to(v_manifest_json, 'UTF8'), 'sha256'), 'hex');
  IF v_digest <> p_observed_manifest_digest THEN
    RAISE EXCEPTION 'assembled manifest differs from fresh source inventory' USING ERRCODE = '23514';
  END IF;
  v_sealed := seal_report_revision(p_report_id, p_expected_current_revision, p_expected_report_version,
    p_revision, p_source_generation, true, true, v_digest);
  IF NOT v_sealed THEN RETURN false; END IF;
  INSERT INTO report_manifest_proofs (
    report_id, source_id, revision, source_generation, observed_manifest_digest,
    source_observed_at, source_stable, inventory_complete
  ) VALUES (
    p_report_id, v_report.source_id, p_revision, p_source_generation, v_digest,
    p_source_observed_at, true, true
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION require_current_manifest_fence(uuid, uuid, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_report_manifest_revision(uuid, integer, bigint, bigint, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_report_manifest_page(uuid, integer, bigint, bigint, uuid, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION seal_observed_report_manifest(uuid, integer, integer, bigint, bigint, uuid, bigint, timestamptz, boolean, boolean, text) FROM PUBLIC;
REVOKE ALL ON report_manifest_proofs FROM PUBLIC;
GRANT EXECUTE ON FUNCTION begin_report_manifest_revision(uuid, integer, bigint, bigint, uuid, bigint) TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION record_report_manifest_page(uuid, integer, bigint, bigint, uuid, bigint, jsonb) TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION seal_observed_report_manifest(uuid, integer, integer, bigint, bigint, uuid, bigint, timestamptz, boolean, boolean, text) TO clarity_v2_device_auth;
