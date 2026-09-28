#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cloud_dir="$repo_root/deploy/cloud"
proof_dir="$(mktemp -d "${TMPDIR:-/tmp}/clarity-v2-hanko-password.XXXXXX")"
project="clarity-v2-hanko-password-$$"
env_file="$proof_dir/proof.env"

port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
secret() { openssl rand -hex 24; }
hanko_port="$(port)"
mailpit_port="$(port)"
postgres_port="$(port)"
hanko_migrate_config="$proof_dir/hanko-migrate.yaml"
hanko_runtime_config="$proof_dir/hanko-runtime.yaml"
orthanc_config="$proof_dir/orthanc.json"
proof_password_file="$proof_dir/password"
proof_username="proof_$(openssl rand -hex 8)"
hanko_image="ghcr.io/teamhanko/hanko:v3.0.4@sha256:a63ff255a85623723878bbc59f3797abc92ba32d0fcc580c6f1a28a66d51dc9c"
node_image="node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e"

cat >"$env_file" <<EOF
PG_BOOTSTRAP_PASSWORD=$(secret)
CLARITY_MIGRATOR_PASSWORD=$(secret)
CLARITY_RUNTIME_PASSWORD=$(secret)
CLARITY_WORKER_PASSWORD=$(secret)
HANKO_MIGRATOR_PASSWORD=$(secret)
HANKO_RUNTIME_PASSWORD=$(secret)
ORTHANC_RUNTIME_PASSWORD=$(secret)
ORTHANC_S3_PASSWORD=$(secret)
ORTHANC_HTTP_PASSWORD=$(secret)
MINIO_ROOT_USER=proofroot$(openssl rand -hex 4)
MINIO_ROOT_PASSWORD=$(secret)
HANKO_SECRET_ENCRYPTION_KEY=$(secret)$(secret)
HANKO_HTTP_PORT=$hanko_port
MAILPIT_HTTP_PORT=$mailpit_port
HANKO_MIGRATE_CONFIG=$hanko_migrate_config
HANKO_RUNTIME_CONFIG=$hanko_runtime_config
ORTHANC_CONFIG=$orthanc_config
EOF
chmod 600 "$env_file"
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

write_config() {
  local path="$1" user="$2" password="$3"
  cat >"$path" <<EOF
account:
  allow_deletion: false
  allow_signup: false
database:
  user: $user
  password: $password
  host: postgres
  port: "5432"
  database: hanko
  dialect: postgres
email:
  enabled: false
  optional: true
  acquire_on_registration: false
  acquire_on_login: false
  require_verification: false
  use_as_login_identifier: false
  use_for_authentication: false
email_delivery:
  enabled: false
mfa:
  enabled: false
passkey:
  enabled: false
password:
  enabled: true
  optional: false
  acquire_on_registration: always
  acquire_on_login: always
  recovery: false
  min_length: 8
secrets:
  keys:
    - $HANKO_SECRET_ENCRYPTION_KEY
server:
  admin:
    address: "127.0.0.1:8001"
  public:
    address: "0.0.0.0:8000"
    cors:
      allow_origins:
        - "http://localhost:$hanko_port"
service:
  name: Clarity V2 disposable username-password proof
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
    secure: false
username:
  enabled: true
  optional: false
  acquire_on_registration: true
  acquire_on_login: true
  use_as_login_identifier: true
  min_length: 3
  max_length: 32
webauthn:
  relying_party:
    id: localhost
    origins:
      - "http://localhost:$hanko_port"
EOF
  chmod 600 "$path"
}

write_config "$hanko_migrate_config" hanko_migrator "$HANKO_MIGRATOR_PASSWORD"
write_config "$hanko_runtime_config" hanko_runtime "$HANKO_RUNTIME_PASSWORD"
printf '{}\n' >"$orthanc_config"
chmod 600 "$orthanc_config"

compose() {
  docker compose --project-name "$project" --env-file "$env_file" \
    --file "$cloud_dir/compose.yaml" "${@:1}"
}

cleanup() {
  docker rm -f "${project}-hanko-admin" >/dev/null 2>&1 || true
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$proof_dir"
}
finish() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    echo 'Username/password proof failed; Hanko/PostgreSQL service logs:' >&2
    compose logs --no-color --tail 100 postgres hanko-migrate hanko mailpit >&2 || true
  fi
  cleanup
  exit "$status"
}
trap finish EXIT

wait_service() {
  local name="$1" wanted="$2" state=''
  for _ in $(seq 1 120); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
    [[ "$state" == "$wanted" ]] && return 0
    sleep 1
  done
  echo "Timed out waiting for $name ($state)." >&2
  return 1
}

cd "$repo_root"
compose up --detach postgres
wait_service "${project}-postgres-1" healthy
compose up --detach hanko-migrate
wait_service "${project}-hanko-migrate-1" exited
if [[ "$(docker inspect --format '{{.State.ExitCode}}' "${project}-hanko-migrate-1")" != 0 ]]; then
  echo 'Hanko database migration did not succeed.' >&2
  exit 1
fi
compose up --detach hanko
wait_service "${project}-hanko-1" healthy
printf 'Synthetic-Only-Password-93!\n' >"$proof_password_file"
chmod 600 "$proof_password_file"
docker run --detach --name "${project}-hanko-admin" --network "container:${project}-hanko-1" \
  --volume "$hanko_runtime_config:/config/hanko-runtime.yaml:ro" "$hanko_image" \
  serve admin --config /config/hanko-runtime.yaml >/dev/null
docker run --rm --network "container:${project}-hanko-1" \
  --volume "$cloud_dir/scripts/provision-hanko-username-password.mjs:/provision.mjs:ro" \
  --entrypoint node -i "$node_image" /provision.mjs "$proof_username" \
  <"$proof_password_file" >/dev/null
second_provision="$(printf '%s' 'Different-Synthetic-Password-94!' | docker run --rm --network "container:${project}-hanko-1" \
  --volume "$cloud_dir/scripts/provision-hanko-username-password.mjs:/provision.mjs:ro" \
  --entrypoint node -i "$node_image" /provision.mjs "$proof_username")"
python3 -c 'import json,sys; v=json.loads(sys.argv[1]); assert v["created"] is False and v["passwordSet"] is False' "$second_provision"
python3 "$cloud_dir/scripts/prove-hanko-username-password.py" \
  "http://localhost:$hanko_port" "$proof_username" "$proof_password_file"
docker rm -f "${project}-hanko-admin" >/dev/null 2>&1
compose down --volumes --remove-orphans >/dev/null
if docker volume ls --filter "label=com.docker.compose.project=$project" --quiet | grep -q .; then
  echo 'Temporary Hanko proof volumes remain.' >&2
  exit 1
fi
trap - EXIT
rm -rf "$proof_dir"
echo 'Standalone Hanko username/password proof resources removed.'
