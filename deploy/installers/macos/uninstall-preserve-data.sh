#!/bin/sh
set -eu

usage() { /usr/bin/printf '%s\n' 'usage: uninstall-preserve-data.sh ROOT'; }
[ "$#" -eq 1 ] || { usage >&2; exit 64; }
root=$1
case "$root" in
  /*) ;;
  *) /usr/bin/printf '%s\n' 'root must be an absolute path' >&2; exit 64 ;;
esac
if [ ! -d "$root" ]; then
  /usr/bin/printf '%s\n' 'root directory must already exist' >&2
  exit 66
fi
root=$(CDPATH= cd -- "$root" && pwd -P)
if [ "$root" = / ]; then
  if [ "${CLARITY_ALLOW_SYSTEM_MUTATION:-}" != 1 ]; then
    /usr/bin/printf '%s\n' 'system root requires CLARITY_ALLOW_SYSTEM_MUTATION=1' >&2
    exit 77
  fi
  if /bin/launchctl print system/org.clarity-v2.sync-service >/dev/null 2>&1; then
    /bin/launchctl bootout system/org.clarity-v2.sync-service
  fi
fi
base="$root/Library/Application Support/ClarityV2/SyncService"
/bin/rm -f "$root/Library/LaunchDaemons/org.clarity-v2.sync-service.plist"
/bin/rm -f "$base/current"
/bin/rm -rf "$base/releases"
/bin/rm -rf "$base/installer"
# The local SQLite queue, spool, credentials and logs are retained by default.
