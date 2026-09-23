#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -z "${CLARITY_DEVICE_AUTH_PASSWORD:-}" ]]; then
  exit 0
fi

psql -X --set ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres <<'SQL'
\getenv device_auth_password CLARITY_DEVICE_AUTH_PASSWORD
SELECT format(
  'CREATE ROLE clarity_v2_device_auth_login LOGIN PASSWORD %L IN ROLE clarity_v2_device_auth',
  :'device_auth_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'clarity_v2_device_auth_login'
)\gexec
GRANT CONNECT ON DATABASE clarity_v2_app TO clarity_v2_device_auth_login;
SQL
