INSERT INTO orthanc_sources (id, display_name)
VALUES ('21000000-0000-4000-8000-000000000001', 'Synthetic manifest source');
INSERT INTO device_installations (id, source_id, display_name, credential_verifier)
VALUES ('31000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
        'Synthetic manifest device', decode(repeat('b', 64), 'hex'));
SELECT acquire_source_lease(
  '21000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001', clock_timestamp() + interval '4 minutes'
);
INSERT INTO reports (id, source_id, source_study_id, study_instance_uid, state)
VALUES ('41000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
        'synthetic-manifest-study', '1.2.840.10008.1.10', 'discovered');
INSERT INTO report_files (id, report_id, source_id, series_instance_uid, sop_instance_uid, sha256, byte_count)
VALUES ('51000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001',
        '21000000-0000-4000-8000-000000000001', '1.2.840.10008.1.10.1',
        '1.2.840.10008.1.10.1.1', repeat('a', 64), 1024);
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id)
VALUES ('1.2.840.10008.1.10', 'study', '21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001'),
       ('1.2.840.10008.1.10.1', 'series', '21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001');
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id, report_file_id, sha256)
VALUES ('1.2.840.10008.1.10.1.1', 'sop', '21000000-0000-4000-8000-000000000001',
        '41000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', repeat('a', 64));

SET ROLE clarity_v2_device_auth;
DO $$
BEGIN
  IF begin_report_manifest_revision(
    '41000000-0000-4000-8000-000000000001', NULL, 99, 1,
    '31000000-0000-4000-8000-000000000001', 1, '81000000-0000-4000-8000-000000000001'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'stale Report version created a manifest draft';
  END IF;
END;
$$;
SELECT begin_report_manifest_revision(
  '41000000-0000-4000-8000-000000000001', NULL, 1, 1,
  '31000000-0000-4000-8000-000000000001', 1, '81000000-0000-4000-8000-000000000001'
);
SELECT record_report_manifest_page(
  '41000000-0000-4000-8000-000000000001', 1, 1, 1,
  '31000000-0000-4000-8000-000000000001', 1,
  '[{"sopInstanceUid":"1.2.840.10008.1.10.1.1","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
  '81000000-0000-4000-8000-000000000001'
);
SELECT record_report_manifest_page(
  '41000000-0000-4000-8000-000000000001', 1, 1, 1,
  '31000000-0000-4000-8000-000000000001', 1,
  '[{"sopInstanceUid":"1.2.840.10008.1.10.1.1","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
  '81000000-0000-4000-8000-000000000001'
);
SELECT begin_report_manifest_revision(
  '41000000-0000-4000-8000-000000000001', NULL, 1, 1,
  '31000000-0000-4000-8000-000000000001', 1, '81000000-0000-4000-8000-000000000001'
);
RESET ROLE;


DO $$
BEGIN
  IF (SELECT count(*) FROM ingestion_batch_files WHERE report_id = '41000000-0000-4000-8000-000000000001' AND revision = 1) <> 1 THEN
    RAISE EXCEPTION 'same inventory attempt retry discarded already paged members';
  END IF;
END;
$$;
SET ROLE clarity_v2_device_auth;
SELECT begin_report_manifest_revision(
  '41000000-0000-4000-8000-000000000001', NULL, 1, 1,
  '31000000-0000-4000-8000-000000000001', 1, '81000000-0000-4000-8000-000000000009'
);
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM ingestion_batch_files WHERE report_id = '41000000-0000-4000-8000-000000000001' AND revision = 1) <> 0 THEN
    RAISE EXCEPTION 'new inventory attempt retained obsolete manifest members';
  END IF;
END;
$$;
SET ROLE clarity_v2_device_auth;
DO $$
BEGIN
  PERFORM record_report_manifest_page(
    '41000000-0000-4000-8000-000000000001', 1, 1, 1,
    '31000000-0000-4000-8000-000000000001', 1,
    '[{"sopInstanceUid":"1.2.840.10008.1.10.1.1","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
    '81000000-0000-4000-8000-000000000001'
  );
  RAISE EXCEPTION 'old inventory attempt appended a member after restart';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;
SELECT record_report_manifest_page(
  '41000000-0000-4000-8000-000000000001', 1, 1, 1,
  '31000000-0000-4000-8000-000000000001', 1,
  '[{"sopInstanceUid":"1.2.840.10008.1.10.1.1","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
  '81000000-0000-4000-8000-000000000009'
);
DO $$
BEGIN
  PERFORM seal_observed_report_manifest(
    '41000000-0000-4000-8000-000000000001', 1, NULL, 1, 1,
    '31000000-0000-4000-8000-000000000001', 1, clock_timestamp(), false, true, repeat('a', 64), '81000000-0000-4000-8000-000000000009'
  );
  RAISE EXCEPTION 'unstable inventory was sealed';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;
DO $$
BEGIN
  PERFORM seal_observed_report_manifest(
    '41000000-0000-4000-8000-000000000001', 1, NULL, 1, 1,
    '31000000-0000-4000-8000-000000000001', 1, clock_timestamp(), true, true, repeat('b', 64), '81000000-0000-4000-8000-000000000009'
  );
  RAISE EXCEPTION 'manifest digest mismatch was sealed';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;
DO $$
BEGIN
  PERFORM seal_observed_report_manifest(
    '41000000-0000-4000-8000-000000000001', 1, NULL, 1, 1,
    '31000000-0000-4000-8000-000000000001', 1, clock_timestamp(), true, true, NULL,
    '81000000-0000-4000-8000-000000000009'
  );
  RAISE EXCEPTION 'null observed digest was sealed';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;
SELECT seal_observed_report_manifest(
  '41000000-0000-4000-8000-000000000001', 1, NULL, 1, 1,
  '31000000-0000-4000-8000-000000000001', 1, clock_timestamp(), true, true,
  encode(digest(convert_to('[{"sopInstanceUid":"1.2.840.10008.1.10.1.1","sha256":"' || repeat('a', 64) || '"}]', 'UTF8'), 'sha256'), 'hex'),
  '81000000-0000-4000-8000-000000000009'
);
RESET ROLE;

DO $$
BEGIN
  UPDATE reports SET state = 'ready' WHERE id = '41000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'unindexed sealed manifest was marked Ready';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;
UPDATE report_files SET state = 'indexed', cloud_orthanc_instance_id = 'synthetic-instance-one'
 WHERE id = '51000000-0000-4000-8000-000000000001';
UPDATE reports SET state = 'ready' WHERE id = '41000000-0000-4000-8000-000000000001';

INSERT INTO report_files (id, report_id, source_id, series_instance_uid, sop_instance_uid, sha256, byte_count, state)
VALUES ('51000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000001',
        '21000000-0000-4000-8000-000000000001', '1.2.840.10008.1.10.1',
        '1.2.840.10008.1.10.1.2', repeat('b', 64), 2048, 'received');
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id, report_file_id, sha256)
VALUES ('1.2.840.10008.1.10.1.2', 'sop', '21000000-0000-4000-8000-000000000001',
        '41000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', repeat('b', 64));
INSERT INTO ingestion_uploads (
  id, source_id, report_id, report_file_id, device_installation_id, fencing_token,
  admission_key, declared_size_bytes, expected_sha256, object_key, expires_at, status
) VALUES (
  '61000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000001', 1, '71000000-0000-4000-8000-000000000001',
  2048, repeat('b', 64), 'proof/late-instance', clock_timestamp() + interval '1 hour', 'received'
);
SET ROLE clarity_v2_device_auth;
SELECT begin_report_manifest_revision(
  '41000000-0000-4000-8000-000000000001', 1, 2, 1,
  '31000000-0000-4000-8000-000000000001', 1, '81000000-0000-4000-8000-000000000002'
);
SELECT record_report_manifest_page(
  '41000000-0000-4000-8000-000000000001', 2, 2, 1,
  '31000000-0000-4000-8000-000000000001', 1,
  '[{"sopInstanceUid":"1.2.840.10008.1.10.1.1","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"sopInstanceUid":"1.2.840.10008.1.10.1.2","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]',
  '81000000-0000-4000-8000-000000000002'
);
SELECT seal_observed_report_manifest(
  '41000000-0000-4000-8000-000000000001', 2, 1, 2, 1,
  '31000000-0000-4000-8000-000000000001', 1, clock_timestamp(), true, true,
  encode(digest(convert_to('[{"sopInstanceUid":"1.2.840.10008.1.10.1.1","sha256":"' || repeat('a', 64) || '"},{"sopInstanceUid":"1.2.840.10008.1.10.1.2","sha256":"' || repeat('b', 64) || '"}]', 'UTF8'), 'sha256'), 'hex'),
  '81000000-0000-4000-8000-000000000002'
);
RESET ROLE;
DO $$
BEGIN
  IF (SELECT state FROM reports WHERE id = '41000000-0000-4000-8000-000000000001') <> 'syncing' THEN
    RAISE EXCEPTION 'late source instance did not reopen the Report';
  END IF;
  IF (SELECT count(*) FROM ingestion_batch_files WHERE report_id = '41000000-0000-4000-8000-000000000001' AND revision = 2) <> 2 THEN
    RAISE EXCEPTION 'late manifest did not preserve the complete exact member set';
  END IF;
  UPDATE reports SET state = 'ready' WHERE id = '41000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'incomplete late manifest was marked Ready';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;
SET ROLE clarity_v2_worker;
SELECT complete_ingestion_import_fenced(
  '61000000-0000-4000-8000-000000000001', repeat('b', 64), 'synthetic-instance-two'
);
RESET ROLE;
DO $$
BEGIN
  IF (SELECT state FROM reports WHERE id = '41000000-0000-4000-8000-000000000001') <> 'ready' THEN
    RAISE EXCEPTION 'Report did not become Ready after every exact manifest member was indexed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM report_manifest_proofs WHERE report_id = '41000000-0000-4000-8000-000000000001' AND revision = 2 AND source_generation = 1 AND source_stable AND inventory_complete) THEN
    RAISE EXCEPTION 'late sealed revision did not retain source inventory evidence';
  END IF;
END;
$$;

-- Study observations accept a valid Study UID when optional tags are absent,
-- while preserving one stable logical Report across deterministic retries.
DO $$
BEGIN
  IF NOT has_function_privilege(
       'clarity_v2_device_auth',
       'public.upsert_observed_study(uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'device-auth role lacks the 0007 study admission grant';
  END IF;
  IF has_function_privilege(
       'clarity_v2_runtime',
       'public.upsert_observed_study(uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'web runtime can admit trusted studies';
  END IF;
END;
$$;
SET ROLE clarity_v2_runtime;
DO $$
BEGIN
  PERFORM upsert_observed_study(
    '21000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001', 1, 1,
    '71000000-0000-4000-8000-000000000097', '1.2.840.10008.1.97', 'runtime-locator',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  RAISE EXCEPTION 'web runtime unexpectedly executed study admission';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
RESET ROLE;
SET ROLE clarity_v2_device_auth;
CREATE TEMP TABLE study_admission_result AS
SELECT * FROM upsert_observed_study(
  '21000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001', 1, 1,
  '71000000-0000-4000-8000-000000000099', '1.2.840.10008.1.99', 'orthanc-study-old',
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
);
CREATE TEMP TABLE study_admission_retry AS
SELECT * FROM upsert_observed_study(
  '21000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001', 1, 1,
  '71000000-0000-4000-8000-000000000099', '1.2.840.10008.1.99', 'orthanc-study-old',
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
);
RESET ROLE;
SET ROLE clarity_v2_device_auth;
DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM upsert_observed_study(
    '21000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    (SELECT generation FROM orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
    (SELECT current_fencing_token FROM orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
    '71000000-0000-4000-8000-000000000099', '1.2.840.10008.1.99', 'orthanc-study-old',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  IF v.current_manifest_revision IS NOT NULL
     OR v.current_manifest_generation IS NOT NULL
     OR v.current_manifest_digest IS NOT NULL THEN
    RAISE EXCEPTION 'study admission without a sealed manifest returned partial seal state';
  END IF;
END;
$$;
RESET ROLE;
CREATE TEMP TABLE expected_sealed_manifest AS
SELECT observed_manifest_digest FROM report_manifest_proofs
 WHERE report_id = '41000000-0000-4000-8000-000000000001' AND revision = 2;
GRANT SELECT ON expected_sealed_manifest TO clarity_v2_device_auth;
SET ROLE clarity_v2_device_auth;
DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM upsert_observed_study(
    '21000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    (SELECT generation FROM orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
    (SELECT current_fencing_token FROM orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
    '71000000-0000-4000-8000-000000000096', '1.2.840.10008.1.10', 'synthetic-manifest-study',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  IF v.current_manifest_revision IS DISTINCT FROM 2
     OR v.current_manifest_generation IS DISTINCT FROM 1
     OR v.current_manifest_digest IS DISTINCT FROM (
       SELECT observed_manifest_digest FROM expected_sealed_manifest
     ) THEN
    RAISE EXCEPTION 'study admission did not return the durable sealed manifest revision, digest and generation';
  END IF;
END;
$$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT report_id FROM study_admission_result) IS DISTINCT FROM
     (SELECT report_id FROM study_admission_retry) THEN
    RAISE EXCEPTION 'same Study UID retry changed stable Report identity';
  END IF;
  IF (SELECT report_version FROM study_admission_result) <> 1 OR
     (SELECT report_version FROM study_admission_retry) <> 1 THEN
    RAISE EXCEPTION 'same study retry changed Report version';
  END IF;
  IF (SELECT patient_snapshot FROM reports WHERE id = (SELECT report_id FROM study_admission_result)) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'study admission stored unexpected source metadata';
  END IF;
END;
$$;
SET ROLE clarity_v2_device_auth;
SELECT * FROM upsert_observed_study(
  '21000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001', 1, 1,
  '71000000-0000-4000-8000-000000000098', '1.2.840.10008.1.99', 'orthanc-study-old',
  NULL, NULL, 'Synthetic patient', NULL, NULL, NULL, NULL, NULL, NULL, NULL
);
DO $$
BEGIN
  PERFORM upsert_observed_study(
    '21000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001', 1, 1,
    '71000000-0000-4000-8000-000000000099', '1.2.840.10008.1.98', 'orthanc-study-old',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  RAISE EXCEPTION 'reused study idempotency key admitted another Study UID';
EXCEPTION WHEN unique_violation THEN NULL;
END;
$$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM reports WHERE source_id = '21000000-0000-4000-8000-000000000001'
      AND study_instance_uid = '1.2.840.10008.1.98') <> 0 THEN
    RAISE EXCEPTION 'rejected Study UID idempotency reuse left a Report';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM dicom_uid_registry WHERE uid_value = '1.2.840.10008.1.99'
                 AND report_id = (SELECT report_id FROM study_admission_result)) THEN
    RAISE EXCEPTION 'study admission failed to reserve its global Study UID';
  END IF;
  IF (SELECT patient_name FROM reports WHERE id = (SELECT report_id FROM study_admission_result)) <> 'Synthetic patient' THEN
    RAISE EXCEPTION 'new non-null metadata observation did not update the snapshot';
  END IF;
  IF (SELECT count(*) FROM source_resource_observations
      WHERE report_id = (SELECT report_id FROM study_admission_result)
        AND resource_kind = 'study' AND generation = 1 AND resource_id = 'orthanc-study-old') <> 1 THEN
    RAISE EXCEPTION 'study locator was not recorded as a generation-bound source observation';
  END IF;
END;
$$;

-- The device API durably reserves the chosen key and global UIDs before URL signing.
SET ROLE clarity_v2_device_auth;
CREATE TEMP TABLE upload_admission_result AS
SELECT * FROM admit_ingestion_upload(
  '21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 1, 1,
  '72000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000001',
  'orthanc-instance-synthetic', '1.2.840.10008.1.99', '1.2.840.10008.1.99.1',
  '1.2.840.10008.1.99.1.1', 1024, repeat('d', 64),
  'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.dcm',
  clock_timestamp() + interval '5 minutes'
);
DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM admit_ingestion_upload(
    '21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 1, 1,
    '72000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000099',
    'orthanc-instance-synthetic', '1.2.840.10008.1.99', '1.2.840.10008.1.99.1',
    '1.2.840.10008.1.99.1.1', 1024, repeat('d', 64),
    'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000099.dcm',
    clock_timestamp() + interval '5 minutes'
  );
  IF v.upload_id <> '62000000-0000-4000-8000-000000000001'
     OR v.object_key <> 'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.dcm' THEN
    RAISE EXCEPTION 'upload retry changed the durable upload identity';
  END IF;
  BEGIN
    PERFORM complete_ingestion_upload('62000000-0000-4000-8000-000000000001',
      '21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',1,1,repeat('e',64),1024);
    RAISE EXCEPTION 'upload completed with a mismatching verified digest';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;
SELECT complete_ingestion_upload('62000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',1,1,repeat('d',64),1024);
SELECT complete_ingestion_upload('62000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',1,1,repeat('d',64),1024);
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM dicom_uid_registry WHERE uid_value IN ('1.2.840.10008.1.99.1','1.2.840.10008.1.99.1.1')) <> 2 THEN
    RAISE EXCEPTION 'upload admission failed to reserve global Series and SOP identities';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM report_files WHERE sop_instance_uid = '1.2.840.10008.1.99.1.1' AND state = 'received') THEN
    RAISE EXCEPTION 'verified upload receipt did not atomically transition the Report file';
  END IF;
  IF (SELECT status FROM ingestion_uploads WHERE id = '62000000-0000-4000-8000-000000000001') <> 'received' THEN
    RAISE EXCEPTION 'verified upload status was not durable';
  END IF;
END;
$$;
UPDATE orthanc_sources SET lease_expires_at = clock_timestamp() - interval '1 second'
 WHERE id = '21000000-0000-4000-8000-000000000001';
SET ROLE clarity_v2_device_auth;
DO $$
BEGIN
  PERFORM upsert_observed_study(
    '21000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001', 1, 1,
    '71000000-0000-4000-8000-000000000099', '1.2.840.10008.1.99', 'orthanc-study-old',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  RAISE EXCEPTION 'expired lease admitted a study mutation';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;
RESET ROLE;

SELECT advance_source_generation(
  '21000000-0000-4000-8000-000000000001', 1, 'orthanc_replaced'
);
SET ROLE clarity_v2_device_auth;
SELECT * FROM acquire_device_source_lease(
  '21000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001', clock_timestamp() + interval '4 minutes'
);
SELECT generation, current_fencing_token, lease_device_id, lease_expires_at > clock_timestamp() AS unexpired
  FROM orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001';
SELECT * FROM upsert_observed_study(
  '21000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001',
  (SELECT generation FROM orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  (SELECT current_fencing_token FROM orthanc_sources WHERE id = '21000000-0000-4000-8000-000000000001'),
  '71000000-0000-4000-8000-000000000099', '1.2.840.10008.1.99', 'orthanc-study-new',
  NULL, NULL, 'Corrected synthetic patient', NULL, NULL, NULL, NULL, NULL, NULL, NULL
);
RESET ROLE;
DO $$
BEGIN
  IF (SELECT source_study_id FROM reports WHERE id = (SELECT report_id FROM study_admission_result)) <> 'orthanc-study-new' THEN
    RAISE EXCEPTION 'new source generation did not update the observed Study locator';
  END IF;
  IF (SELECT count(*) FROM source_resource_observations
      WHERE report_id = (SELECT report_id FROM study_admission_result)
        AND resource_kind = 'study' AND resource_id IN ('orthanc-study-old', 'orthanc-study-new')) <> 2 THEN
    RAISE EXCEPTION 'changed locator did not preserve both generation-bound observations';
  END IF;
  IF (SELECT patient_name FROM reports WHERE id = (SELECT report_id FROM study_admission_result)) <> 'Corrected synthetic patient' THEN
    RAISE EXCEPTION 'new non-null study observation did not replace prior snapshot value';
  END IF;
  IF (SELECT state FROM reports WHERE id = '41000000-0000-4000-8000-000000000001') <> 'syncing' THEN
    RAISE EXCEPTION 'source generation reset left an old Ready Report visible';
  END IF;
  IF (SELECT version FROM reports WHERE id = '41000000-0000-4000-8000-000000000001') <> 5 THEN
    RAISE EXCEPTION 'source generation reset did not invalidate the Report revision CAS';
  END IF;
END;
$$;
SET ROLE clarity_v2_device_auth;
DO $$
BEGIN
  PERFORM begin_report_manifest_revision(
    '41000000-0000-4000-8000-000000000001', 2, 5, 1,
    '31000000-0000-4000-8000-000000000001', 1, '81000000-0000-4000-8000-000000000001'
  );
  RAISE EXCEPTION 'old generation lease created a manifest after source replacement';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;
RESET ROLE;

SET ROLE clarity_v2_runtime;
DO $$
BEGIN
  PERFORM begin_report_manifest_revision(
    '41000000-0000-4000-8000-000000000001', 2, 5, 1,
    '31000000-0000-4000-8000-000000000001', 1, '81000000-0000-4000-8000-000000000001'
  );
  RAISE EXCEPTION 'staff web runtime can create manifest revisions';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
RESET ROLE;

-- If the worker indexed an admitted file before the source seals its inventory,
-- sealing must re-evaluate the final proof and promote Ready in that same transaction.
INSERT INTO reports (id, source_id, source_study_id, study_instance_uid, state)
VALUES ('42000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
        'orthanc-study-precompleted', '1.2.840.10008.1.12', 'processing');
INSERT INTO report_files (id, report_id, source_id, series_instance_uid, sop_instance_uid,
                          sha256, byte_count, state, cloud_orthanc_instance_id)
VALUES ('52000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001',
        '21000000-0000-4000-8000-000000000001', '1.2.840.10008.1.12.1',
        '1.2.840.10008.1.12.1.1', repeat('c', 64), 256, 'indexed', 'orthanc-precompleted-proof');
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id)
VALUES ('1.2.840.10008.1.12', 'study', '21000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001'),
       ('1.2.840.10008.1.12.1', 'series', '21000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001');
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id, report_file_id, sha256)
VALUES ('1.2.840.10008.1.12.1.1', 'sop', '21000000-0000-4000-8000-000000000001',
        '42000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001', repeat('c', 64));
INSERT INTO ingestion_uploads (
  id, source_id, report_id, report_file_id, device_installation_id,
  fencing_token, source_generation, admission_key, declared_size_bytes,
  expected_sha256, verified_sha256, verified_size_bytes, object_key,
  expires_at, status
) VALUES (
  '62000000-0000-4000-8000-000000000201', '21000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001', 3, 2,
  '72000000-0000-4000-8000-000000000201', 256, repeat('c', 64), repeat('c', 64), 256,
  'intake/21000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000201.dcm',
  clock_timestamp() + interval '5 minutes', 'completed'
);

SET ROLE clarity_v2_device_auth;
SELECT begin_report_manifest_revision(
  '42000000-0000-4000-8000-000000000001', NULL, 1, 2,
  '31000000-0000-4000-8000-000000000001', 3, '82000000-0000-4000-8000-000000000201'
);
SELECT record_report_manifest_page(
  '42000000-0000-4000-8000-000000000001', 1, 1, 2,
  '31000000-0000-4000-8000-000000000001', 3,
  '[{"sopInstanceUid":"1.2.840.10008.1.12.1.1","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]',
  '82000000-0000-4000-8000-000000000201'
);
SELECT seal_observed_report_manifest(
  '42000000-0000-4000-8000-000000000001', 1, NULL, 1, 2,
  '31000000-0000-4000-8000-000000000001', 3, clock_timestamp(), true, true,
  encode(digest(convert_to('[{"sopInstanceUid":"1.2.840.10008.1.12.1.1","sha256":"' || repeat('c', 64) || '"}]', 'UTF8'), 'sha256'), 'hex'),
  '82000000-0000-4000-8000-000000000201'
);
RESET ROLE;
DO $$ BEGIN
  IF (SELECT status FROM ingestion_uploads WHERE id='62000000-0000-4000-8000-000000000201') <> 'completed'
     OR (SELECT state FROM report_files WHERE id='52000000-0000-4000-8000-000000000001') <> 'indexed'
     OR (SELECT state FROM reports WHERE id='42000000-0000-4000-8000-000000000001') <> 'ready' THEN
    RAISE EXCEPTION 'sealing did not promote a fully indexed precompleted upload to Ready';
  END IF;
END $$;
\set VERBOSITY verbose
