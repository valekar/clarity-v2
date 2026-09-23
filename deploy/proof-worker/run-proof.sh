#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
proof_dir="$(mktemp -d "${TMPDIR:-/tmp}/clarity-v2-worker-proof.XXXXXX")"
runtime_dir="$proof_dir/runtime"
mkdir -m 700 "$runtime_dir"
project="clarity-v2-worker-proof-$$"
compose_file="$repo_root/deploy/proof-worker/compose.yaml"
env_file="$proof_dir/proof.env"
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
random_secret() { openssl rand -hex 24; }

pg_port="$(port)"
minio_port="$(port)"
orthanc_port="$(port)"
proxy_port="$(port)"
pg_bootstrap_password="$(random_secret)"
pg_migrator_password="$(random_secret)"
pg_runtime_password="$(random_secret)"
pg_worker_password="$(random_secret)"
minio_root_user="proofroot$(openssl rand -hex 4)"
minio_root_password="$(random_secret)"
worker_s3_access_key="proofworker$(openssl rand -hex 4)"
worker_s3_secret_key="$(random_secret)"
orthanc_password="$(random_secret)"
cat >"$env_file" <<EOF
PG_PORT=$pg_port
PG_BOOTSTRAP_PASSWORD=$pg_bootstrap_password
MINIO_PORT=$minio_port
MINIO_ROOT_USER=$minio_root_user
MINIO_ROOT_PASSWORD=$minio_root_password
WORKER_S3_ACCESS_KEY=$worker_s3_access_key
WORKER_S3_SECRET_KEY=$worker_s3_secret_key
ORTHANC_PORT=$orthanc_port
ORTHANC_CONFIG=$runtime_dir/orthanc.json
EOF
chmod 600 "$env_file"
cat "$repo_root/deploy/proof-worker/orthanc.template.json" \
  | sed "s/WORKER_PROOF_PASSWORD/$orthanc_password/g" >"$runtime_dir/orthanc.json"
chmod 600 "$runtime_dir/orthanc.json"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

worker_pid=""
proxy_pid=""
compose() { docker compose --project-name "$project" --env-file "$env_file" --file "$compose_file" "$@"; }
mc() {
  docker run --rm --network "${project}_private" --volume "$runtime_dir:/proof:ro" \
    --env MINIO_ROOT_USER --env MINIO_ROOT_PASSWORD \
    --entrypoint /bin/sh \
    quay.io/minio/mc:RELEASE.2025-05-21T01-59-54Z@sha256:09f93f534cde415d192bb6084dd0e0ddd1715fb602f8a922ad121fd2bf0f8b44 \
    -ec "$*"
}
cleanup() {
  local status=$?
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then kill -TERM "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
  if [[ -n "$proxy_pid" ]] && kill -0 "$proxy_pid" 2>/dev/null; then kill -TERM "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true; fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ "$status" != 0 ]]; then
    for log in "$runtime_dir"/worker-*.log "$runtime_dir"/proxy.log; do
      [[ -f "$log" ]] || continue
      echo "--- $(basename "$log") ---" >&2
      head -35 "$log" >&2
      tail -80 "$log" >&2
    done
  fi
  rm -rf "$proof_dir"
}
trap cleanup EXIT INT TERM

if ! command -v docker >/dev/null || ! docker compose version >/dev/null || \
  ! command -v pnpm >/dev/null || ! command -v psql >/dev/null || ! command -v python3 >/dev/null; then
  echo 'Docker Compose, pnpm, psql and Python 3 are required for this proof.' >&2
  exit 1
fi

cd "$repo_root"
pnpm --filter @clarity/storage build >/dev/null
pnpm --filter @clarity/worker build >/dev/null
python3 deploy/cloud/scripts/make-synthetic-dicom.py "$runtime_dir/instance.dcm" >"$runtime_dir/uids.txt"
study_uid="$(cut -f1 "$runtime_dir/uids.txt")"
series_uid="$(cut -f2 "$runtime_dir/uids.txt")"
sop_uid="$(cut -f3 "$runtime_dir/uids.txt")"
file_size="$(wc -c <"$runtime_dir/instance.dcm" | tr -d '[:space:]')"
file_sha="$(shasum -a 256 "$runtime_dir/instance.dcm" | awk '{print $1}')"
manifest_sha="$(MANIFEST_SOP="$sop_uid" MANIFEST_SHA="$file_sha" node --input-type=module -e "import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(JSON.stringify([{sopInstanceUid:process.env.MANIFEST_SOP,sha256:process.env.MANIFEST_SHA}])).digest('hex'))")"

compose up --detach postgres minio orthanc
compose run --rm minio-init
for _ in $(seq 1 90); do
  if pg_isready --host 127.0.0.1 --port "$pg_port" --username postgres >/dev/null 2>&1 && \
    curl --silent --fail --user "proof:$orthanc_password" "http://127.0.0.1:$orthanc_port/system" >/dev/null; then break; fi
  sleep 1
done
pg_isready --host 127.0.0.1 --port "$pg_port" --username postgres >/dev/null
curl --silent --fail --user "proof:$orthanc_password" "http://127.0.0.1:$orthanc_port/system" >/dev/null

PGHOST=127.0.0.1 PGPORT="$pg_port" PGUSER=postgres PGPASSWORD="$pg_bootstrap_password" PGDATABASE=postgres \
  psql --no-psqlrc --set ON_ERROR_STOP=1 --command "CREATE ROLE clarity_v2_migrator LOGIN PASSWORD '$pg_migrator_password'; CREATE ROLE clarity_v2_runtime LOGIN PASSWORD '$pg_runtime_password'; CREATE ROLE clarity_v2_worker LOGIN PASSWORD '$pg_worker_password'; CREATE ROLE clarity_v2_device_auth NOLOGIN; CREATE ROLE clarity_v2_bootstrap_operator NOLOGIN; GRANT CREATE ON SCHEMA public TO clarity_v2_migrator;"
PGHOST=127.0.0.1 PGPORT="$pg_port" PGUSER=postgres PGPASSWORD="$pg_bootstrap_password" PGDATABASE=postgres \
  psql --no-psqlrc --set ON_ERROR_STOP=1 --command "CREATE DATABASE clarity_v2_worker_proof OWNER clarity_v2_migrator;"
PGHOST=127.0.0.1 PGPORT="$pg_port" PGUSER=postgres PGPASSWORD="$pg_bootstrap_password" PGDATABASE=postgres \
  psql --no-psqlrc --set ON_ERROR_STOP=1 --command "GRANT CONNECT ON DATABASE clarity_v2_worker_proof TO clarity_v2_runtime, clarity_v2_worker;"
export PGHOST=127.0.0.1 PGPORT="$pg_port" PGUSER=clarity_v2_migrator PGPASSWORD="$pg_migrator_password" PGDATABASE=clarity_v2_worker_proof
pnpm --filter @clarity/database migrate >/dev/null
psql --no-psqlrc --set ON_ERROR_STOP=1 --file deploy/cloud/postgres/grant-clarity-runtime.sql >/dev/null

mc 'mc alias set proof http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc cp /proof/instance.dcm proof/clarity-v2-proof-intake/intake/60000000-0000-4000-8000-000000000001/instance.dcm >/dev/null; printf outside-proof | mc pipe proof/clarity-v2-proof-intake/outside/sentinel.txt'

psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --set study_uid="$study_uid" --set series_uid="$series_uid" --set sop_uid="$sop_uid" \
  --set file_sha="$file_sha" --set file_size="$file_size" --set manifest_sha="$manifest_sha" <<'SQL' >/dev/null
INSERT INTO orthanc_sources (id, display_name) VALUES
  ('20000000-0000-4000-8000-000000000001', 'Synthetic worker source');
INSERT INTO device_installations (id, source_id, display_name, credential_verifier) VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'Synthetic worker device', decode(repeat('a', 64), 'hex'));
SELECT acquire_source_lease('20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001', clock_timestamp() + interval '4 minutes');
INSERT INTO reports (id, source_id, source_study_id, study_instance_uid, state)
VALUES ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
        'synthetic-orthanc-study', :'study_uid', 'syncing');
INSERT INTO report_files (id, report_id, source_id, series_instance_uid, sop_instance_uid,
                          sha256, byte_count, state)
VALUES ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001', :'series_uid', :'sop_uid', :'file_sha',
        :'file_size'::bigint, 'received');
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id)
VALUES (:'study_uid', 'study', '20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001'),
       (:'series_uid', 'series', '20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001');
INSERT INTO dicom_uid_registry (uid_value, uid_type, source_id, report_id, report_file_id, sha256)
VALUES (:'sop_uid', 'sop', '20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001', :'file_sha');
SELECT begin_report_manifest_revision(
  '40000000-0000-4000-8000-000000000001', NULL, 1, 1,
  '30000000-0000-4000-8000-000000000001', 1
);
SELECT record_report_manifest_page(
  '40000000-0000-4000-8000-000000000001', 1, 1, 1,
  '30000000-0000-4000-8000-000000000001', 1,
  jsonb_build_array(jsonb_build_object('sopInstanceUid', :'sop_uid', 'sha256', :'file_sha'))
);
SELECT seal_observed_report_manifest(
  '40000000-0000-4000-8000-000000000001', 1, NULL, 1, 1,
  '30000000-0000-4000-8000-000000000001', 1, clock_timestamp(), true, true, :'manifest_sha'
);
INSERT INTO ingestion_uploads (id, source_id, report_id, report_file_id, device_installation_id,
                               fencing_token, admission_key, declared_size_bytes, expected_sha256,
                               object_key, expires_at)
VALUES ('60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001', 1,
        '70000000-0000-4000-8000-000000000001', :'file_size'::bigint, :'file_sha',
        'intake/60000000-0000-4000-8000-000000000001/instance.dcm', clock_timestamp() + interval '1 hour');
UPDATE ingestion_uploads SET status = 'uploading' WHERE id = '60000000-0000-4000-8000-000000000001';
UPDATE ingestion_uploads SET status = 'received' WHERE id = '60000000-0000-4000-8000-000000000001';
SQL

DATABASE_URL="postgresql://clarity_v2_worker:$pg_worker_password@127.0.0.1:$pg_port/clarity_v2_worker_proof" \
S3_PROOF_ENDPOINT="http://127.0.0.1:$minio_port" S3_PROOF_BUCKET=clarity-v2-proof-intake \
S3_PROOF_ACCESS_KEY="$worker_s3_access_key" S3_PROOF_SECRET_KEY="$worker_s3_secret_key" \
  node deploy/proof-worker/check-s3-scope.mjs >/dev/null

PGHOST=127.0.0.1 PGPORT="$pg_port" PGUSER=postgres PGPASSWORD="$pg_bootstrap_password" PGDATABASE=clarity_v2_worker_proof \
  psql --no-psqlrc --set ON_ERROR_STOP=1 --command "CREATE FUNCTION public.proof_pause_worker_commit() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN IF NEW.state = 'indexed' AND OLD.state <> 'indexed' THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END; \$\$; CREATE TRIGGER proof_pause_worker_commit BEFORE UPDATE OF state ON report_files FOR EACH ROW EXECUTE FUNCTION proof_pause_worker_commit();" >/dev/null

worker_environment() {
  exec env DATABASE_URL="postgresql://clarity_v2_worker:$pg_worker_password@127.0.0.1:$pg_port/clarity_v2_worker_proof" \
    INTAKE_S3_ENDPOINT="${1:-http://127.0.0.1:$minio_port}" INTAKE_S3_BUCKET=clarity-v2-proof-intake \
    INTAKE_S3_REGION=us-east-1 INTAKE_S3_ACCESS_KEY="$worker_s3_access_key" \
    INTAKE_S3_SECRET_KEY="$worker_s3_secret_key" CLOUD_ORTHANC_URL="http://127.0.0.1:$orthanc_port/" \
    CLOUD_ORTHANC_USERNAME=proof CLOUD_ORTHANC_PASSWORD="$orthanc_password" \
    WORKER_STAGING_DIR="$runtime_dir/staging" WORKER_MAX_OBJECT_BYTES=100000000 \
    WORKER_BATCH_SIZE=1 WORKER_POLL_MS=250 WORKER_TRACE=1 node apps/worker/dist/main.js
}
worker_environment >"$runtime_dir/worker-before-commit.log" 2>&1 &
worker_pid=$!

find_ids() {
  curl --silent --show-error --fail --user "proof:$orthanc_password" \
    --header 'Content-Type: application/json' --data "{\"Level\":\"Instance\",\"Query\":{\"SOPInstanceUID\":\"$sop_uid\"}}" \
    "http://127.0.0.1:$orthanc_port/tools/find"
}
instance_ids=""
for _ in $(seq 1 120); do
  instance_ids="$(find_ids 2>/dev/null || true)"
  if [[ "$instance_ids" != '[]' && -n "$instance_ids" ]]; then break; fi
  sleep 0.5
done
if [[ "$instance_ids" == '[]' || -z "$instance_ids" ]]; then echo 'Worker did not import the synthetic object to Orthanc.' >&2; exit 1; fi

active_completion=0
for _ in $(seq 1 60); do
  active_completion="$(PGHOST=127.0.0.1 PGPORT="$pg_port" PGUSER=postgres PGPASSWORD="$pg_bootstrap_password" PGDATABASE=postgres \
    psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM pg_stat_activity WHERE datname='clarity_v2_worker_proof' AND application_name='clarity-v2-worker' AND state='active' AND query LIKE '%complete_ingestion_import%';")"
  [[ "$active_completion" == 1 ]] && break
  sleep 0.2
done
if [[ "$active_completion" != 1 ]]; then echo 'Worker never entered its durable completion transaction.' >&2; exit 1; fi
kill -KILL "$worker_pid"
wait "$worker_pid" 2>/dev/null || true
worker_pid=""

for _ in $(seq 1 30); do
  active_completion="$(PGHOST=127.0.0.1 PGPORT="$pg_port" PGUSER=postgres PGPASSWORD="$pg_bootstrap_password" PGDATABASE=postgres \
    psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM pg_stat_activity WHERE datname='clarity_v2_worker_proof' AND application_name='clarity-v2-worker' AND state='active' AND query LIKE '%complete_ingestion_import%';")"
  [[ "$active_completion" == 0 ]] && break
  sleep 0.2
done
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "DROP TRIGGER proof_pause_worker_commit ON report_files; DROP FUNCTION proof_pause_worker_commit();" >/dev/null
state_after_crash="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT u.status || '|' || f.state FROM ingestion_uploads u JOIN report_files f ON f.id=u.report_file_id WHERE u.id='60000000-0000-4000-8000-000000000001';")"
[[ "$state_after_crash" == 'received|received' ]] || { echo 'Worker crash did not roll back the incomplete DB completion transaction.' >&2; exit 1; }

DATABASE_URL="unused" PROXY_PORT="$proxy_port" MINIO_PORT="$minio_port" DELETE_MARKER_PATH="$runtime_dir/delete-seen" \
  node deploy/proof-worker/delete-hold-proxy.mjs >"$runtime_dir/proxy.log" 2>&1 &
proxy_pid=$!
sleep 0.25
worker_environment "http://127.0.0.1:$proxy_port" >"$runtime_dir/worker-before-cleanup.log" 2>&1 &
worker_pid=$!
for _ in $(seq 1 100); do [[ -f "$runtime_dir/delete-seen" ]] && break; sleep 0.2; done
[[ -f "$runtime_dir/delete-seen" ]] || { echo 'Worker did not reach the post-commit cleanup boundary.' >&2; exit 1; }
post_commit_state="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT u.status || '|' || (u.intake_cleaned_at IS NULL)::text || '|' || f.state FROM ingestion_uploads u JOIN report_files f ON f.id=u.report_file_id WHERE u.id='60000000-0000-4000-8000-000000000001';")"
[[ "$post_commit_state" == 'completed|true|indexed' ]] || { echo 'The database completion was not durable before intake DELETE began.' >&2; exit 1; }
kill -KILL "$worker_pid"
wait "$worker_pid" 2>/dev/null || true
worker_pid=""
kill -TERM "$proxy_pid" 2>/dev/null || true
wait "$proxy_pid" 2>/dev/null || true
proxy_pid=""

worker_environment >"$runtime_dir/worker-cleanup-retry.log" 2>&1 &
worker_pid=$!
final_state=""
for _ in $(seq 1 60); do
  final_state="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT u.status || '|' || (u.intake_cleaned_at IS NOT NULL)::text || '|' || f.state || '|' || r.state FROM ingestion_uploads u JOIN report_files f ON f.id=u.report_file_id JOIN reports r ON r.id=u.report_id WHERE u.id='60000000-0000-4000-8000-000000000001';")"
  [[ "$final_state" == 'completed|true|indexed|ready' ]] && break
  sleep 0.2
done
[[ "$final_state" == 'completed|true|indexed|ready' ]] || { echo "Final durable state did not converge: $final_state" >&2; exit 1; }

instance_id="$(node --input-type=module -e 'const ids=JSON.parse(process.argv[1]); if(ids.length!==1) process.exit(1); console.log(ids[0])' "$instance_ids")"
curl --silent --show-error --fail --user "proof:$orthanc_password" \
  "http://127.0.0.1:$orthanc_port/instances/$instance_id/simplified-tags" >"$runtime_dir/tags.json"
node --input-type=module -e 'import fs from "node:fs"; const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(x.StudyInstanceUID!==process.argv[2]||x.SeriesInstanceUID!==process.argv[3]||x.SOPInstanceUID!==process.argv[4])process.exit(1)' \
  "$runtime_dir/tags.json" "$study_uid" "$series_uid" "$sop_uid"
curl --silent --show-error --fail --user "proof:$orthanc_password" \
  "http://127.0.0.1:$orthanc_port/instances/$instance_id/file" >"$runtime_dir/readback.dcm"
[[ "$(shasum -a 256 "$runtime_dir/readback.dcm" | awk '{print $1}')" == "$file_sha" ]] || { echo 'Cloud Orthanc readback digest differed.' >&2; exit 1; }
if mc 'mc alias set proof http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc stat proof/clarity-v2-proof-intake/intake/60000000-0000-4000-8000-000000000001/instance.dcm' >/dev/null 2>&1; then
  echo 'Verified intake object still exists after cleanup receipt.' >&2
  exit 1
fi
worker_count="$(find_ids | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
[[ "$worker_count" == 1 ]] || { echo 'Retry created a duplicate Orthanc SOP instance.' >&2; exit 1; }
kill -TERM "$worker_pid" 2>/dev/null || true
wait "$worker_pid" 2>/dev/null || true
worker_pid=""

echo 'Disposable running-worker proof passed: staged immutable bytes, scoped MinIO intake, Orthanc import/readback, crash rollback/reconciliation, post-commit cleanup retry, and Ready state.'
