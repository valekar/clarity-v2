BEGIN;

-- Start with the Ready revision-1 Report left by manifests.sql. A later file is
-- admitted, received and indexed before revision 2 is sealed.
INSERT INTO public.staff_users (id, display_name, active)
VALUES ('90000000-0000-4000-8000-000000000032', 'Synthetic Admission Admin', true);
INSERT INTO public.staff_memberships (staff_user_id, role, status)
VALUES ('90000000-0000-4000-8000-000000000032', 'admin', 'active');

DO $$
DECLARE
  v_report public.reports%ROWTYPE;
  v_dispatch record;
BEGIN
  SELECT * INTO v_report FROM public.reports
   WHERE id = '42000000-0000-4000-8000-000000000001';
  IF v_report.state IS DISTINCT FROM 'ready'
     OR v_report.current_manifest_revision IS DISTINCT FROM 1
     OR v_report.manifest_dirty IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'reverse-order fixture must start Ready at clean revision 1';
  END IF;
  SELECT * INTO v_dispatch FROM public.create_share_dispatch(
    '92000000-0000-4000-8000-000000000033',
    '93000000-0000-4000-8000-000000000033',
    v_report.id, v_report.version, v_report.current_manifest_revision,
    '90000000-0000-4000-8000-000000000032', true, '+919876543232',
    false, NULL, NULL
  );
  IF v_dispatch.out_dispatch_id IS DISTINCT FROM '92000000-0000-4000-8000-000000000033'
     OR v_dispatch.out_state IS DISTINCT FROM 'blocked_policy' THEN
    RAISE EXCEPTION 'revision-1 dispatch snapshot was not created';
  END IF;
END;
$$;

SELECT * FROM public.admit_ingestion_upload(
  '21000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001',
  (SELECT generation FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  (SELECT current_fencing_token FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '72000000-0000-4000-8000-000000000232', '62000000-0000-4000-8000-000000000232',
  'synthetic-late-instance-before-seal', '1.2.840.10008.1.12', '1.2.840.10008.1.12.1',
  '1.2.840.10008.1.12.1.2', 333, repeat('d', 64),
  'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000232.dcm',
  clock_timestamp() + interval '5 minutes'
);
UPDATE public.ingestion_uploads
   SET status = 'received', verified_sha256 = repeat('d', 64), verified_size_bytes = 333
 WHERE id = '62000000-0000-4000-8000-000000000232';

DO $$
DECLARE
  v_state text;
  v_dirty boolean;
BEGIN
  SELECT state, manifest_dirty INTO v_state, v_dirty FROM public.reports
   WHERE id = '42000000-0000-4000-8000-000000000001';
  IF v_state = 'ready' OR v_dirty IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'novel admission did not durably dirty and reopen the Report';
  END IF;
END;
$$;

-- The old runtime completion function is not executable. Check the actual
-- denial as that role and ensure the received object/file remain unchanged.
SET ROLE clarity_v2_runtime;
DO $$
DECLARE
  v_sqlstate text;
BEGIN
  BEGIN
    PERFORM public.reconcile_ingestion_upload_status(
      '62000000-0000-4000-8000-000000000232', 'received', 'completed'
    );
    RAISE EXCEPTION 'runtime unexpectedly completed a received upload';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
    IF v_sqlstate <> '42501' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT status FROM public.ingestion_uploads
       WHERE id = '62000000-0000-4000-8000-000000000232') IS DISTINCT FROM 'received'
     OR (SELECT state FROM public.report_files
          WHERE id = (SELECT report_file_id FROM public.ingestion_uploads
                       WHERE id = '62000000-0000-4000-8000-000000000232')) IS DISTINCT FROM 'uploading' THEN
    RAISE EXCEPTION 'denied runtime completion changed upload/file state';
  END IF;
END;
$$;

SET ROLE clarity_v2_worker;
SELECT public.complete_ingestion_import_fenced(
  '62000000-0000-4000-8000-000000000232', repeat('d', 64), 'synthetic-late-instance-before-seal-cloud'
);
RESET ROLE;

DO $$
DECLARE
  v_report public.reports%ROWTYPE;
BEGIN
  SELECT * INTO v_report FROM public.reports
   WHERE id = '42000000-0000-4000-8000-000000000001';
  IF v_report.state = 'ready' OR v_report.manifest_dirty IS DISTINCT FROM true
     OR (SELECT state FROM public.report_files
          WHERE sop_instance_uid = '1.2.840.10008.1.12.1.2') IS DISTINCT FROM 'indexed'
     OR (SELECT status FROM public.ingestion_uploads
          WHERE id = '62000000-0000-4000-8000-000000000232') IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'worker completion incorrectly made the stale revision Ready';
  END IF;
  BEGIN
    PERFORM * FROM public.create_share_dispatch(
      '92000000-0000-4000-8000-000000000034',
      '93000000-0000-4000-8000-000000000034', v_report.id,
      v_report.version, v_report.current_manifest_revision,
      '90000000-0000-4000-8000-000000000032', true, '+919876543232',
      false, NULL, NULL
    );
    RAISE EXCEPTION 'dirty Report unexpectedly admitted a new dispatch';
  EXCEPTION WHEN serialization_failure THEN
    NULL;
  END;
END;
$$;

-- The source's fresh inventory excludes the old A member. Its historic file is
-- marked for attention to prove it does not block Ready outside the exact set.
UPDATE public.report_files
   SET state = 'needs_attention'
 WHERE report_id = '42000000-0000-4000-8000-000000000001'
   AND sop_instance_uid = '1.2.840.10008.1.12.1.1';

SELECT public.begin_report_manifest_revision(
  '42000000-0000-4000-8000-000000000001', 1,
  (SELECT version FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001'),
  (SELECT generation FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '31000000-0000-4000-8000-000000000001',
  (SELECT current_fencing_token FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '82000000-0000-4000-8000-000000000232'
);
SELECT public.record_report_manifest_page(
  '42000000-0000-4000-8000-000000000001', 2,
  (SELECT version FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001'),
  (SELECT generation FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '31000000-0000-4000-8000-000000000001',
  (SELECT current_fencing_token FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '[{"sopInstanceUid":"1.2.840.10008.1.12.1.2","sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}]',
  '82000000-0000-4000-8000-000000000232'
);
DO $$
DECLARE
  v_digest text := encode(digest(convert_to(
    '[{"sopInstanceUid":"1.2.840.10008.1.12.1.2","sha256":"' || repeat('d', 64) || '"}]',
    'UTF8'), 'sha256'), 'hex');
BEGIN
  IF NOT public.seal_observed_report_manifest(
    '42000000-0000-4000-8000-000000000001', 2, 1,
    (SELECT version FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001'),
    (SELECT generation FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
    '31000000-0000-4000-8000-000000000001',
    (SELECT current_fencing_token FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
    clock_timestamp(), true, true, v_digest, '82000000-0000-4000-8000-000000000232'
  ) THEN
    RAISE EXCEPTION 'fresh complete revision-2 seal failed';
  END IF;
END;
$$;

DO $$
BEGIN
  IF (SELECT state FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001') IS DISTINCT FROM 'ready'
     OR (SELECT manifest_dirty FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001') IS DISTINCT FROM false
     OR (SELECT current_manifest_revision FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001') IS DISTINCT FROM 2
     OR (SELECT manifest_revision FROM public.share_dispatches WHERE id = '92000000-0000-4000-8000-000000000033') IS DISTINCT FROM 1
     OR has_function_privilege('clarity_v2_runtime', 'public.reconcile_ingestion_upload_status(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fresh seal/readiness, frozen dispatch scope, or runtime function revocation failed';
  END IF;
END;
$$;

-- A second new file admitted while already dirty must invalidate a manifest
-- attempt begun after the first admission. A retry of that same file must not
-- advance the CAS again.
DO $$
DECLARE
  v_report_id uuid := '42000000-0000-4000-8000-000000000001';
  v_source_id uuid := '21000000-0000-4000-8000-000000000001';
  v_device_id uuid := '31000000-0000-4000-8000-000000000001';
  v_generation bigint;
  v_fence bigint;
  v_before_second bigint;
  v_after_second bigint;
  v_revision integer;
  v_page_count integer;
  v_digest text;
  v_old_file public.report_files%ROWTYPE;
  v_members text := '[{"sopInstanceUid":"1.2.840.10008.1.12.1.3","sha256":"' || repeat('e', 64) || '"}]';
BEGIN
  SELECT generation, current_fencing_token INTO v_generation, v_fence
    FROM public.orthanc_sources WHERE id = v_source_id;
  PERFORM * FROM public.admit_ingestion_upload(
    v_source_id, v_device_id, v_generation, v_fence,
    '72000000-0000-4000-8000-000000000233', '62000000-0000-4000-8000-000000000233',
    'synthetic-first-dirty-instance', '1.2.840.10008.1.12', '1.2.840.10008.1.12.1',
    '1.2.840.10008.1.12.1.3', 334, repeat('e', 64),
    'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000233.dcm',
    clock_timestamp() + interval '5 minutes'
  );
  SELECT version INTO v_before_second FROM public.reports WHERE id = v_report_id;
  v_revision := public.begin_report_manifest_revision(
    v_report_id, 2, v_before_second, v_generation, v_device_id, v_fence,
    '82000000-0000-4000-8000-000000000233'
  );
  IF v_revision IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'first dirty admission did not permit revision-3 inventory';
  END IF;
  v_page_count := public.record_report_manifest_page(
    v_report_id, 3, v_before_second, v_generation, v_device_id, v_fence,
    v_members::jsonb, '82000000-0000-4000-8000-000000000233'::uuid
  );
  IF v_page_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'first dirty member page was not recorded';
  END IF;
  PERFORM * FROM public.admit_ingestion_upload(
    v_source_id, v_device_id, v_generation, v_fence,
    '72000000-0000-4000-8000-000000000234', '62000000-0000-4000-8000-000000000234',
    'synthetic-second-dirty-instance', '1.2.840.10008.1.12', '1.2.840.10008.1.12.1',
    '1.2.840.10008.1.12.1.4', 335, repeat('f', 64),
    'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000234.dcm',
    clock_timestamp() + interval '5 minutes'
  );
  SELECT version INTO v_after_second FROM public.reports WHERE id = v_report_id;
  IF v_after_second <= v_before_second THEN
    RAISE EXCEPTION 'second novel admission did not invalidate the in-flight inventory CAS';
  END IF;
  PERFORM * FROM public.admit_ingestion_upload(
    v_source_id, v_device_id, v_generation, v_fence,
    '72000000-0000-4000-8000-000000000234', '62000000-0000-4000-8000-000000000234',
    'synthetic-second-dirty-instance', '1.2.840.10008.1.12', '1.2.840.10008.1.12.1',
    '1.2.840.10008.1.12.1.4', 335, repeat('f', 64),
    'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000234.dcm',
    clock_timestamp() + interval '5 minutes'
  );
  IF (SELECT version FROM public.reports WHERE id = v_report_id) IS DISTINCT FROM v_after_second THEN
    RAISE EXCEPTION 'idempotent retry invalidated the inventory CAS again';
  END IF;
  -- This existing SOP was excluded from revision 2. A fresh admission key
  -- brings it back into scope while already dirty and must invalidate CAS.
  SELECT * INTO v_old_file FROM public.report_files
   WHERE report_id = v_report_id AND sop_instance_uid = '1.2.840.10008.1.12.1.1';
  PERFORM * FROM public.admit_ingestion_upload(
    v_source_id, v_device_id, v_generation, v_fence,
    '72000000-0000-4000-8000-000000000235', '62000000-0000-4000-8000-000000000235',
    'synthetic-readmitted-excluded-instance', '1.2.840.10008.1.12',
    v_old_file.series_instance_uid::text, v_old_file.sop_instance_uid::text,
    v_old_file.byte_count, v_old_file.sha256,
    'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000235.dcm',
    clock_timestamp() + interval '5 minutes'
  );
  IF (SELECT version FROM public.reports WHERE id = v_report_id) <= v_after_second THEN
    RAISE EXCEPTION 'new admission key for excluded existing SOP did not invalidate inventory CAS';
  END IF;
  v_digest := encode(digest(convert_to(v_members, 'UTF8'), 'sha256'), 'hex');
  IF public.seal_observed_report_manifest(
    v_report_id, 3, 2, v_before_second, v_generation, v_device_id, v_fence,
    clock_timestamp(), true, true, v_digest,
    '82000000-0000-4000-8000-000000000233'
  ) THEN
    RAISE EXCEPTION 'manifest attempt omitted a later admitted file but sealed';
  END IF;
  IF (SELECT manifest_dirty FROM public.reports WHERE id = v_report_id) IS DISTINCT FROM true
     OR (SELECT current_manifest_revision FROM public.reports WHERE id = v_report_id) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'stale seal altered the dirty Report or current manifest';
  END IF;
END;
$$;

ROLLBACK;
SELECT 'Reverse-order completion and double late admission stayed fenced until a fresh seal; runtime completion was denied and the old dispatch scope remained frozen.' AS result;
