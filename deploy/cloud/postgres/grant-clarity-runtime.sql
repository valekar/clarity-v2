GRANT USAGE ON SCHEMA public TO clarity_v2_runtime;
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM clarity_v2_runtime;
GRANT SELECT ON public.staff_users, public.staff_identities, public.staff_memberships
  TO clarity_v2_runtime;
GRANT SELECT (id, source_id, source_study_id, study_instance_uid, patient_id, patient_name,
  study_date, study_description, accession_number, modalities, state,
  current_manifest_revision, has_unresolved_conflict, created_at, updated_at)
  ON public.reports TO clarity_v2_runtime;
GRANT SELECT (id, status, generation) ON public.orthanc_sources TO clarity_v2_runtime;
GRANT SELECT (report_id, source_id, revision, state)
  ON public.ingestion_batches TO clarity_v2_runtime;
GRANT SELECT (report_id, source_id, revision, source_generation, source_stable, inventory_complete)
  ON public.report_manifest_proofs TO clarity_v2_runtime;
GRANT SELECT (report_id, source_id, revision, sop_instance_uid, sha256)
  ON public.ingestion_batch_files TO clarity_v2_runtime;
GRANT SELECT (id, report_id, source_id, series_instance_uid, sop_instance_uid, sha256,
  state, cloud_orthanc_instance_id)
  ON public.report_files TO clarity_v2_runtime;
GRANT SELECT ON public.doctors TO clarity_v2_runtime;
GRANT EXECUTE ON FUNCTION public.require_active_doctor_staff(uuid) TO clarity_v2_runtime;
GRANT EXECUTE ON FUNCTION public.insert_doctor_record(uuid, text, text, text, uuid) TO clarity_v2_runtime;
GRANT USAGE ON SCHEMA public TO clarity_v2_worker;
GRANT USAGE ON SCHEMA public TO clarity_v2_device_auth;
GRANT USAGE ON SCHEMA public TO clarity_v2_bootstrap_operator;
GRANT SELECT ON public.ingestion_uploads, public.report_files, public.reports,
  public.dicom_uid_registry TO clarity_v2_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE clarity_v2_migrator IN SCHEMA public
  REVOKE SELECT ON TABLES FROM clarity_v2_runtime;

GRANT EXECUTE ON FUNCTION public.enroll_pending_hanko_identity(uuid, uuid, text, text, text)
  TO clarity_v2_runtime;
GRANT EXECUTE ON FUNCTION public.is_effective_staff_admin(uuid)
  TO clarity_v2_runtime;
GRANT EXECUTE ON FUNCTION public.change_staff_membership(uuid, uuid, bigint, text, text)
  TO clarity_v2_runtime;
GRANT EXECUTE ON FUNCTION public.change_staff_user_active(uuid, uuid, bigint, boolean, boolean)
  TO clarity_v2_runtime;
GRANT EXECUTE ON FUNCTION public.create_source_pairing(uuid, uuid, uuid, bytea, timestamptz)
  TO clarity_v2_runtime;
GRANT EXECUTE ON FUNCTION public.revoke_source_device(uuid, uuid, bigint)
  TO clarity_v2_runtime;

GRANT SELECT (id, source_id, status, credential_verifier, version)
  ON public.device_installations TO clarity_v2_device_auth;
GRANT SELECT (id, status, generation, current_fencing_token, lease_device_id, lease_expires_at)
  ON public.orthanc_sources TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.consume_source_pairing(bytea, uuid, text, bytea)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.acquire_source_lease(uuid, uuid, timestamptz)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.acquire_device_source_lease(uuid, uuid, timestamptz)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.release_source_lease(uuid, uuid, bigint)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.renew_device_source_lease(uuid, uuid, bigint, bigint, timestamptz)
  TO clarity_v2_device_auth;

GRANT EXECUTE ON FUNCTION public.begin_report_manifest_revision(uuid, integer, bigint, bigint, uuid, bigint, uuid)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.record_report_manifest_page(uuid, integer, bigint, bigint, uuid, bigint, jsonb, uuid)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.seal_observed_report_manifest(uuid, integer, integer, bigint, bigint, uuid, bigint, timestamptz, boolean, boolean, text, uuid)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.upsert_observed_study(uuid, uuid, bigint, bigint, uuid, text, text, text, text, text, text, text, text, text, text, text, text)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.admit_ingestion_upload(uuid, uuid, bigint, bigint, uuid, uuid, text, text, text, text, bigint, text, text, timestamptz)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.attach_ingestion_multipart(uuid, uuid, bigint, bigint, text)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.complete_ingestion_upload(uuid, uuid, uuid, bigint, bigint, text, bigint)
  TO clarity_v2_device_auth;
GRANT EXECUTE ON FUNCTION public.read_ingestion_upload(uuid, uuid, uuid)
  TO clarity_v2_device_auth;

GRANT EXECUTE ON FUNCTION public.authorize_ingestion_import(uuid)
  TO clarity_v2_worker;
GRANT EXECUTE ON FUNCTION public.complete_ingestion_import_fenced(uuid, text, text)
  TO clarity_v2_worker;
GRANT EXECUTE ON FUNCTION public.flag_ingestion_attention(uuid)
  TO clarity_v2_worker;
GRANT EXECUTE ON FUNCTION public.mark_ingestion_intake_cleaned(uuid)
  TO clarity_v2_worker;

-- Recipient verification is unresolved. Dispatch intent and provider work stay
-- inaccessible to application roles until a policy migration authorizes them.
REVOKE ALL ON public.share_dispatches, public.share_dispatch_recipients,
  public.dispatch_outbox, public.dispatch_callback_events
  FROM clarity_v2_runtime, clarity_v2_worker, clarity_v2_device_auth;
REVOKE ALL ON FUNCTION public.create_share_dispatch(uuid, uuid, uuid, bigint, integer, uuid, boolean, text, boolean, uuid, bigint)
  FROM clarity_v2_runtime, clarity_v2_worker, clarity_v2_device_auth;
REVOKE ALL ON FUNCTION public.claim_dispatch_outbox(uuid, integer)
  FROM clarity_v2_runtime, clarity_v2_worker, clarity_v2_device_auth;
REVOKE ALL ON FUNCTION public.record_dispatch_provider_outcome(uuid, uuid, text, text, text)
  FROM clarity_v2_runtime, clarity_v2_worker, clarity_v2_device_auth;
REVOKE ALL ON FUNCTION public.reconcile_dispatch_outbox(uuid, text)
  FROM clarity_v2_runtime, clarity_v2_worker, clarity_v2_device_auth;
REVOKE ALL ON FUNCTION public.apply_dispatch_provider_callback(text, uuid, text, text, timestamptz, text)
  FROM clarity_v2_runtime, clarity_v2_worker, clarity_v2_device_auth;
