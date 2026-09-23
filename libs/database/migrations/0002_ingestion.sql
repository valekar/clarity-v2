CREATE TABLE ingestion_batches (
  report_id uuid NOT NULL,
  source_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  base_revision integer,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'sealed')),
  manifest_digest text CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed_at timestamptz,
  FOREIGN KEY (report_id, source_id) REFERENCES reports(id, source_id) ON DELETE RESTRICT,
  UNIQUE (report_id, source_id, revision),
  CHECK (
    (base_revision IS NULL AND revision = 1)
    OR (base_revision IS NOT NULL AND base_revision > 0 AND revision = base_revision + 1)
  ),
  CHECK ((state = 'draft' AND sealed_at IS NULL AND manifest_digest IS NULL) OR (state = 'sealed' AND sealed_at IS NOT NULL AND manifest_digest IS NOT NULL))
);

CREATE TABLE ingestion_batch_files (
  report_id uuid NOT NULL,
  source_id uuid NOT NULL,
  revision integer NOT NULL,
  sop_instance_uid varchar(64) NOT NULL
    CHECK (sop_instance_uid ~ '^[0-9]+([.][0-9]+)*$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (report_id, revision, sop_instance_uid),
  FOREIGN KEY (report_id, source_id, revision)
    REFERENCES ingestion_batches(report_id, source_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (report_id, source_id, sop_instance_uid, sha256)
    REFERENCES report_files(report_id, source_id, sop_instance_uid, sha256) ON DELETE RESTRICT
);

ALTER TABLE ingestion_batches
  ADD CONSTRAINT ingestion_batches_base_revision_fk
  FOREIGN KEY (report_id, source_id, base_revision)
  REFERENCES ingestion_batches(report_id, source_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE reports
  ADD CONSTRAINT reports_current_manifest_fk
  FOREIGN KEY (id, source_id, current_manifest_revision)
  REFERENCES ingestion_batches(report_id, source_id, revision)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guard_manifest_batch_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state <> 'draft' OR NEW.manifest_digest IS NOT NULL OR NEW.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a manifest revision must be inserted as an empty draft' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_batches_insert_as_draft
  BEFORE INSERT ON ingestion_batches
  FOR EACH ROW EXECUTE FUNCTION guard_manifest_batch_insert();

CREATE FUNCTION guard_report_ready_state() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_state text;
  v_member_count bigint;
  v_unready_count bigint;
BEGIN
  IF NEW.state = 'ready' THEN
    IF NEW.current_manifest_revision IS NULL THEN
      RAISE EXCEPTION 'a Report needs a current sealed manifest before Ready' USING ERRCODE = '23514';
    END IF;
    IF NEW.has_unresolved_conflict THEN
      RAISE EXCEPTION 'a Report with unresolved conflicts cannot be Ready' USING ERRCODE = '23514';
    END IF;
    SELECT state INTO v_batch_state FROM ingestion_batches
     WHERE report_id = NEW.id AND source_id = NEW.source_id
       AND revision = NEW.current_manifest_revision;
    IF v_batch_state IS DISTINCT FROM 'sealed' THEN
      RAISE EXCEPTION 'a Report current manifest must be sealed before Ready' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_member_count FROM ingestion_batch_files
     WHERE report_id = NEW.id AND source_id = NEW.source_id
       AND revision = NEW.current_manifest_revision;
    IF v_member_count = 0 THEN
      RAISE EXCEPTION 'a Report current manifest must be nonempty before Ready' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_unready_count
      FROM ingestion_batch_files m
      JOIN report_files f
        ON f.report_id = m.report_id
       AND f.source_id = m.source_id
       AND f.sop_instance_uid = m.sop_instance_uid
       AND f.sha256 = m.sha256
     WHERE m.report_id = NEW.id
       AND m.source_id = NEW.source_id
       AND m.revision = NEW.current_manifest_revision
       AND (f.state <> 'indexed' OR f.cloud_orthanc_instance_id IS NULL);
    IF v_unready_count > 0 THEN
      RAISE EXCEPTION 'every current manifest member must be indexed and conflict-free before Ready' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reports_ready_requires_complete_revision
  BEFORE INSERT OR UPDATE OF state, current_manifest_revision, has_unresolved_conflict ON reports
  FOR EACH ROW EXECUTE FUNCTION guard_report_ready_state();

CREATE FUNCTION seal_report_revision(
  p_report_id uuid,
  p_expected_current_revision integer,
  p_expected_report_version bigint,
  p_new_revision integer,
  p_source_generation bigint,
  p_source_stable boolean,
  p_inventory_complete boolean,
  p_manifest_digest text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_report reports%ROWTYPE;
  v_batch ingestion_batches%ROWTYPE;
  v_current_generation bigint;
  v_changed integer;
BEGIN
  IF p_source_stable IS DISTINCT FROM true OR p_inventory_complete IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sealing requires a fresh stable complete source inventory' USING ERRCODE = '23514';
  END IF;
  IF p_manifest_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'manifest digest must be lowercase SHA-256' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_report FROM reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report does not exist' USING ERRCODE = '23503'; END IF;
  IF v_report.current_manifest_revision IS DISTINCT FROM p_expected_current_revision
     OR v_report.version <> p_expected_report_version THEN
    RETURN false;
  END IF;
  IF p_new_revision <> COALESCE(p_expected_current_revision, 0) + 1 THEN
    RAISE EXCEPTION 'new revision must follow the expected current revision' USING ERRCODE = '23514';
  END IF;
  SELECT generation INTO v_current_generation
    FROM orthanc_sources WHERE id = v_report.source_id FOR SHARE;
  IF v_current_generation IS DISTINCT FROM p_source_generation THEN RETURN false; END IF;
  SELECT * INTO v_batch FROM ingestion_batches
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = p_new_revision
   FOR UPDATE;
  IF NOT FOUND OR v_batch.state <> 'draft'
     OR v_batch.base_revision IS DISTINCT FROM p_expected_current_revision THEN
    RETURN false;
  END IF;
  UPDATE ingestion_batches
     SET state = 'sealed', manifest_digest = p_manifest_digest, sealed_at = clock_timestamp()
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = p_new_revision;
  UPDATE reports
     SET current_manifest_revision = p_new_revision,
         state = 'syncing',
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE id = p_report_id AND version = p_expected_report_version
     AND current_manifest_revision IS NOT DISTINCT FROM p_expected_current_revision;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN RAISE EXCEPTION 'Report CAS changed during seal' USING ERRCODE = '40001'; END IF;
  RETURN true;
END;
$$;

CREATE TABLE dicom_uid_registry (
  uid_value varchar(64) PRIMARY KEY CHECK (uid_value ~ '^[0-9]+([.][0-9]+)*$'),
  uid_type text NOT NULL CHECK (uid_type IN ('study', 'series', 'sop')),
  source_id uuid NOT NULL,
  report_id uuid NOT NULL,
  report_file_id uuid,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (report_id, source_id) REFERENCES reports(id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (report_file_id, report_id, source_id)
    REFERENCES report_files(id, report_id, source_id) ON DELETE RESTRICT,
  UNIQUE (uid_value, report_id, source_id),
  CHECK (
    (uid_type = 'sop' AND report_file_id IS NOT NULL AND sha256 IS NOT NULL)
    OR (uid_type IN ('study', 'series') AND report_file_id IS NULL)
  )
);

CREATE TABLE ingestion_uploads (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL,
  report_id uuid NOT NULL,
  report_file_id uuid NOT NULL,
  device_installation_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  admission_key uuid NOT NULL,
  declared_size_bytes bigint NOT NULL CHECK (declared_size_bytes > 0),
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE CHECK (length(trim(object_key)) > 0),
  multipart_upload_id text,
  status text NOT NULL DEFAULT 'admitted'
    CHECK (status IN ('admitted', 'uploading', 'received', 'completed', 'aborted', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (report_file_id, report_id, source_id)
    REFERENCES report_files(id, report_id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id, device_installation_id)
    REFERENCES device_installations(source_id, id) ON DELETE RESTRICT,
  UNIQUE (source_id, admission_key)
);

CREATE UNIQUE INDEX ingestion_uploads_one_active_per_file
  ON ingestion_uploads(report_file_id)
  WHERE status IN ('admitted', 'uploading', 'received');

CREATE FUNCTION validate_dicom_uid_owner() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_expected_uid text;
  v_expected_sha256 text;
BEGIN
  IF NEW.uid_type = 'study' THEN
    SELECT study_instance_uid INTO v_expected_uid
      FROM reports WHERE id = NEW.report_id AND source_id = NEW.source_id;
  ELSIF NEW.uid_type = 'series' THEN
    SELECT series_instance_uid INTO v_expected_uid
      FROM report_files
     WHERE report_id = NEW.report_id AND source_id = NEW.source_id
       AND series_instance_uid = NEW.uid_value
     LIMIT 1;
  ELSE
    SELECT sop_instance_uid, sha256 INTO v_expected_uid, v_expected_sha256
      FROM report_files
     WHERE id = NEW.report_file_id AND report_id = NEW.report_id AND source_id = NEW.source_id;
  END IF;
  IF v_expected_uid IS DISTINCT FROM NEW.uid_value THEN
    RAISE EXCEPTION 'DICOM UID is not owned by the stated Report/source' USING ERRCODE = '23514';
  END IF;
  IF NEW.uid_type = 'sop' AND NEW.sha256 IS DISTINCT FROM v_expected_sha256 THEN
    RAISE EXCEPTION 'SOP UID digest differs from the Report file' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dicom_uid_registry_validate_owner
  BEFORE INSERT ON dicom_uid_registry
  FOR EACH ROW EXECUTE FUNCTION validate_dicom_uid_owner();

CREATE FUNCTION dicom_uid_registry_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'DICOM UID ownership reservations are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER dicom_uid_registry_no_mutation
  BEFORE UPDATE OR DELETE ON dicom_uid_registry
  FOR EACH ROW EXECUTE FUNCTION dicom_uid_registry_immutable();

CREATE FUNCTION acquire_source_lease(
  p_source_id uuid,
  p_device_id uuid,
  p_lease_expires_at timestamptz
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_source orthanc_sources%ROWTYPE;
  v_device_status text;
  v_next_token bigint;
BEGIN
  IF p_lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'lease expiry must be in the future' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_source FROM orthanc_sources WHERE id = p_source_id FOR UPDATE;
  IF NOT FOUND OR v_source.status <> 'active' THEN
    RAISE EXCEPTION 'source is unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO v_device_status
    FROM device_installations WHERE id = p_device_id AND source_id = p_source_id
    FOR SHARE;
  IF v_device_status IS DISTINCT FROM 'paired' THEN
    RAISE EXCEPTION 'device is not paired to this source' USING ERRCODE = '23514';
  END IF;
  IF v_source.lease_device_id IS NOT NULL
     AND v_source.lease_expires_at > clock_timestamp()
     AND v_source.lease_device_id <> p_device_id THEN
    RAISE EXCEPTION 'source lease is held by another device' USING ERRCODE = '23514';
  END IF;
  IF v_source.lease_device_id IS DISTINCT FROM p_device_id
     OR v_source.lease_expires_at <= clock_timestamp() THEN
    v_next_token := v_source.current_fencing_token + 1;
  ELSE
    v_next_token := v_source.current_fencing_token;
  END IF;
  UPDATE orthanc_sources
     SET lease_device_id = p_device_id,
         lease_expires_at = p_lease_expires_at,
         current_fencing_token = v_next_token,
         version = version + 1
   WHERE id = p_source_id;
  RETURN v_next_token;
END;
$$;

CREATE FUNCTION reject_conflicting_file_digest() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'file digest cannot be replaced' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER report_files_digest_immutable
  BEFORE UPDATE OF sha256 ON report_files
  FOR EACH ROW EXECUTE FUNCTION reject_conflicting_file_digest();

CREATE FUNCTION guard_manifest_batch_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_member_count bigint;
BEGIN
  IF NEW.report_id IS DISTINCT FROM OLD.report_id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.base_revision IS DISTINCT FROM OLD.base_revision THEN
    RAISE EXCEPTION 'manifest revision identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'sealed' THEN
    RAISE EXCEPTION 'sealed manifest revision is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'sealed' THEN
    SELECT count(*) INTO v_member_count
      FROM ingestion_batch_files
     WHERE report_id = OLD.report_id AND revision = OLD.revision;
    IF v_member_count = 0 THEN
      RAISE EXCEPTION 'cannot seal an empty manifest' USING ERRCODE = '23514';
    END IF;
    IF NEW.manifest_digest IS NULL OR NEW.sealed_at IS NULL THEN
      RAISE EXCEPTION 'sealed manifest requires digest and timestamp' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_batches_guard_update
  BEFORE UPDATE ON ingestion_batches
  FOR EACH ROW EXECUTE FUNCTION guard_manifest_batch_update();

CREATE FUNCTION guard_manifest_member_write() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_report_id uuid;
  v_revision integer;
  v_state text;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
    v_report_id := OLD.report_id;
    v_revision := OLD.revision;
    IF TG_OP = 'UPDATE' AND (
      NEW.report_id IS DISTINCT FROM OLD.report_id
      OR NEW.source_id IS DISTINCT FROM OLD.source_id
      OR NEW.revision IS DISTINCT FROM OLD.revision
      OR NEW.sop_instance_uid IS DISTINCT FROM OLD.sop_instance_uid
    ) THEN
      RAISE EXCEPTION 'manifest member identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    v_report_id := NEW.report_id;
    v_revision := NEW.revision;
  END IF;
  SELECT state INTO v_state FROM ingestion_batches
   WHERE report_id = v_report_id AND revision = v_revision
   FOR UPDATE;
  IF v_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'manifest members can only change while draft' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_batch_files_guard_write
  BEFORE INSERT OR UPDATE OR DELETE ON ingestion_batch_files
  FOR EACH ROW EXECUTE FUNCTION guard_manifest_member_write();

CREATE FUNCTION guard_upload_fence() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source orthanc_sources%ROWTYPE;
  v_device_status text;
BEGIN
  IF current_user = 'clarity_v2_migrator' AND session_user <> current_user THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_source FROM orthanc_sources WHERE id = NEW.source_id FOR SHARE;
  SELECT status INTO v_device_status
    FROM device_installations
   WHERE id = NEW.device_installation_id AND source_id = NEW.source_id
   FOR SHARE;
  IF NOT FOUND
     OR v_source.status <> 'active'
     OR v_device_status <> 'paired'
     OR v_source.lease_device_id IS DISTINCT FROM NEW.device_installation_id
     OR v_source.current_fencing_token <> NEW.fencing_token
     OR v_source.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'upload admission has a stale or expired source fence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_uploads_current_fence
  BEFORE INSERT OR UPDATE ON ingestion_uploads
  FOR EACH ROW EXECUTE FUNCTION guard_upload_fence();

CREATE FUNCTION guard_upload_identity_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.report_id IS DISTINCT FROM OLD.report_id
     OR NEW.report_file_id IS DISTINCT FROM OLD.report_file_id
     OR NEW.device_installation_id IS DISTINCT FROM OLD.device_installation_id
     OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
     OR NEW.admission_key IS DISTINCT FROM OLD.admission_key
     OR NEW.declared_size_bytes IS DISTINCT FROM OLD.declared_size_bytes
     OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'upload admission identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ingestion_uploads_identity_immutable
  BEFORE UPDATE ON ingestion_uploads
  FOR EACH ROW EXECUTE FUNCTION guard_upload_identity_update();

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE FUNCTION reconcile_ingestion_upload_status(
  p_upload_id uuid,
  p_expected_status text,
  p_next_status text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_changed integer;
BEGIN
  IF NOT (
    (p_expected_status IN ('admitted', 'uploading', 'received') AND p_next_status IN ('aborted', 'expired'))
    OR (p_expected_status = 'received' AND p_next_status = 'completed')
  ) THEN
    RAISE EXCEPTION 'unsupported trusted upload reconciliation transition' USING ERRCODE = '23514';
  END IF;
  UPDATE public.ingestion_uploads
     SET status = p_next_status
   WHERE id = p_upload_id AND status = p_expected_status;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION acquire_source_lease(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION advance_source_generation(uuid, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION seal_report_revision(uuid, integer, bigint, integer, bigint, boolean, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reconcile_ingestion_upload_status(uuid, text, text) FROM PUBLIC;
