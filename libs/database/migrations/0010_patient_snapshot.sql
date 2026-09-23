ALTER TABLE public.reports
  ADD COLUMN patient_issuer_of_patient_id varchar(64);

CREATE FUNCTION public.upsert_observed_study(
  p_source_id uuid,
  p_device_id uuid,
  p_source_generation bigint,
  p_fencing_token bigint,
  p_idempotency_key uuid,
  p_study_instance_uid text,
  p_orthanc_study_id text,
  p_patient_id text,
  p_patient_issuer_of_patient_id text,
  p_patient_name text,
  p_patient_birth_date text,
  p_patient_sex text,
  p_study_date text,
  p_study_time text,
  p_study_description text,
  p_accession_number text,
  p_modalities text
) RETURNS TABLE (report_id uuid, study_instance_uid text, report_version bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_admission record;
  v_report public.reports%ROWTYPE;
  v_patient_changed boolean;
BEGIN
  IF p_patient_id IS NOT NULL AND length(p_patient_id) > 64
     OR p_patient_issuer_of_patient_id IS NOT NULL AND length(p_patient_issuer_of_patient_id) > 64
     OR p_patient_name IS NOT NULL AND length(p_patient_name) > 200
     OR p_patient_birth_date IS NOT NULL AND length(p_patient_birth_date) > 8
     OR p_patient_sex IS NOT NULL AND length(p_patient_sex) > 16 THEN
    RAISE EXCEPTION 'patient observation exceeds a field bound' USING ERRCODE = '22023';
  END IF;
  -- The original study function serializes by source, reserves the global UID,
  -- and binds the Orthanc locator to the current source generation. Hold that
  -- same source lock while replacing the full patient identity snapshot.
  PERFORM 1 FROM public.orthanc_sources WHERE id = p_source_id FOR UPDATE;
  SELECT r.* INTO v_report FROM public.reports r
   WHERE r.source_id = p_source_id AND r.study_instance_uid = p_study_instance_uid FOR UPDATE;

  SELECT * INTO v_admission FROM public.upsert_observed_study(
    p_source_id, p_device_id, p_source_generation, p_fencing_token,
    p_idempotency_key, p_study_instance_uid, p_orthanc_study_id,
    NULL, NULL, NULL, NULL, p_study_date, p_study_time,
    p_study_description, p_accession_number, p_modalities
  );
  SELECT r.* INTO v_report FROM public.reports r WHERE r.id = v_admission.report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admitted Report is missing' USING ERRCODE = '23503'; END IF;
  v_patient_changed := v_report.patient_id IS DISTINCT FROM p_patient_id
    OR v_report.patient_issuer_of_patient_id IS DISTINCT FROM p_patient_issuer_of_patient_id
    OR v_report.patient_name IS DISTINCT FROM p_patient_name
    OR v_report.patient_birth_date IS DISTINCT FROM p_patient_birth_date
    OR v_report.patient_sex IS DISTINCT FROM p_patient_sex;
  UPDATE public.reports r SET
    patient_id = p_patient_id,
    patient_issuer_of_patient_id = p_patient_issuer_of_patient_id,
    patient_name = p_patient_name,
    patient_birth_date = p_patient_birth_date,
    patient_sex = p_patient_sex,
    patient_snapshot = jsonb_strip_nulls(jsonb_build_object(
      'patientId', p_patient_id,
      'patientIssuerOfPatientId', p_patient_issuer_of_patient_id,
      'patientName', p_patient_name,
      'patientBirthDate', p_patient_birth_date,
      'patientSex', p_patient_sex
    )),
    version = r.version + CASE WHEN v_patient_changed THEN 1 ELSE 0 END,
    updated_at = CASE WHEN v_patient_changed THEN clock_timestamp() ELSE r.updated_at END
   WHERE r.id = v_report.id RETURNING r.* INTO v_report;
  RETURN QUERY SELECT v_report.id, v_report.study_instance_uid::text, v_report.version;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_observed_study(uuid, uuid, bigint, bigint, uuid, text, text, text, text, text, text, text, text, text, text, text) FROM clarity_v2_device_auth;
REVOKE ALL ON FUNCTION public.upsert_observed_study(uuid, uuid, bigint, bigint, uuid, text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_observed_study(uuid, uuid, bigint, bigint, uuid, text, text, text, text, text, text, text, text, text, text, text, text) TO clarity_v2_device_auth;
