# Synthetic viewer fixture breadth

Date: 2026-09-24. This evidence covers deterministic local DICOM fixture
generation and bounded parser/metadata checks for P4.3. It does not establish
Orthanc indexing, DICOMweb interoperability or browser rendering.

## Fixtures

`deploy/cloud/scripts/make-synthetic-dicom.py` keeps its existing default CT
behavior and accepts an optional `ct`, `mr`, `sr` or `pdf` profile after the UID
suffix and instance suffix. Every profile uses synthetic-only patient values,
deterministic UIDs, Explicit VR Little Endian file meta and a tiny payload.
CT/MR contain an 8×8 MONOCHROME2 pixel pattern. MR uses the MR Image Storage SOP
Class. SR contains a small Structured Report Content Sequence and synthetic text.
PDF uses Encapsulated PDF Storage with a short synthetic PDF payload. None uses
clinic data.

The parser test generates each profile in a temporary directory, checks Study,
Series and SOP identity via `readDicomIdentity`, and checks modality, SOP Class,
pixel-data presence or non-image payload tags. The existing parser rejection
case still checks that JPEG Baseline transfer syntax is rejected before import.
No compressed pixel fixture was generated: the available generator does not
encode compressed pixel data, and assigning a compressed UID to uncompressed
bytes would falsely describe the object.

## Verification and limits

- `python3 -m py_compile deploy/cloud/scripts/make-synthetic-dicom.py` passed.
- Manual generation of MR, SR and PDF profiles produced files recognized by
  `file` as DICOM medical imaging data; a manual profile call with instance
  suffix `2` preserved `.2` in the generated SOP UID.
- `pnpm --filter @clarity/imaging build` passed.
- `pnpm --filter @clarity/imaging test` passed 12/12 assertions across five
  top-level tests, including generated CT/MR/SR/PDF objects and unsupported
  transfer-syntax rejection.
- No Docker-connected run or browser pixels were obtained. The fixtures establish
  deterministic bytes, selected header metadata and identity parser behavior;
  they do not establish DICOM conformance beyond those checks, codec support,
  OHIF rendering, diagnostic suitability or clinical acceptance.

P4.3 remains open for connected MR/non-image viewing and browser codec acceptance.
