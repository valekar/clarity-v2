#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 ENV_FILE ABSOLUTE_CONFIG_DIR" >&2
  exit 2
fi
env_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
config_dir="$2"
[[ "$config_dir" = /* ]] || { echo "Config directory must be absolute" >&2; exit 2; }
[[ -f "$env_file" ]] || { echo "Environment file not found: $env_file" >&2; exit 2; }
mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")"
(( (8#$mode & 077) == 0 )) || { echo "Environment file must not grant group or other permissions" >&2; exit 2; }
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

required=(
  CLARITY_DOMAIN HANKO_DOMAIN HANKO_COOKIE_DOMAIN CLARITY_PUBLIC_ORIGIN
  HANKO_PUBLIC_API_URL HANKO_ISSUER HANKO_AUDIENCE HANKO_RUNTIME_PASSWORD
  HANKO_MIGRATOR_PASSWORD HANKO_SECRET_ENCRYPTION_KEY ORTHANC_RUNTIME_PASSWORD
  ORTHANC_HTTP_USERNAME ORTHANC_HTTP_PASSWORD INTAKE_S3_ENDPOINT
  INTAKE_S3_PUBLIC_ENDPOINT INTAKE_S3_BUCKET INTAKE_S3_REGION
  INTAKE_S3_WEB_ACCESS_KEY INTAKE_S3_WEB_SECRET_KEY
  INTAKE_S3_WORKER_ACCESS_KEY INTAKE_S3_WORKER_SECRET_KEY
)
for name in "${required[@]}"; do
  value="${!name:-}"
  if [[ -z "$value" || "$value" == replace-* || "$value" == *example.com* || "$value" == *example.net* || "$value" == *example.invalid* ]]; then
    echo "$name must be set to a real test value in $env_file" >&2
    exit 2
  fi
done
[[ "$CLARITY_PUBLIC_ORIGIN" == "https://$CLARITY_DOMAIN" ]] || { echo "CLARITY_PUBLIC_ORIGIN must be https://$CLARITY_DOMAIN" >&2; exit 2; }
[[ "$HANKO_PUBLIC_API_URL" == "https://$HANKO_DOMAIN" && "$HANKO_ISSUER" == "$HANKO_PUBLIC_API_URL" ]] || { echo "HANKO_PUBLIC_API_URL and HANKO_ISSUER must equal https://$HANKO_DOMAIN" >&2; exit 2; }
[[ "$INTAKE_S3_ENDPOINT" == https://* && "$INTAKE_S3_PUBLIC_ENDPOINT" == https://* ]] || { echo "Both S3 endpoints must use HTTPS" >&2; exit 2; }
dns_name='^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?))+$'
[[ "$CLARITY_DOMAIN" =~ $dns_name && "$HANKO_DOMAIN" =~ $dns_name ]] || { echo "Public domains must be valid DNS names" >&2; exit 2; }
cookie_suffix="${HANKO_COOKIE_DOMAIN#.}"
[[ "$HANKO_COOKIE_DOMAIN" == ".${cookie_suffix}" && "$cookie_suffix" =~ $dns_name && "$CLARITY_DOMAIN" == *".${cookie_suffix}" && "$HANKO_DOMAIN" == *".${cookie_suffix}" ]] || { echo "Both public domains must be subdomains of HANKO_COOKIE_DOMAIN" >&2; exit 2; }
[[ "$ORTHANC_HTTP_USERNAME" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ORTHANC_HTTP_USERNAME may contain only letters, digits, underscore and hyphen" >&2; exit 2; }
for name in PG_BOOTSTRAP_PASSWORD CLARITY_MIGRATOR_PASSWORD CLARITY_RUNTIME_PASSWORD CLARITY_WORKER_PASSWORD CLARITY_DEVICE_AUTH_PASSWORD HANKO_RUNTIME_PASSWORD HANKO_MIGRATOR_PASSWORD ORTHANC_RUNTIME_PASSWORD ORTHANC_HTTP_PASSWORD; do
  value="${!name:-}"
  [[ "$value" =~ ^[a-fA-F0-9]{32,}$ ]] || { echo "$name must be at least 32 hexadecimal characters" >&2; exit 2; }
done
[[ "$HANKO_SECRET_ENCRYPTION_KEY" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "HANKO_SECRET_ENCRYPTION_KEY must be 64 hex characters" >&2; exit 2; }
mkdir -p "$config_dir"
chmod 700 "$config_dir"

write_hanko_config() {
  local path="$1" db_user="$2" db_password="$3"
  cat >"$path" <<EOF
account:
  allow_deletion: false
  allow_signup: false
database:
  user: $db_user
  password: $db_password
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
username:
  enabled: true
  optional: false
  acquire_on_registration: true
  acquire_on_login: true
  use_as_login_identifier: true
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
    - "$CLARITY_PUBLIC_ORIGIN"
    - "$HANKO_PUBLIC_API_URL"
service:
  name: Clarity V2 synthetic test
session:
  issuer: $HANKO_ISSUER
  audience:
    - $HANKO_AUDIENCE
  enable_auth_token_header: false
  cookie:
    name: hanko
    domain: $HANKO_COOKIE_DOMAIN
    http_only: true
    same_site: lax
    secure: true
webauthn:
  relying_party:
    id: $HANKO_DOMAIN
    origins:
      - "$CLARITY_PUBLIC_ORIGIN"
      - "$HANKO_PUBLIC_API_URL"
EOF
  chmod 600 "$path"
}

write_hanko_config "$config_dir/hanko-migrate.yaml" hanko_migrator "$HANKO_MIGRATOR_PASSWORD"
write_hanko_config "$config_dir/hanko-runtime.yaml" hanko_runtime "$HANKO_RUNTIME_PASSWORD"
cat >"$config_dir/orthanc.json" <<EOF
{
  "Name": "Clarity V2 synthetic Coolify test",
  "RemoteAccessAllowed": true,
  "AuthenticationEnabled": true,
  "RegisteredUsers": {"$ORTHANC_HTTP_USERNAME": "$ORTHANC_HTTP_PASSWORD"},
  "HttpPort": 8042,
  "DicomServerEnabled": false,
  "Plugins": [
    "/usr/share/orthanc/plugins-available/libOrthancPostgreSQLIndex.so",
    "/usr/share/orthanc/plugins-available/libOrthancDicomWeb.so",
    "/usr/share/orthanc/plugins-available/libOrthancOHIF.so"
  ],
  "StorageDirectory": "/var/lib/orthanc/db",
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
  "DicomWeb": {"Enable": true, "Root": "/dicom-web/"},
  "OHIF": {"DataSource": "dicom-web", "RouterBasename": "/ohif/"}
}
EOF
chmod 600 "$config_dir/orthanc.json"
echo "Generated private synthetic Hanko and Orthanc configs in $config_dir"
