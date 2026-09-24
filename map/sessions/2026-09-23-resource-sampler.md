---
id: resource-sampler-2026-09-23
type: session
title: Sample synthetic compiled-service resources
universe: live
status: verified
updated: 2026-09-23
revision: resource-sampler-2026-09-23
---

# Sample synthetic compiled-service resources

## Request and result

Implemented a bounded sampler for P5.4 using the existing disposable compiled
service proof. It follows the compiled child under its own proof shell, samples
host CPU/RSS, scoped Docker role counters and temporary SQLite/spool size, and
emits aggregate JSON without process identifiers, argv, generated UIDs or
clinical metadata. See [resource evidence](../../docs/evidence/30-resource-sampler.md).

The one synthetic run passed end to end and the proof trap removed its
containers, networks and volumes. It used one 840-byte generated DICOM object.
The process was seen in one 0.5-second sample, so its 83,968,000-byte RSS and
17.8% CPU are single observations. SQLite plus sidecars measured 118,784 bytes;
the sampler observed no spool file. Container counters yielded a short
11,401-byte RX and 12,100-byte TX delta that does not span the full service
transfer. The sampler reports `capacity_estimate: false` and the service/resource
cards remain ghost because one disposable observation does not establish pilot
capacity.

## Verification

- `python3 deploy/cloud/scripts/measure-compiled-sync-resources.py` — pass; the
  wrapped cloud proof passed and cleaned its disposable resources.
- `python3` AST parse of the sampler — pass; 282 authored lines, within the
  project source limit.
- Read-only resource query confirmed the unique proof project and source
  container were absent after the run.

## Map review and next step

ICM reviewed; no runtime map change. P5.4 remains open. A larger bounded
synthetic load and a sampling interval that captures the whole transfer are
needed before drawing storage, bandwidth or CPU limits; clinic/capacity inputs
remain outside this synthetic run.
