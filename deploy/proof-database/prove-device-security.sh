#!/usr/bin/env bash
set -Eeuo pipefail

image='postgres:18.6-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af'
container_name="clarity-v2-device-proof-$$"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
postgres_password='clarity-v2-device-proof-only'
migrator_password='clarity-v2-migrator-proof-only'
runtime_password='clarity-v2-runtime-proof-only'
device_password='clarity-v2-device-auth-proof-only'
bootstrap_password='clarity-v2-bootstrap-proof-only'
volume_name=''

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [[ "$result" -ne 0 ]]; then
    docker logs "$container_name" >&2 2>/dev/null || true
  fi
  docker rm -fv "$container_name" >/dev/null 2>&1 || true
  if docker inspect "$container_name" >/dev/null 2>&1 ||
     { [[ -n "$volume_name" ]] && docker volume inspect "$volume_name" >/dev/null 2>&1; }; then
    echo 'Disposable PostgreSQL container or anonymous volume remained after cleanup.' >&2
    result=1
  fi
  return "$result"
}
trap cleanup EXIT INT TERM

docker run --detach --name "$container_name" \
  --publish '127.0.0.1::5432' \
  --env POSTGRES_DB=clarity_v2_device_proof \
  --env POSTGRES_PASSWORD="$postgres_password" \
  "$image" >/dev/null
volume_name="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$container_name")"
port="$(docker port "$container_name" 5432/tcp | awk -F: '{print $NF}')"
export PGHOST=127.0.0.1 PGPORT="$port" PGUSER=postgres PGPASSWORD="$postgres_password"
export PGDATABASE=clarity_v2_device_proof
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

psql --no-psqlrc --set ON_ERROR_STOP=1 --command "
  CREATE ROLE clarity_v2_migrator LOGIN PASSWORD '$migrator_password';
  CREATE ROLE clarity_v2_runtime LOGIN PASSWORD '$runtime_password';
  CREATE ROLE clarity_v2_worker LOGIN PASSWORD '$runtime_password';
  CREATE ROLE clarity_v2_device_auth NOLOGIN;
  CREATE ROLE clarity_v2_device_auth_login LOGIN PASSWORD '$device_password' IN ROLE clarity_v2_device_auth;
  CREATE ROLE clarity_v2_bootstrap_operator NOLOGIN;
  CREATE ROLE clarity_v2_bootstrap_login LOGIN PASSWORD '$bootstrap_password' IN ROLE clarity_v2_bootstrap_operator;
  GRANT CONNECT ON DATABASE clarity_v2_device_proof TO clarity_v2_migrator, clarity_v2_runtime, clarity_v2_worker, clarity_v2_device_auth, clarity_v2_bootstrap_operator;
  GRANT CREATE, USAGE ON SCHEMA public TO clarity_v2_migrator;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
"
export PGUSER=clarity_v2_migrator PGPASSWORD="$migrator_password"
pnpm --filter @clarity/database migrate
export PGUSER=postgres PGPASSWORD="$postgres_password"
psql --no-psqlrc --set ON_ERROR_STOP=1 --file "$repo_root/deploy/cloud/postgres/grant-clarity-runtime.sql" >/dev/null

staff_id='a495f83e-2e3f-41cd-82ec-88c5f30635d1'
identity_id='a495f83e-2e3f-41cd-82ec-88c5f30635d2'
source_id='b495f83e-2e3f-41cd-82ec-88c5f30635d1'
pairing_id='c495f83e-2e3f-41cd-82ec-88c5f30635d1'
device_id='d495f83e-2e3f-41cd-82ec-88c5f30635d1'
expired_pairing_id='e495f83e-2e3f-41cd-82ec-88c5f30635d1'
expired_device_id='f495f83e-2e3f-41cd-82ec-88c5f30635d1'
pairing_secret='cp2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
expired_secret='cp2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
device_secret='ccccccccccccccccccccccccccccccccccccccccccc'
device_verifier="$(node --input-type=module -e "import {createHash} from 'node:crypto'; process.stdout.write(createHash('sha256').update('$device_secret','ascii').digest('hex'))")"
pairing_verifier="$(node --input-type=module -e "import {createHash} from 'node:crypto'; process.stdout.write(createHash('sha256').update('$pairing_secret','ascii').digest('hex'))")"
expired_verifier="$(node --input-type=module -e "import {createHash} from 'node:crypto'; process.stdout.write(createHash('sha256').update('$expired_secret','ascii').digest('hex'))")"

psql --no-psqlrc --set ON_ERROR_STOP=1 --command "
  INSERT INTO public.staff_users (id, display_name) VALUES ('$staff_id', 'Synthetic Device Admin');
  INSERT INTO public.staff_identities (id, staff_user_id, provider, issuer, subject)
    VALUES ('$identity_id', '$staff_id', 'hanko', 'https://hanko.example.invalid', 'device-proof-admin');
"
PGUSER=clarity_v2_bootstrap_login PGPASSWORD="$bootstrap_password" \
  psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "SELECT public.bootstrap_first_staff_admin('$staff_id', '$identity_id');" >/dev/null
export PGUSER=postgres PGPASSWORD="$postgres_password"

psql --no-psqlrc --set ON_ERROR_STOP=1 --command "
  INSERT INTO public.orthanc_sources (id, display_name) VALUES ('$source_id', 'Synthetic pairing source');
"
PGUSER=clarity_v2_runtime PGPASSWORD="$runtime_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "SELECT public.create_source_pairing('$staff_id', '$source_id', '$pairing_id', decode('$pairing_verifier', 'hex'), clock_timestamp() + interval '10 minutes');" >/dev/null
pairing_secret_safe="$(PGUSER=postgres PGPASSWORD="$postgres_password" psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT p.token_verifier = decode('$pairing_verifier', 'hex') AND NOT (a.details::text LIKE '%' || '$pairing_secret' || '%' OR a.details::text LIKE '%' || '$pairing_verifier' || '%') FROM public.source_pairing_tokens p JOIN public.device_security_audit a ON a.pairing_id=p.id WHERE p.id='$pairing_id' AND a.action='pairing_created';")"
if [[ "$pairing_secret_safe" != 't' ]]; then
  echo 'Pairing storage/audit contains anything beyond the one-way verifier and nonsecret expiry.' >&2
  exit 1
fi

if PGUSER=clarity_v2_device_auth_login PGPASSWORD="$device_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "SELECT public.create_source_pairing('$staff_id', '$source_id', '$expired_pairing_id', decode('$expired_verifier', 'hex'), clock_timestamp() + interval '10 minutes');" >/dev/null 2>&1; then
  echo 'Device-auth database role could create a staff pairing.' >&2
  exit 1
fi
if PGUSER=clarity_v2_runtime PGPASSWORD="$runtime_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "SELECT * FROM public.consume_source_pairing(decode('$pairing_verifier', 'hex'), '$device_id', 'Synthetic service', decode('$device_verifier', 'hex'));" >/dev/null 2>&1; then
  echo 'Staff runtime database role could consume a device pairing.' >&2
  exit 1
fi

PGUSER=clarity_v2_device_auth_login PGPASSWORD="$device_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "SELECT * FROM public.consume_source_pairing(decode('$pairing_verifier', 'hex'), '$device_id', 'Synthetic service', decode('$device_verifier', 'hex'));" >/dev/null
device_state="$(PGUSER=clarity_v2_device_auth_login PGPASSWORD="$device_password" psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT d.status || ':' || (s.lease_device_id IS NULL)::text || ':' || s.current_fencing_token::text FROM public.device_installations d JOIN public.orthanc_sources s ON s.id=d.source_id WHERE d.id='$device_id';")"
if [[ "$device_state" != 'paired:true:0' ]]; then
  echo "Newly paired device unexpectedly has a lease: $device_state" >&2
  exit 1
fi
if PGUSER=clarity_v2_device_auth_login PGPASSWORD="$device_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "SELECT * FROM public.consume_source_pairing(decode('$pairing_verifier', 'hex'), '$expired_device_id', 'Synthetic second service', decode('$device_verifier', 'hex'));" >/dev/null 2>&1; then
  echo 'A consumed pairing code was accepted a second time.' >&2
  exit 1
fi

lease_dto="$(PGUSER=clarity_v2_device_auth_login PGPASSWORD="$device_password" psql --no-psqlrc --tuples-only --no-align --field-separator ':' --command \
  "SELECT source_generation, fencing_token, lease_expires_at FROM public.acquire_device_source_lease('$source_id', '$device_id', clock_timestamp() + interval '4 minutes');")"
IFS=':' read -r source_generation fencing_token lease_expires_at <<<"$lease_dto"
if [[ "$source_generation" != '1' || "$fencing_token" != '1' || -z "$lease_expires_at" ]]; then
  echo 'Device lease response did not contain the authoritative source generation/fence.' >&2
  exit 1
fi

PGUSER=clarity_v2_runtime PGPASSWORD="$runtime_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "SELECT public.create_source_pairing('$staff_id', '$source_id', '$expired_pairing_id', decode('$expired_verifier', 'hex'), clock_timestamp() + interval '10 minutes');" >/dev/null
PGUSER=clarity_v2_migrator PGPASSWORD="$migrator_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "UPDATE public.source_pairing_tokens SET created_at = clock_timestamp() - interval '2 minutes', expires_at = clock_timestamp() - interval '1 minute' WHERE id = '$expired_pairing_id';" >/dev/null
if PGUSER=clarity_v2_device_auth_login PGPASSWORD="$device_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "SELECT * FROM public.consume_source_pairing(decode('$expired_verifier', 'hex'), '$expired_device_id', 'Synthetic expired service', decode('$device_verifier', 'hex'));" >/dev/null 2>&1; then
  echo 'An expired pairing code was accepted.' >&2
  exit 1
fi

PGUSER=clarity_v2_runtime PGPASSWORD="$runtime_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --command \
  "SELECT public.revoke_source_device('$staff_id', '$device_id', 1);" >/dev/null
revoked_state="$(PGUSER=clarity_v2_device_auth_login PGPASSWORD="$device_password" psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT d.status || ':' || s.current_fencing_token::text || ':' || (s.lease_device_id IS NULL)::text FROM public.device_installations d JOIN public.orthanc_sources s ON s.id=d.source_id WHERE d.id='$device_id';")"
if [[ "$revoked_state" != 'revoked:2:true' ]]; then
  echo "Device revocation did not clear and advance its lease fence: $revoked_state" >&2
  exit 1
fi

runtime_verifier_read="$(PGUSER=postgres PGPASSWORD="$postgres_password" psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT has_column_privilege('clarity_v2_runtime', 'public.device_installations', 'credential_verifier', 'SELECT');")"
device_report_read="$(PGUSER=postgres PGPASSWORD="$postgres_password" psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT has_table_privilege('clarity_v2_device_auth', 'public.reports', 'SELECT');")"
device_staff_read="$(PGUSER=postgres PGPASSWORD="$postgres_password" psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT has_table_privilege('clarity_v2_device_auth', 'public.staff_identities', 'SELECT');")"
device_pairing_table_read="$(PGUSER=postgres PGPASSWORD="$postgres_password" psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT has_table_privilege('clarity_v2_device_auth', 'public.source_pairing_tokens', 'SELECT');")"
device_admin_function="$(PGUSER=postgres PGPASSWORD="$postgres_password" psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT has_function_privilege('clarity_v2_device_auth', 'public.create_source_pairing(uuid,uuid,uuid,bytea,timestamp with time zone)', 'EXECUTE');")"
runtime_schema_usage="$(PGUSER=postgres PGPASSWORD="$postgres_password" psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT has_schema_privilege('clarity_v2_device_auth_login', 'public', 'USAGE');")"
if [[ "$runtime_verifier_read" != 'f' || "$device_report_read" != 'f' ||
      "$device_staff_read" != 'f' || "$device_pairing_table_read" != 'f' ||
      "$device_admin_function" != 'f' || "$runtime_schema_usage" != 't' ]]; then
  echo 'Database role privilege boundary or app-schema usage proof failed.' >&2
  exit 1
fi

echo 'P3.1 synthetic PostgreSQL pairing, expiry, source lease DTO, revocation fence and role boundary proof passed.'
