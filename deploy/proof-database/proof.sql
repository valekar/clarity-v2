INSERT INTO installation_settings (singleton_id, centre_name, timezone)
VALUES (1, 'Synthetic Proof Centre', 'Asia/Kolkata');

INSERT INTO orthanc_sources (id, display_name) VALUES
  ('20000000-0000-4000-8000-000000000001', 'Synthetic source one'),
  ('20000000-0000-4000-8000-000000000002', 'Synthetic source two');
INSERT INTO device_installations (id, source_id, display_name, credential_verifier) VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Synthetic device one', decode(repeat('a', 64), 'hex')),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'Synthetic device two', decode(repeat('b', 64), 'hex')),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', 'Synthetic device three', decode(repeat('c', 64), 'hex'));

DO $$
DECLARE
  first_fence bigint;
  second_fence bigint;
BEGIN
  first_fence := acquire_source_lease(
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '2 minutes'
  );
  IF first_fence <> 1 THEN RAISE EXCEPTION 'first source fence was not 1'; END IF;
  UPDATE orthanc_sources
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = '20000000-0000-4000-8000-000000000001';
  second_fence := acquire_source_lease(
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002',
    clock_timestamp() + interval '2 minutes'
  );
  IF second_fence <> first_fence + 1 THEN RAISE EXCEPTION 'source fence did not increase on takeover'; END IF;
END;
$$;

SELECT acquire_source_lease(
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  clock_timestamp() + interval '2 minutes'
);

INSERT INTO reports (id, source_id, source_study_id, study_instance_uid) VALUES
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'orthanc-study-one', '1.2.840.10008.1.1'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'orthanc-study-two', '1.2.840.10008.1.2');

DO $$
BEGIN
  INSERT INTO report_files (id, report_id, source_id, series_instance_uid, sop_instance_uid)
  VALUES (
    '50000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '1.2.840.10008.1.1.1',
    '1.2.840.10008.1.1.1.1'
  );
  RAISE EXCEPTION 'source/Report mismatch was accepted';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END;
$$;

INSERT INTO report_files (id, report_id, source_id, series_instance_uid, sop_instance_uid, sha256, byte_count, state, cloud_orthanc_instance_id)
VALUES (
  '50000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '1.2.840.10008.1.1.1',
  '1.2.840.10008.1.1.1.1',
  repeat('a', 64),
  1024,
  'indexed',
  'cloud-instance-one'
);
INSERT INTO report_files (id, report_id, source_id, series_instance_uid, sop_instance_uid, sha256, byte_count, state, cloud_orthanc_instance_id)
VALUES (
  '50000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000002',
  '1.2.840.10008.1.2.1',
  '1.2.840.10008.1.1.1.1',
  repeat('b', 64),
  2048,
  'indexed',
  'cloud-instance-two'
);

INSERT INTO source_resource_observations (
  id, source_id, generation, report_id, resource_kind, resource_id
) VALUES (
  '80000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 1,
  '40000000-0000-4000-8000-000000000001', 'study', 'orthanc-study-one'
);
INSERT INTO source_resource_observations (
  id, source_id, generation, report_id, resource_kind, resource_id, report_file_id
) VALUES (
  '80000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 1,
  '40000000-0000-4000-8000-000000000001', 'instance', 'orthanc-instance-one',
  '50000000-0000-4000-8000-000000000001'
);

DO $$
BEGIN
  UPDATE reports SET study_instance_uid = '1.2.3.99'
   WHERE id = '40000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'Report Study UID mutation was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  UPDATE report_files SET series_instance_uid = '1.2.3.88'
   WHERE id = '50000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'Report file Series UID mutation was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  UPDATE report_files SET sop_instance_uid = '1.2.3.77'
   WHERE id = '50000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'Report file SOP UID mutation was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id)
VALUES ('1.2.840.10008.1.1', 'study', '20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001');
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id)
VALUES ('1.2.840.10008.1.1.1', 'series', '20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001');
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id, report_file_id, sha256)
VALUES ('1.2.840.10008.1.1.1.1', 'sop', '20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', repeat('a', 64));

DO $$
BEGIN
  INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id, report_file_id, sha256)
  VALUES ('1.2.840.10008.1.1.1.1', 'sop', '20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', repeat('b', 64));
  RAISE EXCEPTION 'global duplicate SOP UID was accepted';
EXCEPTION WHEN unique_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  UPDATE report_files SET sha256 = repeat('c', 64)
   WHERE id = '50000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'conflicting file digest overwrite was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

INSERT INTO ingestion_batches (report_id, source_id, revision, base_revision)
VALUES ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 1, NULL);
INSERT INTO ingestion_batch_files (report_id, source_id, revision, sop_instance_uid, sha256)
VALUES ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 1, '1.2.840.10008.1.1.1.1', repeat('a', 64));
SELECT seal_report_revision(
  '40000000-0000-4000-8000-000000000001', NULL, 1, 1, 1, true, true, :'digest_one'
);
INSERT INTO report_manifest_proofs (
  report_id, source_id, revision, source_generation, observed_manifest_digest,
  source_observed_at, source_stable, inventory_complete
) VALUES (
  '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  1, 1, :'digest_one', clock_timestamp(), true, true
);

DO $$
BEGIN
  INSERT INTO ingestion_batches (report_id, source_id, revision, base_revision)
  VALUES ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 1, NULL);
  UPDATE ingestion_batches
     SET state = 'sealed', manifest_digest = repeat('e', 64), sealed_at = clock_timestamp()
   WHERE report_id = '40000000-0000-4000-8000-000000000002' AND revision = 1;
  RAISE EXCEPTION 'empty manifest was sealed';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  INSERT INTO ingestion_batches (
    report_id, source_id, revision, base_revision, state, manifest_digest, sealed_at
  ) VALUES (
    '40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
    2, 1, 'sealed', repeat('e', 64), clock_timestamp()
  );
  RAISE EXCEPTION 'direct sealed INSERT was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  UPDATE ingestion_batch_files SET sha256 = repeat('f', 64)
   WHERE report_id = '40000000-0000-4000-8000-000000000001' AND revision = 1;
  RAISE EXCEPTION 'sealed member row was mutable';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

INSERT INTO ingestion_batches (report_id, source_id, revision, base_revision)
VALUES ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 2, 1);
INSERT INTO ingestion_batch_files (report_id, source_id, revision, sop_instance_uid, sha256)
VALUES ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 2, '1.2.840.10008.1.1.1.1', repeat('a', 64));
SELECT seal_report_revision(
  '40000000-0000-4000-8000-000000000001', 1, 2, 2, 1, true, true, :'digest_one'
);
INSERT INTO report_manifest_proofs (
  report_id, source_id, revision, source_generation, observed_manifest_digest,
  source_observed_at, source_stable, inventory_complete
) VALUES (
  '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  2, 1, :'digest_one', clock_timestamp(), true, true
);

INSERT INTO ingestion_batches (report_id, source_id, revision, base_revision)
VALUES ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 1, NULL);

DO $$
BEGIN
  INSERT INTO ingestion_batch_files (report_id, source_id, revision, sop_instance_uid, sha256)
  VALUES ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 1, '1.2.840.10008.1.1.1.1', repeat('c', 64));
  RAISE EXCEPTION 'manifest member with wrong Report file digest was accepted';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  IF seal_report_revision(
    '40000000-0000-4000-8000-000000000001', 1, 1, 2, 1, true, true, repeat('0', 64)
  ) THEN
    RAISE EXCEPTION 'stale Report revision CAS unexpectedly succeeded';
  END IF;
END;
$$;
SELECT seal_report_revision(
  '40000000-0000-4000-8000-000000000001', 1, 2, 2, 1, true, true, :'digest_one'
);

UPDATE reports SET state = 'ready'
 WHERE id = '40000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  UPDATE report_files SET state = 'received', cloud_orthanc_instance_id = NULL
   WHERE id = '50000000-0000-4000-8000-000000000001';
  UPDATE reports SET state = 'ready'
   WHERE id = '40000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'unindexed manifest member was allowed to remain Ready';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  UPDATE reports SET state = 'ready'
   WHERE id = '40000000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'Report with no current manifest was marked Ready';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

UPDATE reports SET current_manifest_revision = 1
 WHERE id = '40000000-0000-4000-8000-000000000002';
DO $$
BEGIN
  UPDATE reports SET state = 'ready'
   WHERE id = '40000000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'Report with a draft current manifest was marked Ready';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

INSERT INTO report_files (id, report_id, source_id, series_instance_uid, sop_instance_uid, sha256, byte_count, state, cloud_orthanc_instance_id)
VALUES (
  '50000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '1.2.840.10008.1.1.1',
  '1.2.840.10008.1.1.1.2',
  repeat('b', 64),
  4096,
  'indexed',
  'cloud-instance-three'
);
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id, report_file_id, sha256)
VALUES ('1.2.840.10008.1.1.1.2', 'sop', '20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000003', repeat('b', 64));
INSERT INTO ingestion_batches (report_id, source_id, revision, base_revision)
VALUES ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 3, 2);

INSERT INTO ingestion_uploads (
  id, source_id, report_id, report_file_id, device_installation_id, fencing_token,
  admission_key, declared_size_bytes, expected_sha256, object_key, expires_at
)
VALUES (
  '60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002', 2,
  '70000000-0000-4000-8000-000000000001', 1024, repeat('a', 64),
  'proof/object-one', clock_timestamp() + interval '5 minutes'
);
UPDATE ingestion_uploads SET status = 'uploading'
 WHERE id = '60000000-0000-4000-8000-000000000001';
UPDATE ingestion_uploads SET status = 'received'
 WHERE id = '60000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  UPDATE ingestion_uploads SET object_key = 'proof/replaced-object'
   WHERE id = '60000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'upload object identity mutation was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  INSERT INTO ingestion_uploads (
    id, source_id, report_id, report_file_id, device_installation_id, fencing_token,
    admission_key, declared_size_bytes, expected_sha256, object_key, expires_at
  ) VALUES (
    '60000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002', 2,
    '70000000-0000-4000-8000-000000000002', 1024, repeat('a', 64),
    'proof/object-two', clock_timestamp() + interval '5 minutes'
  );
  RAISE EXCEPTION 'second active admission for a file was accepted';
EXCEPTION WHEN unique_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  INSERT INTO ingestion_uploads (
    id, source_id, report_id, report_file_id, device_installation_id, fencing_token,
    admission_key, declared_size_bytes, expected_sha256, object_key, expires_at
  ) VALUES (
    '60000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001', 1,
    '70000000-0000-4000-8000-000000000003', 1024, repeat('a', 64),
    'proof/object-stale-fence', clock_timestamp() + interval '5 minutes'
  );
  RAISE EXCEPTION 'stale device fence was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

DO $$
BEGIN
  UPDATE dicom_uid_registry SET report_id = '40000000-0000-4000-8000-000000000002'
   WHERE uid_value = '1.2.840.10008.1.1.1.1';
  RAISE EXCEPTION 'UID ownership was mutable';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;

SELECT 'PostgreSQL schema constraints and CAS proof passed' AS result;
