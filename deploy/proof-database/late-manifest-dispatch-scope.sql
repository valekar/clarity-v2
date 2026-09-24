BEGIN;

-- Report 420 is a Ready, one-member synthetic Study created by
-- manifests.sql. Freeze a dispatch at revision 1 before discovering a late SOP.
INSERT INTO public.staff_users (id, display_name, active)
VALUES ('90000000-0000-4000-8000-000000000031', 'Synthetic Late Manifest Admin', true);
INSERT INTO public.staff_memberships (staff_user_id, role, status)
VALUES ('90000000-0000-4000-8000-000000000031', 'admin', 'active');

DO $$
DECLARE
  v_report public.reports%ROWTYPE;
  v_dispatch record;
BEGIN
  SELECT * INTO v_report FROM public.reports
   WHERE id = '42000000-0000-4000-8000-000000000001';
  IF v_report.state IS DISTINCT FROM 'ready'
     OR v_report.current_manifest_revision IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'late-manifest fixture must start Ready at revision 1';
  END IF;
  SELECT * INTO v_dispatch FROM public.create_share_dispatch(
    '92000000-0000-4000-8000-000000000031',
    '93000000-0000-4000-8000-000000000031',
    v_report.id, v_report.version, v_report.current_manifest_revision,
    '90000000-0000-4000-8000-000000000031', true, '+919876543231',
    false, NULL, NULL
  );
  IF v_dispatch.out_dispatch_id IS DISTINCT FROM '92000000-0000-4000-8000-000000000031'
     OR v_dispatch.out_state IS DISTINCT FROM 'blocked_policy'
     OR v_dispatch.out_recipient_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'revision 1 dispatch snapshot was not created as expected';
  END IF;
END;
$$;

-- A later instance arrives after the revision-1 dispatch. Admit it through the
-- same device API path, then seal a complete revision 2 while it is unindexed.
SELECT * FROM public.admit_ingestion_upload(
  '21000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001',
  (SELECT generation FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  (SELECT current_fencing_token FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '72000000-0000-4000-8000-000000000231', '62000000-0000-4000-8000-000000000231',
  'synthetic-late-instance', '1.2.840.10008.1.12', '1.2.840.10008.1.12.1',
  '1.2.840.10008.1.12.1.2', 333, repeat('d', 64),
  'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000231.dcm',
  clock_timestamp() + interval '5 minutes'
);
UPDATE public.ingestion_uploads
   SET status = 'received', verified_sha256 = repeat('d', 64), verified_size_bytes = 333
 WHERE id = '62000000-0000-4000-8000-000000000231';

SELECT public.begin_report_manifest_revision(
  '42000000-0000-4000-8000-000000000001', 1,
  (SELECT version FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001'),
  (SELECT generation FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '31000000-0000-4000-8000-000000000001',
  (SELECT current_fencing_token FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '82000000-0000-4000-8000-000000000231'
);
SELECT public.record_report_manifest_page(
  '42000000-0000-4000-8000-000000000001', 2,
  (SELECT version FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001'),
  (SELECT generation FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '31000000-0000-4000-8000-000000000001',
  (SELECT current_fencing_token FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '[{"sopInstanceUid":"1.2.840.10008.1.12.1.1","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},{"sopInstanceUid":"1.2.840.10008.1.12.1.2","sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}]',
  '82000000-0000-4000-8000-000000000231'
);
DO $$
DECLARE
  v_digest text := encode(digest(convert_to(
    '[{"sopInstanceUid":"1.2.840.10008.1.12.1.1","sha256":"' || repeat('c', 64) || '"},{"sopInstanceUid":"1.2.840.10008.1.12.1.2","sha256":"' || repeat('d', 64) || '"}]',
    'UTF8'), 'sha256'), 'hex');
BEGIN
  BEGIN
    PERFORM public.seal_observed_report_manifest(
      '42000000-0000-4000-8000-000000000001', 2, 1,
      (SELECT version FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001'),
      (SELECT generation FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
      '31000000-0000-4000-8000-000000000001',
      (SELECT current_fencing_token FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
      clock_timestamp(), true, false, v_digest, '82000000-0000-4000-8000-000000000231'
    );
    RAISE EXCEPTION 'quiet-but-incomplete inventory was sealed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT state FROM public.ingestion_batches WHERE report_id = '42000000-0000-4000-8000-000000000001' AND revision = 2)
       IS DISTINCT FROM 'draft'
     OR EXISTS (SELECT 1 FROM public.report_manifest_proofs WHERE report_id = '42000000-0000-4000-8000-000000000001' AND revision = 2) THEN
    RAISE EXCEPTION 'incomplete inventory changed sealed state or created proof';
  END IF;
  IF NOT public.seal_observed_report_manifest(
    '42000000-0000-4000-8000-000000000001', 2, 1,
    (SELECT version FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001'),
    (SELECT generation FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
    '31000000-0000-4000-8000-000000000001',
    (SELECT current_fencing_token FROM public.orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
    clock_timestamp(), true, true, v_digest, '82000000-0000-4000-8000-000000000231'
  ) THEN
    RAISE EXCEPTION 'stable complete late inventory failed to seal';
  END IF;
END;
$$;
DO $$
BEGIN
  IF (SELECT state FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001') IS DISTINCT FROM 'syncing'
     OR (SELECT current_manifest_revision FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001') IS DISTINCT FROM 2
     OR (SELECT manifest_revision FROM public.share_dispatches WHERE id = '92000000-0000-4000-8000-000000000031') IS DISTINCT FROM 1
     OR (SELECT state FROM public.share_dispatches WHERE id = '92000000-0000-4000-8000-000000000031') IS DISTINCT FROM 'blocked_policy'
     OR (SELECT count(*) FROM public.ingestion_batch_files WHERE report_id = '42000000-0000-4000-8000-000000000001' AND revision = 1) <> 1
     OR (SELECT count(*) FROM public.ingestion_batch_files WHERE report_id = '42000000-0000-4000-8000-000000000001' AND revision = 2) <> 2
     OR (SELECT count(*) FROM public.share_dispatch_recipients WHERE dispatch_id = '92000000-0000-4000-8000-000000000031') <> 1 THEN
    RAISE EXCEPTION 'late inventory changed a frozen revision-1 dispatch';
  END IF;
END;
$$;

-- The completion routine rechecks the upload's persisted source fence. Worker
-- EXECUTE isolation is covered by the existing role assertions in manifests.sql.
SELECT public.complete_ingestion_import_fenced('62000000-0000-4000-8000-000000000231', repeat('d', 64), 'synthetic-late-instance-cloud');

DO $$
DECLARE
  v_report public.reports%ROWTYPE;
  v_retry record;
BEGIN
  SELECT * INTO v_report FROM public.reports WHERE id = '42000000-0000-4000-8000-000000000001';
  IF v_report.state IS DISTINCT FROM 'ready'
     OR v_report.current_manifest_revision IS DISTINCT FROM 2
     OR (SELECT state FROM public.report_files WHERE sop_instance_uid = '1.2.840.10008.1.12.1.2') IS DISTINCT FROM 'indexed'
     OR (SELECT manifest_revision FROM public.share_dispatches WHERE id = '92000000-0000-4000-8000-000000000031') IS DISTINCT FROM 1
     OR (SELECT state FROM public.share_dispatches WHERE id = '92000000-0000-4000-8000-000000000031') IS DISTINCT FROM 'blocked_policy'
     OR (SELECT count(*) FROM public.ingestion_batch_files WHERE report_id = v_report.id AND revision = 1) <> 1
     OR (SELECT count(*) FROM public.ingestion_batch_files WHERE report_id = v_report.id AND revision = 2) <> 2
     OR (SELECT count(*) FROM public.share_dispatch_recipients WHERE dispatch_id = '92000000-0000-4000-8000-000000000031') <> 1 THEN
    RAISE EXCEPTION 'late member completion did not reopen Ready or altered frozen dispatch scope';
  END IF;
  SELECT * INTO v_retry FROM public.create_share_dispatch(
    '92000000-0000-4000-8000-000000000032',
    '93000000-0000-4000-8000-000000000031', v_report.id,
    (SELECT report_version FROM public.share_dispatches WHERE id = '92000000-0000-4000-8000-000000000031'),
    1, '90000000-0000-4000-8000-000000000031', true, '+919876543231', false, NULL, NULL
  );
  IF v_retry.out_dispatch_id IS DISTINCT FROM '92000000-0000-4000-8000-000000000031'
     OR v_retry.out_recipient_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'dispatch idempotency retry did not preserve its original scope';
  END IF;
END;
$$;

ROLLBACK;
SELECT 'Late-instance reopen, incomplete-inventory denial, and frozen dispatch scope passed; all fixture state rolled back.' AS result;
