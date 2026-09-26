#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image='postgres:18.6-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af'
name="clarity-v2-doctors-proof-$$"
volume=''
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  docker rm -fv "$name" >/dev/null 2>&1 || true
  if docker inspect "$name" >/dev/null 2>&1 ||
     { [[ -n "$volume" ]] && docker volume inspect "$volume" >/dev/null 2>&1; }; then
    echo 'Disposable doctor proof container or anonymous volume remained.' >&2
    result=1
  fi
  return "$result"
}
trap cleanup EXIT INT TERM

docker run --detach --name "$name" --publish '127.0.0.1::5432' \
  --env POSTGRES_DB=clarity_v2_doctors_proof --env POSTGRES_PASSWORD=syntheticproofpassword \
  "$image" >/dev/null
volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$name")"
export PGHOST=127.0.0.1
export PGPORT="$(docker port "$name" 5432/tcp | awk -F: '{print $NF}')"
export PGDATABASE=clarity_v2_doctors_proof
export PGUSER=postgres PGPASSWORD=syntheticproofpassword
ready=0
for _ in $(seq 1 60); do
  if pg_isready --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ "$ready" -eq 1 ]] || { echo 'Disposable PostgreSQL did not become ready.' >&2; exit 1; }

psql -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE clarity_v2_migrator LOGIN PASSWORD 'syntheticmigratorpassword';
CREATE ROLE clarity_v2_runtime LOGIN PASSWORD 'syntheticruntimepassword';
CREATE ROLE clarity_v2_worker LOGIN PASSWORD 'syntheticruntimepassword';
CREATE ROLE clarity_v2_device_auth NOLOGIN;
CREATE ROLE clarity_v2_bootstrap_operator NOLOGIN;
GRANT CONNECT ON DATABASE clarity_v2_doctors_proof TO clarity_v2_migrator, clarity_v2_runtime, clarity_v2_worker, clarity_v2_device_auth;
GRANT CREATE, USAGE ON SCHEMA public TO clarity_v2_migrator;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL

cd "$repo_root"
PGUSER=clarity_v2_migrator PGPASSWORD=syntheticmigratorpassword pnpm --filter @clarity/database migrate >/dev/null
psql -X -v ON_ERROR_STOP=1 -f deploy/cloud/postgres/grant-clarity-runtime.sql >/dev/null
psql -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO public.staff_users (id, display_name)
VALUES ('10000000-0000-4000-8000-000000000001', 'Synthetic Doctor Staff');
INSERT INTO public.staff_memberships (staff_user_id, role, status)
VALUES ('10000000-0000-4000-8000-000000000001', 'staff', 'active');
SQL
if PGUSER=clarity_v2_runtime PGPASSWORD=syntheticruntimepassword \
  psql -X -v ON_ERROR_STOP=1 --command \
  "INSERT INTO public.doctors (id, display_name, normalized_name, phone_e164, created_by_staff_user_id) VALUES ('20000000-0000-4000-8000-000000000001', 'Synthetic Bypass', 'synthetic bypass', '+919876543219', '10000000-0000-4000-8000-000000000001');" \
  >/dev/null 2>&1; then
  echo 'Web runtime could directly bypass guarded doctor creation.' >&2
  exit 1
fi

pnpm --filter @clarity/domain build >/dev/null
pnpm --filter @clarity/database build >/dev/null
DOCTOR_PROOF_ROOT="$repo_root" \
DOCTOR_PROOF_URL="postgresql://clarity_v2_runtime:syntheticruntimepassword@127.0.0.1:$PGPORT/clarity_v2_doctors_proof" \
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const { createDoctorPool, createDoctorRepository } = await import(
  `${process.env.DOCTOR_PROOF_ROOT}/libs/database/dist/doctor-repository.js`);
const repo = createDoctorRepository(createDoctorPool(process.env.DOCTOR_PROOF_URL));
const actorStaffUserId = '10000000-0000-4000-8000-000000000001';
try {
  await assert.rejects(() => repo.create({
    displayName: 'Dr. US Example', phoneE164: '+14155550123',
    confirmedSharedPhone: false, actorStaffUserId,
  }), TypeError);
  const first = await repo.create({
    displayName: '  Dr. Ada   Rao ', phoneE164: '+919876543210',
    confirmedSharedPhone: false, actorStaffUserId,
  });
  assert.equal(first.outcome, 'created');
  assert.equal(first.doctor.displayName, 'Dr. Ada Rao');
  const exact = await repo.create({
    displayName: 'Dr. ADA Rao', phoneE164: '+919876543210',
    confirmedSharedPhone: false, actorStaffUserId,
  });
  assert.equal(exact.outcome, 'reused');
  assert.equal(exact.doctor.id, first.doctor.id);
  const shared = await repo.create({
    displayName: 'Dr. Ben Rao', phoneE164: '+919876543210',
    confirmedSharedPhone: false, actorStaffUserId,
  });
  assert.equal(shared.outcome, 'confirm_shared_phone');
  assert.equal(shared.matches.length, 1);
  const confirmed = await repo.create({
    displayName: 'Dr. Ben Rao', phoneE164: '+919876543210',
    confirmedSharedPhone: true, actorStaffUserId,
  });
  assert.equal(confirmed.outcome, 'created');
  assert.equal((await repo.search('ada')).length, 1);
  assert.equal((await repo.search('+919876543210')).length, 2);
  assert.equal((await repo.search('+91 98765 43210')).length, 2);
  assert.equal((await repo.search('')).length, 2);
  const race = await Promise.all([
    repo.create({ displayName: 'Dr. Cee', phoneE164: '+919876543211', confirmedSharedPhone: false, actorStaffUserId }),
    repo.create({ displayName: 'Dr. Dee', phoneE164: '+919876543211', confirmedSharedPhone: false, actorStaffUserId }),
  ]);
  assert.deepEqual(race.map((result) => result.outcome).sort(), ['confirm_shared_phone', 'created']);
  console.log('Doctor directory proof passed: exact retry, shared-phone confirmation, populated default list, search and concurrent first insert.');
} finally {
  await repo.close();
}
NODE

psql -X -v ON_ERROR_STOP=1 --command \
  "BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.staff_memberships SET status = 'disabled' WHERE staff_user_id = '10000000-0000-4000-8000-000000000001'; COMMIT;" >/dev/null
DOCTOR_PROOF_ROOT="$repo_root" \
DOCTOR_PROOF_URL="postgresql://clarity_v2_runtime:syntheticruntimepassword@127.0.0.1:$PGPORT/clarity_v2_doctors_proof" \
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
const { createDoctorPool, createDoctorRepository } = await import(
  `${process.env.DOCTOR_PROOF_ROOT}/libs/database/dist/doctor-repository.js`);
const repo = createDoctorRepository(createDoctorPool(process.env.DOCTOR_PROOF_URL));
try {
  await assert.rejects(
    repo.create({
      displayName: 'Dr. Eve', phoneE164: '+919876543212',
      confirmedSharedPhone: false,
      actorStaffUserId: '10000000-0000-4000-8000-000000000001',
    }),
    (error) => error.code === '42501',
  );
  console.log('Disabled staff doctor creation was rejected.');
} finally {
  await repo.close();
}
NODE
