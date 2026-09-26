#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
demo_dir="${CLARITY_SYNTHETIC_DEMO_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/clarity-v2/synthetic-demo}"
if [[ -L "$demo_dir" ]]; then
  echo "Synthetic demo state directory cannot be a symlink: $demo_dir" >&2
  exit 1
fi
mkdir -p "$demo_dir"
chmod 700 "$demo_dir"
demo_dir="$(cd "$demo_dir" && pwd -P)"

export CLARITY_INTERACTIVE_SYNTHETIC_DEMO=1
export CLARITY_SYNTHETIC_DEMO_DIR="$demo_dir"
export CLARITY_SYNC_CONFIG_PATH="$demo_dir/sync-service.json"
export CLARITY_SYNC_CONFIG_WRITER="$repo_root/apps/sync-service/dist/main.js"
export CLARITY_NODE_EXECUTABLE="$(command -v node)"

exec bash "$repo_root/deploy/cloud/scripts/proof.sh"
