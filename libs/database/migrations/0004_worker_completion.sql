ALTER TABLE ingestion_uploads ADD COLUMN intake_cleaned_at timestamptz;

CREATE FUNCTION complete_ingestion_import(
  p_upload_id uuid,
  p_expected_sha256 text,
  p_cloud_instance_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_upload ingestion_uploads%ROWTYPE;
  v_file report_files%ROWTYPE;
  v_report reports%ROWTYPE;
  v_uid_count integer;
BEGIN
  IF p_expected_sha256 !~ '^[a-f0-9]{64}$' OR length(trim(p_cloud_instance_id)) = 0 THEN
    RAISE EXCEPTION 'invalid verified import result' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_upload FROM ingestion_uploads WHERE id = p_upload_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload does not exist' USING ERRCODE = '23503'; END IF;
  SELECT * INTO v_file FROM report_files
   WHERE id = v_upload.report_file_id AND report_id = v_upload.report_id AND source_id = v_upload.source_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload file does not exist' USING ERRCODE = '23503'; END IF;
  SELECT * INTO v_report FROM reports WHERE id = v_upload.report_id AND source_id = v_upload.source_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload Report does not exist' USING ERRCODE = '23503'; END IF;

  IF v_upload.expected_sha256 IS DISTINCT FROM p_expected_sha256
     OR v_file.sha256 IS DISTINCT FROM p_expected_sha256
     OR v_file.byte_count IS DISTINCT FROM v_upload.declared_size_bytes THEN
    RAISE EXCEPTION 'verified import differs from durable file admission' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_uid_count FROM dicom_uid_registry
   WHERE (uid_type = 'study' AND uid_value = v_report.study_instance_uid
          AND source_id = v_upload.source_id AND report_id = v_upload.report_id)
      OR (uid_type = 'series' AND uid_value = v_file.series_instance_uid
          AND source_id = v_upload.source_id AND report_id = v_upload.report_id)
      OR (uid_type = 'sop' AND uid_value = v_file.sop_instance_uid
          AND source_id = v_upload.source_id AND report_id = v_upload.report_id
          AND report_file_id = v_file.id AND sha256 = p_expected_sha256);
  IF v_uid_count <> 3 THEN
    RAISE EXCEPTION 'global DICOM UID reservations do not match this upload' USING ERRCODE = '23514';
  END IF;

  IF v_upload.status = 'completed' THEN
    IF v_file.state <> 'indexed' OR v_file.cloud_orthanc_instance_id IS DISTINCT FROM p_cloud_instance_id THEN
      RAISE EXCEPTION 'completed upload has a different indexed reference' USING ERRCODE = '23514';
    END IF;
    RETURN true;
  END IF;
  IF v_upload.status <> 'received' THEN
    RAISE EXCEPTION 'only received uploads can be committed by the worker' USING ERRCODE = '23514';
  END IF;
  IF v_file.state = 'indexed' AND v_file.cloud_orthanc_instance_id IS DISTINCT FROM p_cloud_instance_id THEN
    RAISE EXCEPTION 'indexed SOP UID already points at another Orthanc instance' USING ERRCODE = '23514';
  END IF;

  UPDATE report_files
     SET state = 'indexed', cloud_orthanc_instance_id = p_cloud_instance_id, updated_at = clock_timestamp()
   WHERE id = v_file.id;
  UPDATE ingestion_uploads SET status = 'completed' WHERE id = v_upload.id;
  UPDATE reports r
     SET state = CASE
       WHEN r.current_manifest_revision IS NOT NULL
        AND NOT r.has_unresolved_conflict
        AND NOT EXISTS (
          SELECT 1 FROM report_files attention_file
           WHERE attention_file.report_id = r.id AND attention_file.source_id = r.source_id
             AND attention_file.state = 'needs_attention'
        )
        AND EXISTS (
          SELECT 1 FROM ingestion_batches b
           WHERE b.report_id = r.id AND b.source_id = r.source_id
             AND b.revision = r.current_manifest_revision AND b.state = 'sealed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM ingestion_batch_files m
          JOIN report_files f ON f.report_id = m.report_id AND f.source_id = m.source_id
                            AND f.sop_instance_uid = m.sop_instance_uid AND f.sha256 = m.sha256
     WHERE m.report_id = r.id AND m.source_id = r.source_id
             AND m.revision = r.current_manifest_revision
             AND (f.id IS NULL OR f.state <> 'indexed' OR f.cloud_orthanc_instance_id IS NULL)
        ) THEN 'ready'
       WHEN r.has_unresolved_conflict OR EXISTS (
         SELECT 1 FROM report_files attention_file
          WHERE attention_file.report_id = r.id AND attention_file.source_id = r.source_id
            AND attention_file.state = 'needs_attention'
       ) THEN 'needs_attention'
       ELSE 'processing'
     END,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE r.id = v_report.id;
  RETURN true;
END;
$$;

CREATE FUNCTION flag_ingestion_attention(p_upload_id uuid) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_upload ingestion_uploads%ROWTYPE;
BEGIN
  SELECT * INTO v_upload FROM ingestion_uploads WHERE id = p_upload_id FOR UPDATE;
  IF NOT FOUND OR v_upload.status <> 'received' THEN RETURN false; END IF;
  UPDATE report_files SET state = 'needs_attention', updated_at = clock_timestamp()
   WHERE id = v_upload.report_file_id AND report_id = v_upload.report_id
     AND source_id = v_upload.source_id AND state <> 'indexed';
  UPDATE reports SET state = 'needs_attention', version = version + 1, updated_at = clock_timestamp()
   WHERE id = v_upload.report_id AND source_id = v_upload.source_id;
  RETURN true;
END;
$$;

CREATE FUNCTION mark_ingestion_intake_cleaned(p_upload_id uuid) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM ingestion_uploads WHERE id = p_upload_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'completed' THEN RETURN false; END IF;
  UPDATE ingestion_uploads SET intake_cleaned_at = COALESCE(intake_cleaned_at, clock_timestamp())
   WHERE id = p_upload_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION complete_ingestion_import(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION flag_ingestion_attention(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_ingestion_intake_cleaned(uuid) FROM PUBLIC;
