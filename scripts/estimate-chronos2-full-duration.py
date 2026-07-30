#!/usr/bin/env python3
"""Estimate the five-week Chronos-2 qualification from a completed pilot."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import statistics
import tempfile
from typing import Any


PROFILES = (
    "close_only",
    "ohlcv_calendar",
    "microstructure_calendar",
    "derivatives_calendar",
)
STAGES = (
    "pipeline_eager",
    "worker_local",
    "no_padding",
    "gpu_gather",
    "cuda_graph",
)
FULL_HOURS = 840
FULL_ROWS = FULL_HOURS * 8
FULL_PROTOCOL_CALLS = 3 * (10 + 30)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pilot-run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def number(value: object, *keys: str) -> float | None:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    if (
        not isinstance(current, (int, float))
        or isinstance(current, bool)
        or not math.isfinite(float(current))
    ):
        return None
    return float(current)


def step_seconds(state: dict[str, Any], step_id: str) -> float:
    for step in state["steps"]:
        if step.get("id") == step_id and isinstance(step.get("durationMs"), int):
            return step["durationMs"] / 1_000
    raise ValueError(f"pilot step duration unavailable: {step_id}")


def benchmark_seconds(
    value: dict[str, Any],
    percentile: str,
) -> float:
    load = number(value, "model_load_ms")
    wall = number(value, "timing", "wall_ms", percentile)
    if load is None or wall is None:
        raise ValueError("pilot benchmark is missing model load or timing")
    return (load + FULL_PROTOCOL_CALLS * wall) / 1_000


def generation_seconds(run: Path, profile: str) -> tuple[float, int]:
    root = run / "outputs" / "chronos2" / profile
    manifest = read(root / "manifest.json")
    total = 0.0
    rows = 0
    for name in manifest.get("chunks", []):
        chunk = read(root / str(name))
        latency = number(chunk, "latency", "wall_ms")
        start = chunk.get("start_row")
        end = chunk.get("end_row")
        if (
            latency is None
            or not isinstance(start, int)
            or not isinstance(end, int)
            or end <= start
        ):
            raise ValueError("pilot generation chunk is incomplete")
        total += latency / 1_000
        rows += end - start
    if rows < 1:
        raise ValueError("pilot generation contains no rows")
    return total, rows


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    args = arguments()
    run = args.pilot_run.resolve(strict=True)
    if not run.is_dir() or run.is_symlink():
        raise ValueError("pilot run must be an absolute normalized directory")
    state = read(run / "state.json")
    pilot_hours = int(state["config"]["durationHours"])
    pilot_rows = pilot_hours * 8
    if pilot_hours < 1 or pilot_hours >= FULL_HOURS:
        raise ValueError("pilot duration must be in 1..839 hours")
    row_scale = FULL_ROWS / pilot_rows

    batch_expected = 0.0
    batch_upper = 0.0
    stage_expected = 0.0
    stage_upper = 0.0
    for profile in PROFILES:
        batch = read(
            run
            / "benchmarks"
            / profile
            / "batch-worker-local-b48.json"
        )
        batch_expected += 5 * benchmark_seconds(batch, "p50")
        batch_upper += 5 * benchmark_seconds(batch, "p95")
        for backend in STAGES:
            stage = read(
                run
                / "benchmarks"
                / profile
                / f"stage-{backend}-b48.json"
            )
            try:
                stage_expected += benchmark_seconds(stage, "p50")
                stage_upper += benchmark_seconds(stage, "p95")
            except ValueError:
                # A rejected/unavailable optimization is still executed in an
                # independent process in the full run. Use the successful
                # worker-local cost as a conservative bounded substitute.
                stage_expected += benchmark_seconds(batch, "p50")
                stage_upper += benchmark_seconds(batch, "p95")

    load_samples = [
        number(
            read(
                run
                / "benchmarks"
                / profile
                / "batch-worker-local-b48.json"
            ),
            "model_load_ms",
        )
        for profile in PROFILES
    ]
    model_load_seconds = statistics.median(
        [value for value in load_samples if value is not None]
    ) / 1_000
    generation_expected = 0.0
    generation_upper = 0.0
    generation_measurements: dict[str, Any] = {}
    for profile in PROFILES:
        measured, rows = generation_seconds(run, profile)
        scaled = measured / rows * FULL_ROWS + model_load_seconds
        generation_expected += scaled
        generation_upper += scaled * 1.35
        generation_measurements[profile] = {
            "pilot_rows": rows,
            "pilot_chunk_wall_seconds": measured,
            "full_scaled_seconds": scaled,
        }

    input_expected = step_seconds(state, "prepare-input") * row_scale
    artifact_expected = step_seconds(state, "chronos-artifacts") * row_scale
    comparison_expected = step_seconds(state, "pilot-comparison") * row_scale
    fincast_timing = read(run / "timings" / "fincast-generation.json")
    fincast_measured = number(fincast_timing, "wall_seconds")
    if fincast_measured is None or fincast_measured <= 0:
        raise ValueError("pilot FinCast generation timing is unavailable")
    fincast_expected = max(
        model_load_seconds,
        (fincast_measured - model_load_seconds) / pilot_rows * FULL_ROWS
        + model_load_seconds,
    )
    fixed_seconds = 8 * 60
    expected = (
        input_expected
        + artifact_expected
        + batch_expected
        + stage_expected
        + generation_expected
        + fincast_expected
        + comparison_expected
        + fixed_seconds
    )
    upper = (
        input_expected * 1.25
        + artifact_expected * 1.25
        + batch_upper * 1.2
        + stage_upper * 1.2
        + generation_upper
        + fincast_expected * 1.35
        + comparison_expected * 1.35
        + 15 * 60
    )
    result = {
        "schema_version": "chronos2-five-week-duration-estimate/v1",
        "method": (
            "pilot fixed-cost plus measured per-row and per-iteration extrapolation; "
            "upper bound uses p95 and 20-35% subsystem margins"
        ),
        "pilot": {
            "run_id": state["runId"],
            "duration_hours": pilot_hours,
            "row_count": pilot_rows,
            "wall_seconds": number(state, "progress", "elapsedMs") / 1_000,
        },
        "full": {
            "duration_hours": FULL_HOURS,
            "row_count": FULL_ROWS,
            "estimated_duration_ms": round(expected * 1_000),
            "estimated_duration_upper_ms": round(upper * 1_000),
            "estimated_duration_hours": expected / 3_600,
            "estimated_duration_upper_hours": upper / 3_600,
            "exceeds_one_hour": expected > 3_600,
        },
        "components_seconds": {
            "input_collection": input_expected,
            "artifact_preparation": artifact_expected,
            "batch_sweep": batch_expected,
            "optimization_waterfall": stage_expected,
            "chronos2_generation": generation_expected,
            "fincast_generation": fincast_expected,
            "policy_comparison": comparison_expected,
            "fixed_runtime_and_restoration": fixed_seconds,
        },
        "generation_measurements": generation_measurements,
    }
    atomic_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
