#!/usr/bin/env bash
set -euo pipefail

image='postgres:18.6-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af'
container_name="clarity-v2-proof-$$"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bootstrap_password='clarity-v2-bootstrap-proof-only'
runtime_password='clarity-v2-runtime-proof-only'
device_auth_password='clarity-v2-device-auth-proof-only'

if ! command -v docker >/dev/null || ! command -v psql >/dev/null || ! command -v pg_isready >/dev/null; then
  echo 'Docker, psql and pg_isready are required for the isolated database proof.' >&2
  exit 1
fi

cleanup() {
  docker rm -fv "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach --name "$container_name" \
  --publish '127.0.0.1::5432' \
  --env POSTGRES_DB=clarity_v2_proof \
  --env POSTGRES_PASSWORD=clarity-v2-proof-only \
  "$image" >/dev/null
volume_name="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$container_name")"

port="$(docker port "$container_name" 5432/tcp | awk -F: '{print $NF}')"
export PGHOST=127.0.0.1
export PGPORT="$port"
export PGUSER=postgres
export PGPASSWORD=clarity-v2-proof-only
export PGDATABASE=clarity_v2_proof

ready=0
for _ in $(seq 1 60); do
  if pg_isready --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" >/dev/null 2>&1; then
    ready=1
  break
  fi
  sleep 0.5
done
if [[ "$ready" -ne 1 ]]; then
  echo 'Disposable PostgreSQL did not become ready.' >&2
  exit 1
fi

psql --no-psqlrc --set ON_ERROR_STOP=1 --command "CREATE ROLE clarity_v2_migrator NOLOGIN; CREATE ROLE clarity_v2_runtime LOGIN PASSWORD '$runtime_password'; CREATE ROLE clarity_v2_worker LOGIN PASSWORD '$runtime_password'; CREATE ROLE clarity_v2_device_auth NOLOGIN; CREATE ROLE clarity_v2_device_auth_login LOGIN PASSWORD '$device_auth_password' IN ROLE clarity_v2_device_auth; CREATE ROLE clarity_v2_bootstrap_operator NOLOGIN; CREATE ROLE clarity_v2_bootstrap_login LOGIN PASSWORD '$bootstrap_password' IN ROLE clarity_v2_bootstrap_operator; GRANT CREATE ON SCHEMA public TO clarity_v2_migrator;"
cd "$repo_root"
pnpm --filter @clarity/database migrate
digest_one="$(node --input-type=module -e "import { createHash } from 'node:crypto'; console.log(createHash('sha256').update(JSON.stringify([{sopInstanceUid:'1.2.840.10008.1.1.1.1',sha256:'$(printf 'a%.0s' {1..64})'}])).digest('hex'))")"
psql --no-psqlrc --set ON_ERROR_STOP=1 --set "digest_one=$digest_one" --file deploy/proof-database/proof.sql
psql --no-psqlrc --set ON_ERROR_STOP=1 --file deploy/proof-database/dispatch-outbox.sql

psql --no-psqlrc --set ON_ERROR_STOP=1 --command "ALTER FUNCTION reconcile_ingestion_upload_status(uuid,text,text) OWNER TO clarity_v2_migrator; ALTER FUNCTION complete_ingestion_import(uuid,text,text) OWNER TO clarity_v2_migrator; ALTER FUNCTION flag_ingestion_attention(uuid) OWNER TO clarity_v2_migrator; ALTER FUNCTION mark_ingestion_intake_cleaned(uuid) OWNER TO clarity_v2_migrator; ALTER FUNCTION authorize_ingestion_import(uuid) OWNER TO clarity_v2_migrator; ALTER FUNCTION complete_ingestion_import_fenced(uuid,text,text) OWNER TO clarity_v2_migrator; ALTER FUNCTION renew_device_source_lease(uuid,uuid,bigint,bigint,timestamptz) OWNER TO clarity_v2_migrator; GRANT USAGE ON SCHEMA public TO clarity_v2_migrator, clarity_v2_runtime, clarity_v2_worker, clarity_v2_device_auth, clarity_v2_bootstrap_operator; GRANT CONNECT ON DATABASE clarity_v2_proof TO clarity_v2_device_auth; GRANT SELECT ON staff_users, staff_identities, staff_memberships TO clarity_v2_runtime; GRANT SELECT ON ingestion_uploads, report_files, reports, dicom_uid_registry TO clarity_v2_worker; GRANT SELECT, UPDATE(status, intake_cleaned_at) ON ingestion_uploads TO clarity_v2_migrator; GRANT SELECT, UPDATE ON report_files TO clarity_v2_migrator; GRANT SELECT, INSERT, UPDATE ON reports TO clarity_v2_migrator; GRANT SELECT, INSERT, UPDATE ON source_study_admissions TO clarity_v2_migrator; GRANT SELECT, INSERT ON source_resource_observations, dicom_uid_registry TO clarity_v2_migrator; GRANT SELECT ON ingestion_batches, ingestion_batch_files, dicom_uid_registry TO clarity_v2_migrator; GRANT SELECT, INSERT, UPDATE ON staff_users, staff_identities, staff_memberships, staff_access_control, staff_access_audit TO clarity_v2_migrator; GRANT TRUNCATE ON staff_access_audit TO clarity_v2_migrator; GRANT USAGE, SELECT ON SEQUENCE staff_access_audit_id_seq TO clarity_v2_migrator; ALTER FUNCTION enroll_pending_hanko_identity(uuid,uuid,text,text,text) OWNER TO clarity_v2_migrator; ALTER FUNCTION bootstrap_first_staff_admin(uuid,uuid) OWNER TO clarity_v2_migrator; ALTER FUNCTION is_effective_staff_admin(uuid) OWNER TO clarity_v2_migrator; ALTER FUNCTION change_staff_membership(uuid,uuid,bigint,text,text) OWNER TO clarity_v2_migrator; ALTER FUNCTION change_staff_user_active(uuid,uuid,bigint,boolean,boolean) OWNER TO clarity_v2_migrator; GRANT EXECUTE ON FUNCTION reconcile_ingestion_upload_status(uuid,text,text) TO clarity_v2_runtime; GRANT EXECUTE ON FUNCTION authorize_ingestion_import(uuid), complete_ingestion_import_fenced(uuid,text,text), flag_ingestion_attention(uuid), mark_ingestion_intake_cleaned(uuid) TO clarity_v2_worker;"
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "ALTER FUNCTION admit_ingestion_upload(uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz) OWNER TO clarity_v2_migrator; ALTER FUNCTION admit_ingestion_upload_base_0013(uuid,uuid,bigint,bigint,uuid,uuid,text,text,text,text,bigint,text,text,timestamptz) OWNER TO clarity_v2_migrator; ALTER FUNCTION attach_ingestion_multipart(uuid,uuid,bigint,bigint,text) OWNER TO clarity_v2_migrator; ALTER FUNCTION complete_ingestion_upload(uuid,uuid,uuid,bigint,bigint,text,bigint) OWNER TO clarity_v2_migrator; ALTER FUNCTION read_ingestion_upload(uuid,uuid,uuid) OWNER TO clarity_v2_migrator; GRANT SELECT, INSERT, UPDATE ON ingestion_uploads TO clarity_v2_migrator; GRANT INSERT ON report_files TO clarity_v2_migrator;"
device_auth_schema_usage="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT has_schema_privilege('clarity_v2_device_auth_login', 'public', 'USAGE');")"
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "ALTER FUNCTION seal_report_revision(uuid,integer,bigint,integer,bigint,boolean,boolean,text) OWNER TO clarity_v2_migrator; ALTER FUNCTION require_current_manifest_fence(uuid,uuid,bigint,bigint) OWNER TO clarity_v2_migrator; ALTER FUNCTION begin_report_manifest_revision(uuid,integer,bigint,bigint,uuid,bigint) OWNER TO clarity_v2_migrator; ALTER FUNCTION record_report_manifest_page(uuid,integer,bigint,bigint,uuid,bigint,jsonb) OWNER TO clarity_v2_migrator; ALTER FUNCTION seal_observed_report_manifest(uuid,integer,integer,bigint,bigint,uuid,bigint,timestamptz,boolean,boolean,text,uuid) OWNER TO clarity_v2_migrator; ALTER FUNCTION seal_observed_report_manifest_base_0013(uuid,integer,integer,bigint,bigint,uuid,bigint,timestamptz,boolean,boolean,text,uuid) OWNER TO clarity_v2_migrator; ALTER FUNCTION begin_report_manifest_revision(uuid,integer,bigint,bigint,uuid,bigint,uuid) OWNER TO clarity_v2_migrator; ALTER FUNCTION record_report_manifest_page(uuid,integer,bigint,bigint,uuid,bigint,jsonb,uuid) OWNER TO clarity_v2_migrator; ALTER FUNCTION upsert_observed_study(uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO clarity_v2_migrator; ALTER FUNCTION upsert_observed_study_base_0013(uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO clarity_v2_migrator; GRANT USAGE ON SCHEMA public TO clarity_v2_device_auth; GRANT EXECUTE ON FUNCTION begin_report_manifest_revision(uuid,integer,bigint,bigint,uuid,bigint,uuid), record_report_manifest_page(uuid,integer,bigint,bigint,uuid,bigint,jsonb,uuid), seal_observed_report_manifest(uuid,integer,integer,bigint,bigint,uuid,bigint,timestamptz,boolean,boolean,text,uuid), upsert_observed_study(uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text,text,text,text,text,text) TO clarity_v2_device_auth;"
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "GRANT SELECT, UPDATE ON orthanc_sources, device_installations TO clarity_v2_migrator; GRANT SELECT, INSERT, UPDATE ON ingestion_batches, report_manifest_proofs TO clarity_v2_migrator; GRANT SELECT, INSERT, DELETE ON ingestion_batch_files TO clarity_v2_migrator;"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file deploy/proof-database/manifests.sql
if [[ "$device_auth_schema_usage" != 't' ]]; then
  echo 'Device-auth login lacks USAGE on the migrated application schema.' >&2
  exit 1
fi
bash deploy/proof-database/prove-staff-access.sh
bash deploy/proof-database/prove-ingestion-admission-race.sh

admin_user_id="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT bootstrapped_user_id FROM staff_access_control WHERE singleton_id = 1;")"
staff_user_id="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT staff_user_id FROM staff_identities WHERE provider = 'hanko' AND issuer = 'https://hanko.example.invalid' AND subject = 'synthetic-subject-three';")"
admin_hanko_subject='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
staff_hanko_subject='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "INSERT INTO staff_identities (id, staff_user_id, provider, issuer, subject) VALUES ('10000000-0000-4000-8000-000000000011', '$admin_user_id', 'hanko', 'https://hanko.example.invalid', '$admin_hanko_subject'), ('10000000-0000-4000-8000-000000000012', '$staff_user_id', 'hanko', 'https://hanko.example.invalid', '$staff_hanko_subject');"
PGUSER=clarity_v2_runtime PGPASSWORD="$runtime_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SELECT change_staff_membership('$admin_user_id', '$staff_user_id', 0, 'staff', 'active');" >/dev/null
pnpm --filter @clarity/database build
pnpm --filter @clarity/server build
STAFF_PROOF_DATABASE_URL="postgresql://clarity_v2_runtime:$runtime_password@$PGHOST:$PGPORT/$PGDATABASE" \
STAFF_PROOF_ADMIN_ID="$admin_user_id" \
STAFF_PROOF_STAFF_ID="$staff_user_id" \
STAFF_PROOF_ADMIN_SUBJECT="$admin_hanko_subject" \
STAFF_PROOF_STAFF_SUBJECT="$staff_hanko_subject" \
  node --experimental-strip-types --test libs/server/tests/staff-access.postgres.ts

privileged_grants="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE n.nspname = 'public' AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = 'clarity_v2_runtime')) AND a.privilege_type = 'EXECUTE' AND p.proname IN ('acquire_source_lease', 'advance_source_generation', 'seal_report_revision');")"
if [[ "$privileged_grants" != '0' ]]; then
  echo 'Privileged lease, generation, or seal function is executable by PUBLIC/runtime.' >&2
  exit 1
fi
if psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SET ROLE clarity_v2_runtime; CREATE TABLE public.runtime_must_not_create(id integer);" >/dev/null 2>&1; then
  echo 'Runtime role can create objects in the pinned SECURITY DEFINER search_path schema.' >&2
  exit 1
fi
if psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SET ROLE clarity_v2_runtime; UPDATE reports SET state = 'ready' WHERE id = '40000000-0000-4000-8000-000000000001';" >/dev/null 2>&1; then
  echo 'Runtime role can directly set Report Ready.' >&2
  exit 1
fi

psql --no-psqlrc --set ON_ERROR_STOP=1 --command "BEGIN; INSERT INTO ingestion_batch_files (report_id, source_id, revision, sop_instance_uid, sha256) VALUES ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 3, '1.2.840.10008.1.1.1.1', repeat('a', 64)); SELECT pg_sleep(1); COMMIT;" >/dev/null &
member_writer_pid=$!
sleep 0.15
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SELECT seal_report_revision('40000000-0000-4000-8000-000000000001', 2, 3, 3, 1, true, true, '$digest_one');" >/dev/null
wait "$member_writer_pid"
sealed_member_count="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT state || ':' || manifest_digest || ':' || (SELECT count(*) FROM ingestion_batch_files WHERE report_id = '40000000-0000-4000-8000-000000000001' AND revision = 3) FROM ingestion_batches WHERE report_id = '40000000-0000-4000-8000-000000000001' AND revision = 3;")"
if [[ "$sealed_member_count" != "sealed:$digest_one:1" ]]; then
  echo 'Concurrent manifest insert/seal did not preserve the one-member proof manifest.' >&2
  exit 1
fi

psql --no-psqlrc --set ON_ERROR_STOP=1 --command "INSERT INTO ingestion_uploads (id, source_id, report_id, report_file_id, device_installation_id, fencing_token, admission_key, declared_size_bytes, expected_sha256, object_key, expires_at, status) VALUES ('60000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000002', 2, '70000000-0000-4000-8000-000000000002', 1024, repeat('b',64), 'proof/object-two', clock_timestamp() + interval '5 minutes', 'received');" >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "UPDATE orthanc_sources SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = '20000000-0000-4000-8000-000000000001'; UPDATE report_files SET state = 'needs_attention', cloud_orthanc_instance_id = NULL WHERE id = '50000000-0000-4000-8000-000000000003'; UPDATE reports SET state = 'needs_attention' WHERE id = '40000000-0000-4000-8000-000000000001'; SET ROLE clarity_v2_worker; SELECT authorize_ingestion_import('60000000-0000-4000-8000-000000000001'); SELECT complete_ingestion_import_fenced('60000000-0000-4000-8000-000000000001', repeat('a',64), 'cloud-instance-one'); SELECT mark_ingestion_intake_cleaned('60000000-0000-4000-8000-000000000001'); SELECT mark_ingestion_intake_cleaned('60000000-0000-4000-8000-000000000001'); RESET ROLE;" >/dev/null
completed_status="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT status FROM ingestion_uploads WHERE id = '60000000-0000-4000-8000-000000000001';")"
if [[ "$completed_status" != 'completed' ]]; then
  echo 'An unchanged, already-received upload could not finish after lease expiry.' >&2
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "BEGIN; SELECT acquire_source_lease('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', clock_timestamp() + interval '2 minutes'); SELECT pg_sleep(1); COMMIT;" >/dev/null &
lease_takeover_pid=$!
sleep 0.15
wait "$lease_takeover_pid"
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SET ROLE clarity_v2_worker; SELECT authorize_ingestion_import('60000000-0000-4000-8000-000000000002'); SELECT authorize_ingestion_import('60000000-0000-4000-8000-000000000002'); RESET ROLE;" >/dev/null
stale_status="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT status FROM ingestion_uploads WHERE id = '60000000-0000-4000-8000-000000000002';")"
if [[ "$stale_status" != 'aborted' ]]; then
  echo 'A received upload survived a superseding source fence.' >&2
  exit 1
fi
stale_report_version="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT version FROM reports WHERE id = '40000000-0000-4000-8000-000000000001';")"
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SET ROLE clarity_v2_worker; SELECT authorize_ingestion_import('60000000-0000-4000-8000-000000000002'); RESET ROLE;" >/dev/null
if [[ "$(psql --no-psqlrc --tuples-only --no-align --command "SELECT version FROM reports WHERE id = '40000000-0000-4000-8000-000000000001';")" != "$stale_report_version" ]]; then
  echo 'Repeated stale import authorization churned Report version.' >&2
  exit 1
fi
if psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SET ROLE clarity_v2_runtime; SELECT complete_ingestion_import_fenced('60000000-0000-4000-8000-000000000001', repeat('a',64), 'cloud-instance-one'); RESET ROLE;" >/dev/null 2>&1; then
  echo 'Web runtime unexpectedly completed an imaging import.' >&2
  exit 1
fi
if psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SET ROLE clarity_v2_worker; SELECT staff_user_id FROM staff_identities LIMIT 1; RESET ROLE;" >/dev/null 2>&1; then
  echo 'Worker role unexpectedly read staff identity data.' >&2
  exit 1
fi
cleanup_marked="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT intake_cleaned_at IS NOT NULL FROM ingestion_uploads WHERE id = '60000000-0000-4000-8000-000000000001';")"
if [[ "$cleanup_marked" != 't' ]]; then
  echo 'Worker cleanup receipt was not persisted.' >&2
  exit 1
fi
attention_state="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT state FROM reports WHERE id = '40000000-0000-4000-8000-000000000001';")"
if [[ "$attention_state" != 'needs_attention' ]]; then
  echo 'Completing one file erased another unresolved file attention state.' >&2
  exit 1
fi

psql --no-psqlrc --set ON_ERROR_STOP=1 >/dev/null <<'SQL'
SELECT advance_source_generation(
  '20000000-0000-4000-8000-000000000001', 1, 'orthanc_replaced'
);
UPDATE reports SET source_study_id = 'orthanc-study-one-after-reset'
 WHERE id = '40000000-0000-4000-8000-000000000001';
INSERT INTO source_resource_observations (
  id, source_id, generation, report_id, resource_kind, resource_id
) VALUES (
  '80000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 2,
  '40000000-0000-4000-8000-000000000001', 'study', 'orthanc-study-one-new'
);
INSERT INTO source_resource_observations (
  id, source_id, generation, report_id, resource_kind, resource_id, report_file_id
) VALUES (
  '80000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 2,
  '40000000-0000-4000-8000-000000000001', 'instance', 'orthanc-instance-one-new',
  '50000000-0000-4000-8000-000000000001'
);
SQL
reset_summary="$(psql --no-psqlrc --tuples-only --no-align --command "
  SELECT s.generation || ':' || r.source_study_id || ':' || r.id || ':' || f.id || ':' || count(o.id)
    FROM orthanc_sources s
    JOIN reports r ON r.source_id = s.id
    JOIN report_files f ON f.report_id = r.id
    JOIN source_resource_observations o ON o.report_id = r.id
   WHERE s.id = '20000000-0000-4000-8000-000000000001'
     AND r.id = '40000000-0000-4000-8000-000000000001'
     AND f.id = '50000000-0000-4000-8000-000000000001'
   GROUP BY s.generation, r.source_study_id, r.id, f.id;")"
expected_reset_summary='2:orthanc-study-one-after-reset:40000000-0000-4000-8000-000000000001:50000000-0000-4000-8000-000000000001:4'
if [[ "$reset_summary" != "$expected_reset_summary" ]]; then
  echo "Source generation reset did not preserve logical IDs and observation history: $reset_summary" >&2
  exit 1
fi
stale_generation_result="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT COALESCE(advance_source_generation('20000000-0000-4000-8000-000000000001', 1, 'orthanc_replaced'), 0);")"
if [[ "$stale_generation_result" != '0' ]]; then
  echo 'Stale source generation CAS unexpectedly advanced the source.' >&2
  exit 1
fi
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "DO \$\$ BEGIN UPDATE source_generations SET reason = 'explicit_reconcile' WHERE source_id = '20000000-0000-4000-8000-000000000001' AND generation = 1; RAISE EXCEPTION 'source generation history mutation was accepted'; EXCEPTION WHEN check_violation THEN NULL; END; \$\$;" >/dev/null

pnpm --filter @clarity/database migrate
cleanup
trap - EXIT INT TERM
if docker inspect "$container_name" >/dev/null 2>&1; then
  echo 'Disposable PostgreSQL container unexpectedly remains after cleanup.' >&2
  exit 1
fi
if [[ -n "$volume_name" ]] && docker volume inspect "$volume_name" >/dev/null 2>&1; then
  echo 'Disposable PostgreSQL anonymous volume unexpectedly remains after cleanup.' >&2
  exit 1
fi
echo 'Disposable PostgreSQL container and anonymous volume removed.'
