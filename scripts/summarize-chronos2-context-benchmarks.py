#!/usr/bin/env python3
"""Select qualifying Chronos-2 context batches/backends and evaluate pilot gates."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import tempfile
from typing import Any


CONTEXTS = (512, 1024, 2048, 4096, 8192)
BATCHES = (1, 2, 4, 8, 12, 16, 24, 32, 48, 50)
BACKENDS = ("pipeline_eager", "worker_local", "no_padding", "gpu_gather")
FULL_ROWS = 6_720
MINIMUM_DISK_FREE_BYTES = 30 * 1024**3
MAXIMUM_FULL_DURATION_MS = 8 * 60 * 60 * 1000


def absolute_directory(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_dir()
    ):
        raise argparse.ArgumentTypeError("run directory must be absolute and normalized")
    return path


def absolute_file(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_file()
    ):
        raise argparse.ArgumentTypeError("input must be an absolute normalized regular file")
    return path


def new_file(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=False) != path or path.exists():
        raise argparse.ArgumentTypeError("output must be a new absolute normalized path")
    return path


def load(path: Path) -> dict[str, Any]:
    if path.stat().st_size < 1 or path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError(f"{path.name} exceeds its JSON size bound")
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def passed(value: dict[str, Any]) -> bool:
    return (
        value.get("schema_version") == "chronos2-p40-raw-benchmark/v1"
        and value.get("status") == "passed"
        and value.get("accuracy_gate", {}).get("finite") is True
        and value.get("accuracy_gate", {}).get("quantile_monotonicity") is True
        and value.get("repeat_output_digest", {}).get("stable") is True
        and value.get("memory", {}).get("headroom_passed") is True
    )


def fastest(values: list[dict[str, Any]]) -> dict[str, Any] | None:
    eligible = [value for value in values if passed(value)]
    if not eligible:
        return None
    return min(
        eligible,
        key=lambda value: (
            float(value["timing"]["wall_ms"]["p95"]),
            -float(value["timing"]["tasks_per_second"]["median"]),
            int(value["variate_batch_size"]),
        ),
    )


def telemetry(value: dict[str, Any]) -> tuple[float | None, float | None]:
    power: list[float] = []
    temperature: list[float] = []
    for round_value in value.get("rounds", []):
        summary = round_value.get("gpu_telemetry", {})
        for key, target in (
            ("power_watts", power),
            ("temperature_celsius", temperature),
        ):
            candidate = summary.get(key)
            maximum = candidate.get("max") if isinstance(candidate, dict) else None
            if isinstance(maximum, (int, float)) and math.isfinite(maximum):
                target.append(float(maximum))
    return (max(power) if power else None, max(temperature) if temperature else None)


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase-root", type=absolute_directory, required=True)
    parser.add_argument("--origin-parity", type=absolute_file, required=True)
    parser.add_argument("--output", type=new_file, required=True)
    parser.add_argument("--mode", choices=("pilot", "full"), required=True)
    parser.add_argument("--disk-free-bytes", type=int)
    parser.add_argument("--estimated-artifact-bytes", type=int, default=0)
    arguments = parser.parse_args()
    parity = load(arguments.origin_parity)
    if parity.get("status") != "passed":
        raise ValueError("scored-origin exact parity did not pass")

    contexts: dict[str, Any] = {}
    estimates: list[float] = []
    benchmark_estimates: list[float] = []
    all_contexts_passed = True
    for context in CONTEXTS:
        directory = arguments.phase_root / "benchmarks" / str(context)
        candidate_results = [
            load(directory / f"candidate-{backend}-b{batch}.json")
            for batch in BATCHES
            for backend in BACKENDS
        ]
        selected_result = fastest(candidate_results)
        if selected_result is None:
            contexts[str(context)] = {
                "status": "rejected",
                "rejection_reasons": ["no_qualifying_batch_backend"],
                "failed_candidates": sum(
                    not passed(value) for value in candidate_results
                ),
            }
            all_contexts_passed = False
            continue
        if arguments.mode == "pilot":
            benchmark_estimates.extend(
                float(value.get("model_load_ms", 0))
                + float(value.get("timing", {}).get("wall_ms", {}).get("p95", 0))
                * 3 * (10 + 30)
                for value in candidate_results
            )
        batch = int(selected_result["variate_batch_size"])
        wall_p95 = float(selected_result["timing"]["wall_ms"]["p95"])
        task_batch = int(selected_result["task_batch_size"])
        estimates.append(FULL_ROWS / task_batch * wall_p95)
        power, temperature = telemetry(selected_result)
        contexts[str(context)] = {
            "status": "passed",
            "selected_batch_size": batch,
            "selected_backend": selected_result["backend"],
            "latency_p95_ms": wall_p95,
            "tasks_per_second": float(
                selected_result["timing"]["tasks_per_second"]["median"]
            ),
            "peak_vram_bytes": int(
                selected_result["memory"]["torch_peak_reserved_bytes"]
            ),
            "minimum_free_vram_bytes": int(
                selected_result["memory"]["minimum_nvml_free_bytes"]
            ),
            "maximum_power_w": power,
            "maximum_temperature_c": temperature,
            "artifact_digest": selected_result["input"]["artifact_digest"],
            "failed_candidates": sum(
                value.get("status") in {"rejected", "unavailable"}
                for value in candidate_results
            ),
        }

    estimated_full_ms = int(sum(estimates) + sum(benchmark_estimates))
    estimated_upper_ms = int(estimated_full_ms * 1.25)
    disk_gate: bool | None = None
    projected_disk_free = None
    if arguments.disk_free_bytes is not None:
        projected_disk_free = (
            arguments.disk_free_bytes - arguments.estimated_artifact_bytes
        )
        disk_gate = projected_disk_free >= MINIMUM_DISK_FREE_BYTES
    gate_reasons: list[str] = []
    if not all_contexts_passed:
        gate_reasons.append("not_all_contexts_have_qualifying_batch_backend")
    if parity.get("status") != "passed":
        gate_reasons.append("scored_origin_parity")
    if estimated_upper_ms > MAXIMUM_FULL_DURATION_MS:
        gate_reasons.append("estimated_full_duration_above_8h")
    if disk_gate is False:
        gate_reasons.append("projected_disk_free_below_30gib")
    pilot_gate = not gate_reasons if arguments.mode == "pilot" else None
    result = {
        "schema_version": "chronos2-context-benchmark-selection/v1",
        "mode": arguments.mode,
        "status": "passed" if all_contexts_passed else "rejected",
        "contexts": contexts,
        "origin_parity": {
            "status": parity["status"],
            "row_count": parity["full_row_count"],
            "identity_digest": parity["baseline_identity_digest"],
        },
        "estimated_full_duration_ms": estimated_full_ms,
        "estimated_full_duration_upper_ms": estimated_upper_ms,
        "projected_disk_free_bytes": projected_disk_free,
        "pilot_gate": {
            "passed": pilot_gate,
            "rejection_reasons": gate_reasons,
            "requirements": {
                "all_contexts_qualify": True,
                "non_finite": 0,
                "quantile_monotonicity": True,
                "repeat_digest_stable": True,
                "scored_origin_exact_parity": True,
                "minimum_vram_headroom_bytes": 2 * 1024**3,
                "maximum_estimated_full_duration_ms": MAXIMUM_FULL_DURATION_MS,
                "minimum_projected_disk_free_bytes": MINIMUM_DISK_FREE_BYTES,
            },
        },
    }
    atomic_json(arguments.output, result)
    print(json.dumps({
        "status": result["status"],
        "pilot_gate_passed": pilot_gate,
        "estimated_full_duration_upper_ms": estimated_upper_ms,
        "output": str(arguments.output),
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
