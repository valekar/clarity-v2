#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cloud_dir="$repo_root/deploy/cloud"
proof_dir="$(mktemp -d "${TMPDIR:-/tmp}/clarity-v2-hanko-proof.XXXXXX")"
project="clarity-v2-hanko-$$"
env_file="$proof_dir/proof.env"

port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
random_secret() { openssl rand -hex 24; }
hanko_port="$(port)"
mailpit_port="$(port)"
web_port="$(port)"
postgres_port="$(port)"
hanko_migrate_config="$proof_dir/hanko-migrate.yaml"
hanko_runtime_config="$proof_dir/hanko-runtime.yaml"
orthanc_config="$proof_dir/orthanc.json"
compose_override="$proof_dir/web-proof-compose.yaml"
web_origin="http://localhost:$web_port"

cat >"$env_file" <<EOF
PG_BOOTSTRAP_PASSWORD=$(random_secret)
CLARITY_MIGRATOR_PASSWORD=$(random_secret)
CLARITY_RUNTIME_PASSWORD=$(random_secret)
CLARITY_WORKER_PASSWORD=$(random_secret)
HANKO_MIGRATOR_PASSWORD=$(random_secret)
HANKO_RUNTIME_PASSWORD=$(random_secret)
ORTHANC_RUNTIME_PASSWORD=$(random_secret)
ORTHANC_S3_PASSWORD=$(random_secret)
ORTHANC_HTTP_PASSWORD=$(random_secret)
MINIO_ROOT_USER=proofroot$(openssl rand -hex 4)
MINIO_ROOT_PASSWORD=$(random_secret)
HANKO_SECRET_ENCRYPTION_KEY=$(random_secret)$(random_secret)
HANKO_HTTP_PORT=$hanko_port
MAILPIT_HTTP_PORT=$mailpit_port
PROOF_POSTGRES_PORT=$postgres_port
MINIO_API_PORT=$(port)
MINIO_CONSOLE_PORT=$(port)
HANKO_MIGRATE_CONFIG=$hanko_migrate_config
HANKO_RUNTIME_CONFIG=$hanko_runtime_config
ORTHANC_CONFIG=$orthanc_config
EOF
chmod 600 "$env_file"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

cat >"$compose_override" <<EOF
services:
  postgres:
    ports:
      - "127.0.0.1:$postgres_port:5432"
EOF
chmod 600 "$compose_override"

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
  from_name: Clarity V2 synthetic Hanko proof
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
    - "http://localhost:$hanko_port"
    - "$web_origin"
service:
  name: Clarity V2 synthetic Hanko proof
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
      - "http://localhost:$hanko_port"
      - "$web_origin"
EOF
  chmod 600 "$path"
}

write_hanko_config "$hanko_migrate_config" hanko_migrator "$HANKO_MIGRATOR_PASSWORD"
write_hanko_config "$hanko_runtime_config" hanko_runtime "$HANKO_RUNTIME_PASSWORD"
printf '{}\n' >"$orthanc_config"
chmod 600 "$orthanc_config"

compose() {
  docker compose --project-name "$project" --env-file "$env_file" \
    --file "$cloud_dir/compose.yaml" --file "$compose_override" "${@:1}"
}

web_pid=''

cleanup() {
  if [[ -n "$web_pid" ]]; then
    kill "$web_pid" >/dev/null 2>&1 || true
    wait "$web_pid" >/dev/null 2>&1 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$proof_dir"
}

finish() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    echo 'Hanko auth proof failed; relevant service logs follow.' >&2
    compose logs --no-color --tail 100 postgres hanko-migrate hanko mailpit >&2 || true
    if [[ -f "$proof_dir/web.log" ]]; then
      echo 'Web application logs follow.' >&2
      tail -n 100 "$proof_dir/web.log" >&2 || true
    fi
  fi
  cleanup
  exit "$status"
}
trap finish EXIT

wait_healthy() {
  local name="$1" state=''
  for _ in $(seq 1 90); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
    [[ "$state" == healthy ]] && return 0
    sleep 1
  done
  echo "Timed out waiting for $name health ($state)." >&2
  return 1
}

wait_completed() {
  local name="$1" state='' code=''
  for _ in $(seq 1 120); do
    state="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true)"
    if [[ "$state" == exited ]]; then
      code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
      [[ "$code" == 0 ]] && return 0
      echo "One-shot service $name exited with $code." >&2
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for $name completion ($state)." >&2
  return 1
}

cd "$repo_root"
compose up --detach postgres mailpit
wait_healthy "${project}-postgres-1"
compose build clarity-migrate
compose up --detach clarity-migrate hanko-migrate
wait_completed "${project}-clarity-migrate-1"
wait_completed "${project}-hanko-migrate-1"
compose exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U postgres -d postgres \
  --command "SELECT 'runtime_connect=' || has_database_privilege('clarity_v2_runtime', 'clarity_v2_app', 'CONNECT');"
compose exec --no-TTY --env "PGPASSWORD=$CLARITY_RUNTIME_PASSWORD" postgres \
  psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U clarity_v2_runtime -d clarity_v2_app \
  --command "SELECT 'runtime_session=' || current_user;"
compose up --detach hanko
wait_healthy "${project}-hanko-1"
NEXT_PUBLIC_HANKO_API_URL="http://localhost:$hanko_port" pnpm --filter @clarity/web build
web_snapshot="$proof_dir/web-standalone"
mkdir -p "$web_snapshot"
cp -R "$repo_root/apps/web/.next/standalone/." "$web_snapshot/"
snapshot_static="$web_snapshot/apps/web/.next/static"
if [[ -L "$snapshot_static" ]]; then
  unlink "$snapshot_static"
fi
mkdir -p "$snapshot_static"
cp -R "$repo_root/apps/web/.next/static/." "$snapshot_static/"
nonce_one="$(openssl rand -hex 8)"
nonce_two="$(openssl rand -hex 8)"
python3 "$cloud_dir/scripts/prove-hanko-flow.py" \
  "http://localhost:$hanko_port" "http://localhost:$mailpit_port" "$nonce_one" "$proof_dir/identity-one.json"
python3 "$cloud_dir/scripts/prove-hanko-flow.py" \
  "http://localhost:$hanko_port" "http://localhost:$mailpit_port" "$nonce_two" "$proof_dir/identity-two.json"

CLARITY_PUBLIC_ORIGIN="$web_origin" \
DATABASE_URL="postgresql://clarity_v2_runtime:$CLARITY_RUNTIME_PASSWORD@127.0.0.1:$postgres_port/clarity_v2_app" \
HANKO_API_ORIGIN="http://localhost:$hanko_port" \
HANKO_ISSUER='https://clarity-v2-synthetic.invalid' \
HANKO_AUDIENCE='clarity-v2-synthetic-client' \
NEXT_PUBLIC_HANKO_API_URL="http://localhost:$hanko_port" \
  HOSTNAME=127.0.0.1 PORT="$web_port" \
  bash -c 'cd "$1" && exec node server.js' \
  _ "$web_snapshot/apps/web" >"$proof_dir/web.log" 2>&1 &
web_pid=$!
web_ready=0
for _ in $(seq 1 60); do
  response_code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 "$web_origin/api/staff/access" 2>/dev/null || true)"
  if [[ "$response_code" == 401 || "$response_code" == 503 ]]; then
    web_ready=1
    break
  fi
  sleep 1
done
if [[ "$web_ready" != 1 ]]; then
  echo 'Web application did not start for the synthetic access proof.' >&2
  cat "$proof_dir/web.log" >&2
  exit 1
fi

python3 "$cloud_dir/scripts/prove-staff-web.py" enroll \
  "$web_origin" "http://localhost:$hanko_port" \
  "$proof_dir/identity-one.json" "$proof_dir/identity-two.json"

compose exec --no-TTY postgres psql -X --set ON_ERROR_STOP=1 -U postgres -d postgres \
  --command "CREATE ROLE clarity_v2_bootstrap_login LOGIN PASSWORD '$PG_BOOTSTRAP_PASSWORD' IN ROLE clarity_v2_bootstrap_operator;" >/dev/null
compose exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U postgres -d postgres \
  --command "SELECT 'bootstrap_connect=' || has_database_privilege('clarity_v2_bootstrap_login', 'clarity_v2_app', 'CONNECT');"
admin_subject="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["subject"])' "$proof_dir/identity-one.json")"
staff_subject="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["subject"])' "$proof_dir/identity-two.json")"
for subject in "$admin_subject" "$staff_subject"; do
  if [[ ! "$subject" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    echo 'Hanko proof returned a malformed identity subject.' >&2
    exit 1
  fi
done
admin_subject="${admin_subject,,}"
staff_subject="${staff_subject,,}"
admin_user_id="$(compose exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U postgres -d clarity_v2_app --command "SELECT staff_user_id FROM staff_identities WHERE provider = 'hanko' AND issuer = 'https://clarity-v2-synthetic.invalid' AND lower(subject) = '$admin_subject';")"
admin_identity_id="$(compose exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U postgres -d clarity_v2_app --command "SELECT id FROM staff_identities WHERE provider = 'hanko' AND issuer = 'https://clarity-v2-synthetic.invalid' AND lower(subject) = '$admin_subject';")"
if [[ -z "$admin_user_id" || -z "$admin_identity_id" ]]; then
  identity_summary="$(compose exec --no-TTY postgres psql -X --tuples-only --no-align --set ON_ERROR_STOP=1 -U postgres -d clarity_v2_app --command "SELECT (SELECT count(*) FROM staff_users) || ':' || (SELECT count(*) FROM staff_identities WHERE provider = 'hanko') || ':' || (SELECT count(*) FROM staff_memberships);")"
  echo "Hanko-validated admin account was not enrolled by the protected API (staff rows: $identity_summary)." >&2
  exit 1
fi
compose exec --no-TTY --env "PGPASSWORD=$PG_BOOTSTRAP_PASSWORD" postgres psql -X --set ON_ERROR_STOP=1 \
  -U clarity_v2_bootstrap_login -d clarity_v2_app \
  --command "SELECT bootstrap_first_staff_admin('$admin_user_id', '$admin_identity_id');" >/dev/null

python3 "$cloud_dir/scripts/prove-staff-web.py" verify \
  "$web_origin" "http://localhost:$hanko_port" \
  "$proof_dir/identity-one.json" "$proof_dir/identity-two.json"
echo 'Staff API proof forwarded two provider-issued cookies directly; browser storage requires the optional Chromium proof.'
if [[ "${HANKO_BROWSER_PROOF:-0}" == 1 ]]; then
  python3 "$cloud_dir/scripts/prove-hanko-browser.py" \
    "$web_origin" "http://localhost:$hanko_port" "http://localhost:$mailpit_port"
fi
browser_hold="${HANKO_BROWSER_HOLD_SECONDS:-0}"
if [[ ! "$browser_hold" =~ ^[0-9]+$ ]] || (( browser_hold > 600 )); then
  echo 'HANKO_BROWSER_HOLD_SECONDS must be an integer from 0 to 600.' >&2
  exit 1
fi
if (( browser_hold > 0 )); then
  echo "Browser proof endpoints: web=$web_origin hanko=http://localhost:$hanko_port mailpit=http://localhost:$mailpit_port"
  sleep "$browser_hold"
fi
compose down --volumes --remove-orphans >/dev/null
if docker volume ls --filter "label=com.docker.compose.project=$project" --quiet | grep -q .; then
  echo "Temporary Hanko proof volumes remain for $project." >&2
  exit 1
fi
trap - EXIT
rm -rf "$proof_dir"
echo 'Standalone Hanko v3 proof resources removed.'
