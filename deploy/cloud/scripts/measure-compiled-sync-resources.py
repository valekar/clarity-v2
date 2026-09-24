#!/usr/bin/env python3
"""Sample host/container resources during the synthetic compiled-service proof."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
PROOF = ROOT / "deploy/cloud/scripts/proof.sh"
SAMPLE_SECONDS = 0.5


def command(args: list[str]) -> str:
    result = subprocess.run(args, check=True, capture_output=True, text=True)
    return result.stdout


def parse_ps(proof_pid: int) -> dict[int, dict[str, Any]]:
    output = command(["ps", "-Ao", "pid=,ppid=,rss=,%cpu=,command="])
    rows: dict[int, dict[str, Any]] = {}
    for row in output.splitlines():
        parts = row.strip().split(None, 4)
        if len(parts) != 5:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
            rss_kib, cpu = int(parts[2]), float(parts[3])
        except ValueError:
            continue
        rows[pid] = {
            "ppid": ppid,
            "rss_bytes": rss_kib * 1024,
            "cpu_percent": cpu,
            "command": parts[4],
        }
    found: dict[int, dict[str, Any]] = {}
    for pid, item in rows.items():
        if "apps/sync-service/dist/main.js" not in item["command"]:
            continue
        ancestor = int(item["ppid"])
        visited: set[int] = set()
        while ancestor in rows and ancestor not in visited and ancestor != proof_pid:
            visited.add(ancestor)
            ancestor = int(rows[ancestor]["ppid"])
        if ancestor == proof_pid:
            found[pid] = {"rss_bytes": item["rss_bytes"], "cpu_percent": item["cpu_percent"]}
    return found


def parse_size(value: str) -> int:
    match = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*([kMGT]?i?B)\s*", value)
    if not match:
        raise ValueError(f"unrecognized Docker byte counter: {value!r}")
    amount = float(match.group(1))
    unit = match.group(2)
    exponent = {"B": 0, "kB": 1, "KB": 1, "KiB": 1, "MB": 2, "MiB": 2,
                "GB": 3, "GiB": 3, "TB": 4, "TiB": 4}.get(unit)
    if exponent is None:
        raise ValueError(f"unrecognized Docker byte unit: {unit!r}")
    base = 1024 if "iB" in unit else 1000
    return int(amount * (base**exponent))


def docker_names(project: str) -> list[str]:
    output = command(["docker", "ps", "--format", "{{.Names}}"])
    return sorted(
        name for name in output.splitlines()
        if name.startswith(f"{project}-") or name.startswith("clarity-v2-sync-proof-")
    )


def docker_stats(names: list[str]) -> dict[str, dict[str, Any]]:
    if not names:
        return {}
    raw = command(["docker", "stats", "--no-stream", "--format", "{{json .}}", *names])
    result: dict[str, dict[str, Any]] = {}
    for line in raw.splitlines():
        try:
            item = json.loads(line)
            name = str(item["Name"])
            net = str(item["NetIO"]).split(" / ", 1)
            mem = str(item["MemUsage"]).split(" / ", 1)
            if len(net) != 2 or len(mem) != 2:
                continue
            result[name] = {
                "cpu_percent": float(str(item["CPUPerc"]).rstrip("%")),
                "memory_bytes": parse_size(mem[0]),
                "network_rx_bytes": parse_size(net[0]),
                "network_tx_bytes": parse_size(net[1]),
            }
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue
    return result


def container_role(name: str, project: str) -> str:
    if name.startswith("clarity-v2-sync-proof-"):
        return "synthetic-source-orthanc"
    prefix = f"{project}-"
    return name.removeprefix(prefix) if name.startswith(prefix) else "other-proof-container"


def folder_sizes() -> tuple[int, int]:
    temp_root = Path(tempfile.gettempdir())
    checkpoint_max = 0
    spool_max = 0
    for candidate in temp_root.glob("clarity-v2-sync-process-proof-*"):
        state = candidate / "state"
        spool = candidate / "spool"
        checkpoint_max = max(checkpoint_max, sum_files(state))
        spool_max = max(spool_max, sum_files(spool))
    return checkpoint_max, spool_max


def sum_files(folder: Path) -> int:
    if not folder.exists():
        return 0
    return sum(path.stat().st_size for path in folder.rglob("*") if path.is_file())


def read_result(log_path: Path) -> dict[str, Any]:
    for line in reversed(log_path.read_text(errors="replace").splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if value.get("compiledEntry") is True:
            return value
    raise RuntimeError("compiled service proof did not emit its machine-readable success result")


def main() -> int:
    if sys.platform != "darwin":
        raise RuntimeError("this bounded proof currently supports macOS Docker Desktop only")
    if not PROOF.is_file():
        raise RuntimeError(f"cloud proof not found: {PROOF}")

    environment = os.environ.copy()
    environment["CLARITY_COMPILED_SYNC_PROOF"] = "1"
    log_fd, log_name = tempfile.mkstemp(prefix="clarity-v2-resource-proof-")
    os.close(log_fd)
    log_path = Path(log_name)
    log_handle = log_path.open("w")
    process = subprocess.Popen(
        ["bash", str(PROOF)], cwd=ROOT, env=environment,
        stdout=log_handle, stderr=subprocess.STDOUT,
    )
    project = f"clarity-v2-proof-{process.pid}"
    start = time.monotonic()
    service_first: float | None = None
    service_last: float | None = None
    process_samples: list[dict[str, float]] = []
    checkpoint_peak = 0
    spool_peak = 0
    container_observations: dict[str, dict[str, float | int]] = {}
    network_start: dict[str, dict[str, Any]] | None = None
    network_end: dict[str, dict[str, Any]] | None = None
    final_names: list[str] = []
    try:
        while process.poll() is None:
            now = time.monotonic()
            processes = parse_ps(process.pid)
            service_pids = set(processes)
            if service_pids:
                if service_first is None:
                    service_first = now
                    final_names = docker_names(project)
                network_start = docker_stats(final_names)
                service_last = now
                process_samples.extend(processes.values())
                stats = docker_stats(final_names)
                network_end = stats
                for name, item in stats.items():
                    role = container_role(name, project)
                    observed = container_observations.setdefault(
                        role, {"cpu_percent_sampled_max": 0.0, "memory_bytes_sampled_max": 0, "sample_count": 0}
                    )
                    observed["cpu_percent_sampled_max"] = max(float(observed["cpu_percent_sampled_max"]), item["cpu_percent"])
                    observed["memory_bytes_sampled_max"] = max(int(observed["memory_bytes_sampled_max"]), item["memory_bytes"])
                    observed["sample_count"] = int(observed["sample_count"]) + 1
            checkpoint, spool = folder_sizes()
            checkpoint_peak = max(checkpoint_peak, checkpoint)
            spool_peak = max(spool_peak, spool)
            time.sleep(SAMPLE_SECONDS)
        status = process.wait()
        log_handle.close()
        if status != 0:
            raise RuntimeError(f"cloud proof exited with status {status}; detailed output is suppressed by the sampler")
        proof_result = read_result(log_path)
        if service_first is None or service_last is None or not process_samples:
            raise RuntimeError("compiled sync-service process was not observed by the sampler")
        wall = time.monotonic() - start
        sampled_span = max(0.0, service_last - service_first)
        rx_delta = 0
        tx_delta = 0
        network_roles: list[str] = []
        if network_start is not None and network_end is not None:
            network_names = sorted(set(network_start) & set(network_end))
            network_roles = sorted({container_role(name, project) for name in network_names})
            for name in network_names:
                rx_delta += max(0, network_end[name]["network_rx_bytes"] - network_start[name]["network_rx_bytes"])
                tx_delta += max(0, network_end[name]["network_tx_bytes"] - network_start[name]["network_tx_bytes"])
        result = {
            "result": "pass",
            "proof": "CLARITY_COMPILED_SYNC_PROOF=1 deploy/cloud/scripts/proof.sh",
            "platform": f"{sys.platform}-{os.uname().machine}",
            "sampling_interval_seconds": SAMPLE_SECONDS,
            "proof_wall_seconds": round(wall, 3),
            "service_sampled_span_seconds": round(sampled_span, 3),
            "synthetic_file_bytes": proof_result["sourceBytes"],
            "capacity_estimate": False,
            "sample_adequacy": {
                "compiled_service_process_samples": len(process_samples),
                "multiple_process_samples_observed": len(process_samples) >= 2,
                "container_samples_per_role": {
                    role: int(values["sample_count"])
                    for role, values in sorted(container_observations.items())
                },
            },
            "local_state_sampled_max_bytes": {
                "sqlite_state_and_sidecars": checkpoint_peak,
                "spool_directory": spool_peak,
                "spool_interpretation": "no spool files were observed by the sampler" if spool_peak == 0 else "sampled maximum only",
            },
            "compiled_service_host_process_observations": {
                "rss_sampled_max_bytes": max(item["rss_bytes"] for item in process_samples),
                "cpu_percent_sampled_max": round(max(item["cpu_percent"] for item in process_samples), 2),
                "cpu_percent_sampled_mean": round(sum(item["cpu_percent"] for item in process_samples) / len(process_samples), 2),
                "sample_count": len(process_samples),
            },
            "docker_container_resource_observations": container_observations,
            "docker_container_network_delta_during_service": {
                "available": bool(network_roles),
                "container_roles": network_roles,
                "rx_bytes_sum": rx_delta if network_roles else None,
                "tx_bytes_sum": tx_delta if network_roles else None,
                "rx_plus_tx_bytes": rx_delta + tx_delta if network_roles else None,
            },
            "scope_limits": [
                "one generated synthetic DICOM object and one local Docker Desktop run",
                "host CPU and RSS values are sampled observations, not true peaks; no total service CPU seconds are inferred",
                "Docker container CPU, memory and network counters are sampled observations, not true peaks; cadence is 0.5 seconds",
                "container network bytes include control traffic and count packets at each container interface; inter-container transfers are counted at both ends",
                "network counters do not isolate DICOM payload bytes or include the host service process; synthetic_file_bytes is the verified object size",
                "spool and SQLite sizes are sampled maxima and can miss brief peaks between samples; a zero spool observation is not proof of zero transient spool use",
                "no clinic load, WAN bandwidth, storage capacity, concurrency, or pilot breadth was measured",
            ],
        }
        print(json.dumps(result, indent=2))
        output_path = os.environ.get("CLARITY_RESOURCE_RESULT_FILE")
        if output_path:
            Path(output_path).write_text(json.dumps(result, indent=2) + "\n")
        return 0
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if not log_handle.closed:
            log_handle.close()
        log_path.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # bounded CLI diagnostic
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
