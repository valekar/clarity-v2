# Cloud worker entry

Input: durable received uploads from the trusted ingestion database and private
intake bucket. The compiled worker validates one bounded staged DICOM Part 10
identity using `@clarity/imaging`, imports it into cloud Orthanc, checks indexed
UIDs and bytes, then commits file/upload/Report state through worker-only SQL.
Cleanup is separately durable and retried. Synthetic process/crash evidence is
in [worker foundation](../../docs/evidence/15-worker-foundation.md); connected
device-to-Ready evidence is recorded in [connected ingestion](../../docs/evidence/26-connected-ingestion.md).
Production storage/provider policy, wider transfer syntax and codec support,
clinical validation and centre capacity remain open.
