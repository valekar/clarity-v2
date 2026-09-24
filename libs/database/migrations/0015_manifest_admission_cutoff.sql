ALTER TABLE public.reports
  ADD COLUMN manifest_dirty boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT reports_ready_requires_clean_manifest
    CHECK (state <> 'ready' OR NOT manifest_dirty);

COMMENT ON COLUMN public.reports.manifest_dirty IS
  'A novel admitted file is outside the current sealed scope until a later successful complete manifest seal clears this flag.';

CREATE OR REPLACE FUNCTION public.guard_report_ready_state() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_state text;
  v_member_count bigint;
  v_unready_count bigint;
BEGIN
  -- An indexed completion against the old sealed revision must commit, but it
  -- cannot make that stale scope Ready while a novel admission is outstanding.
  IF NEW.state = 'ready' AND NEW.manifest_dirty THEN
    NEW.state := 'processing';
    RETURN NEW;
  END IF;
  IF NEW.state = 'ready' THEN
    IF NEW.current_manifest_revision IS NULL OR NEW.has_unresolved_conflict THEN
      RAISE EXCEPTION 'Ready requires a current conflict-free manifest' USING ERRCODE = '23514';
    END IF;
    SELECT state INTO v_batch_state FROM public.ingestion_batches
     WHERE report_id = NEW.id AND source_id = NEW.source_id
       AND revision = NEW.current_manifest_revision;
    IF v_batch_state IS DISTINCT FROM 'sealed' THEN
      RAISE EXCEPTION 'a Report current manifest must be sealed before Ready' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.report_manifest_proofs p
       WHERE p.report_id = NEW.id AND p.source_id = NEW.source_id
         AND p.revision = NEW.current_manifest_revision
         AND p.source_generation = (SELECT generation FROM public.orthanc_sources WHERE id = NEW.source_id)
         AND p.source_stable AND p.inventory_complete
    ) THEN
      RAISE EXCEPTION 'Ready requires a current verified source inventory proof' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_member_count FROM public.ingestion_batch_files
     WHERE report_id = NEW.id AND source_id = NEW.source_id
       AND revision = NEW.current_manifest_revision;
    IF v_member_count = 0 THEN
      RAISE EXCEPTION 'a Report current manifest must be nonempty before Ready' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_unready_count
      FROM public.ingestion_batch_files m
      LEFT JOIN public.report_files f
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

-- Keep same-source admission serialized with sealing. The base admission holds
-- the Report row lock until this wrapper records the dirty cutoff.
CREATE OR REPLACE FUNCTION public.admit_ingestion_upload(
  p_source_id uuid, p_device_id uuid, p_generation bigint, p_fencing_token bigint,
  p_admission_key uuid, p_upload_id uuid, p_orthanc_instance_id text,
  p_study_uid text, p_series_uid text, p_sop_uid text, p_byte_count bigint,
  p_sha256 text, p_object_key text, p_expires_at timestamptz
) RETURNS TABLE(upload_id uuid, report_id uuid, report_file_id uuid, object_key text,
                expected_sha256 text, declared_size_bytes bigint, upload_status text,
                multipart_upload_id text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_admission record;
  v_report public.reports%ROWTYPE;
  v_file public.report_files%ROWTYPE;
  v_is_current_member boolean;
  v_admission_existed boolean;
BEGIN
  IF p_source_id IS NULL OR p_admission_key IS NULL THEN
    RAISE EXCEPTION 'source and admission key are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_source_id::text || ':' || p_admission_key::text, 0)
  );
  -- A fresh admission outside the current scope invalidates any in-flight
  -- manifest CAS even when the Report was already dirty. Exact key retries
  -- do not repeatedly invalidate a valid inventory attempt.
  SELECT EXISTS (
    SELECT 1 FROM public.ingestion_uploads
     WHERE source_id = p_source_id AND admission_key = p_admission_key
  ) INTO v_admission_existed;
  SELECT * INTO v_admission FROM public.admit_ingestion_upload_base_0013(
    p_source_id, p_device_id, p_generation, p_fencing_token,
    p_admission_key, p_upload_id, p_orthanc_instance_id,
    p_study_uid, p_series_uid, p_sop_uid, p_byte_count,
    p_sha256, p_object_key, p_expires_at
  );
  IF NOT FOUND OR v_admission.report_id IS NULL OR v_admission.report_file_id IS NULL THEN
    RAISE EXCEPTION 'upload admission did not return its Report and file' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_report FROM public.reports WHERE id = v_admission.report_id;
  SELECT * INTO v_file FROM public.report_files WHERE id = v_admission.report_file_id;
  IF NOT FOUND OR v_report.id IS NULL OR v_file.id IS NULL THEN
    RAISE EXCEPTION 'upload admission returned missing Report or file' USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.ingestion_batch_files m
     WHERE m.report_id = v_report.id AND m.source_id = v_report.source_id
       AND m.revision = v_report.current_manifest_revision
       AND m.sop_instance_uid = v_file.sop_instance_uid
       AND m.sha256 = v_file.sha256
  ) INTO v_is_current_member;
  IF NOT v_is_current_member THEN
    UPDATE public.reports
       SET manifest_dirty = true,
           state = CASE WHEN state = 'ready' THEN 'processing' ELSE state END,
           version = version + CASE WHEN manifest_dirty AND v_admission_existed THEN 0 ELSE 1 END,
           updated_at = clock_timestamp()
     WHERE id = v_report.id;
  END IF;
  RETURN QUERY SELECT v_admission.upload_id, v_admission.report_id,
    v_admission.report_file_id, v_admission.object_key, v_admission.expected_sha256,
    v_admission.declared_size_bytes, v_admission.upload_status,
    v_admission.multipart_upload_id, v_admission.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admit_ingestion_upload(
  uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_ingestion_upload(
  uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz
) TO clarity_v2_device_auth;

-- Clear the marker only after a successful current-generation complete seal.
-- The base seal locks and CAS-updates the Report; the row lock is held through
-- marker clearing and Ready reconciliation so a concurrent admission re-dirties
-- the Report only after this transaction commits.
CREATE OR REPLACE FUNCTION public.seal_observed_report_manifest(
  p_report_id uuid, p_revision integer, p_expected_current_revision integer,
  p_expected_report_version bigint, p_source_generation bigint,
  p_device_id uuid, p_fencing_token bigint, p_source_observed_at timestamptz,
  p_source_stable boolean, p_inventory_complete boolean,
  p_observed_manifest_digest text, p_inventory_attempt_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_sealed boolean;
BEGIN
  v_sealed := public.seal_observed_report_manifest_base_0013(
    p_report_id, p_revision, p_expected_current_revision, p_expected_report_version,
    p_source_generation, p_device_id, p_fencing_token, p_source_observed_at,
    p_source_stable, p_inventory_complete, p_observed_manifest_digest,
    p_inventory_attempt_id
  );
  IF NOT v_sealed THEN RETURN false; END IF;

  UPDATE public.reports
     SET manifest_dirty = false
   WHERE id = p_report_id AND current_manifest_revision = p_revision;

  UPDATE public.reports r
     SET state = 'ready', version = r.version + 1, updated_at = clock_timestamp()
   WHERE r.id = p_report_id
     AND r.current_manifest_revision = p_revision
     AND NOT r.manifest_dirty
     AND r.state IN ('syncing', 'processing')
     AND NOT r.has_unresolved_conflict
     AND EXISTS (
       SELECT 1 FROM public.ingestion_batches b
        JOIN public.report_manifest_proofs proof
          ON proof.report_id = b.report_id AND proof.source_id = b.source_id
         AND proof.revision = b.revision
        JOIN public.orthanc_sources source ON source.id = b.source_id
       WHERE b.report_id = r.id AND b.source_id = r.source_id
         AND b.revision = p_revision AND b.state = 'sealed'
         AND proof.source_generation = source.generation
         AND proof.source_stable AND proof.inventory_complete
     )
     AND EXISTS (
       SELECT 1 FROM public.ingestion_batch_files m
        WHERE m.report_id = r.id AND m.source_id = r.source_id AND m.revision = p_revision
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.ingestion_batch_files m
       LEFT JOIN public.report_files f
         ON f.report_id = m.report_id AND f.source_id = m.source_id
        AND f.sop_instance_uid = m.sop_instance_uid AND f.sha256 = m.sha256
       WHERE m.report_id = r.id AND m.source_id = r.source_id AND m.revision = p_revision
         AND (f.id IS NULL OR f.state <> 'indexed' OR f.cloud_orthanc_instance_id IS NULL)
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.ingestion_batch_files m
       JOIN public.report_files f
         ON f.report_id = m.report_id AND f.source_id = m.source_id
        AND f.sop_instance_uid = m.sop_instance_uid AND f.sha256 = m.sha256
       WHERE m.report_id = r.id AND m.source_id = r.source_id
         AND m.revision = p_revision AND f.state = 'needs_attention'
     );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.seal_observed_report_manifest(
  uuid,integer,integer,bigint,bigint,uuid,bigint,timestamptz,boolean,boolean,text,uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seal_observed_report_manifest(
  uuid,integer,integer,bigint,bigint,uuid,bigint,timestamptz,boolean,boolean,text,uuid
) TO clarity_v2_device_auth;

-- The runtime must never turn a received upload into completed without worker
-- validation, cloud indexing, and fenced Report/file reconciliation.
REVOKE ALL ON FUNCTION public.reconcile_ingestion_upload_status(uuid, text, text)
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'clarity_v2_runtime') THEN
    REVOKE EXECUTE ON FUNCTION public.reconcile_ingestion_upload_status(uuid, text, text)
      FROM clarity_v2_runtime;
  END IF;
END;
$$;
