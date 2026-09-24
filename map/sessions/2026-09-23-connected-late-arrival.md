---
id: connected-late-arrival-2026-09-23
type: session
title: Prove connected late-file reopening and reseal
universe: live
status: verified
updated: 2026-09-23
revision: connected-late-arrival-2026-09-23
---

# Prove connected late-file reopening and reseal

## Request and result

Extended the [connected ingestion harness](../../deploy/cloud/scripts/prove-connected-ingestion.mjs)
to admit a second generated CT SOP after Ready, wait for the running worker to
index it while the Report remains non-Ready, then seal an exact two-member
revision 2. The [evidence](../../docs/evidence/32-connected-late-arrival.md)
records observed states and limits. The connected proof flag now includes its
application overlay prerequisite.

## Verification

- `node --check deploy/cloud/scripts/prove-connected-ingestion.mjs` and
  `python3 -m py_compile deploy/cloud/scripts/make-synthetic-dicom.py` passed.
- `CLARITY_CONNECTED_PROOF=1 bash deploy/cloud/scripts/proof.sh` passed with
  migrations 0001–0015, late `processing|dirty` after worker completion,
  revision-2 `ready|clean`, replacement persistence, fresh-volume restore and
  disposable cleanup.
- Two earlier attempts did not test the new flow: the first omitted the app
  overlay flag before the harness was corrected; the second read the shell
  script while it was being edited and stopped at a transient parse error.

## Map review and next step

The [Report relationship card](../objects/report-package.md) now cites the
connected synthetic late-arrival proof. P4.2 stays open for centre inventory
completeness and restart/failure breadth. ICM reviewed; no other runtime
relationship changed.
