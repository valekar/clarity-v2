#!/bin/sh
set -eu

usage() { /usr/bin/printf '%s\n' 'usage: build-release.sh VERSION OUTPUT_DIR'; }
[ "$#" -eq 2 ] || { usage >&2; exit 64; }
version=$1
output=$2
caller_pwd=$(/bin/pwd -P)
case "$output" in /*) ;; *) output="$caller_pwd/$output" ;; esac
case "$version" in
  ''|[!0-9]*|*[!A-Za-z0-9._-]*|*..*|*.) /usr/bin/printf '%s\n' 'invalid release version' >&2; exit 64 ;;
esac
case "$(/usr/bin/uname -s)/$(/usr/bin/uname -m)" in
  Darwin/arm64) node_target=darwin-arm64 ;;
  Darwin/x86_64) node_target=darwin-x64 ;;
  *) /usr/bin/printf '%s\n' 'release builder requires a supported macOS host' >&2; exit 69 ;;
esac
[ ! -e "$output" ] || { /usr/bin/printf '%s\n' 'output directory already exists' >&2; exit 73; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
tmp_root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/clarity-macos-release.XXXXXX")
trap '/bin/rm -rf "$tmp_root"' EXIT HUP INT TERM
release="$tmp_root/release"
workspace="$tmp_root/workspace"
mkdir -p "$release/runtime/bin" "$workspace/apps/sync-service/dist" \
  "$workspace/libs/contracts/dist"

cd "$repo_root"
node --version | /usr/bin/grep -qx 'v22.20.0' || { /usr/bin/printf '%s\n' 'build requires Node v22.20.0' >&2; exit 65; }
pnpm exec turbo run build --filter=@clarity/sync-service...
cp "$repo_root/apps/sync-service/package.json" "$workspace/apps/sync-service/package.json"
cp -R "$repo_root/apps/sync-service/dist/." "$workspace/apps/sync-service/dist/"
cp "$repo_root/libs/contracts/package.json" "$workspace/libs/contracts/package.json"
cp -R "$repo_root/libs/contracts/dist/." "$workspace/libs/contracts/dist/"
cp "$repo_root/pnpm-lock.yaml" "$repo_root/pnpm-workspace.yaml" "$workspace/"
printf '%s\n' '{"name":"clarity-release-workspace","private":true,"packageManager":"pnpm@12.3.4"}' > "$workspace/package.json"
cd "$workspace"
pnpm --filter @clarity/sync-service deploy --prod --legacy --offline "$release/app"

archive="$tmp_root/node.tar.gz"
checksums="$tmp_root/SHASUMS256.txt"
base="https://nodejs.org/dist/v22.20.0"
/usr/bin/curl --fail --location --silent --show-error "$base/node-v22.20.0-$node_target.tar.gz" --output "$archive"
/usr/bin/curl --fail --location --silent --show-error "$base/SHASUMS256.txt" --output "$checksums"
expected=$(/usr/bin/awk -v file="node-v22.20.0-$node_target.tar.gz" '$2 == file {print $1}' "$checksums")
[ "${#expected}" -eq 64 ] || { /usr/bin/printf '%s\n' 'Node archive checksum is missing from official manifest' >&2; exit 65; }
printf '%s  %s\n' "$expected" "$archive" | /usr/bin/shasum -a 256 -c - >/dev/null
/usr/bin/tar -xzf "$archive" -C "$tmp_root"
/bin/cp "$tmp_root/node-v22.20.0-$node_target/bin/node" "$release/runtime/bin/node"
/bin/chmod 0755 "$release/runtime/bin/node"
/usr/bin/printf '%s\n' "$version" > "$release/RELEASE_VERSION"
/usr/bin/printf '%s\n' "node=v22.20.0" "node_target=$node_target" "node_archive_sha256=$expected" > "$release/BUILD_INFO"

entry="$release/app/dist/main.js"
[ -f "$entry" ] || { /usr/bin/printf '%s\n' 'compiled service entry is missing from deploy output' >&2; exit 66; }
[ -d "$release/app/node_modules/@clarity/contracts/dist" ] || { /usr/bin/printf '%s\n' 'compiled workspace dependencies are missing from deploy output' >&2; exit 66; }
set +e
"$release/runtime/bin/node" "$entry" --config "$tmp_root/missing-config.json" >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 78 ] || { /usr/bin/printf 'compiled service smoke launch returned %s; expected 78\n' "$status" >&2; exit 70; }
mkdir -p "$(dirname -- "$output")"
/bin/mv "$release" "$output"
/usr/bin/printf '%s\n' "Built $node_target release $version at $output"
