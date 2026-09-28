#!/usr/bin/env bash

# Source this helper from proof.sh after its compose() function is defined.
provision_interactive_demo_admin() {
  local project="$1" state_dir="$2" issuer="$3" cloud_dir="$4"
  local username password password_file node_image hanko_result subject staff_user identity operator_role
  username="clarity_admin_$(openssl rand -hex 4)"
  password="$(openssl rand -hex 20)"
  password_file="$state_dir/admin-password.txt"
  (umask 077; printf '%s' "$password" >"$password_file")
  chmod 600 "$password_file"

  node_image="node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e"
  hanko_result="$(printf '%s' "$password" | docker run --rm --interactive --network "container:${project}-hanko-1" \
    --volume "$cloud_dir/scripts/provision-hanko-username-password.mjs:/provision.mjs:ro" \
    --entrypoint node "$node_image" /provision.mjs "$username")"
  subject="$(python3 -c 'import json,sys,uuid; print(uuid.UUID(json.load(sys.stdin)["id"]))' <<<"$hanko_result")"
  staff_user="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  identity="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  operator_role="clarity_demo_bootstrap_$(openssl rand -hex 8)"
  compose "$project" exec --no-TTY postgres psql -X -q -U postgres -d postgres --set ON_ERROR_STOP=1 \
    --command "CREATE ROLE $operator_role LOGIN IN ROLE clarity_v2_bootstrap_operator;" >/dev/null
  [[ "$staff_user" =~ ^[0-9a-f-]{36}$ && "$identity" =~ ^[0-9a-f-]{36}$ && "$subject" =~ ^[0-9a-f-]{36}$ ]] || {
    echo 'Hanko or Clarity provisioning returned an invalid UUID.' >&2
    return 1
  }
  [[ "$issuer" == 'https://clarity-v2-synthetic.invalid' ]] || {
    echo 'Unexpected Hanko issuer for the interactive synthetic demo.' >&2
    return 1
  }
  staff_user="$(printf '%s\n' \
    "SELECT public.enroll_pending_hanko_identity('$staff_user', '$identity', 'Synthetic administrator', '$issuer', '$subject');" | \
    compose "$project" exec --no-TTY postgres psql -X -q -A -t -U "$operator_role" -d clarity_v2_app --set ON_ERROR_STOP=1)"
  identity="$(printf '%s\n' \
    "SELECT id FROM public.staff_identities WHERE provider='hanko' AND issuer='$issuer' AND subject='$subject';" | \
    compose "$project" exec --no-TTY postgres psql -X -q -A -t -U postgres -d clarity_v2_app --set ON_ERROR_STOP=1)"
  compose "$project" exec --no-TTY postgres psql -X -q -U "$operator_role" -d clarity_v2_app --set ON_ERROR_STOP=1 \
    --command "SELECT public.bootstrap_first_staff_admin('$staff_user', '$identity');" >/dev/null
  compose "$project" exec --no-TTY postgres psql -X -q -U postgres -d postgres --set ON_ERROR_STOP=1 \
    --command "DROP ROLE IF EXISTS $operator_role;" >/dev/null
  python3 - "$state_dir/demo-admin.json" "$subject" "$username" <<'PY'
import json, os, sys
path, subject, username = sys.argv[1:]
with open(path, 'w', encoding='utf-8') as f:
    json.dump({'subject': subject, 'username': username}, f)
    f.write('\n')
os.chmod(path, 0o600)
PY
  echo 'Staff-only synthetic administrator provisioned and bootstrapped in Clarity.'
}
