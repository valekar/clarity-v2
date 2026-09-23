#!/bin/sh
set -eu

usage() { /usr/bin/printf '%s\n' 'usage: activate-release.sh ROOT VERSION'; }
[ "$#" -eq 2 ] || { usage >&2; exit 64; }
root=$1
version=$2
case "$version" in
  ''|[!0-9]*|*[!A-Za-z0-9._-]*|*..*|*.) /usr/bin/printf '%s\n' 'invalid release version' >&2; exit 64 ;;
esac
case "$root" in
  /*) ;;
  *) /usr/bin/printf '%s\n' 'root must be an absolute path' >&2; exit 64 ;;
esac
if [ ! -d "$root" ]; then
  /usr/bin/printf '%s\n' 'root directory must already exist' >&2
  exit 66
fi
root=$(CDPATH= cd -- "$root" && pwd -P)
if [ "$root" = / ] && [ "${CLARITY_ALLOW_SYSTEM_MUTATION:-}" != 1 ]; then
  /usr/bin/printf '%s\n' 'system root requires CLARITY_ALLOW_SYSTEM_MUTATION=1' >&2
  exit 77
fi
base="$root/Library/Application Support/ClarityV2/SyncService"
release="$base/releases/$version"
[ -d "$release" ] || { /usr/bin/printf '%s\n' 'release directory is missing' >&2; exit 66; }
[ ! -L "$release" ] || { /usr/bin/printf '%s\n' 'release directory must not be a symlink' >&2; exit 65; }
next="$base/.current.$$.next"
trap '/bin/rm -f "$next"' EXIT HUP INT TERM
/bin/ln -s "releases/$version" "$next"
/bin/mv -fh "$next" "$base/current"
