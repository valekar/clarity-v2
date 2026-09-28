# Synthetic Coolify test preflight

**Date:** 2026-09-27. **Scope:** repository preparation for a dedicated
synthetic Coolify environment. No hosted deployment or patient data was used.

## Change

[Coolify test Compose](../../deploy/cloud/coolify-test/compose.yaml) is separate
from the disposable localhost proof. It declares persistent PostgreSQL,
Orthanc-file and worker-staging volumes; private PostgreSQL, Orthanc and worker
services; web and Hanko public proxy targets; and a dedicated external HTTPS S3
intake bucket with separate web and worker credentials. The
[configuration generator](../../deploy/cloud/coolify-test/prepare.sh) validates
the shared HTTPS auth/web domain, cookie scope, S3 endpoint scheme, private
environment-file mode and URL-safe synthetic passwords before writing Hanko and
Orthanc configs. Hanko uses no-email username/password; the hosted profile has
no account-recovery path. The [setup instructions](../../deploy/cloud/coolify-test/README.md)
keep V1 and clinical resources outside the test.

The [remote synthetic smoke script](../../deploy/cloud/scripts/coolify-smoke.mjs)
is prepared but has not run against Coolify. Its separate
[evidence note](45-coolify-test-smoke.md) describes the bounded test and limits.
The [Hanko protocol proof](46-hanko-username-password.md) passed three
disposable no-email runs. Focused Clarity adapter tests now accept absent email
while keeping issuer/subject membership authorization and malformed/unverified
email denial.

## Verification

- `docker compose --env-file deploy/cloud/coolify-test/.env.example -f deploy/cloud/coolify-test/compose.yaml config --quiet` passed with placeholder inputs. This parses the stack; it does not validate a real bucket or Coolify proxy.
- `bash -n deploy/cloud/coolify-test/prepare.sh` and `node --check deploy/cloud/scripts/coolify-smoke.mjs` passed.
- `pnpm run check` passed docs, source-policy, formatting, lint and typechecks in the final rerun with no lint warnings.
- `pnpm exec turbo run test` passed all 16 workspace tasks, including 33 server tests after the no-email adapter change.
- `CLARITY_APP_PROOF=1 bash deploy/cloud/scripts/proof.sh` passed a disposable local image build, migrations, runtime checks and backup/restore into fresh volumes before the hosted configuration was added. The script removed its own volumes afterward.

## Remaining acceptance

No Coolify host, HTTPS domains, test S3 bucket/keys, synthetic tester accounts or
paired device credential were supplied for an actual deployment. Hosted Hanko
Elements login, shared-domain cookie behavior, remote signed PUT, full smoke,
container restart and restore remain unproved. A later Docker daemon query on
the local development host stopped responding, so no further container run was
claimed. This evidence closes only the static configuration part of CT.1; CT.2
and CT.3 remain open.
