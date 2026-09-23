#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cloud_dir="$repo_root/deploy/cloud"
proof_dir="$(mktemp -d "${TMPDIR:-/tmp}/clarity-v2-cloud-proof.XXXXXX")"
project="clarity-v2-proof-$$"
restore_project="${project}-restore"
compose_file="$cloud_dir/compose.yaml"
env_file="$proof_dir/proof.env"
app_proof="${CLARITY_APP_PROOF:-0}"
connected_proof="${CLARITY_CONNECTED_PROOF:-0}"
viewer_proof="${CLARITY_VIEWER_PROOF:-0}"
viewer_browser_diagnostic="${CLARITY_VIEWER_BROWSER_DIAGNOSTIC:-0}"
viewer_browser_hold="${CLARITY_VIEWER_BROWSER_HOLD_SECONDS:-0}"
compiled_sync_proof="${CLARITY_COMPILED_SYNC_PROOF:-0}"
if [[ "$viewer_proof" == 1 || "$viewer_browser_diagnostic" == 1 ]]; then
  viewer_proof=1
  app_proof=1
  connected_proof=1
fi
if [[ "$compiled_sync_proof" == 1 ]]; then
  app_proof=1
fi
port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }

if ! command -v docker >/dev/null || ! command -v curl >/dev/null || ! command -v python3 >/dev/null; then
  echo 'Docker, curl and Python 3 are required for the cloud proof.' >&2
  exit 1
fi
if ! docker compose version >/dev/null; then
  echo 'Docker Compose v2 is required.' >&2
  exit 1
fi

random_secret() { openssl rand -hex 24; }
hanko_port="$(port)"
orthanc_port="$(port)"
mailpit_port="$(port)"
minio_port="$(port)"
console_port="$(port)"
web_port="$(port)"
cat >"$env_file" <<EOF
PG_BOOTSTRAP_PASSWORD=$(random_secret)
CLARITY_MIGRATOR_PASSWORD=$(random_secret)
CLARITY_RUNTIME_PASSWORD=$(random_secret)
CLARITY_WORKER_PASSWORD=$(random_secret)
CLARITY_DEVICE_AUTH_PASSWORD=$(random_secret)
INTAKE_UPLOAD_PASSWORD=$(random_secret)
INTAKE_WORKER_PASSWORD=$(random_secret)
HANKO_MIGRATOR_PASSWORD=$(random_secret)
HANKO_RUNTIME_PASSWORD=$(random_secret)
ORTHANC_RUNTIME_PASSWORD=$(random_secret)
ORTHANC_S3_PASSWORD=$(random_secret)
ORTHANC_HTTP_PASSWORD=$(random_secret)
MINIO_ROOT_USER=proofroot$(openssl rand -hex 4)
MINIO_ROOT_PASSWORD=$(random_secret)
HANKO_SECRET_ENCRYPTION_KEY=$(random_secret)$(random_secret)
HANKO_HTTP_PORT=$hanko_port
ORTHANC_HTTP_PORT=$orthanc_port
MAILPIT_HTTP_PORT=$mailpit_port
MINIO_API_PORT=$minio_port
MINIO_CONSOLE_PORT=$console_port
HANKO_PUBLIC_API_URL=http://localhost:$hanko_port
HANKO_ISSUER=https://clarity-v2-synthetic.invalid
HANKO_AUDIENCE=clarity-v2-synthetic-client
CLARITY_PUBLIC_ORIGIN=http://localhost:$web_port
INTAKE_S3_PUBLIC_ENDPOINT=http://localhost:$minio_port
ORTHANC_HTTP_USERNAME=proof
WEB_HTTP_PORT=$web_port
EOF
chmod 600 "$env_file"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

write_hanko_config() {
  local path="$1" user="$2" password="$3"
  cat >"$path" <<EOF
account:
  allow_deletion: true
  allow_signup: true
database:
  user: $user
  password: $password
  host: postgres
  port: "5432"
  database: hanko
  dialect: postgres
email:
  enabled: true
  optional: false
  require_verification: true
  passcode_ttl: 300
email_delivery:
  enabled: true
  from_address: no-reply@clarity.invalid
  from_name: Clarity V2 synthetic proof
  smtp:
    host: mailpit
    port: "1025"
mfa:
  enabled: false
passkey:
  enabled: false
password:
  enabled: false
  optional: true
secrets:
  keys:
    - $HANKO_SECRET_ENCRYPTION_KEY
server:
  public:
    address: "0.0.0.0:8000"
cors:
  allow_origins:
    - "http://127.0.0.1:$hanko_port"
    - "http://localhost:$hanko_port"
    - "http://localhost:$web_port"
service:
  name: Clarity V2 synthetic proof
session:
  issuer: https://clarity-v2-synthetic.invalid
  audience:
    - clarity-v2-synthetic-client
  enable_auth_token_header: false
  cookie:
    name: hanko
    domain: localhost
    http_only: true
    same_site: strict
    secure: true
webauthn:
  relying_party:
    id: localhost
    origins:
      - "http://127.0.0.1:$hanko_port"
      - "http://localhost:$hanko_port"
      - "http://localhost:$web_port"
EOF
  chmod 600 "$path"
}

hanko_migrate_config="$proof_dir/hanko-migrate.yaml"
hanko_runtime_config="$proof_dir/hanko-runtime.yaml"
orthanc_config="$proof_dir/orthanc.json"
write_hanko_config "$hanko_migrate_config" hanko_migrator "$HANKO_MIGRATOR_PASSWORD"
write_hanko_config "$hanko_runtime_config" hanko_runtime "$HANKO_RUNTIME_PASSWORD"
cat >"$orthanc_config" <<EOF
{
  "Name": "Clarity V2 synthetic cloud proof",
  "RemoteAccessAllowed": true,
  "AuthenticationEnabled": true,
  "RegisteredUsers": {"proof": "$ORTHANC_HTTP_PASSWORD"},
  "HttpPort": 8042,
  "DicomServerEnabled": false,
  "Plugins": [
    "/usr/share/orthanc/plugins-available/libOrthancPostgreSQLIndex.so",
    "/usr/share/orthanc/plugins-available/libOrthancAwsS3Storage.so",
    "/usr/share/orthanc/plugins-available/libOrthancDicomWeb.so",
    "/usr/share/orthanc/plugins-available/libOrthancOHIF.so"
  ],
  "PostgreSQL": {
    "EnableIndex": true,
    "EnableStorage": false,
    "Host": "postgres",
    "Port": 5432,
    "Database": "orthanc",
    "Username": "orthanc_runtime",
    "Password": "$ORTHANC_RUNTIME_PASSWORD",
    "EnableSsl": false,
    "MaximumConnectionRetries": 20,
    "ConnectionRetryInterval": 1,
    "IndexConnectionsCount": 5
  },
  "AwsS3Storage": {
    "BucketName": "clarity-v2-imaging",
    "Region": "us-east-1",
    "Endpoint": "http://minio:9000/",
    "AccessKey": "orthanc-runtime",
    "SecretKey": "$ORTHANC_S3_PASSWORD",
    "RootPath": "synthetic-proof",
    "VirtualAddressing": false
  },
  "DicomWeb": {"Enable": true, "Root": "/dicom-web/"},
  "OHIF": {"DataSource": "dicom-web", "RouterBasename": "/ohif/"}
}
EOF
chmod 600 "$orthanc_config"
export HANKO_MIGRATE_CONFIG="$hanko_migrate_config"
export HANKO_RUNTIME_CONFIG="$hanko_runtime_config"
export ORTHANC_CONFIG="$orthanc_config"

compose() {
  local selected_project="$1"; shift
  local compose_files=(--file "$compose_file")
  if [[ "$app_proof" == 1 ]]; then
    compose_files+=(--file "$cloud_dir/compose.application.yaml")
  fi
  docker compose --project-name "$selected_project" --env-file "$env_file" "${compose_files[@]}" "$@"
}

finish() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    echo 'Cloud proof failed; relevant service logs follow.' >&2
    compose "$project" logs --no-color --tail 100 postgres clarity-migrate hanko-migrate hanko minio minio-init orthanc >&2 || true
    compose "$restore_project" logs --no-color --tail 80 postgres hanko orthanc minio >&2 || true
  fi
  cleanup
  exit "$status"
}

cleanup() {
  compose "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  compose "$restore_project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$proof_dir"
}
trap finish EXIT

wait_healthy() {
  local name="$1"
  for _ in $(seq 1 90); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
    [[ "$state" == healthy ]] && return 0
    sleep 1
  done
  echo "Timed out waiting for container health: $name ($state)" >&2
  return 1
}

wait_completed() {
  local name="$1"
  for _ in $(seq 1 120); do
    state="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true)"
    if [[ "$state" == exited ]]; then
      exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
      [[ "$exit_code" == 0 ]] && return 0
      echo "One-shot service failed: $name (exit $exit_code)" >&2
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for one-shot service: $name ($state)" >&2
  return 1
}

wait_http() {
  local url="$1" auth="${2:-}"
  for _ in $(seq 1 90); do
    if [[ -n "$auth" ]]; then
      curl --silent --fail --user "$auth" "$url" >/dev/null && return 0
    else
      curl --silent --fail "$url" >/dev/null && return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for HTTP endpoint: $url" >&2
  return 1
}

mc_run() {
  local selected_project="$1"; shift
  docker run --rm --network "${selected_project}_private" \
    --volume "$proof_dir:/proof" \
    --env MINIO_ROOT_USER --env MINIO_ROOT_PASSWORD \
    --entrypoint /bin/sh \
    quay.io/minio/mc:RELEASE.2025-05-21T01-59-54Z@sha256:09f93f534cde415d192bb6084dd0e0ddd1715fb602f8a922ad121fd2bf0f8b44 \
    -ec "$*"
}

cd "$repo_root"
compose "$project" build clarity-migrate
compose "$project" up --detach postgres minio mailpit
wait_healthy "${project}-postgres-1"
compose "$project" up --detach clarity-migrate hanko-migrate minio-init
wait_completed "${project}-clarity-migrate-1"
wait_completed "${project}-hanko-migrate-1"
wait_completed "${project}-minio-init-1"
compose "$project" up --detach hanko orthanc
wait_healthy "${project}-hanko-1"
wait_http "http://127.0.0.1:$hanko_port/health/ready"
wait_http "http://127.0.0.1:$orthanc_port/system" "proof:$ORTHANC_HTTP_PASSWORD"

compose "$project" exec --no-TTY hanko /hanko isready --config /config/hanko-runtime.yaml public
compose "$project" exec --no-TTY hanko /hanko config show --config /config/hanko-runtime.yaml >"$proof_dir/hanko-effective.json"
python3 - "$proof_dir/hanko-effective.json" <<'PY'
import json, sys
config = json.load(open(sys.argv[1], encoding="utf-8"))
cookie = config["session"]["cookie"]
assert cookie["http_only"] is True
assert cookie["same_site"] == "strict"
assert cookie["secure"] is True
assert config["session"]["enable_auth_token_header"] is False
print("Hanko v3 effective session settings: HttpOnly, Secure, SameSite=Strict, auth-token header disabled")
PY

expected_migrations="$(find "$repo_root/libs/database/migrations" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' | wc -l | tr -d '[:space:]')"
applied_migrations="$(compose "$project" exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U clarity_v2_migrator -d clarity_v2_app --command "SELECT count(*) FROM public.schema_migrations;")"
if [[ "$applied_migrations" != "$expected_migrations" ]]; then
  echo "Clarity database has $applied_migrations applied migrations; expected $expected_migrations." >&2
  exit 1
fi
compose "$project" exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U clarity_v2_runtime -d clarity_v2_app --command "SELECT count(*) FROM public.staff_users;" >/dev/null
if compose "$project" exec --no-TTY postgres psql -X --set ON_ERROR_STOP=1 -U clarity_v2_runtime -d clarity_v2_app --command "SELECT count(*) FROM public.schema_migrations;" >/dev/null 2>&1; then
  echo 'Clarity runtime role unexpectedly reads migration history.' >&2
  exit 1
fi
if compose "$project" exec --no-TTY postgres psql -X --set ON_ERROR_STOP=1 -U clarity_v2_runtime -d clarity_v2_app --command "UPDATE reports SET state = 'ready';" >/dev/null 2>&1; then
  echo 'Clarity runtime role unexpectedly has direct Report write permission.' >&2
  exit 1
fi
if compose "$project" exec --no-TTY postgres psql -X --set ON_ERROR_STOP=1 -U clarity_v2_runtime -d clarity_v2_app --command "CREATE TABLE public.runtime_must_not_create(id integer);" >/dev/null 2>&1; then
  echo 'Clarity runtime role unexpectedly has public schema CREATE.' >&2
  exit 1
fi
runtime_worker_execute="$(compose "$project" exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U clarity_v2_runtime -d clarity_v2_app --command "SELECT has_function_privilege(current_user, 'public.complete_ingestion_import_fenced(uuid,text,text)', 'EXECUTE');")"
worker_execute="$(compose "$project" exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U clarity_v2_worker -d clarity_v2_app --command "SELECT has_function_privilege(current_user, 'public.complete_ingestion_import_fenced(uuid,text,text)', 'EXECUTE');")"
if [[ "$runtime_worker_execute" != f || "$worker_execute" != t ]]; then
  echo "Worker import privilege is not isolated from web runtime: runtime=$runtime_worker_execute worker=$worker_execute" >&2
  exit 1
fi
if compose "$project" exec --no-TTY postgres psql -X --set ON_ERROR_STOP=1 -U clarity_v2_worker -d clarity_v2_app --command "UPDATE reports SET state = 'ready';" >/dev/null 2>&1; then
  echo 'Clarity worker role unexpectedly has direct Report write permission.' >&2
  exit 1
fi
if compose "$project" exec --no-TTY postgres psql -X --set ON_ERROR_STOP=1 -U clarity_v2_worker -d clarity_v2_app --command "SELECT id FROM staff_identities LIMIT 1;" >/dev/null 2>&1; then
  echo 'Clarity worker role unexpectedly reads staff identities.' >&2
  exit 1
fi
device_lease_execute="$(compose "$project" exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U clarity_v2_device_auth_login -d clarity_v2_app --command "SELECT has_function_privilege(current_user, 'public.acquire_device_source_lease(uuid,uuid,timestamptz)', 'EXECUTE');")"
device_admin_execute="$(compose "$project" exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U clarity_v2_device_auth_login -d clarity_v2_app --command "SELECT has_function_privilege(current_user, 'public.create_source_pairing(uuid,uuid,uuid,bytea,timestamptz)', 'EXECUTE');")"
if [[ "$device_lease_execute" != t || "$device_admin_execute" != f ]]; then
  echo "Device role grants are not isolated: lease=$device_lease_execute admin=$device_admin_execute" >&2
  exit 1
fi
if compose "$project" exec --no-TTY postgres psql -X --set ON_ERROR_STOP=1 -U clarity_v2_device_auth_login -d clarity_v2_app --command "SELECT id FROM staff_identities LIMIT 1;" >/dev/null 2>&1; then
  echo 'Clarity device role unexpectedly reads staff identities.' >&2
  exit 1
fi
for role in clarity_v2_runtime clarity_v2_worker clarity_v2_device_auth_login; do
  dispatch_access="$(compose "$project" exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 \
    -U "$role" -d clarity_v2_app --command "SELECT has_function_privilege(current_user, 'public.create_share_dispatch(uuid,uuid,uuid,bigint,integer,uuid,boolean,text,boolean,uuid,bigint)', 'EXECUTE')::text || '|' || has_function_privilege(current_user, 'public.claim_dispatch_outbox(uuid,integer)', 'EXECUTE')::text || '|' || has_table_privilege(current_user, 'public.dispatch_outbox', 'SELECT')::text;")"
  if [[ "$dispatch_access" != 'f|f|f' ]]; then
    echo "Recipient-policy gate unexpectedly exposes dispatch to $role: $dispatch_access" >&2
    exit 1
  fi
done

python3 "$cloud_dir/scripts/make-synthetic-dicom.py" "$proof_dir/synthetic.dcm" >"$proof_dir/dicom-uids.txt"
upload_response="$(curl --silent --show-error --fail --user "proof:$ORTHANC_HTTP_PASSWORD" \
  --header 'Content-Type: application/dicom' --data-binary "@$proof_dir/synthetic.dcm" \
  "http://127.0.0.1:$orthanc_port/instances")"
instance_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["ID"])' "$upload_response")"
study_uid="$(cut -f1 "$proof_dir/dicom-uids.txt")"
file_sha="$(shasum -a 256 "$proof_dir/synthetic.dcm" | awk '{print $1}')"
curl --silent --show-error --fail --user "proof:$ORTHANC_HTTP_PASSWORD" \
  "http://127.0.0.1:$orthanc_port/instances/$instance_id/file" >"$proof_dir/readback.dcm"
readback_sha="$(shasum -a 256 "$proof_dir/readback.dcm" | awk '{print $1}')"
[[ "$file_sha" == "$readback_sha" ]] || { echo 'Orthanc DICOM byte readback hash differs.' >&2; exit 1; }
plugins="$(curl --silent --show-error --fail --user "proof:$ORTHANC_HTTP_PASSWORD" "http://127.0.0.1:$orthanc_port/plugins")"
python3 - "$plugins" <<'PY'
import json, sys
plugins = json.loads(sys.argv[1])
names = {(item if isinstance(item, str) else item.get("ID") or item.get("Name")).lower() for item in plugins}
required = {"postgresql-index", "aws s3 storage", "dicom-web", "ohif"}
if not required.issubset(names):
    raise SystemExit(f"Orthanc plugins missing: {sorted(required - names)} (loaded {sorted(names)})")
print("Orthanc reports PostgreSQL index, S3 storage, DICOMweb and OHIF plugins loaded")
PY
curl --silent --show-error --fail --user "proof:$ORTHANC_HTTP_PASSWORD" \
  --header 'Accept: application/dicom+json' \
  "http://127.0.0.1:$orthanc_port/dicom-web/studies?StudyInstanceUID=$study_uid" >"$proof_dir/qido.json"
python3 - "$proof_dir/qido.json" "$study_uid" <<'PY'
import json, sys
items = json.load(open(sys.argv[1], encoding="utf-8"))
if isinstance(items, dict):
    items = [items]
items = [json.loads(item) if isinstance(item, str) and item.lstrip().startswith("{") else item for item in items]
assert any(item.get("0020000D", {}).get("Value", [None])[0] == sys.argv[2] for item in items)
print("Orthanc DICOMweb QIDO-RS returned the synthetic Study Instance UID")
PY
mc_run "$project" 'mc alias set proof http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; test -n "$(mc ls --recursive proof/clarity-v2-imaging)"'
pnpm --filter @clarity/worker... build
mc_run "$project" 'mc alias set proof http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; printf "clarity-v2 worker synthetic S3 check\n" | mc pipe "proof/clarity-v2-imaging/proof-worker/nested path/synthetic.txt"'
S3_PROOF_ENDPOINT="http://127.0.0.1:$minio_port" \
S3_PROOF_BUCKET=clarity-v2-imaging \
S3_PROOF_OBJECT_KEY='proof-worker/nested path/synthetic.txt' \
S3_PROOF_ACCESS_KEY="$MINIO_ROOT_USER" \
S3_PROOF_SECRET_KEY="$MINIO_ROOT_PASSWORD" \
ORTHANC_PROOF_DICOM_PATH="$proof_dir/synthetic.dcm" \
ORTHANC_PROOF_URL="http://127.0.0.1:$orthanc_port/" \
ORTHANC_PROOF_USERNAME=proof \
ORTHANC_PROOF_PASSWORD="$ORTHANC_HTTP_PASSWORD" \
  node "$cloud_dir/scripts/prove-worker-adapters.mjs"
echo "Initial runtime proof passed: schema migrations, Hanko v3 readiness/config, Orthanc PG index + S3 object + DICOMweb readback ($instance_id)."

if [[ "$app_proof" == 1 ]]; then
  compose "$project" build web worker
  compose "$project" up --detach intake-init web worker
  wait_completed "${project}-intake-init-1"
  wait_healthy "${project}-web-1"
  wait_http "http://127.0.0.1:$web_port/api/health"
  if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$web_port/api/staff")" != 401 ]]; then
    echo 'Anonymous staff API was not denied by the containerized web service.' >&2
    exit 1
  fi
  worker_state="$(docker inspect --format '{{.State.Running}}:{{.RestartCount}}' "${project}-worker-1")"
  if [[ "$worker_state" != true:0 ]]; then
    echo "Containerized worker did not remain stable after its database startup check ($worker_state)." >&2
    exit 1
  fi
  echo 'Application overlay proof passed: scoped intake init, web liveness/anonymous denial and worker startup.'
fi

if [[ "$viewer_proof" == 1 ]]; then
  nonce_admin="$(openssl rand -hex 8)"
  nonce_staff="$(openssl rand -hex 8)"
  python3 "$cloud_dir/scripts/prove-hanko-flow.py" \
    "http://localhost:$hanko_port" "http://localhost:$mailpit_port" \
    "$nonce_admin" "$proof_dir/viewer-admin.json"
  python3 "$cloud_dir/scripts/prove-hanko-flow.py" \
    "http://localhost:$hanko_port" "http://localhost:$mailpit_port" \
    "$nonce_staff" "$proof_dir/viewer-staff.json"
  web_origin="http://localhost:$web_port"
  python3 "$cloud_dir/scripts/prove-staff-web.py" enroll \
    "$web_origin" "http://localhost:$hanko_port" \
    "$proof_dir/viewer-admin.json" "$proof_dir/viewer-staff.json"
  compose "$project" exec --no-TTY postgres psql -X --set ON_ERROR_STOP=1 \
    -U postgres -d postgres \
    --command "CREATE ROLE clarity_v2_bootstrap_login LOGIN PASSWORD '$PG_BOOTSTRAP_PASSWORD' IN ROLE clarity_v2_bootstrap_operator;" >/dev/null
  admin_subject="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["subject"])' "$proof_dir/viewer-admin.json")"
  if [[ ! "$admin_subject" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    echo 'Hanko viewer proof returned a malformed administrator subject.' >&2
    exit 1
  fi
  admin_subject="${admin_subject,,}"
  admin_user_id="$(compose "$project" exec --no-TTY postgres psql -X --tuples-only --no-align \
    --set ON_ERROR_STOP=1 -U postgres -d clarity_v2_app \
    --command "SELECT staff_user_id FROM staff_identities WHERE provider='hanko' AND issuer='$HANKO_ISSUER' AND lower(subject)='$admin_subject';")"
  admin_identity_id="$(compose "$project" exec --no-TTY postgres psql -X --tuples-only --no-align \
    --set ON_ERROR_STOP=1 -U postgres -d clarity_v2_app \
    --command "SELECT id FROM staff_identities WHERE provider='hanko' AND issuer='$HANKO_ISSUER' AND lower(subject)='$admin_subject';")"
  if [[ -z "$admin_user_id" || -z "$admin_identity_id" ]]; then
    echo 'Viewer proof administrator was not enrolled before connected ingestion.' >&2
    exit 1
  fi
  compose "$project" exec --no-TTY --env "PGPASSWORD=$PG_BOOTSTRAP_PASSWORD" postgres \
    psql -X --set ON_ERROR_STOP=1 -U clarity_v2_bootstrap_login -d clarity_v2_app \
    --command "SELECT bootstrap_first_staff_admin('$admin_user_id', '$admin_identity_id');" >/dev/null
  echo 'Two synthetic Hanko identities were enrolled and the connected-ingestion administrator was bootstrapped.'
fi

if [[ "$connected_proof" == 1 ]]; then
  CLARITY_PROOF_PROJECT="$project" \
  CLARITY_PROOF_ENV_FILE="$env_file" \
  CLARITY_WEB_URL="http://127.0.0.1:$web_port" \
  CLARITY_PROOF_ORTHANC_URL="http://127.0.0.1:$orthanc_port/" \
  CLARITY_PROOF_RESULT_FILE="$proof_dir/connected-ingestion.json" \
  ORTHANC_HTTP_USERNAME=proof \
  ORTHANC_HTTP_PASSWORD="$ORTHANC_HTTP_PASSWORD" \
  node "$cloud_dir/scripts/prove-connected-ingestion.mjs"
  echo "Connected synthetic device-to-Ready proof passed; private fixture: $proof_dir/connected-ingestion.json"
fi

if [[ "$viewer_proof" == 1 ]]; then
  python3 "$cloud_dir/scripts/prove-staff-web.py" verify \
    "http://localhost:$web_port" "http://localhost:$hanko_port" \
    "$proof_dir/viewer-admin.json" "$proof_dir/viewer-staff.json" \
    "$proof_dir/connected-ingestion.json"
  echo 'Authenticated viewer routes passed against the worker-created source-offline Ready Report fixture.'
fi

if [[ "$viewer_browser_diagnostic" == 1 ]]; then
  python3 "$cloud_dir/scripts/prove-ohif-browser.py" \
    "http://localhost:$web_port" "$proof_dir/viewer-admin.json" \
    "$proof_dir/connected-ingestion.json"
fi

if [[ "$compiled_sync_proof" == 1 ]]; then
  CLARITY_PROOF_PROJECT="$project" \
  CLARITY_PROOF_ENV_FILE="$env_file" \
  CLARITY_WEB_URL="http://127.0.0.1:$web_port" \
  CLARITY_PROOF_CLOUD_ORTHANC_URL="http://127.0.0.1:$orthanc_port/" \
  CLARITY_PROOF_RESULT_FILE="$proof_dir/compiled-sync-service.json" \
  ORTHANC_HTTP_USERNAME=proof \
  ORTHANC_HTTP_PASSWORD="$ORTHANC_HTTP_PASSWORD" \
  node "$cloud_dir/scripts/prove-compiled-sync-service.mjs"
  echo 'Compiled sync-service discovered a separate synthetic Orthanc source and reached cloud Ready.'
fi

if [[ "$viewer_browser_hold" != 0 ]]; then
  if [[ "$viewer_proof" != 1 || ! "$viewer_browser_hold" =~ ^[0-9]+$ ]] || (( viewer_browser_hold > 300 )); then
    echo 'CLARITY_VIEWER_BROWSER_HOLD_SECONDS requires CLARITY_VIEWER_PROOF=1 and an integer from 1 to 300.' >&2
    exit 1
  fi
  echo "Disposable browser check available at http://localhost:$web_port for ${viewer_browser_hold}s."
  sleep "$viewer_browser_hold"
fi

compose "$project" up --detach --force-recreate orthanc
wait_http "http://127.0.0.1:$orthanc_port/instances/$instance_id/file" "proof:$ORTHANC_HTTP_PASSWORD"
compose "$project" up --detach --force-recreate postgres
wait_healthy "${project}-postgres-1"
wait_http "http://127.0.0.1:$orthanc_port/instances/$instance_id/file" "proof:$ORTHANC_HTTP_PASSWORD"
wait_http "http://127.0.0.1:$hanko_port/health/ready"
echo 'Container replacement persistence passed for PostgreSQL, Hanko and Orthanc.'

for database in clarity_v2_app hanko orthanc; do
  compose "$project" exec --no-TTY postgres pg_dump -U postgres --format=custom --no-owner -d "$database" >"$proof_dir/$database.dump"
done
mkdir -p "$proof_dir/object-backup"
docker run --rm --network "${project}_private" --volume "$proof_dir:/proof" \
  --env MINIO_ROOT_USER --env MINIO_ROOT_PASSWORD --entrypoint /bin/sh \
  quay.io/minio/mc:RELEASE.2025-05-21T01-59-54Z@sha256:09f93f534cde415d192bb6084dd0e0ddd1715fb602f8a922ad121fd2bf0f8b44 \
  -ec 'mc alias set proof http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mirror --overwrite proof/clarity-v2-imaging /proof/object-backup'

compose "$project" down --remove-orphans
compose "$restore_project" up --detach postgres minio mailpit
wait_healthy "${restore_project}-postgres-1"
compose "$restore_project" run --rm minio-init
for database in clarity_v2_app hanko orthanc; do
  case "$database" in
    clarity_v2_app) restore_user=clarity_v2_migrator ;;
    hanko) restore_user=hanko_migrator ;;
    orthanc) restore_user=orthanc_runtime ;;
  esac
  compose "$restore_project" exec --no-TTY postgres pg_restore --no-comments -U "$restore_user" -d "$database" <"$proof_dir/$database.dump"
done
docker run --rm --network "${restore_project}_private" --volume "$proof_dir:/proof" \
  --env MINIO_ROOT_USER --env MINIO_ROOT_PASSWORD --entrypoint /bin/sh \
  quay.io/minio/mc:RELEASE.2025-05-21T01-59-54Z@sha256:09f93f534cde415d192bb6084dd0e0ddd1715fb602f8a922ad121fd2bf0f8b44 \
  -ec 'mc alias set proof http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mirror --overwrite /proof/object-backup proof/clarity-v2-imaging'
compose "$restore_project" up --detach clarity-migrate hanko-migrate
wait_completed "${restore_project}-clarity-migrate-1"
wait_completed "${restore_project}-hanko-migrate-1"
compose "$restore_project" up --detach hanko orthanc
wait_healthy "${restore_project}-hanko-1"
restore_orthanc_port="$(compose "$restore_project" port orthanc 8042 | awk -F: '{print $NF}')"
restore_hanko_port="$(compose "$restore_project" port hanko 8000 | awk -F: '{print $NF}')"
wait_http "http://127.0.0.1:$restore_orthanc_port/instances/$instance_id/file" "proof:$ORTHANC_HTTP_PASSWORD"
wait_http "http://127.0.0.1:$restore_hanko_port/health/ready"
restore_sha="$(curl --silent --show-error --fail --user "proof:$ORTHANC_HTTP_PASSWORD" \
  "http://127.0.0.1:$restore_orthanc_port/instances/$instance_id/file" | shasum -a 256 | awk '{print $1}')"
[[ "$restore_sha" == "$file_sha" ]] || { echo 'Orthanc object/index backup restore did not preserve DICOM bytes.' >&2; exit 1; }
echo 'Backup restore into new PostgreSQL/MinIO volumes passed; restored Orthanc returned matching synthetic DICOM bytes.'

compose "$project" down --volumes --remove-orphans >/dev/null
compose "$restore_project" down --volumes --remove-orphans >/dev/null
for old_project in "$project" "$restore_project"; do
  if docker volume ls --filter "label=com.docker.compose.project=$old_project" --quiet | grep -q .; then
    echo "Proof volumes remain after cleanup: $old_project" >&2
    exit 1
  fi
done
trap - EXIT
rm -rf "$proof_dir"
echo 'Disposable containers, project networks and named volumes removed.'
