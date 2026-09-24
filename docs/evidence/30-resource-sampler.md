# Synthetic compiled-service resource sampler

Date: 2026-09-23. This bounded P5.4 measurement experiment wraps the existing
[compiled-service cloud proof](26-connected-ingestion.md) on macOS Docker Desktop.
Run it from the workspace root:

```sh
python3 deploy/cloud/scripts/measure-compiled-sync-resources.py
```

The wrapper runs the disposable `CLARITY_COMPILED_SYNC_PROOF=1` path, follows
only the compiled `apps/sync-service/dist/main.js` process descended from its
own proof shell, samples its RSS/CPU and the named Compose/source containers,
and watches the helper's temporary SQLite/spool directories. It emits aggregate
JSON only; the proof log is kept in a mode-restricted temporary file and removed.
The proof trap removes its Compose volumes, containers, networks and temporary
source files. An optional `CLARITY_RESOURCE_RESULT_FILE` writes the aggregate
result to a caller-selected path.

## One observed run

The run exited successfully on Darwin arm64. The full cloud proof took 138.198 s
including stack startup, schema/application proof, restore and cleanup. The
normal compiled service discovered a separate generated source, reached
`ready|sealed|completed`, verified the 840-byte DICOM by SHA-256 and UID, then
stopped with SIGTERM. The project/source containers were absent after cleanup.

| Observation | Value | Interpretation |
| --- | ---: | --- |
| Verified synthetic DICOM size | 840 bytes | Exact single-object source size from the existing proof result |
| SQLite state plus sidecars | 118,784 bytes | Largest size seen by the sampler during this run |
| Spool directory | 0 bytes seen | No spool file appeared in a sample; this does not prove no brief use between samples |
| Compiled service process RSS | 83,968,000 bytes | One sampled observation, not a process peak |
| Compiled service process CPU | 17.8% | One sampled observation; CPU percent is not total CPU time |
| Docker container CPU/memory | One reading per observed container role | Disposable-stack observations only, not capacity limits |
| Container RX / TX counter delta | 11,401 / 12,100 bytes | A short sampled interval, includes control traffic and counts inter-container packets at both ends |

The sampler saw the service in one 0.5-second polling sample. Its duration and
resource peaks therefore could not be resolved, and it reports
`capacity_estimate: false`. The RX/TX snapshot interval also did not span the
full transfer.
The host process's transfer bytes are not included in Docker interface counters.
The 840-byte synthetic object is far too small to support a bandwidth or
capacity conclusion. These numbers are observations from one local run, not
measured peaks, throughput, storage limits or a centre pilot.

## Acceptance status

This verifies that the measurement wrapper can observe the existing compiled
service path and produce a sanitized result. It does not satisfy P5.4's synthetic
staff-pilot breadth or measured storage/bandwidth/CPU limits, and it does not
establish centre capacity. P5.4 remains open pending a larger bounded synthetic
load with adequate sampling, restore evidence under that load, and the named
centre-specific acceptance inputs. The existing [769-instance ingestion
benchmark](03-ingestion-proof.md) remains the stronger synthetic transfer
measurement; its Orthanc-to-intake path does not exercise the compiled service.

## Verification

- `python3 deploy/cloud/scripts/measure-compiled-sync-resources.py` — pass;
  underlying compiled-service cloud proof exited 0 and cleaned its disposable
  project/source resources.
- Python AST parse of the sampler — pass; authored script is below the 700-line
  source limit.
- Container roles and process data are emitted without PIDs, argv, credentials,
  generated UIDs or DICOM metadata.
