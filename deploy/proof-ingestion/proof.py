"""Disposable P0.4 test harness; generates synthetic DICOM only. Runtime stays TypeScript."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import boto3
import pydicom
import requests
from botocore.config import Config
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, CTImageStorage, generate_uid

RUNTIME = Path("/proof/runtime")
FIXTURES = RUNTIME / "fixtures"
RESULT = RUNTIME / "result.json"
SOURCE = "http://source:8042"
CLOUD = "http://cloud:8042"
S3 = boto3.client(
    "s3",
    endpoint_url="http://minio:9000",
    aws_access_key_id="v2proofminio",
    aws_secret_access_key="v2proof-only-local-secret",
    region_name="us-east-1",
    config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 2}),
)


def wait_http(url: str) -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            if requests.get(f"{url}/system", timeout=2).ok:
                return
        except requests.RequestException:
            time.sleep(0.5)
    raise RuntimeError(f"Orthanc readiness timed out: {url}")


def write_instance(path: Path, study: str, series: str, sop: str, seed: int) -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = generate_uid()
    dataset = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = CTImageStorage
    dataset.SOPInstanceUID = sop
    dataset.StudyInstanceUID = study
    dataset.SeriesInstanceUID = series
    dataset.PatientID = "SYNTHETIC-P0-4"
    dataset.PatientName = "SYNTHETIC^P0PROOF"
    dataset.Modality = "CT"
    dataset.StudyDate = "20260101"
    dataset.Rows = 1024
    dataset.Columns = 1024
    dataset.SamplesPerPixel = 1
    dataset.PhotometricInterpretation = "MONOCHROME2"
    dataset.BitsAllocated = 16
    dataset.BitsStored = 16
    dataset.HighBit = 15
    dataset.PixelRepresentation = 0
    size = dataset.Rows * dataset.Columns * 2
    dataset.PixelData = bytes(((index * 31 + seed) & 0xFF) for index in range(size))
    dataset.save_as(path, enforce_file_format=True)


def new_uid() -> str:
    return f"2.25.{uuid.uuid4().int}"


def prepare_fixtures() -> dict[str, Any]:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    manifest_path = FIXTURES / "manifest.json"
    if manifest_path.exists():
        return json.loads(manifest_path.read_text())
    manifest = {
        "study_uid": new_uid(),
        "series_uid": new_uid(),
        "instances": [
            {"sop_uid": new_uid(), "file": "first.dcm", "seed": 17},
            {"sop_uid": new_uid(), "file": "late.dcm", "seed": 81},
        ],
    }
    for item in manifest["instances"]:
        write_instance(
            FIXTURES / item["file"],
            manifest["study_uid"],
            manifest["series_uid"],
            item["sop_uid"],
            item["seed"],
        )
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def load_dicom(path: Path) -> tuple[bytes, Any]:
    data = path.read_bytes()
    return data, pydicom.dcmread(io.BytesIO(data))


def orthanc_json(base: str, path: str) -> Any:
    response = requests.get(f"{base}{path}", timeout=20)
    response.raise_for_status()
    return response.json()


def find_instance(base: str, sop_uid: str) -> str | None:
    response = requests.post(
        f"{base}/tools/find",
        json={"Level": "Instance", "Query": {"SOPInstanceUID": sop_uid}},
        timeout=20,
    )
    response.raise_for_status()
    ids = response.json()
    return ids[0] if ids else None


def get_instance(base: str, sop_uid: str) -> tuple[str, bytes] | None:
    instance_id = find_instance(base, sop_uid)
    if instance_id is None:
        return None
    response = requests.get(f"{base}/instances/{instance_id}/file", timeout=60)
    response.raise_for_status()
    return instance_id, response.content


def post_dicom(base: str, data: bytes) -> tuple[int, Any]:
    response = requests.post(
        f"{base}/instances",
        data=data,
        headers={"Content-Type": "application/dicom", "Expect": ""},
        timeout=90,
    )
    body = response.json() if response.content else {}
    return response.status_code, body


def ensure_source_instance(item: dict[str, Any], manifest: dict[str, Any]) -> str:
    current = find_instance(SOURCE, item["sop_uid"])
    if current:
        return current
    data, _ = load_dicom(FIXTURES / item["file"])
    status, body = post_dicom(SOURCE, data)
    if status not in (200, 201) or body.get("Status") not in ("Success", "AlreadyStored"):
        raise RuntimeError(f"Source Orthanc rejected synthetic instance: {status} {body}")
    found = find_instance(SOURCE, item["sop_uid"])
    if not found:
        raise AssertionError(f"Source Orthanc indexed no instance for {item['sop_uid']}")
    tags = orthanc_json(SOURCE, f"/instances/{found}/simplified-tags")
    if tags.get("StudyInstanceUID") != manifest["study_uid"]:
        raise AssertionError("Source Orthanc returned the wrong StudyInstanceUID")
    return found


def instance_count(base: str, study_uid: str) -> int:
    response = requests.post(
        f"{base}/tools/find",
        json={"Level": "Study", "Query": {"StudyInstanceUID": study_uid}, "Expand": True},
        timeout=20,
    )
    response.raise_for_status()
    studies = response.json()
    if not studies:
        return 0
    study_id = studies[0]["ID"]
    return len(orthanc_json(base, f"/studies/{study_id}/instances"))


def last_change_seq() -> int:
    feed = orthanc_json(SOURCE, "/changes")
    return int(feed.get("Last", 0))


def transfer(sop_uid: str, expected_sha: str) -> dict[str, Any]:
    source_id = find_instance(SOURCE, sop_uid)
    if not source_id:
        raise AssertionError(f"Source instance missing: {sop_uid}")
    started = time.perf_counter()
    source_start = time.perf_counter()
    source_response = requests.get(f"{SOURCE}/instances/{source_id}/file", timeout=90)
    source_response.raise_for_status()
    source_data = source_response.content
    source_ms = round((time.perf_counter() - source_start) * 1000, 3)
    digest = hashlib.sha256(source_data).hexdigest()
    if digest != expected_sha:
        raise AssertionError(f"Source bytes changed for {sop_uid}")
    dataset = pydicom.dcmread(io.BytesIO(source_data))
    study_uid = str(dataset.StudyInstanceUID)
    intake_key = f"{study_uid}/{sop_uid}/{digest}.dcm"
    put_start = time.perf_counter()
    S3.put_object(Bucket="proof-intake", Key=intake_key, Body=source_data)
    put_ms = round((time.perf_counter() - put_start) * 1000, 3)
    get_start = time.perf_counter()
    object_data = S3.get_object(Bucket="proof-intake", Key=intake_key)["Body"].read()
    intake_get_ms = round((time.perf_counter() - get_start) * 1000, 3)
    if hashlib.sha256(object_data).hexdigest() != digest:
        raise AssertionError("Intake S3 object checksum differs from source Orthanc")
    object_dataset = pydicom.dcmread(io.BytesIO(object_data))
    if str(object_dataset.SOPInstanceUID) != sop_uid:
        raise AssertionError("Intake S3 object SOPInstanceUID mismatch")
    import_start = time.perf_counter()
    status, body = post_dicom(CLOUD, object_data)
    import_ms = round((time.perf_counter() - import_start) * 1000, 3)
    if status not in (200, 201) or body.get("Status") not in ("Success", "AlreadyStored"):
        raise RuntimeError(f"Cloud Orthanc rejected validated synthetic file: {status} {body}")
    readback_start = time.perf_counter()
    cloud_entry = get_instance(CLOUD, sop_uid)
    readback_ms = round((time.perf_counter() - readback_start) * 1000, 3)
    if cloud_entry is None:
        raise AssertionError("Cloud Orthanc indexed no imported instance")
    cloud_id, cloud_data = cloud_entry
    cloud_sha = hashlib.sha256(cloud_data).hexdigest()
    if cloud_sha != digest:
        raise AssertionError("Cloud Orthanc readback SHA-256 differs from source")
    cloud_dataset = pydicom.dcmread(io.BytesIO(cloud_data))
    if str(cloud_dataset.StudyInstanceUID) != study_uid:
        raise AssertionError("Cloud readback StudyInstanceUID mismatch")
    S3.delete_object(Bucket="proof-intake", Key=intake_key)
    return {
        "source_orthanc_id": source_id,
        "cloud_orthanc_id": cloud_id,
        "http_status": status,
        "orthanc_status": body.get("Status"),
        "sha256": digest,
        "file_bytes": len(source_data),
        "source_read_ms": source_ms,
        "intake_put_ms": put_ms,
        "intake_readback_ms": intake_get_ms,
        "cloud_import_ms": import_ms,
        "cloud_readback_ms": readback_ms,
        "path_elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        "estimated_path_payload_bytes": len(source_data) * 6,
    }


def create_conflict(base_path: Path, output_path: Path) -> tuple[bytes, Any]:
    dataset = pydicom.dcmread(base_path)
    changed = bytearray(dataset.PixelData)
    changed[0] ^= 0xFF
    dataset.PixelData = bytes(changed)
    dataset.save_as(output_path, enforce_file_format=True)
    return load_dicom(output_path)


def admit_uid_hash(registry: dict[str, str], sop_uid: str, digest: str) -> str:
    existing = registry.get(sop_uid)
    if existing is None:
        registry[sop_uid] = digest
        return "new"
    return "duplicate" if existing == digest else "conflict"


def poll_new_instance(before: int, sop_uid: str) -> dict[str, Any]:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        feed = orthanc_json(SOURCE, f"/changes?since={before}&limit=100")
        for change in feed.get("Changes", []):
            if change.get("ChangeType") == "NewInstance":
                tags = orthanc_json(SOURCE, f"/instances/{change['ID']}/simplified-tags")
                if tags.get("SOPInstanceUID") == sop_uid:
                    return change
        time.sleep(0.2)
    raise AssertionError(f"No NewInstance change observed for late SOP {sop_uid}")


def bucket_summary(bucket: str) -> dict[str, int]:
    pages = S3.get_paginator("list_objects_v2").paginate(Bucket=bucket)
    objects = [obj for page in pages for obj in page.get("Contents", [])]
    return {"object_count": len(objects), "object_bytes": sum(obj["Size"] for obj in objects)}


def baseline() -> None:
    wait_http(SOURCE)
    wait_http(CLOUD)
    manifest = prepare_fixtures()
    first = manifest["instances"][0]
    late = manifest["instances"][1]
    first_data, first_ds = load_dicom(FIXTURES / first["file"])
    first_hash = hashlib.sha256(first_data).hexdigest()
    source_first_id = ensure_source_instance(first, manifest)
    registry: dict[str, str] = {}
    if admit_uid_hash(registry, first["sop_uid"], first_hash) != "new":
        raise AssertionError("Proof UID registry did not admit the first byte set")
    duplicate_decision = admit_uid_hash(registry, first["sop_uid"], first_hash)
    if duplicate_decision != "duplicate":
        raise AssertionError("Proof UID registry did not classify identical bytes as duplicate")
    first_result = transfer(first["sop_uid"], first_hash)
    if instance_count(CLOUD, manifest["study_uid"]) != 1:
        raise AssertionError("Initial import did not create exactly one cloud instance")

    duplicate_result = transfer(first["sop_uid"], first_hash)
    if instance_count(CLOUD, manifest["study_uid"]) != 1:
        raise AssertionError("Identical retry created a duplicate cloud instance")

    conflict_data, conflict_ds = create_conflict(
        FIXTURES / first["file"], FIXTURES / "conflict.dcm"
    )
    conflict_hash = hashlib.sha256(conflict_data).hexdigest()
    if str(conflict_ds.SOPInstanceUID) != str(first_ds.SOPInstanceUID):
        raise AssertionError("Conflict fixture did not preserve SOPInstanceUID")
    if conflict_hash == first_hash:
        raise AssertionError("Conflict fixture did not change the bytes")
    conflict_decision = admit_uid_hash(
        {str(first_ds.SOPInstanceUID): first_hash},
        str(conflict_ds.SOPInstanceUID),
        conflict_hash,
    )
    if conflict_decision != "conflict":
        raise AssertionError("UID/hash conflict guard did not reject modified bytes")
    if instance_count(CLOUD, manifest["study_uid"]) != 1:
        raise AssertionError("Conflicting bytes changed the cloud index")

    feed_before = last_change_seq()
    source_late_id = ensure_source_instance(late, manifest)
    late_change = poll_new_instance(feed_before, late["sop_uid"])
    late_data, _ = load_dicom(FIXTURES / late["file"])
    late_result = transfer(late["sop_uid"], hashlib.sha256(late_data).hexdigest())
    if instance_count(CLOUD, manifest["study_uid"]) != 2:
        raise AssertionError("Late instance was not indexed exactly once")

    summary = {
        "study_uid": manifest["study_uid"],
        "instances": [
            {"sop_uid": first["sop_uid"], "fixture": first["file"], "transfer": first_result},
            {"sop_uid": late["sop_uid"], "fixture": late["file"], "transfer": late_result},
        ],
        "duplicate_retry": {
            "orthanc_status": duplicate_result["orthanc_status"],
            "uid_hash_registry_decision": duplicate_decision,
            "file_bytes": duplicate_result["file_bytes"],
            "cloud_instance_count_after_retry": 1,
        },
        "uid_conflict": {
            "same_sop_uid": True,
            "original_sha256": first_hash,
            "conflicting_sha256": conflict_hash,
            "decision": conflict_decision,
            "intake_writes": 0,
            "rejected_before_intake_or_import": True,
            "scope": "proof harness UID/hash guard; not production admission code",
        },
        "late_instance": {
            "orthanc_change_type": late_change["ChangeType"],
            "orthanc_change_seq": late_change["Seq"],
            "source_orthanc_id": source_late_id,
            "cloud_instance_count": 2,
        },
        "source_before_reset": {
            "first_orthanc_id": source_first_id,
            "late_orthanc_id": source_late_id,
            "last_change_seq": last_change_seq(),
        },
        "storage_after_cleanup": {
            "intake": bucket_summary("proof-intake"),
            "cloud_orthanc": bucket_summary("proof-cloud-orthanc"),
        },
    }
    (RUNTIME / "baseline.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"stage": "baseline", "result": summary}, indent=2))


def source_reset() -> None:
    wait_http(SOURCE)
    wait_http(CLOUD)
    manifest = prepare_fixtures()
    baseline_data = json.loads((RUNTIME / "baseline.json").read_text())
    cloud_before = instance_count(CLOUD, manifest["study_uid"])
    if cloud_before != 2:
        raise AssertionError("Cloud data did not survive source volume replacement")
    cloud_hashes = {}
    for item in manifest["instances"]:
        fixture_data, _ = load_dicom(FIXTURES / item["file"])
        cloud_entry = get_instance(CLOUD, item["sop_uid"])
        if cloud_entry is None:
            raise AssertionError("Cloud instance missing after source reset")
        cloud_hashes[item["sop_uid"]] = hashlib.sha256(cloud_entry[1]).hexdigest()
        if cloud_hashes[item["sop_uid"]] != hashlib.sha256(fixture_data).hexdigest():
            raise AssertionError("Cloud bytes changed while the source was reset")
    empty_count = len(orthanc_json(SOURCE, "/instances"))
    empty_source_last_change_seq = last_change_seq()
    if empty_count != 0:
        raise AssertionError("Replacement source volume was not empty")

    reingested = []
    for item in manifest["instances"]:
        new_id = ensure_source_instance(item, manifest)
        reingested.append({"sop_uid": item["sop_uid"], "new_source_orthanc_id": new_id})
    if instance_count(SOURCE, manifest["study_uid"]) != 2:
        raise AssertionError("Synthetic study did not reconcile into the replacement source")
    result = {
        "action": "stopped only the proof source and removed only its named Docker volume",
        "cloud_instances_retained": cloud_before,
        "cloud_sha256_by_sop_uid": cloud_hashes,
        "source_was_empty_after_replacement": empty_count == 0,
        "empty_source_last_change_seq": empty_source_last_change_seq,
        "same_study_uid_reingested": manifest["study_uid"],
        "reingested_instances": reingested,
        "previous_source": baseline_data["source_before_reset"],
        "source_after_reset_last_change_seq": last_change_seq(),
        "scope": "volume replacement and manual synthetic replay; no production reconciler tested",
    }
    (RUNTIME / "reset.json").write_text(json.dumps(result, indent=2) + "\n")
    combined = {
        "proof": "synthetic-local-p0.4",
        "harness": "disposable Python test harness; production runtime remains TypeScript",
        "measured_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "baseline": baseline_data,
        "source_reset": result,
        "images": {
            "orthanc": "orthancteam/orthanc@sha256:9758c8702a89abece99fcfe6d5571d5eaae59587e8e1ce36b9aafc8d4f24457b",
            "minio": "quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
        },
    }
    (RUNTIME / "result.json").write_text(json.dumps(combined, indent=2) + "\n")
    print(json.dumps({"stage": "source-reset", "result": result}, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("baseline", "source-reset", "benchmark"):
        raise SystemExit("Usage: proof.py baseline|source-reset|benchmark")
    if sys.argv[1] == "baseline":
        baseline()
    elif sys.argv[1] == "source-reset":
        source_reset()
    else:
        from benchmark import benchmark

        benchmark()
