# Coolify synthetic test stack

This stack is for isolated synthetic testing. It deploys Clarity web, Hanko,
PostgreSQL, a private Orthanc test source and the worker.
Only web and Hanko should receive public domains in Coolify. Set their domains to
the HTTPS origins in the environment, with Coolify-managed certificates. Do not
publish `postgres` or `orthanc`.

The stack uses a dedicated external S3-compatible test bucket because centre-side
sync uploads directly to the public endpoint in short-lived signed URLs. Configure
separate credentials scoped to this empty test bucket: one for web uploads and one
for worker reads/deletes. Do not use MinIO on the private Coolify network for this
path; a centre machine cannot reach it. A centre-side ingestion run also requires
the separately built synthetic desktop/service and is outside this cloud smoke.
Orthanc's synthetic test files use a private named Docker volume; this does not
prove production object-storage durability or Orthanc backup/restore.

## Prepare and deploy

The staff-only username/password profile has no mail delivery, public signup,
account deletion or password recovery. Hanko identifies users; only an active
Clarity membership grants staff access. A hosted browser proof is still needed
before this profile passes sign-in acceptance.

1. Create an isolated Coolify project and a persistent deployment checkout. Enable
   Coolify's option to preserve the repository between deployments; Compose uses
   tracked repository-relative migrations and role-init files. Set the Compose
   file path to `deploy/cloud/coolify-test/compose.yaml`.
2. Copy `.env.example` into Coolify's private environment settings. Choose two
   HTTPS hostnames under the same parent domain and set `HANKO_COOKIE_DOMAIN` to
   that parent with a leading dot. Point DNS to Coolify, use
   unique random values for every password/key, and provision a dedicated empty
   test bucket with the two scoped S3 credentials. `INTAKE_S3_PUBLIC_ENDPOINT`
   must be HTTPS and reachable from a separate test workstation. Never reuse V1
   or production credentials.
3. On the Coolify host, create the configured absolute `HANKO_CONFIG_DIR` with
   owner-readable permissions. Put the same non-secret environment values and
   generated test credentials in a mode-600 env file on that host. From this
   checked-out repository run:

   ```sh
   bash deploy/cloud/coolify-test/prepare.sh /secure/path/coolify-test.env /data/coolify/clarity-v2-synthetic-test/config
   ```

   The script writes concrete Hanko migration/runtime and Orthanc configs there,
   with mode 600. Set `HANKO_CONFIG_DIR` in Coolify to that exact host path.
4. Deploy. In Coolify, assign HTTPS domain `CLARITY_DOMAIN` to service `web` on
   port 3000 and `HANKO_DOMAIN` to `hanko` on port 8000. Confirm only these two
   services are proxy-exposed. `/api/health` is liveness only; it does not prove
   authentication, ingestion or recovery.
5. Provision each staff username on the Coolify host from the checked-out
   repository. Get the exact Compose project name from `docker compose ls` for
   this Coolify stack; pass that value explicitly so the script cannot target a
   different stack. For example:

   ```sh
   bash deploy/cloud/coolify-test/provision-staff.sh \
     /secure/path/coolify-test.env clarity-v2-coolify-test radiology-admin "Synthetic Admin"
   ```

   The script prompts for the password without echoing it. It uses Hanko's
   private Admin API through a short-lived helper sharing Hanko's network
   namespace; Hanko's admin listener is bound to `127.0.0.1:8001` and is not
   proxy-exposed. Hanko stores the password credential using its own password
   service. Repeating the command for the same username preserves the existing
   password and identity. The script prints the Hanko subject and Clarity IDs,
   creates an identity with no membership, and removes its temporary database
   login. Do not paste or log the password.
6. For the first administrator only, independently verify the Hanko subject
   from the private Hanko Admin API, then pass the Clarity identity ID printed
   in step 5 to this restricted bootstrap command:

   ```sh
   bash deploy/cloud/coolify-test/bootstrap-first-admin.sh \
     /secure/path/coolify-test.env clarity-v2-coolify-test ID_FROM_STEP_5
   ```

   It uses `bootstrap_first_staff_admin` through a temporary login granted
   membership in `clarity_v2_bootstrap_operator`; it makes no direct table
   updates and drops the login on exit. The function only permits the first
   administrator. Verify that the account can sign in and has active admin
   access. For every later staff account, sign in as an active administrator,
   review the pending identity in the protected Staff Settings page, and grant
   its `staff` or `admin` role there. Verify the role appears as active before
   staff use.
7. Verify username/password login, session validation and logout in a browser.
   Public signup is disabled by Hanko configuration and the sign-in page uses
   the login-only element. This profile has no email integration, mail-based
   passcodes, account recovery, passkeys, MFA or password recovery. Recovery
   remains an open acceptance item.

## Limits and cleanup

This is not production approval. It disables Hanko email, passkeys and MFA, uses
a test S3 bucket, and has no account recovery, production email or backup/restore
acceptance. The private Coolify PostgreSQL and Orthanc
services contain only synthetic records. To reset the test, remove this Coolify
stack's volumes and delete the dedicated test bucket contents. Never run the
disposable `deploy/cloud/scripts/proof.sh` against this stack: that script owns a
separate ephemeral Compose project and removes its own volumes.
