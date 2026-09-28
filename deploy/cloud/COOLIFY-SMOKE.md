# Coolify test deployment smoke check

Run `node deploy/cloud/scripts/coolify-smoke.mjs` against an already running
synthetic test deployment. The check uses the public web origin and does not
need host access to the Coolify database or containers.

## Inputs

Prepare two test credentials through the approved synthetic setup:

- A Hanko session cookie for an active Clarity staff account.
- A paired Clarity device credential for a synthetic source in this deployment.

Set these variables in a private shell or secret manager, without putting their
values in shell history, tickets, logs or source control. For an interactive
Bash shell, use hidden prompts for the two secrets:

```sh
export CLARITY_SMOKE_WEB_URL='https://clarity-test.example.invalid'
read -r -s -p 'Synthetic Hanko cookie: ' CLARITY_SMOKE_STAFF_COOKIE; printf '\n'
read -r -s -p 'Synthetic device credential: ' CLARITY_SMOKE_DEVICE_CREDENTIAL; printf '\n'
export CLARITY_SMOKE_STAFF_COOKIE CLARITY_SMOKE_DEVICE_CREDENTIAL
export CLARITY_SMOKE_CONFIRM_SYNTHETIC=ONLY
node deploy/cloud/scripts/coolify-smoke.mjs
```

For a local HTTP test only, also set `CLARITY_SMOKE_ALLOW_HTTP=1`. HTTPS is
required by default so secure Hanko cookies and the deployed ingress are tested
through the expected scheme.

## What passes

The script requires all of the following to pass:

1. `/api/health` responds successfully.
2. An unauthenticated staff access request returns 401, and the supplied
   synthetic staff session authenticates.
3. The paired synthetic device acquires a lease.
4. A unique synthetic Study is admitted, a generated synthetic CT object is
   uploaded, and its exact one member manifest is sealed.
5. The asynchronous worker imports the object and authenticated Study search
   reports `ready`, `canView: true`, one manifest member and one indexed member
   within 120 seconds.
6. An unauthenticated DICOMweb WADO request is denied, while the authenticated
   WADO response contains the exact generated DICOM bytes and is non-cacheable.

The DICOM is generated locally by `make-synthetic-dicom.py`; the script does
not read a clinic file. Each run uses new UIDs and creates one persistent
synthetic Report in the test deployment. The script removes only its temporary
local DICOM file. Review or remove the synthetic Report through the test
deployment's approved data-retention process.

This check exercises the deployed web, Hanko-backed staff authentication,
object upload, worker, Orthanc import and staff visibility together. It does
not validate browser-rendered login screens, TLS certificate policy, backups,
recovery, production data, external message delivery or native centre-service
installation. Run it only against a dedicated test deployment with a synthetic
source and test staff account.
