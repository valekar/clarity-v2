#!/bin/sh
set -eu

usage() { /usr/bin/printf '%s\n' 'usage: build-pkg.sh VERSION RELEASE_DIR OUTPUT.pkg'; }
[ "$#" -eq 3 ] || { usage >&2; exit 64; }
version=$1
release_dir=$2
output=$3
case "$version" in
  ''|[!0-9]*|*[!A-Za-z0-9._-]*|*..*|*.) /usr/bin/printf '%s\n' 'invalid release version' >&2; exit 64 ;;
esac
[ -d "$release_dir" ] || { /usr/bin/printf '%s\n' 'release directory is missing' >&2; exit 66; }
[ -x "$release_dir/runtime/bin/node" ] || { /usr/bin/printf '%s\n' 'bundled Node executable is missing' >&2; exit 66; }
[ -f "$release_dir/app/main.js" ] || { /usr/bin/printf '%s\n' 'compiled service entry is missing' >&2; exit 66; }
node_version=$("$release_dir/runtime/bin/node" --version)
[ "$node_version" = v22.20.0 ] || { /usr/bin/printf '%s\n' 'release must bundle Node v22.20.0' >&2; exit 65; }
if [ -n "${CLARITY_MACOS_INSTALLER_IDENTITY:-}" ] || [ "${CLARITY_REQUIRE_CODESIGN:-0}" = 1 ]; then
  /usr/bin/codesign --verify --strict "$release_dir/runtime/bin/node"
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temp_root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/clarity-macos-pkg.XXXXXX")
trap '/bin/rm -rf "$temp_root"' EXIT HUP INT TERM
payload="$temp_root/payload"
mkdir -p "$payload/Library/Application Support/ClarityV2/SyncService/releases/$version" \
  "$payload/Library/Application Support/ClarityV2/SyncService/installer"
/usr/bin/ditto "$release_dir" "$payload/Library/Application Support/ClarityV2/SyncService/releases/$version"
/usr/bin/install -m 0644 "$script_dir/templates/org.clarity-v2.sync-service.plist.in" \
  "$payload/Library/Application Support/ClarityV2/SyncService/installer/org.clarity-v2.sync-service.plist.template"
/usr/bin/install -m 0755 "$script_dir/activate-release.sh" \
  "$payload/Library/Application Support/ClarityV2/SyncService/installer/activate-release.sh"
/usr/bin/install -m 0755 "$script_dir/uninstall-preserve-data.sh" \
  "$payload/Library/Application Support/ClarityV2/SyncService/installer/uninstall-preserve-data.sh"
printf '%s\n' "$version" > "$payload/Library/Application Support/ClarityV2/SyncService/releases/$version/RELEASE_VERSION"

set -- /usr/bin/pkgbuild \
  --root "$payload" \
  --scripts "$script_dir/scripts" \
  --identifier org.clarity-v2.sync-service \
  --version "$version" \
  --install-location / \
  --ownership recommended
if [ -n "${CLARITY_MACOS_INSTALLER_IDENTITY:-}" ]; then
  set -- "$@" --sign "$CLARITY_MACOS_INSTALLER_IDENTITY"
fi
"$@" "$output"
