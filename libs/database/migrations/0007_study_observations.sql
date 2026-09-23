ALTER TABLE public.reports
  ADD COLUMN patient_id varchar(64),
  ADD COLUMN patient_name varchar(200),
  ADD COLUMN patient_birth_date varchar(8),
  ADD COLUMN patient_sex varchar(16),
  ADD COLUMN study_date varchar(8),
  ADD COLUMN study_time varchar(16),
  ADD COLUMN study_description varchar(256),
  ADD COLUMN accession_number varchar(64),
  ADD COLUMN modalities varchar(128);

CREATE TABLE public.source_study_admissions (
  source_id uuid NOT NULL REFERENCES public.orthanc_sources(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  study_instance_uid varchar(64) NOT NULL CHECK (study_instance_uid ~ '^[0-9]+([.][0-9]+)*$'),
  report_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_id, idempotency_key),
  FOREIGN KEY (report_id, source_id) REFERENCES public.reports(id, source_id) ON DELETE RESTRICT
);

CREATE FUNCTION public.upsert_observed_study(
  p_source_id uuid,
  p_device_id uuid,
  p_source_generation bigint,
  p_fencing_token bigint,
  p_idempotency_key uuid,
  p_study_instance_uid text,
  p_orthanc_study_id text,
  p_patient_id text,
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
  v_report public.reports%ROWTYPE;
  v_idempotent public.source_study_admissions%ROWTYPE;
  v_known_admission boolean := false;
BEGIN
  IF p_idempotency_key IS NULL OR p_study_instance_uid IS NULL
     OR p_orthanc_study_id IS NULL OR length(trim(p_orthanc_study_id)) = 0
     OR length(p_orthanc_study_id) > 200
     OR length(p_study_instance_uid) > 64
     OR p_study_instance_uid !~ '^[0-9]+([.][0-9]+)*$' THEN
    RAISE EXCEPTION 'study identity or idempotency key is invalid' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      (p_patient_id, 64), (p_patient_name, 200), (p_patient_birth_date, 8),
      (p_patient_sex, 16), (p_study_date, 8), (p_study_time, 16),
      (p_study_description, 256), (p_accession_number, 64), (p_modalities, 128)
    ) AS v(value, maximum) WHERE value IS NOT NULL AND length(value) > maximum
  ) THEN
    RAISE EXCEPTION 'optional study observation exceeds a field bound' USING ERRCODE = '22023';
  END IF;
  -- Serialize first admission for a source so concurrent retries cannot create
  -- two Reports before either unique key becomes visible.
  PERFORM 1 FROM public.orthanc_sources WHERE id = p_source_id FOR UPDATE;
  PERFORM public.require_current_manifest_fence(
    p_source_id, p_device_id, p_fencing_token, p_source_generation
  );

  SELECT * INTO v_idempotent FROM public.source_study_admissions
   WHERE source_id = p_source_id AND idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_idempotent.study_instance_uid <> p_study_instance_uid THEN
      RAISE EXCEPTION 'idempotency key was already used for another Study UID' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_report FROM public.reports WHERE id = v_idempotent.report_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'admitted Report is missing' USING ERRCODE = '23503'; END IF;
    v_known_admission := true;
  ELSE
    SELECT r.* INTO v_report FROM public.reports r
     WHERE r.source_id = p_source_id AND r.study_instance_uid = p_study_instance_uid FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    INSERT INTO public.reports (
      id, source_id, source_study_id, study_instance_uid, state,
      patient_id, patient_name, patient_birth_date, patient_sex,
      study_date, study_time, study_description, accession_number, modalities
    ) VALUES (
      gen_random_uuid(), p_source_id, p_orthanc_study_id,
      p_study_instance_uid, 'syncing', p_patient_id, p_patient_name,
      p_patient_birth_date, p_patient_sex, p_study_date, p_study_time,
      p_study_description, p_accession_number, p_modalities
    ) RETURNING * INTO v_report;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.source_resource_observations o
       WHERE o.report_id = v_report.id AND o.generation = p_source_generation
         AND o.resource_kind = 'study' AND o.resource_id <> p_orthanc_study_id
    ) THEN
      RAISE EXCEPTION 'source Study locator changed without a generation reset' USING ERRCODE = '23514';
    END IF;
    UPDATE public.reports r SET
      source_study_id = p_orthanc_study_id,
      patient_id = COALESCE(p_patient_id, r.patient_id),
      patient_name = COALESCE(p_patient_name, r.patient_name),
      patient_birth_date = COALESCE(p_patient_birth_date, r.patient_birth_date),
      patient_sex = COALESCE(p_patient_sex, r.patient_sex),
      study_date = COALESCE(p_study_date, r.study_date),
      study_time = COALESCE(p_study_time, r.study_time),
      study_description = COALESCE(p_study_description, r.study_description),
      accession_number = COALESCE(p_accession_number, r.accession_number),
      modalities = COALESCE(p_modalities, r.modalities),
      version = r.version + CASE WHEN
        (p_orthanc_study_id IS DISTINCT FROM r.source_study_id)
        OR (p_patient_id IS NOT NULL AND p_patient_id IS DISTINCT FROM r.patient_id)
        OR (p_patient_name IS NOT NULL AND p_patient_name IS DISTINCT FROM r.patient_name)
        OR (p_patient_birth_date IS NOT NULL AND p_patient_birth_date IS DISTINCT FROM r.patient_birth_date)
        OR (p_patient_sex IS NOT NULL AND p_patient_sex IS DISTINCT FROM r.patient_sex)
        OR (p_study_date IS NOT NULL AND p_study_date IS DISTINCT FROM r.study_date)
        OR (p_study_time IS NOT NULL AND p_study_time IS DISTINCT FROM r.study_time)
        OR (p_study_description IS NOT NULL AND p_study_description IS DISTINCT FROM r.study_description)
        OR (p_accession_number IS NOT NULL AND p_accession_number IS DISTINCT FROM r.accession_number)
        OR (p_modalities IS NOT NULL AND p_modalities IS DISTINCT FROM r.modalities)
        THEN 1 ELSE 0 END,
      updated_at = CASE WHEN
        (p_orthanc_study_id IS DISTINCT FROM r.source_study_id)
        OR (p_patient_id IS NOT NULL AND p_patient_id IS DISTINCT FROM r.patient_id)
        OR (p_patient_name IS NOT NULL AND p_patient_name IS DISTINCT FROM r.patient_name)
        OR (p_patient_birth_date IS NOT NULL AND p_patient_birth_date IS DISTINCT FROM r.patient_birth_date)
        OR (p_patient_sex IS NOT NULL AND p_patient_sex IS DISTINCT FROM r.patient_sex)
        OR (p_study_date IS NOT NULL AND p_study_date IS DISTINCT FROM r.study_date)
        OR (p_study_time IS NOT NULL AND p_study_time IS DISTINCT FROM r.study_time)
        OR (p_study_description IS NOT NULL AND p_study_description IS DISTINCT FROM r.study_description)
        OR (p_accession_number IS NOT NULL AND p_accession_number IS DISTINCT FROM r.accession_number)
        OR (p_modalities IS NOT NULL AND p_modalities IS DISTINCT FROM r.modalities)
        THEN clock_timestamp() ELSE r.updated_at END
    WHERE r.id = v_report.id RETURNING r.* INTO v_report;
  END IF;
  INSERT INTO public.source_resource_observations(
    id, source_id, generation, report_id, resource_kind, resource_id
  ) VALUES (
    gen_random_uuid(), p_source_id, p_source_generation, v_report.id, 'study', p_orthanc_study_id
  ) ON CONFLICT DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public.source_resource_observations o
     WHERE o.source_id = p_source_id AND o.generation = p_source_generation
       AND o.report_id = v_report.id AND o.resource_kind = 'study'
       AND o.resource_id = p_orthanc_study_id
  ) THEN
    RAISE EXCEPTION 'source Study locator is already assigned to another Report' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.dicom_uid_registry(uid_value, uid_type, source_id, report_id)
  VALUES (p_study_instance_uid, 'study', p_source_id, v_report.id)
  ON CONFLICT (uid_value) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public.dicom_uid_registry d
     WHERE d.uid_value = p_study_instance_uid AND d.uid_type = 'study'
       AND d.source_id = p_source_id AND d.report_id = v_report.id
  ) THEN
    RAISE EXCEPTION 'Study UID is already reserved to another identity' USING ERRCODE = '23505';
  END IF;
  IF NOT v_known_admission THEN
    INSERT INTO public.source_study_admissions(source_id, idempotency_key, study_instance_uid, report_id)
    VALUES (p_source_id, p_idempotency_key, p_study_instance_uid, v_report.id);
  END IF;
  RETURN QUERY SELECT v_report.id, v_report.study_instance_uid::text, v_report.version;
END;
$$;

REVOKE ALL ON public.source_study_admissions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_observed_study(uuid, uuid, bigint, bigint, uuid, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'clarity_v2_device_auth') THEN
    GRANT EXECUTE ON FUNCTION public.upsert_observed_study(uuid, uuid, bigint, bigint, uuid, text, text, text, text, text, text, text, text, text, text, text) TO clarity_v2_device_auth;
  END IF;
END $$;
