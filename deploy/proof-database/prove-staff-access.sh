#!/usr/bin/env bash
set -euo pipefail

bootstrap_password='clarity-v2-bootstrap-proof-only'
runtime_password='clarity-v2-runtime-proof-only'
proof_suffix="$$"
log_one="/tmp/clarity-v2-staff-one-$proof_suffix.log"
log_two="/tmp/clarity-v2-staff-two-$proof_suffix.log"
trap 'rm -f "$log_one" "$log_two"' EXIT INT TERM

runtime_psql() {
  PGUSER=clarity_v2_runtime PGPASSWORD="$runtime_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --set=VERBOSITY=verbose "$@"
}

operator_psql() {
  PGUSER=clarity_v2_bootstrap_login PGPASSWORD="$bootstrap_password" psql --no-psqlrc --set ON_ERROR_STOP=1 --set=VERBOSITY=verbose "$@"
}

expect_sqlstate() {
  local sqlstate="$1"
  local log_path="$2"
  shift 2
  if "$@" >"$log_path" 2>&1; then
    echo "Expected SQLSTATE $sqlstate but statement succeeded." >&2
    exit 1
  fi
  if ! rg -q "ERROR:  $sqlstate:" "$log_path"; then
    cat "$log_path" >&2
    echo "Expected SQLSTATE $sqlstate from proof statement." >&2
    exit 1
  fi
}

runtime_psql --file deploy/proof-database/staff-access-proof.sql >/dev/null

enrollment_sql_one="BEGIN; SELECT pg_sleep(0.25); SELECT enroll_pending_hanko_identity('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'Concurrent Candidate Three', 'https://hanko.example.invalid', 'synthetic-subject-three'); SELECT pg_sleep(0.5); COMMIT;"
enrollment_sql_two="BEGIN; SELECT pg_sleep(0.25); SELECT enroll_pending_hanko_identity('00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'Concurrent Candidate Four', 'https://hanko.example.invalid', 'synthetic-subject-three'); SELECT pg_sleep(0.5); COMMIT;"
runtime_psql --command "$enrollment_sql_one" >"$log_one" 2>&1 &
enrollment_one_pid=$!
sleep 0.05
runtime_psql --command "$enrollment_sql_two" >"$log_two" 2>&1 &
enrollment_two_pid=$!
set +e
wait "$enrollment_one_pid"
enrollment_one_status=$?
wait "$enrollment_two_pid"
enrollment_two_status=$?
set -e
if [[ "$enrollment_one_status" -ne 0 || "$enrollment_two_status" -ne 0 ]]; then
  cat "$log_one" "$log_two" >&2
  echo 'Concurrent same-identity enrollment retry failed.' >&2
  exit 1
fi
canonical_enrollment_user="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT staff_user_id FROM staff_identities WHERE provider = 'hanko' AND issuer = 'https://hanko.example.invalid' AND subject = 'synthetic-subject-three';")"
if ! rg -q "$canonical_enrollment_user" "$log_one" || ! rg -q "$canonical_enrollment_user" "$log_two"; then
  echo 'Concurrent enrollment calls did not both return the canonical Hanko identity user.' >&2
  exit 1
fi
staff_counts="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT (SELECT count(*) FROM staff_users) || ':' || (SELECT count(*) FROM staff_identities) || ':' || (SELECT count(*) FROM staff_memberships) || ':' || (SELECT count(*) FROM staff_access_audit WHERE action = 'identity_enrolled');")"
if [[ "$staff_counts" != '3:3:0:3' ]]; then
  echo "Pending/retried enrollment created unexpected user, identity, membership, or audit counts: $staff_counts" >&2
  exit 1
fi

expect_sqlstate 42501 "$log_one" runtime_psql --command "INSERT INTO staff_memberships (staff_user_id, role) VALUES ('00000000-0000-4000-8000-000000000001', 'staff');"
expect_sqlstate 42501 "$log_one" runtime_psql --command "INSERT INTO staff_identities (id, staff_user_id, provider, issuer, subject) VALUES ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'hanko', 'https://hanko.example.invalid', 'direct-write-subject');"
expect_sqlstate 42501 "$log_one" runtime_psql --command "UPDATE staff_users SET active = false WHERE id = '00000000-0000-4000-8000-000000000001';"
expect_sqlstate 42501 "$log_one" runtime_psql --command "UPDATE staff_access_audit SET new_values = '{}'::jsonb WHERE id = 1;"
expect_sqlstate 42501 "$log_one" runtime_psql --command "SELECT bootstrap_first_staff_admin('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');"

bootstrap_sql_one="BEGIN; SELECT public.bootstrap_first_staff_admin('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'); SELECT pg_sleep(0.6); COMMIT;"
bootstrap_sql_two="BEGIN; SELECT public.bootstrap_first_staff_admin('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002'); SELECT pg_sleep(0.6); COMMIT;"
operator_psql --command "$bootstrap_sql_one" >"$log_one" 2>&1 &
bootstrap_one_pid=$!
sleep 0.05
operator_psql --command "$bootstrap_sql_two" >"$log_two" 2>&1 &
bootstrap_two_pid=$!
set +e
wait "$bootstrap_one_pid"
bootstrap_one_status=$?
wait "$bootstrap_two_pid"
bootstrap_two_status=$?
set -e
if [[ "$bootstrap_one_status" -eq "$bootstrap_two_status" ]]; then
  cat "$log_one" "$log_two" >&2
  echo 'Concurrent operator bootstrap did not produce exactly one successful transaction.' >&2
  exit 1
fi
if [[ "$bootstrap_one_status" -ne 0 ]]; then
  rg -q 'ERROR:  23514:' "$log_one" || { cat "$log_one" >&2; echo 'Concurrent bootstrap loser did not report the already-bootstrapped constraint.' >&2; exit 1; }
else
  rg -q 'ERROR:  23514:' "$log_two" || { cat "$log_two" >&2; echo 'Concurrent bootstrap loser did not report the already-bootstrapped constraint.' >&2; exit 1; }
fi
bootstrap_user="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT bootstrapped_user_id FROM staff_access_control WHERE singleton_id = 1 AND bootstrap_completed;")"
bootstrap_log_count="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM staff_access_audit WHERE action = 'first_admin_bootstrapped' AND target_user_id = '$bootstrap_user' AND actor_database_role = 'clarity_v2_bootstrap_login';")"
if [[ "$bootstrap_log_count" != '1' ]]; then
  echo 'First-admin bootstrap was not recorded with its operator database identity.' >&2
  exit 1
fi
if [[ "$bootstrap_user" == '00000000-0000-4000-8000-000000000001' ]]; then
  pending_user='00000000-0000-4000-8000-000000000002'
else
  pending_user='00000000-0000-4000-8000-000000000001'
fi
expect_sqlstate 23514 "$log_one" operator_psql --command "SELECT bootstrap_first_staff_admin('$pending_user', '10000000-0000-4000-8000-00000000000${pending_user: -1}');"
bootstrap_membership_count="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM staff_memberships;")"
if [[ "$bootstrap_membership_count" != '1' ]]; then
  echo 'A bootstrap loser received an unexpected membership.' >&2
  exit 1
fi

runtime_psql --command "SELECT change_staff_membership('$bootstrap_user', '$pending_user', 0, 'admin', 'active');" >/dev/null
audit_before_stale_cas="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM staff_access_audit;")"
stale_membership_cas="$(runtime_psql --tuples-only --no-align --command "SELECT change_staff_membership('$bootstrap_user', '$pending_user', 0, 'staff', 'active');")"
if [[ "$stale_membership_cas" != 'f' ]]; then
  echo 'Stale membership version did not fail compare-and-set.' >&2
  exit 1
fi
if [[ "$(psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM staff_access_audit;")" != "$audit_before_stale_cas" ]]; then
  echo 'Stale membership CAS unexpectedly appended an audit row.' >&2
  exit 1
fi

recheck_delay='0.25'
admin_sql_one="BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM staff_memberships; SELECT pg_sleep($recheck_delay); SELECT change_staff_user_active('$bootstrap_user', '$pending_user', 1, true, false); SELECT pg_sleep(0.5); COMMIT;"
admin_sql_two="BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM staff_memberships; SELECT pg_sleep($recheck_delay); SELECT change_staff_membership('$pending_user', '$bootstrap_user', 1, 'admin', 'disabled'); SELECT pg_sleep(0.5); COMMIT;"
runtime_psql --command "$admin_sql_one" >"$log_one" 2>&1 &
admin_one_pid=$!
sleep 0.05
runtime_psql --command "$admin_sql_two" >"$log_two" 2>&1 &
admin_two_pid=$!
set +e
wait "$admin_one_pid"
admin_one_status=$?
wait "$admin_two_pid"
admin_two_status=$?
set -e
if [[ "$admin_one_status" -eq "$admin_two_status" ]]; then
  cat "$log_one" "$log_two" >&2
  echo 'Repeatable-read opposing admin mutations did not serialize to exactly one successful transaction.' >&2
  exit 1
fi
if [[ "$admin_one_status" -ne 0 ]]; then
  rg -q 'ERROR:  40001:' "$log_one" || { cat "$log_one" >&2; echo 'REPEATABLE READ loser did not report serialization failure 40001.' >&2; exit 1; }
else
  rg -q 'ERROR:  40001:' "$log_two" || { cat "$log_two" >&2; echo 'REPEATABLE READ loser did not report serialization failure 40001.' >&2; exit 1; }
fi
effective_admin_count="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM staff_users u JOIN staff_memberships m ON m.staff_user_id = u.id WHERE u.active AND m.status = 'active' AND m.role = 'admin';")"
if [[ "$effective_admin_count" != '1' ]]; then
  echo "Concurrent access mutation left $effective_admin_count effective admins; expected exactly one." >&2
  exit 1
fi
disabled_admin="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT u.id FROM staff_users u JOIN staff_memberships m ON m.staff_user_id = u.id WHERE m.role = 'admin' AND (NOT u.active OR m.status <> 'active');")"
remaining_admin="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT u.id FROM staff_users u JOIN staff_memberships m ON m.staff_user_id = u.id WHERE u.active AND m.status = 'active' AND m.role = 'admin';")"
expect_sqlstate 42501 "$log_one" runtime_psql --command "SELECT change_staff_membership('$disabled_admin', '$remaining_admin', 1, 'staff', 'active');"

membership_version="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT version FROM staff_memberships WHERE staff_user_id = '$remaining_admin';")"
if [[ "$membership_version" != '1' ]]; then
  echo "Unexpected remaining administrator membership version: $membership_version" >&2
  exit 1
fi
audit_before="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM staff_access_audit;")"
expect_sqlstate 22023 "$log_one" runtime_psql --command "SELECT change_staff_membership('$remaining_admin', '$remaining_admin', NULL, 'admin', 'active');"
expect_sqlstate 22023 "$log_one" runtime_psql --command "SELECT change_staff_membership('$remaining_admin', '$canonical_enrollment_user', NULL, 'staff', 'active');"
expect_sqlstate 22023 "$log_one" runtime_psql --command "SELECT change_staff_user_active('$remaining_admin', '$remaining_admin', NULL, true, false);"
if [[ "$(psql --no-psqlrc --tuples-only --no-align --command "SELECT (SELECT version FROM staff_memberships WHERE staff_user_id = '$remaining_admin') || ':' || (SELECT count(*) FROM staff_memberships WHERE staff_user_id = '$canonical_enrollment_user') || ':' || (SELECT active::text FROM staff_users WHERE id = '$remaining_admin');")" != '1:0:true' ]]; then
  echo 'NULL optimistic versions mutated membership/user state or enrolled a membership.' >&2
  exit 1
fi
for mutation in "change_staff_membership('$remaining_admin', '$remaining_admin', 1, 'staff', 'active')" \
  "change_staff_membership('$remaining_admin', '$remaining_admin', 1, 'admin', 'disabled')" \
  "change_staff_user_active('$remaining_admin', '$remaining_admin', 1, true, false)"; do
  expect_sqlstate 23514 "$log_one" runtime_psql --command "SELECT $mutation;"
done
audit_after="$(psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM staff_access_audit;")"
if [[ "$audit_after" != "$audit_before" ]]; then
  echo 'Rejected last-admin mutations appended audit rows.' >&2
  exit 1
fi

if psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SET ROLE clarity_v2_migrator; UPDATE staff_access_audit SET new_values = '{}'::jsonb WHERE id = (SELECT min(id) FROM staff_access_audit);" >"$log_one" 2>&1; then
  echo 'Append-only audit trigger accepted UPDATE under migration role.' >&2
  exit 1
fi
if ! rg -q 'append-only' "$log_one"; then
  cat "$log_one" >&2
  echo 'Audit UPDATE failed for a reason other than the append-only guard.' >&2
  exit 1
fi
if psql --no-psqlrc --set ON_ERROR_STOP=1 --command "SET ROLE clarity_v2_migrator; TRUNCATE staff_access_audit;" >"$log_one" 2>&1; then
  echo 'Append-only audit trigger accepted TRUNCATE under migration role.' >&2
  exit 1
fi
if ! rg -q 'append-only' "$log_one"; then
  cat "$log_one" >&2
  echo 'Audit TRUNCATE failed for a reason other than the append-only guard.' >&2
  exit 1
fi

printf '%s\n' 'Pending enrollment, idempotent retries, operator-only concurrent bootstrap, append-only audit, active actor checks, optimistic versions, and REPEATABLE READ last-admin serialization passed.'
