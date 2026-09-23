#!/usr/bin/env bash
set -euo pipefail

source_id='21000000-0000-4000-8000-000000000001'
device_id='31000000-0000-4000-8000-000000000001'
admission_key='72000000-0000-4000-8000-000000000101'
first_upload='62000000-0000-4000-8000-000000000101'
second_upload='62000000-0000-4000-8000-000000000102'
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/clarity-v2-ingestion-race.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

first_sql="BEGIN; SET ROLE clarity_v2_device_auth; SELECT pg_advisory_xact_lock(hashtextextended('${source_id}:${admission_key}', 0)); SELECT pg_sleep(1); SELECT upload_id FROM public.admit_ingestion_upload('${source_id}', '${device_id}', 2, 3, '${admission_key}', '${first_upload}', 'race-instance', '1.2.840.10008.1.99', '1.2.840.10008.1.99.2', '1.2.840.10008.1.99.2.1', 512, repeat('f',64), 'intake/${source_id}/${first_upload}.dcm', clock_timestamp()+interval '4 minutes'); COMMIT;"
second_sql="BEGIN; SET ROLE clarity_v2_device_auth; SELECT upload_id FROM public.admit_ingestion_upload('${source_id}', '${device_id}', 2, 3, '${admission_key}', '${second_upload}', 'race-instance', '1.2.840.10008.1.99', '1.2.840.10008.1.99.2', '1.2.840.10008.1.99.2.1', 512, repeat('f',64), 'intake/${source_id}/${second_upload}.dcm', clock_timestamp()+interval '4 minutes'); COMMIT;"

psql --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "$first_sql" >"$temp_dir/first.out" 2>"$temp_dir/first.err" &
first_pid=$!
sleep 0.1
psql --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "$second_sql" >"$temp_dir/second.out" 2>"$temp_dir/second.err" &
second_pid=$!
wait "$first_pid"
wait "$second_pid"

first_result="$(grep -E '^[0-9a-f-]{36}$' "$temp_dir/first.out" | tail -n 1)"
second_result="$(grep -E '^[0-9a-f-]{36}$' "$temp_dir/second.out" | tail -n 1)"
if [[ "$first_result" != "$first_upload" || "$second_result" != "$first_upload" ]]; then
  cat "$temp_dir/first.out" "$temp_dir/second.out" >&2
  echo "Concurrent same-key admissions diverged: first=$first_result second=$second_result" >&2
  exit 1
fi
row_count="$(psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "SELECT count(*) FROM public.ingestion_uploads WHERE source_id='${source_id}' AND admission_key='${admission_key}';")"
if [[ "$row_count" != 1 ]]; then
  echo "Expected one durable same-key upload, found $row_count." >&2
  exit 1
fi
echo 'Two-session same-key admission race returned one durable upload ID.'
