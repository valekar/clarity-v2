#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 PRIVATE_ENV_FILE COOLIFY_COMPOSE_PROJECT_NAME CLARITY_IDENTITY_ID" >&2
  exit 2
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cloud_dir="$repo_root/deploy/cloud"
env_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
project_name="$2"
identity_id="$3"
[[ -f "$env_file" ]] || { echo "Environment file not found." >&2; exit 2; }
mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")"
(( (8#$mode & 077) == 0 )) || { echo "Environment file must not grant group or other permissions." >&2; exit 2; }
[[ "$project_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]] || { echo "Coolify Compose project name is invalid." >&2; exit 2; }
[[ "$identity_id" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "Clarity identity ID must be a UUID." >&2; exit 2; }
compose=(docker compose --project-name "$project_name" --env-file "$env_file" --file "$cloud_dir/coolify-test/compose.yaml")
operator_role="clarity_first_admin_$(openssl rand -hex 8)"
cleanup() {
  "${compose[@]}" exec --no-TTY postgres psql -X -q -U postgres -d postgres \
    --set ON_ERROR_STOP=1 --command "DROP ROLE IF EXISTS $operator_role;" >/dev/null 2>&1 || true
}
trap cleanup EXIT

staff_user_id="$(printf '%s\n' "SELECT staff_user_id FROM public.staff_identities WHERE id='$identity_id' AND provider='hanko';" | \
  "${compose[@]}" exec --no-TTY postgres psql -X -q -A -t -U postgres -d clarity_v2_app --set ON_ERROR_STOP=1)"
[[ "$staff_user_id" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "No matching Hanko identity was found." >&2; exit 1; }

already_admin="$(printf '%s\n' "SELECT (c.bootstrap_completed AND c.bootstrapped_user_id='$staff_user_id' AND m.role='admin' AND m.status='active')::text FROM public.staff_access_control c JOIN public.staff_memberships m ON m.staff_user_id=c.bootstrapped_user_id WHERE c.singleton_id=1;" | \
  "${compose[@]}" exec --no-TTY postgres psql -X -q -A -t -U postgres -d clarity_v2_app --set ON_ERROR_STOP=1)"
if [[ "$already_admin" == true ]]; then
  echo "The requested Hanko identity is already the bootstrapped active administrator."
  exit 0
fi

"${compose[@]}" exec --no-TTY postgres psql -X -q -U postgres -d postgres --set ON_ERROR_STOP=1 \
  --command "CREATE ROLE $operator_role LOGIN IN ROLE clarity_v2_bootstrap_operator;" >/dev/null
result="$(printf '%s\n' "SELECT public.bootstrap_first_staff_admin('$staff_user_id', '$identity_id');" | \
  "${compose[@]}" exec --no-TTY postgres psql -X -q -A -t -U "$operator_role" -d clarity_v2_app --set ON_ERROR_STOP=1)"
[[ "$result" == t ]] || { echo "First administrator bootstrap did not complete." >&2; exit 1; }
echo "The selected Hanko identity now has active Clarity administrator membership."
