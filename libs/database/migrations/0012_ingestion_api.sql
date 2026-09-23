ALTER TABLE public.ingestion_uploads
  ADD COLUMN verified_sha256 text,
  ADD COLUMN verified_size_bytes bigint,
  ADD CONSTRAINT ingestion_uploads_verified_pair CHECK (
    (verified_sha256 IS NULL AND verified_size_bytes IS NULL)
    OR (verified_sha256 IS NOT NULL AND verified_size_bytes IS NOT NULL
        AND verified_sha256 ~ '^[a-f0-9]{64}$' AND verified_size_bytes > 0)
  );
ALTER TABLE public.ingestion_uploads DROP CONSTRAINT ingestion_uploads_source_id_admission_key_key;
CREATE INDEX ingestion_uploads_admission_lookup ON public.ingestion_uploads(source_id, admission_key, created_at DESC);

CREATE FUNCTION public.admit_ingestion_upload(
  p_source_id uuid, p_device_id uuid, p_generation bigint, p_fencing_token bigint,
  p_admission_key uuid, p_upload_id uuid, p_orthanc_instance_id text,
  p_study_uid text, p_series_uid text, p_sop_uid text, p_byte_count bigint,
  p_sha256 text, p_object_key text, p_expires_at timestamptz
) RETURNS TABLE(upload_id uuid, report_id uuid, report_file_id uuid, object_key text,
                expected_sha256 text, declared_size_bytes bigint, upload_status text,
                multipart_upload_id text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_prior public.ingestion_uploads%ROWTYPE;
  v_report public.reports%ROWTYPE;
  v_file public.report_files%ROWTYPE;
  v_series_owner public.dicom_uid_registry%ROWTYPE;
  v_sop_owner public.dicom_uid_registry%ROWTYPE;
  v_file_id uuid;
BEGIN
  IF p_source_id IS NULL OR p_device_id IS NULL OR p_generation IS NULL OR p_fencing_token IS NULL
     OR p_admission_key IS NULL OR p_upload_id IS NULL OR p_orthanc_instance_id IS NULL
     OR length(trim(p_orthanc_instance_id)) NOT BETWEEN 1 AND 200
     OR p_study_uid IS NULL OR length(p_study_uid) > 64 OR p_study_uid !~ '^[0-9]+([.][0-9]+)*$'
     OR p_series_uid IS NULL OR length(p_series_uid) > 64 OR p_series_uid !~ '^[0-9]+([.][0-9]+)*$'
     OR p_sop_uid IS NULL OR length(p_sop_uid) > 64 OR p_sop_uid !~ '^[0-9]+([.][0-9]+)*$'
     OR p_byte_count IS NULL OR p_byte_count NOT BETWEEN 1 AND 5368709120
     OR p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
     OR p_object_key IS DISTINCT FROM ('intake/' || p_source_id::text || '/' || p_upload_id::text || '.dcm')
     OR p_expires_at IS NULL OR p_expires_at <= clock_timestamp()
     OR p_expires_at > clock_timestamp() + interval '15 minutes' THEN
    RAISE EXCEPTION 'upload admission fields are invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM public.require_current_manifest_fence(p_source_id, p_device_id, p_fencing_token, p_generation);
  SELECT * INTO v_prior FROM public.ingestion_uploads
   WHERE source_id = p_source_id AND admission_key = p_admission_key
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    SELECT r.* INTO v_report FROM public.reports r WHERE r.id = v_prior.report_id FOR SHARE;
    SELECT f.* INTO v_file FROM public.report_files f WHERE f.id = v_prior.report_file_id FOR SHARE;
    IF v_prior.expected_sha256 IS DISTINCT FROM p_sha256
       OR v_prior.declared_size_bytes IS DISTINCT FROM p_byte_count
       OR v_file.sop_instance_uid IS DISTINCT FROM p_sop_uid
       OR v_file.series_instance_uid IS DISTINCT FROM p_series_uid
       OR v_report.study_instance_uid IS DISTINCT FROM p_study_uid THEN
      RAISE EXCEPTION 'admission key was reused for different content' USING ERRCODE = '23505';
    END IF;
    IF v_prior.status = 'completed' THEN
      RETURN QUERY SELECT v_prior.id, v_prior.report_id, v_prior.report_file_id, v_prior.object_key,
        v_prior.expected_sha256, v_prior.declared_size_bytes, v_prior.status, v_prior.multipart_upload_id, v_prior.expires_at;
      RETURN;
    ELSIF v_prior.status = 'received' THEN
      IF public.authorize_ingestion_import(v_prior.id) THEN
        RETURN QUERY SELECT v_prior.id, v_prior.report_id, v_prior.report_file_id, v_prior.object_key,
          v_prior.expected_sha256, v_prior.declared_size_bytes, v_prior.status, v_prior.multipart_upload_id, v_prior.expires_at;
        RETURN;
      END IF;
      SELECT * INTO v_prior FROM public.ingestion_uploads WHERE id = v_prior.id;
    ELSIF v_prior.status IN ('admitted', 'uploading')
       AND v_prior.device_installation_id = p_device_id AND v_prior.source_generation = p_generation
       AND v_prior.fencing_token = p_fencing_token AND v_prior.expires_at > clock_timestamp() THEN
      RETURN QUERY SELECT v_prior.id, v_prior.report_id, v_prior.report_file_id, v_prior.object_key,
        v_prior.expected_sha256, v_prior.declared_size_bytes, v_prior.status, v_prior.multipart_upload_id, v_prior.expires_at;
      RETURN;
    ELSE
      UPDATE public.ingestion_uploads SET status = CASE WHEN expires_at <= clock_timestamp() THEN 'expired' ELSE 'aborted' END
       WHERE id = v_prior.id AND status IN ('admitted', 'uploading');
    END IF;
  END IF;
  SELECT * INTO v_report FROM public.reports
   WHERE source_id = p_source_id AND study_instance_uid = p_study_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Study must be admitted before its instances' USING ERRCODE = '23503'; END IF;
  SELECT f.* INTO v_file FROM public.report_files f
   WHERE f.report_id = v_report.id AND f.source_id = p_source_id AND f.sop_instance_uid = p_sop_uid FOR UPDATE;
  IF FOUND THEN
    IF v_file.series_instance_uid IS DISTINCT FROM p_series_uid
       OR v_file.sha256 IS DISTINCT FROM p_sha256 OR v_file.byte_count IS DISTINCT FROM p_byte_count THEN
      RAISE EXCEPTION 'SOP UID is already reserved for different bytes' USING ERRCODE = '23505';
    END IF;
    v_file_id := v_file.id;
    IF v_file.state = 'indexed' THEN
      SELECT u.* INTO v_prior FROM public.ingestion_uploads u
       WHERE u.report_file_id = v_file.id AND u.status = 'completed'
       ORDER BY u.created_at DESC LIMIT 1;
      IF FOUND THEN
        RETURN QUERY SELECT v_prior.id, v_prior.report_id, v_prior.report_file_id, v_prior.object_key,
          v_prior.expected_sha256, v_prior.declared_size_bytes, v_prior.status, v_prior.multipart_upload_id, v_prior.expires_at;
        RETURN;
      END IF;
      RAISE EXCEPTION 'indexed Report file has no durable completed upload to reconcile' USING ERRCODE = '23514';
    END IF;
  ELSE
    v_file_id := gen_random_uuid();
    INSERT INTO public.report_files(id, report_id, source_id, series_instance_uid, sop_instance_uid,
      sha256, byte_count, state)
    VALUES(v_file_id, v_report.id, p_source_id, p_series_uid, p_sop_uid, p_sha256, p_byte_count, 'uploading');
  END IF;
  INSERT INTO public.dicom_uid_registry(uid_value, uid_type, source_id, report_id)
  VALUES(p_series_uid, 'series', p_source_id, v_report.id) ON CONFLICT(uid_value) DO NOTHING;
  SELECT * INTO v_series_owner FROM public.dicom_uid_registry WHERE uid_value = p_series_uid;
  IF v_series_owner.uid_type IS DISTINCT FROM 'series' OR v_series_owner.source_id IS DISTINCT FROM p_source_id
     OR v_series_owner.report_id IS DISTINCT FROM v_report.id THEN
    RAISE EXCEPTION 'Series UID is reserved to another identity' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.dicom_uid_registry(uid_value, uid_type, source_id, report_id, report_file_id, sha256)
  VALUES(p_sop_uid, 'sop', p_source_id, v_report.id, v_file_id, p_sha256) ON CONFLICT(uid_value) DO NOTHING;
  SELECT * INTO v_sop_owner FROM public.dicom_uid_registry WHERE uid_value = p_sop_uid;
  IF v_sop_owner.uid_type IS DISTINCT FROM 'sop' OR v_sop_owner.source_id IS DISTINCT FROM p_source_id
     OR v_sop_owner.report_id IS DISTINCT FROM v_report.id OR v_sop_owner.report_file_id IS DISTINCT FROM v_file_id
     OR v_sop_owner.sha256 IS DISTINCT FROM p_sha256 THEN
    RAISE EXCEPTION 'SOP UID is reserved to another identity' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.source_resource_observations(id, source_id, generation, report_id, resource_kind, resource_id, report_file_id)
  VALUES(gen_random_uuid(), p_source_id, p_generation, v_report.id, 'instance', p_orthanc_instance_id, v_file_id)
  ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.source_resource_observations o
    WHERE o.source_id = p_source_id AND o.generation = p_generation AND o.report_id = v_report.id
      AND o.resource_kind = 'instance' AND o.resource_id = p_orthanc_instance_id AND o.report_file_id = v_file_id) THEN
    RAISE EXCEPTION 'Orthanc instance locator is already assigned' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.ingestion_uploads(id, source_id, report_id, report_file_id, device_installation_id,
    fencing_token, source_generation, admission_key, declared_size_bytes, expected_sha256, object_key, expires_at)
  VALUES(p_upload_id, p_source_id, v_report.id, v_file_id, p_device_id, p_fencing_token, p_generation,
    p_admission_key, p_byte_count, p_sha256, p_object_key, p_expires_at);
  UPDATE public.report_files SET state = 'uploading', updated_at = clock_timestamp() WHERE id = v_file_id;
  UPDATE public.reports SET state = 'processing', version = version + 1, updated_at = clock_timestamp()
   WHERE id = v_report.id AND state = 'ready';
  RETURN QUERY SELECT p_upload_id, v_report.id, v_file_id, p_object_key, p_sha256, p_byte_count,
    'admitted'::text, NULL::text, p_expires_at;
END; $$;

CREATE FUNCTION public.attach_ingestion_multipart(
  p_upload_id uuid, p_device_id uuid, p_generation bigint, p_fencing_token bigint, p_multipart_id text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_upload public.ingestion_uploads%ROWTYPE;
BEGIN
  IF p_multipart_id IS NULL OR length(p_multipart_id) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'multipart upload ID is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_upload FROM public.ingestion_uploads WHERE id = p_upload_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload does not exist' USING ERRCODE = '23503'; END IF;
  PERFORM public.require_current_manifest_fence(v_upload.source_id, p_device_id, p_fencing_token, p_generation);
  IF v_upload.device_installation_id IS DISTINCT FROM p_device_id
     OR v_upload.source_generation IS DISTINCT FROM p_generation OR v_upload.fencing_token IS DISTINCT FROM p_fencing_token
     OR v_upload.status NOT IN ('admitted', 'uploading') THEN RETURN false; END IF;
  IF v_upload.multipart_upload_id IS NOT NULL AND v_upload.multipart_upload_id IS DISTINCT FROM p_multipart_id THEN
    RAISE EXCEPTION 'multipart upload ID changed' USING ERRCODE = '23514';
  END IF;
  UPDATE public.ingestion_uploads SET multipart_upload_id = p_multipart_id, status = 'uploading' WHERE id = p_upload_id;
  RETURN true;
END; $$;

CREATE FUNCTION public.complete_ingestion_upload(
  p_upload_id uuid, p_source_id uuid, p_device_id uuid, p_generation bigint, p_fencing_token bigint,
  p_verified_sha256 text, p_verified_size bigint
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_upload public.ingestion_uploads%ROWTYPE;
BEGIN
  IF p_upload_id IS NULL OR p_source_id IS NULL OR p_device_id IS NULL OR p_generation IS NULL
     OR p_fencing_token IS NULL OR p_verified_sha256 IS NULL OR p_verified_sha256 !~ '^[a-f0-9]{64}$'
     OR p_verified_size IS NULL OR p_verified_size < 1 THEN
    RAISE EXCEPTION 'verified upload receipt is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_upload FROM public.ingestion_uploads WHERE id = p_upload_id FOR UPDATE;
  IF NOT FOUND OR v_upload.source_id IS DISTINCT FROM p_source_id OR v_upload.device_installation_id IS DISTINCT FROM p_device_id
     OR v_upload.source_generation IS DISTINCT FROM p_generation OR v_upload.fencing_token IS DISTINCT FROM p_fencing_token THEN
    RAISE EXCEPTION 'upload receipt is outside its source fence' USING ERRCODE = '23514';
  END IF;
  PERFORM public.require_current_manifest_fence(p_source_id, p_device_id, p_fencing_token, p_generation);
  IF v_upload.status = 'received' OR v_upload.status = 'completed' THEN
    IF v_upload.verified_sha256 IS DISTINCT FROM p_verified_sha256 OR v_upload.verified_size_bytes IS DISTINCT FROM p_verified_size THEN
      RAISE EXCEPTION 'retry verification differs from durable receipt' USING ERRCODE = '23514';
    END IF;
    RETURN v_upload.status;
  END IF;
  IF v_upload.status NOT IN ('admitted', 'uploading') OR v_upload.expires_at <= clock_timestamp()
     OR v_upload.expected_sha256 IS DISTINCT FROM p_verified_sha256 OR v_upload.declared_size_bytes IS DISTINCT FROM p_verified_size THEN
    RAISE EXCEPTION 'object verification does not match an active durable admission' USING ERRCODE = '23514';
  END IF;
  UPDATE public.ingestion_uploads SET status = 'received', verified_sha256 = p_verified_sha256,
    verified_size_bytes = p_verified_size WHERE id = p_upload_id;
  UPDATE public.report_files SET state = 'received', updated_at = clock_timestamp() WHERE id = v_upload.report_file_id;
  RETURN 'received';
END; $$;

CREATE FUNCTION public.read_ingestion_upload(p_upload_id uuid, p_source_id uuid, p_device_id uuid)
RETURNS TABLE(upload_id uuid, report_id uuid, report_file_id uuid, object_key text, expected_sha256 text,
  declared_size_bytes bigint, upload_status text, multipart_upload_id text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id AS upload_id, u.report_id, u.report_file_id, u.object_key, u.expected_sha256, u.declared_size_bytes,
    u.status AS upload_status, u.multipart_upload_id, u.expires_at FROM public.ingestion_uploads u
    JOIN public.orthanc_sources s ON s.id = u.source_id
   WHERE u.id = p_upload_id AND u.source_id = p_source_id AND u.device_installation_id = p_device_id
     AND s.status = 'active' AND s.lease_device_id = p_device_id AND s.lease_expires_at > clock_timestamp()
$$;

REVOKE ALL ON FUNCTION public.admit_ingestion_upload(uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attach_ingestion_multipart(uuid,uuid,bigint,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_ingestion_upload(uuid,uuid,uuid,bigint,bigint,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_ingestion_upload(uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clarity_v2_device_auth') THEN
    GRANT EXECUTE ON FUNCTION public.admit_ingestion_upload(uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz) TO clarity_v2_device_auth;
    GRANT EXECUTE ON FUNCTION public.attach_ingestion_multipart(uuid,uuid,bigint,bigint,text) TO clarity_v2_device_auth;
    GRANT EXECUTE ON FUNCTION public.complete_ingestion_upload(uuid,uuid,uuid,bigint,bigint,text,bigint) TO clarity_v2_device_auth;
    GRANT EXECUTE ON FUNCTION public.read_ingestion_upload(uuid,uuid,uuid) TO clarity_v2_device_auth;
  END IF;
END $$;
