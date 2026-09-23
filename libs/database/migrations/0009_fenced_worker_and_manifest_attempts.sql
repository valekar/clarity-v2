ALTER TABLE public.ingestion_uploads
  ADD COLUMN source_generation bigint NOT NULL DEFAULT 1 CHECK (source_generation > 0);

ALTER TABLE public.ingestion_batches
  ADD COLUMN source_generation bigint NOT NULL DEFAULT 1 CHECK (source_generation > 0),
  ADD COLUMN inventory_attempt_id uuid;

CREATE OR REPLACE FUNCTION public.require_current_manifest_fence(
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
  v_source public.orthanc_sources%ROWTYPE;
  v_device_status text;
BEGIN
  IF p_source_id IS NULL OR p_device_id IS NULL OR p_fencing_token IS NULL OR p_generation IS NULL THEN
    RAISE EXCEPTION 'manifest fence fields are required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = p_source_id FOR SHARE;
  SELECT d.status INTO v_device_status FROM public.device_installations d
   WHERE d.source_id = p_source_id AND d.id = p_device_id FOR SHARE;
  IF v_source.id IS NULL OR v_device_status IS DISTINCT FROM 'paired'
     OR v_source.status IS DISTINCT FROM 'active'
     OR v_source.generation IS DISTINCT FROM p_generation
     OR v_source.lease_device_id IS DISTINCT FROM p_device_id
     OR v_source.current_fencing_token IS DISTINCT FROM p_fencing_token
     OR v_source.lease_expires_at IS NULL
     OR v_source.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'manifest operation has a stale source fence' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_report_manifest_revision(
  p_report_id uuid,
  p_expected_current_revision integer,
  p_expected_report_version bigint,
  p_source_generation bigint,
  p_device_id uuid,
  p_fencing_token bigint,
  p_inventory_attempt_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_report public.reports%ROWTYPE;
  v_revision integer;
  v_batch public.ingestion_batches%ROWTYPE;
BEGIN
  IF p_inventory_attempt_id IS NULL THEN
    RAISE EXCEPTION 'manifest inventory attempt ID is required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_report FROM public.reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report does not exist' USING ERRCODE = '23503'; END IF;
  PERFORM public.require_current_manifest_fence(v_report.source_id, p_device_id, p_fencing_token, p_source_generation);
  IF v_report.current_manifest_revision IS DISTINCT FROM p_expected_current_revision
     OR v_report.version IS DISTINCT FROM p_expected_report_version THEN RETURN NULL; END IF;
  v_revision := COALESCE(p_expected_current_revision, 0) + 1;
  SELECT * INTO v_batch FROM public.ingestion_batches
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = v_revision
   FOR UPDATE;
  IF FOUND THEN
    IF v_batch.state <> 'draft' OR v_batch.base_revision IS DISTINCT FROM p_expected_current_revision THEN
      RAISE EXCEPTION 'next manifest revision already exists in another state' USING ERRCODE = '23514';
    END IF;
    IF v_batch.inventory_attempt_id IS DISTINCT FROM p_inventory_attempt_id
       OR v_batch.source_generation IS DISTINCT FROM p_source_generation THEN
      DELETE FROM public.ingestion_batch_files
       WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = v_revision;
      UPDATE public.ingestion_batches
         SET inventory_attempt_id = p_inventory_attempt_id, source_generation = p_source_generation,
             created_at = clock_timestamp()
       WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = v_revision;
    END IF;
    RETURN v_revision;
  END IF;
  INSERT INTO public.ingestion_batches (
    report_id, source_id, revision, base_revision, source_generation, inventory_attempt_id
  ) VALUES (
    p_report_id, v_report.source_id, v_revision, p_expected_current_revision,
    p_source_generation, p_inventory_attempt_id
  );
  RETURN v_revision;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_report_manifest_page(
  p_report_id uuid,
  p_revision integer,
  p_expected_report_version bigint,
  p_source_generation bigint,
  p_device_id uuid,
  p_fencing_token bigint,
  p_members jsonb,
  p_inventory_attempt_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_report public.reports%ROWTYPE;
  v_batch public.ingestion_batches%ROWTYPE;
  v_member_count integer;
  v_matching_count integer;
BEGIN
  IF p_inventory_attempt_id IS NULL OR p_members IS NULL OR jsonb_typeof(p_members) <> 'array'
     OR jsonb_array_length(p_members) < 1 OR jsonb_array_length(p_members) > 500 THEN
    RAISE EXCEPTION 'manifest page attempt or member count is invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_report FROM public.reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report does not exist' USING ERRCODE = '23503'; END IF;
  PERFORM public.require_current_manifest_fence(v_report.source_id, p_device_id, p_fencing_token, p_source_generation);
  IF v_report.version IS DISTINCT FROM p_expected_report_version THEN RETURN 0; END IF;
  SELECT * INTO v_batch FROM public.ingestion_batches
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = p_revision FOR UPDATE;
  IF NOT FOUND OR v_batch.state <> 'draft'
     OR v_batch.base_revision IS DISTINCT FROM v_report.current_manifest_revision
     OR v_batch.source_generation <> p_source_generation
     OR v_batch.inventory_attempt_id IS DISTINCT FROM p_inventory_attempt_id THEN
    RAISE EXCEPTION 'manifest page does not target the active draft attempt' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_member_count FROM jsonb_to_recordset(p_members) AS x("sopInstanceUid" text, sha256 text);
  IF v_member_count <> jsonb_array_length(p_members)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_members) e
       WHERE jsonb_typeof(e) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 2) THEN
    RAISE EXCEPTION 'manifest page member shape is invalid' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_matching_count
    FROM jsonb_to_recordset(p_members) AS x("sopInstanceUid" text, sha256 text)
    JOIN public.report_files f ON f.report_id = p_report_id AND f.source_id = v_report.source_id
      AND f.sop_instance_uid = x."sopInstanceUid" AND f.sha256 = x.sha256
    JOIN public.dicom_uid_registry u ON u.uid_value = f.sop_instance_uid AND u.uid_type = 'sop'
      AND u.source_id = f.source_id AND u.report_id = f.report_id
      AND u.report_file_id = f.id AND u.sha256 = f.sha256
   WHERE x."sopInstanceUid" ~ '^[0-9]+([.][0-9]+)*$'
     AND x.sha256 ~ '^[a-f0-9]{64}$' AND f.state <> 'needs_attention';
  IF v_matching_count <> v_member_count THEN
    RAISE EXCEPTION 'manifest page differs from reserved source files' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.ingestion_batch_files (report_id, source_id, revision, sop_instance_uid, sha256)
    SELECT p_report_id, v_report.source_id, p_revision, x."sopInstanceUid", x.sha256
      FROM jsonb_to_recordset(p_members) AS x("sopInstanceUid" text, sha256 text)
    ON CONFLICT (report_id, revision, sop_instance_uid) DO NOTHING;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_members) AS x("sopInstanceUid" text, sha256 text)
    LEFT JOIN public.ingestion_batch_files m ON m.report_id = p_report_id AND m.revision = p_revision
      AND m.sop_instance_uid = x."sopInstanceUid" AND m.sha256 = x.sha256
    WHERE m.report_id IS NULL
  ) THEN RAISE EXCEPTION 'manifest retry conflicts with existing member' USING ERRCODE = '23514'; END IF;
  RETURN v_member_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.seal_observed_report_manifest(
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
  p_observed_manifest_digest text,
  p_inventory_attempt_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_report public.reports%ROWTYPE;
  v_batch public.ingestion_batches%ROWTYPE;
  v_manifest_json text;
  v_digest text;
  v_count bigint;
  v_sealed boolean;
BEGIN
  IF p_inventory_attempt_id IS NULL OR p_source_stable IS DISTINCT FROM true
     OR p_inventory_complete IS DISTINCT FROM true OR p_source_observed_at IS NULL
     OR p_source_observed_at > clock_timestamp()
     OR p_source_observed_at < clock_timestamp() - interval '10 minutes'
     OR p_observed_manifest_digest IS NULL
     OR p_observed_manifest_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'sealing requires fresh stable complete inventory evidence' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_report FROM public.reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report does not exist' USING ERRCODE = '23503'; END IF;
  PERFORM public.require_current_manifest_fence(v_report.source_id, p_device_id, p_fencing_token, p_source_generation);
  IF v_report.current_manifest_revision IS DISTINCT FROM p_expected_current_revision
     OR v_report.version IS DISTINCT FROM p_expected_report_version THEN RETURN false; END IF;
  SELECT * INTO v_batch FROM public.ingestion_batches
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = p_revision FOR UPDATE;
  IF NOT FOUND OR v_batch.state <> 'draft'
     OR v_batch.base_revision IS DISTINCT FROM p_expected_current_revision
     OR v_batch.source_generation <> p_source_generation
     OR v_batch.inventory_attempt_id IS DISTINCT FROM p_inventory_attempt_id
     OR p_revision <> COALESCE(p_expected_current_revision, 0) + 1 THEN RETURN false; END IF;
  SELECT count(*), '[' || string_agg(
      format('{"sopInstanceUid":"%s","sha256":"%s"}', sop_instance_uid, sha256),
      ',' ORDER BY sop_instance_uid COLLATE "C") || ']'
    INTO v_count, v_manifest_json FROM public.ingestion_batch_files
   WHERE report_id = p_report_id AND source_id = v_report.source_id AND revision = p_revision;
  IF v_count = 0 THEN RAISE EXCEPTION 'cannot seal an empty observed manifest' USING ERRCODE = '23514'; END IF;
  v_digest := encode(digest(convert_to(v_manifest_json, 'UTF8'), 'sha256'), 'hex');
  IF v_digest IS DISTINCT FROM p_observed_manifest_digest THEN
    RAISE EXCEPTION 'assembled manifest differs from fresh source inventory' USING ERRCODE = '23514';
  END IF;
  v_sealed := public.seal_report_revision(p_report_id, p_expected_current_revision, p_expected_report_version,
    p_revision, p_source_generation, true, true, v_digest);
  IF NOT v_sealed THEN RETURN false; END IF;
  INSERT INTO public.report_manifest_proofs (
    report_id, source_id, revision, source_generation, observed_manifest_digest,
    source_observed_at, source_stable, inventory_complete
  ) VALUES (
    p_report_id, v_report.source_id, p_revision, p_source_generation, v_digest,
    p_source_observed_at, true, true
  );
  RETURN true;
END;
$$;

CREATE FUNCTION public.authorize_ingestion_import(p_upload_id uuid) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_upload public.ingestion_uploads%ROWTYPE;
  v_source public.orthanc_sources%ROWTYPE;
  v_device_status text;
BEGIN
  SELECT * INTO v_upload FROM public.ingestion_uploads WHERE id = p_upload_id FOR UPDATE;
  IF NOT FOUND OR v_upload.status <> 'received' THEN RETURN false; END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = v_upload.source_id FOR SHARE;
  SELECT d.status INTO v_device_status FROM public.device_installations d
   WHERE d.id = v_upload.device_installation_id AND d.source_id = v_upload.source_id FOR SHARE;
  IF v_source.id IS NULL OR v_source.status IS DISTINCT FROM 'active'
     OR v_source.generation IS DISTINCT FROM v_upload.source_generation
     OR v_source.current_fencing_token IS DISTINCT FROM v_upload.fencing_token
     OR v_device_status IS DISTINCT FROM 'paired' THEN
    UPDATE public.report_files SET state = 'needs_attention', updated_at = clock_timestamp()
     WHERE id = v_upload.report_file_id AND state NOT IN ('indexed', 'needs_attention');
    UPDATE public.reports SET state = 'needs_attention', version = version + 1, updated_at = clock_timestamp()
     WHERE id = v_upload.report_id AND state IS DISTINCT FROM 'needs_attention';
    UPDATE public.ingestion_uploads SET status = 'aborted' WHERE id = v_upload.id;
    RETURN false;
  END IF;
  -- Lease expiry alone does not invalidate an already received object. A revoke,
  -- source disable, generation change or fencing-token takeover does.
  RETURN true;
END;
$$;

CREATE FUNCTION public.complete_ingestion_import_fenced(
  p_upload_id uuid,
  p_expected_sha256 text,
  p_cloud_instance_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_upload public.ingestion_uploads%ROWTYPE;
  v_source public.orthanc_sources%ROWTYPE;
  v_device_status text;
BEGIN
  IF p_upload_id IS NULL OR p_expected_sha256 IS NULL
     OR p_expected_sha256 !~ '^[a-f0-9]{64}$'
     OR p_cloud_instance_id IS NULL OR length(trim(p_cloud_instance_id)) = 0 THEN
    RAISE EXCEPTION 'worker completion fields are required and bounded' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_upload FROM public.ingestion_uploads WHERE id = p_upload_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload does not exist' USING ERRCODE = '23503'; END IF;
  IF v_upload.status = 'completed' THEN
    RETURN public.complete_ingestion_import(p_upload_id, p_expected_sha256, p_cloud_instance_id);
  END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = v_upload.source_id FOR SHARE;
  SELECT d.status INTO v_device_status FROM public.device_installations d
   WHERE d.id = v_upload.device_installation_id AND d.source_id = v_upload.source_id FOR SHARE;
  IF v_source.id IS NULL OR v_source.status IS DISTINCT FROM 'active'
     OR v_source.generation IS DISTINCT FROM v_upload.source_generation
     OR v_source.current_fencing_token IS DISTINCT FROM v_upload.fencing_token
     OR v_device_status IS DISTINCT FROM 'paired' THEN
    RAISE EXCEPTION 'worker completion was superseded by a source fence' USING ERRCODE = '23514';
  END IF;
  RETURN public.complete_ingestion_import(p_upload_id, p_expected_sha256, p_cloud_instance_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_device_source_lease(
  p_source_id uuid,
  p_device_id uuid,
  p_expected_generation bigint,
  p_expected_fencing_token bigint,
  p_lease_expires_at timestamptz
) RETURNS TABLE (source_generation bigint, fencing_token bigint, lease_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source public.orthanc_sources%ROWTYPE;
  v_device_status text;
BEGIN
  IF p_source_id IS NULL OR p_device_id IS NULL OR p_expected_generation IS NULL
     OR p_expected_fencing_token IS NULL OR p_lease_expires_at IS NULL
     OR p_lease_expires_at <= clock_timestamp()
     OR p_lease_expires_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'lease renewal inputs are invalid or outside the allowed bound' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = p_source_id FOR UPDATE;
  SELECT d.status INTO v_device_status FROM public.device_installations d
   WHERE d.id = p_device_id AND d.source_id = p_source_id FOR SHARE;
  IF v_source.id IS NULL OR v_device_status IS DISTINCT FROM 'paired'
     OR v_source.status IS DISTINCT FROM 'active'
     OR v_source.generation IS DISTINCT FROM p_expected_generation
     OR v_source.current_fencing_token IS DISTINCT FROM p_expected_fencing_token
     OR v_source.lease_device_id IS DISTINCT FROM p_device_id
     OR v_source.lease_expires_at IS NULL
     OR v_source.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'lease renewal used a stale generation, token, owner, or expiry' USING ERRCODE = '23514';
  END IF;
  UPDATE public.orthanc_sources
     SET lease_expires_at = p_lease_expires_at, version = version + 1
   WHERE id = p_source_id;
  RETURN QUERY SELECT v_source.generation, v_source.current_fencing_token, p_lease_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_report_manifest_revision(uuid, integer, bigint, bigint, uuid, bigint) FROM clarity_v2_device_auth;
REVOKE ALL ON FUNCTION public.record_report_manifest_page(uuid, integer, bigint, bigint, uuid, bigint, jsonb) FROM clarity_v2_device_auth;
REVOKE ALL ON FUNCTION public.seal_observed_report_manifest(uuid, integer, integer, bigint, bigint, uuid, bigint, timestamptz, boolean, boolean, text) FROM clarity_v2_device_auth;
REVOKE ALL ON FUNCTION public.complete_ingestion_import(uuid, text, text) FROM clarity_v2_worker;
REVOKE ALL ON FUNCTION public.begin_report_manifest_revision(uuid, integer, bigint, bigint, uuid, bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_report_manifest_page(uuid, integer, bigint, bigint, uuid, bigint, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seal_observed_report_manifest(uuid, integer, integer, bigint, bigint, uuid, bigint, timestamptz, boolean, boolean, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_device_source_lease(uuid, uuid, bigint, bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_ingestion_import(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_ingestion_import_fenced(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_report_manifest_revision(uuid, integer, bigint, bigint, uuid, bigint, uuid) TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.record_report_manifest_page(uuid, integer, bigint, bigint, uuid, bigint, jsonb, uuid) TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.seal_observed_report_manifest(uuid, integer, integer, bigint, bigint, uuid, bigint, timestamptz, boolean, boolean, text, uuid) TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.authorize_ingestion_import(uuid) TO clarity_v2_worker;
GRANT EXECUTE ON FUNCTION public.complete_ingestion_import_fenced(uuid, text, text) TO clarity_v2_worker;
