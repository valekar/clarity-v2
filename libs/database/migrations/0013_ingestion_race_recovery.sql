-- Serialize retries on the source/idempotency key before validating the lease.
-- The previous implementation remains private as the canonical transaction body.
ALTER FUNCTION public.admit_ingestion_upload(
  uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz
) RENAME TO admit_ingestion_upload_base_0013;
REVOKE ALL ON FUNCTION public.admit_ingestion_upload_base_0013(
  uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz
) FROM PUBLIC, clarity_v2_device_auth;

CREATE FUNCTION public.admit_ingestion_upload(
  p_source_id uuid, p_device_id uuid, p_generation bigint, p_fencing_token bigint,
  p_admission_key uuid, p_upload_id uuid, p_orthanc_instance_id text,
  p_study_uid text, p_series_uid text, p_sop_uid text, p_byte_count bigint,
  p_sha256 text, p_object_key text, p_expires_at timestamptz
) RETURNS TABLE(upload_id uuid, report_id uuid, report_file_id uuid, object_key text,
                expected_sha256 text, declared_size_bytes bigint, upload_status text,
                multipart_upload_id text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_source_id IS NULL OR p_admission_key IS NULL THEN
    RAISE EXCEPTION 'source and admission key are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_source_id::text || ':' || p_admission_key::text, 0)
  );
  RETURN QUERY SELECT * FROM public.admit_ingestion_upload_base_0013(
    p_source_id, p_device_id, p_generation, p_fencing_token,
    p_admission_key, p_upload_id, p_orthanc_instance_id,
    p_study_uid, p_series_uid, p_sop_uid, p_byte_count,
    p_sha256, p_object_key, p_expires_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public.admit_ingestion_upload(
  uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_ingestion_upload(
  uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz
) TO clarity_v2_device_auth;

-- Preserve the exact old completion logic, but reconcile readiness after its
-- durable proof insert in the same transaction when every file was indexed first.
ALTER FUNCTION public.seal_observed_report_manifest(
  uuid,integer,integer,bigint,bigint,uuid,bigint,timestamptz,boolean,boolean,text,uuid
) RENAME TO seal_observed_report_manifest_base_0013;
REVOKE ALL ON FUNCTION public.seal_observed_report_manifest_base_0013(
  uuid,integer,integer,bigint,bigint,uuid,bigint,timestamptz,boolean,boolean,text,uuid
) FROM PUBLIC, clarity_v2_device_auth;

CREATE FUNCTION public.seal_observed_report_manifest(
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

  UPDATE public.reports r
     SET state = 'ready', version = r.version + 1, updated_at = clock_timestamp()
   WHERE r.id = p_report_id
     AND r.current_manifest_revision = p_revision
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
       SELECT 1 FROM public.report_files f
        WHERE f.report_id = r.id AND f.source_id = r.source_id AND f.state = 'needs_attention'
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

-- Return durable seal state so a lost seal response can be reconciled by digest.
ALTER FUNCTION public.upsert_observed_study(
  uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text
) RENAME TO upsert_observed_study_base_0013;
REVOKE ALL ON FUNCTION public.upsert_observed_study_base_0013(
  uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text
) FROM PUBLIC, clarity_v2_device_auth;
-- The previous patient-snapshot wrapper calls the original 0007 function;
-- allow only its SECURITY DEFINER owner to reach that private implementation.
GRANT EXECUTE ON FUNCTION public.upsert_observed_study(
  uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text
) TO clarity_v2_migrator;

CREATE FUNCTION public.upsert_observed_study(
  p_source_id uuid, p_device_id uuid, p_source_generation bigint,
  p_fencing_token bigint, p_idempotency_key uuid, p_study_instance_uid text,
  p_orthanc_study_id text, p_patient_id text, p_patient_issuer_of_patient_id text,
  p_patient_name text, p_patient_birth_date text, p_patient_sex text,
  p_study_date text, p_study_time text, p_study_description text,
  p_accession_number text, p_modalities text
) RETURNS TABLE (
  report_id uuid, study_instance_uid text, report_version bigint,
  current_manifest_revision integer, current_manifest_digest text,
  current_manifest_generation bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_admission record;
BEGIN
  SELECT * INTO v_admission FROM public.upsert_observed_study_base_0013(
    p_source_id, p_device_id, p_source_generation, p_fencing_token,
    p_idempotency_key, p_study_instance_uid, p_orthanc_study_id,
    p_patient_id, p_patient_issuer_of_patient_id, p_patient_name,
    p_patient_birth_date, p_patient_sex, p_study_date, p_study_time,
    p_study_description, p_accession_number, p_modalities
  );
  RETURN QUERY
    SELECT r.id, r.study_instance_uid::text, r.version,
      r.current_manifest_revision, proof.observed_manifest_digest, proof.source_generation
    FROM public.reports r
    LEFT JOIN public.report_manifest_proofs proof
      ON proof.report_id = r.id AND proof.source_id = r.source_id
     AND proof.revision = r.current_manifest_revision
   WHERE r.id = v_admission.report_id;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_observed_study(
  uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_observed_study(
  uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text
) TO clarity_v2_device_auth;
