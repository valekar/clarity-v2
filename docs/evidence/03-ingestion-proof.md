# Disposable synthetic Orthanc-to-cloud path proof

Date: 2026-09-23. Scope: a local P0.4 experiment using only generated DICOM.
The [proof harness](../../deploy/proof-ingestion/proof.py),
[streaming benchmark](../../deploy/proof-ingestion/benchmark.py),
[isolated Compose stack](../../deploy/proof-ingestion/compose.yaml) and
[machine-readable result](../../deploy/proof-ingestion/results.json) record the
tested path. This is not the V2 sync service or a production admission API.

## Observed result

- Source Orthanc returned a 2,097,884-byte generated CT instance. The harness
  copied it into a private MinIO intake bucket, read it back, imported it into
  cloud Orthanc using its S3 storage plugin, and read it back again. SHA-256 and
  DICOM UIDs matched across each observed boundary.
- The latest baseline run measured 89.488 ms for the first instance and
  70.252 ms for the late second instance. Its original estimate included six
  DICOM-sized copies/transfer edges, or 12,587,304 bytes for each 2,097,884-byte
  instance. The later streaming benchmark counted five **actual measured I/O
  edges**: source read, intake PUT, intake readback, Orthanc import and cloud
  readback. Both figures exclude protocol framing and physical disk copies.
- Retrying the identical instance returned `AlreadyStored` and kept one indexed
  instance. A changed byte with the same SOP UID was rejected by the harness's
  synthetic UID/hash guard before intake; no production registry was exercised.
- Orthanc emitted `NewInstance` for the late instance; cloud Orthanc then held
  two instances. After replacement of only the proof source volume, the cloud
  retained both verified objects. Manual replay restored the same source UIDs.
  The source change cursor reached the same sequence after replay, so cursor
  value alone cannot prove that a source database was not reset.
- The runs used only the named `clarity-v2-p0-4` containers, network and volumes,
  with no public port. Those disposable resources were absent after cleanup.

## Bounded synthetic benchmark and transport decision

The second run generated 769 files across three CT-like profiles, streamed
them in 1 MiB chunks, and verified every cloud Orthanc readback by size and
SHA-256. It completed in 38.009 seconds on one disposable local Docker stack.

| Profile | Instances | Actual DICOM bytes | Path median / p95 |
| --- | ---: | ---: | ---: |
| 128 KiB pixel target | 512 | 67,487,638 | 17.654 / 24.340 ms |
| 2 MiB pixel target | 256 | 537,060,310 | 59.368 / 77.178 ms |
| 32 MiB pixel target | 1 | 33,555,172 | 815.916 ms (single sample) |

The 638,103,120 actual file bytes caused 3,190,515,600 measured payload-edge
bytes, a 5.0× ratio for the verified path. Overall actual-file throughput was
16.011 MiB/s. The benchmark also recorded stage timings, finite 769-instance
and 30-minute budgets, and exact image digests in
[results.json](../../deploy/proof-ingestion/results.json).

**Selected transport for V2:** service → private intake object → validating
worker → cloud Orthanc index and final storage. This is the one path implemented
in the worker foundation. The measured extra intake and verification transfers
are accepted for the first staff pilot in exchange for private direct upload,
durable retry and cloud indexed viewing. Capacity tuning must use the centre's
actual study sizes and bandwidth when OI-04 is supplied.

## Limits after P0.4 acceptance

These are synthetic payload distributions on one local machine, not the
centre's daily/maximum load or a measured WAN. The source reset and late signal
were observed by the harness, not yet through the production reconciler. No
signed multipart admission, network outage, crashed worker, installed service,
production UID registry or clinic source was exercised in this path benchmark.
P3/P4/P5 retain those integration and capacity acceptance gates.

The pinned MinIO image is a disposable S3-compatible test endpoint only. The
[upstream repository](https://github.com/minio/minio) was archived in April 2026
and states that its community distribution is now source-only; it is not a
maintained production-image selection for V2. OI-03 still owns the real storage
endpoint and durability/restore proof.
