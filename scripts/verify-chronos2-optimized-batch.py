#!/usr/bin/env python3
"""Verify optimized Chronos-2 WebSocket batch parity on real prepared data."""

from __future__ import annotations

import argparse
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import time
from typing import Any, Mapping, Sequence


def _load_runner() -> Any:
    path = Path(__file__).with_name("cadence-context-3w.py")
    specification = importlib.util.spec_from_file_location(
        "cadence_context_optimized_batch_verify",
        path,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("cadence/context runner module cannot be loaded")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def _series_values(series: Mapping[str, Any]) -> list[float]:
    output: list[float] = []
    for horizon in series["horizons"]:
        output.extend(
            float(value["value"])
            for value in horizon["return_quantiles"]
        )
        output.extend(
            float(value["value"])
            for value in horizon.get("native_return_quantiles", ())
        )
    return output


def _request(
    runner: Any,
    client: Any,
    combination: Mapping[str, Any],
    tasks: Sequence[Any],
) -> tuple[dict[str, Any], float]:
    started = time.monotonic()
    response = client.request(
        runner.request_payload_batch(combination, tasks)
    )
    elapsed_ms = (time.monotonic() - started) * 1_000
    if response.get("status") != "available":
        raise RuntimeError(
            f"Chronos-2 batch returned {response.get('status')}"
        )
    if len(response.get("series", ())) != len(tasks):
        raise RuntimeError("Chronos-2 batch response count is misaligned")
    if any(
        item.get("status") != "available"
        for item in response["series"]
    ):
        raise RuntimeError("Chronos-2 batch contains unavailable series")
    return response, elapsed_ms


def _maximum_difference(
    left: Mapping[str, Any],
    right: Mapping[str, Any],
) -> float:
    left_values = _series_values(left)
    right_values = _series_values(right)
    if len(left_values) != len(right_values):
        raise RuntimeError("Chronos-2 parity vectors have different lengths")
    return max(
        (abs(left_value - right_value)
         for left_value, right_value in zip(
             left_values,
             right_values,
             strict=True,
         )),
        default=0.0,
    )


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--prepared-dir", type=Path, required=True)
    value.add_argument("--source-dir", type=Path, required=True)
    value.add_argument("--url", required=True)
    value.add_argument("--token-file", type=Path, required=True)
    value.add_argument("--context", type=int, choices=(1024, 2048, 4096, 8192), required=True)
    value.add_argument("--cadence", type=int, choices=(5, 15, 30, 60), required=True)
    value.add_argument("--tolerance", type=float, default=1e-6)
    return value


def main() -> None:
    args = parser().parse_args()
    runner = _load_runner()
    source_manifest = json.loads(
        (args.source_dir / "source-manifest.json").read_text(
            encoding="utf-8"
        )
    )
    evaluation_end = runner.from_iso(
        source_manifest["end_exclusive_at"]
    )
    repository = runner.DataRepository(
        args.prepared_dir,
        args.source_dir,
    )
    latest_origin = runner.smoke_origins(
        repository,
        evaluation_end,
    )[0][0]
    origin_values = (
        latest_origin - runner.ORIGIN_INTERVAL_MINUTES * 60_000,
        latest_origin,
    )
    combination = runner.combination(
        "chronos-2",
        args.context,
        args.cadence,
    )
    tasks = [
        runner._prepare_forecast_task(
            repository,
            combination,
            (symbol, origin_ms, None),
        )
        for origin_ms in origin_values
        for symbol in runner.SYMBOLS
    ]
    if any(task.bars is None for task in tasks):
        raise RuntimeError("selected batch smoke origin is unavailable")
    client = runner.WorkerClient(args.url, args.token_file)
    try:
        batch2, batch2_ms = _request(
            runner,
            client,
            combination,
            tasks[:2],
        )
        batch4_capture, batch4_capture_ms = _request(
            runner,
            client,
            combination,
            tasks,
        )
        batch4_replay, batch4_replay_ms = _request(
            runner,
            client,
            combination,
            tasks,
        )
    finally:
        client.close()

    batch2_by_key = {
        item["instrument_key"]: item for item in batch2["series"]
    }
    batch4_by_key = {
        item["instrument_key"]: item
        for item in batch4_capture["series"]
    }
    replay_by_key = {
        item["instrument_key"]: item
        for item in batch4_replay["series"]
    }
    batch_difference = max(
        _maximum_difference(
            batch2_by_key[task.instrument_key],
            batch4_by_key[task.instrument_key],
        )
        for task in tasks[:2]
    )
    replay_difference = max(
        _maximum_difference(
            batch4_by_key[task.instrument_key],
            replay_by_key[task.instrument_key],
        )
        for task in tasks
    )
    if batch_difference > args.tolerance:
        raise RuntimeError(
            "Chronos-2 batch-size parity exceeded tolerance: "
            f"{batch_difference}"
        )
    if replay_difference > args.tolerance:
        raise RuntimeError(
            "Chronos-2 graph replay parity exceeded tolerance: "
            f"{replay_difference}"
        )
    model = batch4_replay["model"]
    if (
        model.get("model_id") != runner.MODEL_IDS["chronos-2"]
        or model.get("model_revision")
        != runner.CHRONOS2_MODEL_REVISION
    ):
        raise RuntimeError("Chronos-2 smoke used an unexpected model revision")
    print(
        json.dumps(
            {
                "status": "passed",
                "checkedAt": runner.iso(datetime.now(runner.UTC)),
                "contextBars": args.context,
                "cadenceSeconds": args.cadence,
                "predictionLengthSteps": runner.prediction_steps(
                    args.cadence
                ),
                "batch2LatencyMs": batch2_ms,
                "batch4CaptureLatencyMs": batch4_capture_ms,
                "batch4ReplayLatencyMs": batch4_replay_ms,
                "batchSizeParityMaxAbs": batch_difference,
                "graphReplayMaxAbs": replay_difference,
                "modelId": model["model_id"],
                "modelRevision": model["model_revision"],
                "origins": [
                    runner.iso_ms(origin_ms)
                    for origin_ms in origin_values
                ],
            },
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
