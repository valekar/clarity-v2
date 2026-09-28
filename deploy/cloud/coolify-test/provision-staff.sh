#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 PRIVATE_ENV_FILE COOLIFY_COMPOSE_PROJECT_NAME USERNAME DISPLAY_NAME" >&2
  exit 2
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cloud_dir="$repo_root/deploy/cloud"
env_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
project_name="$2"
username="$3"
display_name="$4"
[[ -f "$env_file" ]] || { echo "Environment file not found." >&2; exit 2; }
mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")"
(( (8#$mode & 077) == 0 )) || { echo "Environment file must not grant group or other permissions." >&2; exit 2; }
[[ "$username" =~ ^[A-Za-z0-9_]{3,32}$ ]] || { echo "Username must be 3–32 letters, digits or underscore." >&2; exit 2; }
[[ "$project_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]] || { echo "Coolify Compose project name is invalid." >&2; exit 2; }
[[ -n "$display_name" && ${#display_name} -le 320 ]] || { echo "Display name is required and must be at most 320 characters." >&2; exit 2; }

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
[[ -n "${HANKO_ISSUER:-}" && -n "${HANKO_CONFIG_DIR:-}" ]] || { echo "HANKO_ISSUER and HANKO_CONFIG_DIR must be set." >&2; exit 2; }

compose=(docker compose --project-name "$project_name" --env-file "$env_file" --file "$cloud_dir/coolify-test/compose.yaml")
hanko_container="$("${compose[@]}" ps --status running --quiet hanko)"
[[ -n "$hanko_container" ]] || { echo "The Coolify Hanko service must be running." >&2; exit 1; }
helper="$cloud_dir/scripts/provision-hanko-username-password.mjs"
node_image="node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e"

read -r -s -p "Set password for $username: " staff_password
printf '\n' >&2
[[ ${#staff_password} -ge 12 && ${#staff_password} -le 256 ]] || { unset staff_password; echo "Password must contain 12–256 characters." >&2; exit 2; }
hanko_result="$(printf '%s' "$staff_password" | docker run --rm --network "container:$hanko_container" --volume "$helper:/provision.mjs:ro" --entrypoint node "$node_image" /provision.mjs "$username")"
unset staff_password

hanko_subject="$(python3 -c 'import json,sys,uuid; v=json.load(sys.stdin); print(uuid.UUID(v["id"]))' <<<"$hanko_result")"
staff_user_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
identity_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
operator_role="clarity_staff_operator_$(openssl rand -hex 8)"

cleanup() {
  "${compose[@]}" exec --no-TTY postgres psql -X -q -U postgres -d postgres \
    --set ON_ERROR_STOP=1 --command "DROP ROLE IF EXISTS $operator_role;" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" exec --no-TTY postgres psql -X -q -U postgres -d postgres \
  --set ON_ERROR_STOP=1 \
  --command "CREATE ROLE $operator_role LOGIN IN ROLE clarity_v2_bootstrap_operator;" >/dev/null

provision_sql="SELECT public.enroll_pending_hanko_identity('$staff_user_id', '$identity_id', :'display_name', :'issuer', '$hanko_subject');"
staff_user_id="$(printf '%s\n' "$provision_sql" | "${compose[@]}" exec --no-TTY postgres psql -X -q -A -t -U "$operator_role" -d clarity_v2_app \
  --set ON_ERROR_STOP=1 --set "display_name=$display_name" --set "issuer=$HANKO_ISSUER")"
identity_id="$(printf '%s\n' "SELECT id FROM public.staff_identities WHERE provider='hanko' AND issuer=:'issuer' AND subject='$hanko_subject';" | \
  "${compose[@]}" exec --no-TTY postgres psql -X -q -A -t -U postgres -d clarity_v2_app \
    --set ON_ERROR_STOP=1 --set "issuer=$HANKO_ISSUER")"
[[ "$staff_user_id" =~ ^[0-9a-f-]{36}$ && "$identity_id" =~ ^[0-9a-f-]{36}$ ]] || { echo "Clarity identity provisioning returned invalid IDs." >&2; exit 1; }

printf 'Hanko username: %s\nHanko subject: %s\nClarity staff user: %s\nClarity identity: %s\n' \
  "$username" "$hanko_subject" "$staff_user_id" "$identity_id"
echo "Identity is pending and has no Clarity role. An active administrator must grant its role in Settings."
