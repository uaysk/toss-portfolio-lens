#!/usr/bin/env python3
"""Project context qualification artifacts into the bounded dashboard contract."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
from typing import Any


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
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError("dashboard source must be a JSON object")
    return value


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
            json.dump(value, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", type=absolute_file, required=True)
    parser.add_argument("--analysis", type=absolute_file)
    parser.add_argument("--output", type=new_file, required=True)
    arguments = parser.parse_args()
    selection = load(arguments.selection)
    analysis = load(arguments.analysis) if arguments.analysis else None
    contexts = []
    for context_raw, selected in sorted(
        selection.get("contexts", {}).items(),
        key=lambda item: int(item[0]),
    ):
        if not isinstance(selected, dict):
            continue
        context = int(context_raw)
        result: dict[str, Any] = {
            "contextBars": context,
            "status": selected.get("status", "failed"),
            "progressPercent": 100,
            "failureCount": int(selected.get("failed_candidates", 0)),
        }
        mappings = (
            ("selected_batch_size", "batchSize"),
            ("selected_backend", "backend"),
            ("latency_p95_ms", "latencyP95Ms"),
            ("tasks_per_second", "tasksPerSecond"),
            ("peak_vram_bytes", "peakVramBytes"),
            ("minimum_free_vram_bytes", "minimumFreeVramBytes"),
            ("maximum_power_w", "maximumPowerW"),
            ("maximum_temperature_c", "maximumTemperatureC"),
            ("artifact_digest", "artifactDigest"),
        )
        for source, target in mappings:
            if selected.get(source) is not None:
                result[target] = selected[source]
        if analysis is not None:
            scored = analysis.get("contexts", {}).get(str(context), {})
            metrics = scored.get("metrics", {}) if isinstance(scored, dict) else {}
            for source, target in (
                ("mean_pinball_loss", "meanPinballLoss"),
                ("wis", "wis"),
                ("q50_mae", "q50Mae"),
                ("brier", "brier"),
            ):
                if metrics.get(source) is not None:
                    result[target] = metrics[source]
            comparison = analysis.get("paired_comparisons", {}).get(str(context), {})
            ci = comparison.get("three_hour_blocks", {}).get("ci95")
            if isinstance(ci, list) and len(ci) == 2:
                result["bootstrapCiLow"] = ci[0]
                result["bootstrapCiHigh"] = ci[1]
        contexts.append(result)
    projected = selection.get("projected_disk_free_bytes")
    metrics_output: dict[str, Any] = {
        "estimatedFullDurationMs": selection.get("estimated_full_duration_ms"),
        "estimatedFullDurationUpperMs": selection.get("estimated_full_duration_upper_ms"),
        "scoredOriginDigest": selection.get("origin_parity", {}).get("identity_digest"),
        "contextResults": contexts,
    }
    pilot_gate = selection.get("pilot_gate", {}).get("passed")
    if isinstance(pilot_gate, bool):
        metrics_output["pilotGatePassed"] = pilot_gate
    if isinstance(projected, int):
        metrics_output["projectedDiskFreeGiB"] = projected / 1024**3
    if analysis is not None:
        metrics_output["selectedContextBars"] = analysis["selected_context_bars"]
        metrics_output["resultStatus"] = analysis["status"]
    atomic_json(arguments.output, metrics_output)
    print(json.dumps(metrics_output, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
