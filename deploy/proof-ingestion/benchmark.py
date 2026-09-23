"""Finite disposable payload benchmark; uses only synthetic DICOM and local proof services."""

from __future__ import annotations

import hashlib
import json
import math
import statistics
import time
import uuid
from pathlib import Path
from tempfile import TemporaryFile
from typing import Any, BinaryIO

import pydicom
import requests
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

import proof

PROFILES = (
    ("many-small", 512, 128 * 1024),
    ("medium", 256, 2 * 1024 * 1024),
    ("large", 1, 32 * 1024 * 1024),
)
MAX_INSTANCES = 769
MAX_PIXEL_BYTES = sum(count * size for _, count, size in PROFILES)
MAX_RUN_SECONDS = 1800
CHUNK_BYTES = 1024 * 1024


def deterministic_uid(seed: str) -> str:
    value = int.from_bytes(hashlib.sha256(seed.encode()).digest()[:16], "big")
    return f"2.25.{value}"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def write_fixture(path: Path, study_uid: str, series_uid: str, sop_uid: str, pixel_bytes: int, seed: int) -> None:
    if pixel_bytes % 256:
        raise ValueError("benchmark pixel size must be divisible by 256")
    edge = math.isqrt(pixel_bytes // 2)
    if edge * edge * 2 != pixel_bytes or edge > 65535:
        raise ValueError("benchmark pixel size must form a supported square 16-bit image")
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = generate_uid()
    dataset = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = CTImageStorage
    dataset.SOPInstanceUID = sop_uid
    dataset.StudyInstanceUID = study_uid
    dataset.SeriesInstanceUID = series_uid
    dataset.PatientID = "SYNTHETIC-P0-4-BENCH"
    dataset.PatientName = "SYNTHETIC^BENCHMARK"
    dataset.Modality = "CT"
    dataset.StudyDate = "20260101"
    dataset.Rows = edge
    dataset.Columns = edge
    dataset.SamplesPerPixel = 1
    dataset.PhotometricInterpretation = "MONOCHROME2"
    dataset.BitsAllocated = 16
    dataset.BitsStored = 16
    dataset.HighBit = 15
    dataset.PixelRepresentation = 0
    pattern = bytes((index + seed) & 0xFF for index in range(256))
    dataset.PixelData = pattern * (pixel_bytes // len(pattern))
    dataset.save_as(path, enforce_file_format=True)


def stream_to_file(response: requests.Response, destination: BinaryIO, deadline: float) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    for chunk in response.iter_content(CHUNK_BYTES):
        if time.monotonic() > deadline:
            raise TimeoutError("synthetic benchmark exceeded its overall time budget")
        if not chunk:
            continue
        destination.write(chunk)
        digest.update(chunk)
        total += len(chunk)
    return digest.hexdigest(), total


def stream_digest(response: requests.Response, deadline: float) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    for chunk in response.iter_content(CHUNK_BYTES):
        if time.monotonic() > deadline:
            raise TimeoutError("synthetic benchmark exceeded its overall time budget")
        if chunk:
            digest.update(chunk)
            total += len(chunk)
    return digest.hexdigest(), total


def ensure_source_file(path: Path, sop_uid: str, deadline: float) -> None:
    if proof.find_instance(proof.SOURCE, sop_uid):
        return
    size = path.stat().st_size
    with path.open("rb") as body:
        response = requests.post(
            f"{proof.SOURCE}/instances",
            data=body,
            headers={"Content-Type": "application/dicom", "Content-Length": str(size), "Expect": ""},
            timeout=(10, 90),
        )
    if time.monotonic() > deadline:
        raise TimeoutError("synthetic benchmark exceeded its overall time budget")
    response.raise_for_status()
    result = response.json()
    if result.get("Status") not in ("Success", "AlreadyStored"):
        raise RuntimeError(f"Source Orthanc rejected synthetic benchmark DICOM: {result}")


def transfer_streamed(sop_uid: str, study_uid: str, expected_sha: str, deadline: float) -> dict[str, Any]:
    source_id = proof.find_instance(proof.SOURCE, sop_uid)
    if not source_id:
        raise AssertionError(f"Source Orthanc missing synthetic SOP {sop_uid}")
    result: dict[str, Any] = {"file_bytes": 0, "edge_bytes": {}}
    started = time.monotonic()
    with TemporaryFile() as source_file, TemporaryFile() as intake_file:
        stage = time.monotonic()
        with requests.get(
            f"{proof.SOURCE}/instances/{source_id}/file", stream=True, timeout=(10, 90)
        ) as response:
            response.raise_for_status()
            source_sha, source_bytes = stream_to_file(response, source_file, deadline)
        source_file.flush()
        result["source_read_ms"] = round((time.monotonic() - stage) * 1000, 3)
        if source_sha != expected_sha:
            raise AssertionError("Source stream SHA-256 differs from generated fixture")
        result["file_bytes"] = source_bytes
        result["edge_bytes"]["source_read"] = source_bytes

        intake_key = f"{study_uid}/{sop_uid}/{source_sha}.dcm"
        source_file.seek(0)
        stage = time.monotonic()
        proof.S3.put_object(
            Bucket="proof-intake", Key=intake_key, Body=source_file, ContentLength=source_bytes
        )
        result["intake_put_ms"] = round((time.monotonic() - stage) * 1000, 3)
        result["edge_bytes"]["intake_put"] = source_bytes

        stage = time.monotonic()
        object_response = proof.S3.get_object(Bucket="proof-intake", Key=intake_key)
        object_body = object_response["Body"]
        digest = hashlib.sha256()
        intake_bytes = 0
        while True:
            if time.monotonic() > deadline:
                object_body.close()
                raise TimeoutError("synthetic benchmark exceeded its overall time budget")
            chunk = object_body.read(CHUNK_BYTES)
            if not chunk:
                break
            intake_file.write(chunk)
            digest.update(chunk)
            intake_bytes += len(chunk)
        object_body.close()
        intake_file.flush()
        result["intake_readback_ms"] = round((time.monotonic() - stage) * 1000, 3)
        if digest.hexdigest() != source_sha or intake_bytes != source_bytes:
            raise AssertionError("Private intake readback differs from the source stream")
        result["edge_bytes"]["intake_readback"] = intake_bytes

        intake_file.seek(0)
        stage = time.monotonic()
        response = requests.post(
            f"{proof.CLOUD}/instances",
            data=intake_file,
            headers={
                "Content-Type": "application/dicom",
                "Content-Length": str(intake_bytes),
                "Expect": "",
            },
            timeout=(10, 90),
        )
        response.raise_for_status()
        body = response.json()
        result["cloud_import_ms"] = round((time.monotonic() - stage) * 1000, 3)
        if body.get("Status") not in ("Success", "AlreadyStored"):
            raise RuntimeError(f"Cloud Orthanc rejected synthetic DICOM: {body}")
        result["edge_bytes"]["cloud_import"] = intake_bytes

        cloud_id = proof.find_instance(proof.CLOUD, sop_uid)
        if cloud_id is None:
            raise AssertionError("Cloud Orthanc indexed no synthetic benchmark instance")
        stage = time.monotonic()
        with requests.get(
            f"{proof.CLOUD}/instances/{cloud_id}/file", stream=True, timeout=(10, 90)
        ) as response:
            response.raise_for_status()
            cloud_sha, cloud_bytes = stream_digest(response, deadline)
        result["cloud_readback_ms"] = round((time.monotonic() - stage) * 1000, 3)
        if cloud_sha != source_sha or cloud_bytes != source_bytes:
            raise AssertionError("Cloud Orthanc readback differs from source SHA-256 or byte count")
        result["edge_bytes"]["cloud_readback"] = cloud_bytes
        result["cloud_orthanc_id"] = cloud_id
    proof.S3.delete_object(Bucket="proof-intake", Key=intake_key)
    result["path_elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
    if time.monotonic() > deadline:
        raise TimeoutError("synthetic benchmark exceeded its overall time budget")
    return result


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def benchmark() -> None:
    proof.wait_http(proof.SOURCE)
    proof.wait_http(proof.CLOUD)
    if MAX_INSTANCES != sum(count for _, count, _ in PROFILES):
        raise AssertionError("benchmark instance budget does not match profiles")
    run_id = uuid.uuid4().hex
    run_root = proof.RUNTIME / "benchmark" / run_id
    run_root.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + MAX_RUN_SECONDS
    results = []
    total_file_bytes = 0
    total_edge_bytes = 0
    run_started = time.monotonic()

    for profile_name, count, pixel_bytes in PROFILES:
        study_uid = deterministic_uid(f"{run_id}:{profile_name}:study")
        series_uid = deterministic_uid(f"{run_id}:{profile_name}:series")
        path_times: list[float] = []
        stage_totals: dict[str, float] = {}
        profile_file_bytes = 0
        profile_edge_bytes = 0
        for index in range(count):
            if time.monotonic() >= deadline:
                raise TimeoutError("synthetic benchmark exceeded its 30-minute overall budget")
            sop_uid = deterministic_uid(f"{run_id}:{profile_name}:{index}:sop")
            fixture = run_root / f"{profile_name}-{index:04d}.dcm"
            write_fixture(fixture, study_uid, series_uid, sop_uid, pixel_bytes, index % 256)
            expected_sha = file_sha256(fixture)
            ensure_source_file(fixture, sop_uid, deadline)
            transfer = transfer_streamed(sop_uid, study_uid, expected_sha, deadline)
            fixture.unlink()
            profile_file_bytes += transfer["file_bytes"]
            profile_edge_bytes += sum(transfer["edge_bytes"].values())
            path_times.append(float(transfer["path_elapsed_ms"]))
            for stage in (
                "source_read_ms",
                "intake_put_ms",
                "intake_readback_ms",
                "cloud_import_ms",
                "cloud_readback_ms",
            ):
                stage_totals[stage] = stage_totals.get(stage, 0.0) + float(transfer[stage])
        observed = proof.instance_count(proof.CLOUD, study_uid)
        if observed != count:
            raise AssertionError(f"{profile_name}: expected {count} cloud instances, found {observed}")
        profile_elapsed = sum(path_times)
        results.append(
            {
                "profile": profile_name,
                "instance_count": count,
                "target_pixel_bytes_per_instance": pixel_bytes,
                "actual_dicom_file_bytes": profile_file_bytes,
                "actual_edge_bytes": profile_edge_bytes,
                "stage_elapsed_ms_sum": stage_totals,
                "path_latency_ms": {
                    "min": min(path_times),
                    "median": statistics.median(path_times),
                    "p95": percentile(path_times, 0.95),
                    "max": max(path_times),
                },
                "measured_path_mib_per_second": round(
                    profile_file_bytes / (profile_elapsed / 1000) / (1024 * 1024), 3
                ),
                "verified_cloud_instance_count": observed,
                "study_uid": study_uid,
            }
        )
        total_file_bytes += profile_file_bytes
        total_edge_bytes += profile_edge_bytes

    elapsed = time.monotonic() - run_started
    summary = {
        "scope": "synthetic disposable Orthanc-to-private-intake-to-cloud-Orthanc journey; not clinical capacity evidence",
        "run_id": run_id,
        "profiles": results,
        "budgets": {
            "maximum_instances": MAX_INSTANCES,
            "maximum_pixel_bytes": MAX_PIXEL_BYTES,
            "maximum_elapsed_seconds": MAX_RUN_SECONDS,
            "stream_chunk_bytes": CHUNK_BYTES,
        },
        "totals": {
            "instances": MAX_INSTANCES,
            "actual_dicom_file_bytes": total_file_bytes,
            "actual_transfer_edge_bytes": total_edge_bytes,
            "elapsed_seconds": round(elapsed, 3),
            "actual_file_mib_per_second": round(
                total_file_bytes / elapsed / (1024 * 1024), 3
            ),
            "actual_edge_multiplier": round(total_edge_bytes / total_file_bytes, 3),
            "all_instances_verified": True,
        },
    }
    output = proof.RUNTIME / "benchmark.json"
    output.write_text(json.dumps(summary, indent=2) + "\n")
    result_path = proof.RUNTIME / "result.json"
    combined = json.loads(result_path.read_text()) if result_path.exists() else {}
    combined["benchmark"] = summary
    combined["measured_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    result_path.write_text(json.dumps(combined, indent=2) + "\n")
    print(json.dumps({"stage": "benchmark", "result": summary}, indent=2))
