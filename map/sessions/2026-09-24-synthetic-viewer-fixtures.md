---
id: synthetic-viewer-fixtures-2026-09-24
type: session
title: Add synthetic modality and non-image viewer fixtures
universe: live
status: verified
updated: 2026-09-24
revision: synthetic-viewer-fixtures-2026-09-24
---

# Add synthetic modality and non-image viewer fixtures

## Request and result

The bounded P4.3 follow-up was to widen synthetic modality and non-image fixture
breadth and add local parser/metadata checks. The DICOM generator now supports CT,
MR, Structured Report and Encapsulated PDF profiles while preserving its default
CT CLI behavior. Generated objects use synthetic-only values and deterministic
UIDs. Focused parser/metadata test coverage and verification limits are recorded
in [evidence 37](../../docs/evidence/37-synthetic-viewer-fixtures.md).

No viewer application or P4.3 plan/checklist files were changed. A compressed
fixture was not emitted because this generator has no pixel codec; assigning a
compressed transfer syntax to uncompressed bytes would create a misleading
object. The existing parser test still exercises rejection of a JPEG Baseline
transfer syntax.

## Verification

Python syntax validation and imaging package build passed. Imaging tests passed
12/12 assertions, including generated DICOM identity and metadata checks for all
four profiles. These are local byte/parser checks only. No connected Docker or
browser run was available, and no MR/non-image pixels or codecs are accepted by
this evidence.

## Map review and next step

The canonical [Report package](../objects/report-package.md) already records
actual MR, non-image and codec interoperability as open; no relationship fact
changed. Root owns plan/ACTIVE and generated catalog closeout. Connected MR and
non-image DICOMweb/OHIF behavior and pixel-based acceptance remain open.
