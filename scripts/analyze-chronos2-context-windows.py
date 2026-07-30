#!/usr/bin/env python3
"""Score Chronos-2 context-window forecasts and select the development context."""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
from typing import Any

import numpy as np


CONTEXTS = (512, 1024, 2048, 4096, 8192)
HORIZONS = (5, 15, 30, 60)
QUANTILES = np.asarray(
    (
        0.01, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30,
        0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65,
        0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.99,
    ),
    dtype=np.float64,
)
Q50_INDEX = int(np.where(QUANTILES == 0.5)[0][0])


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


def pair(value: str) -> tuple[int, Path]:
    context_raw, separator, path_raw = value.partition("=")
    if not separator or int(context_raw) not in CONTEXTS:
        raise argparse.ArgumentTypeError("context mapping must be CONTEXT=/absolute/path")
    return int(context_raw), absolute_file(path_raw)


def parse_timestamp(value: object) -> datetime:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc)
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is not None and parsed.utcoffset() is not None:
            return parsed.astimezone(timezone.utc)
    raise ValueError("timestamp must be epoch milliseconds or RFC3339")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path, maximum_bytes: int = 4 * 1024 * 1024) -> dict[str, Any]:
    if path.stat().st_size < 1 or path.stat().st_size > maximum_bytes:
        raise ValueError(f"{path.name} exceeds its JSON size bound")
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def origins(input_manifest_path: Path) -> tuple[list[dict[str, Any]], str]:
    manifest = load_json(input_manifest_path)
    files = manifest.get("files")
    if (
        manifest.get("schema_version") != "chronos2-raw-input/v2"
        or not isinstance(files, dict)
        or not isinstance(files.get("origins"), dict)
    ):
        raise ValueError("context input must be chronos2-raw-input/v2")
    spec = files["origins"]
    path = input_manifest_path.parent / str(spec.get("name", ""))
    if path.parent != input_manifest_path.parent or not path.is_file() or path.is_symlink():
        raise ValueError("context origin path is unsafe")
    if path.stat().st_size != spec.get("size_bytes") or sha256(path) != spec.get("sha256"):
        raise ValueError("context origins differ from their manifest")
    rows: list[dict[str, Any]] = []
    with path.open("rb") as handle:
        for index, line in enumerate(handle):
            value = json.loads(line)
            if not isinstance(value, dict) or value.get("row_id") != index:
                raise ValueError("context origins are not contiguous")
            rows.append(value)
    if len(rows) != manifest.get("row_count"):
        raise ValueError("context origin count differs from manifest")
    identity = hashlib.sha256()
    for value in rows:
        identity.update(
            (
                json.dumps(
                    {
                        "row_id": value["row_id"],
                        "instrument_key": value["instrument_key"],
                        "origin": parse_timestamp(value["origin"]).isoformat(),
                        "future_timestamps": [
                            parse_timestamp(item).isoformat()
                            for item in value["future_timestamps"]
                        ],
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            ).encode()
        )
    return rows, identity.hexdigest()


def predictions(output_manifest_path: Path) -> tuple[np.ndarray, dict[str, Any]]:
    manifest = load_json(output_manifest_path)
    rows = int(manifest.get("row_count", 0))
    chunks = manifest.get("chunks")
    if (
        manifest.get("schema_version") != "chronos2-raw-predictions/v1"
        or manifest.get("complete") is not True
        or manifest.get("completed_rows") != rows
        or manifest.get("output_shape") != [rows, 4, 22]
        or not isinstance(chunks, list)
    ):
        raise ValueError("context output manifest is incomplete or malformed")
    output = np.empty((rows, 4, 22), dtype=np.float32)
    seen = np.zeros(rows, dtype=np.uint8)
    for name in chunks:
        if not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("context output chunk name is unsafe")
        metadata_path = output_manifest_path.parent / name
        if (
            metadata_path.parent != output_manifest_path.parent / "chunks"
            or not metadata_path.is_file()
            or metadata_path.is_symlink()
        ):
            raise ValueError("context output chunk manifest path is unsafe")
        metadata = load_json(metadata_path)
        start = int(metadata.get("start_row", -1))
        end = int(metadata.get("end_row", -1))
        spec = metadata.get("output")
        if not isinstance(spec, dict) or start < 0 or end <= start or end > rows:
            raise ValueError("context output chunk range is invalid")
        binary_path = output_manifest_path.parent / str(spec.get("name", ""))
        if (
            binary_path.parent != output_manifest_path.parent / "chunks"
            or not binary_path.is_file()
            or binary_path.is_symlink()
            or binary_path.stat().st_size != spec.get("size_bytes")
            or sha256(binary_path) != spec.get("sha256")
        ):
            raise ValueError("context output binary differs from its chunk manifest")
        values = np.fromfile(binary_path, dtype="<f4").reshape(end - start, 4, 22)
        if seen[start:end].any():
            raise ValueError("context output chunks overlap")
        output[start:end] = values
        seen[start:end] = 1
    if not seen.all():
        raise ValueError("context output chunks omit rows")
    if not np.isfinite(output).all() or np.any(np.diff(output[:, :, 1:], axis=-1) < 0):
        raise ValueError("context output contains non-finite or non-monotone quantiles")
    return output, manifest


def market_closes(path: Path) -> dict[tuple[str, datetime], float]:
    result: dict[tuple[str, datetime], float] = {}
    with path.open("rb") as handle:
        for line in handle:
            value = json.loads(line)
            symbol = str(value["symbol"]).upper()
            close_time = parse_timestamp(value.get("close_time", value.get("timestamp")))
            close = float(value["close"])
            if not math.isfinite(close) or close <= 0:
                raise ValueError("market closes must be finite and positive")
            key = (symbol, close_time)
            if key in result:
                raise ValueError("market bars contain duplicate symbol timestamps")
            result[key] = close
    return result


def symbol(origin: dict[str, Any]) -> str:
    metadata = origin.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("symbol"), str):
        return metadata["symbol"].upper()
    return str(origin["instrument_key"]).rsplit(":", maxsplit=1)[-1].upper()


def probability_up(quantiles: np.ndarray, threshold: np.ndarray) -> np.ndarray:
    flat = quantiles.reshape(-1, len(QUANTILES))
    limits = threshold.reshape(-1)
    result = np.empty(len(flat), dtype=np.float64)
    for index, (values, limit) in enumerate(zip(flat, limits, strict=True)):
        if limit < values[0]:
            cdf = 0.0
        elif limit >= values[-1]:
            cdf = 1.0
        else:
            upper = int(np.searchsorted(values, limit, side="right"))
            lower = upper - 1
            width = values[upper] - values[lower]
            fraction = 0.0 if width <= 0 else (limit - values[lower]) / width
            cdf = QUANTILES[lower] + fraction * (QUANTILES[upper] - QUANTILES[lower])
        result[index] = 1 - cdf
    return result.reshape(threshold.shape)


def pinball_losses(actual: np.ndarray, forecast: np.ndarray) -> np.ndarray:
    error = actual[:, :, None] - forecast
    return np.maximum(QUANTILES * error, (QUANTILES - 1) * error)


def wis_losses(actual: np.ndarray, forecast: np.ndarray) -> np.ndarray:
    median_error = np.abs(actual - forecast[:, :, Q50_INDEX])
    weighted = 0.5 * median_error
    pairs = 0
    for lower in range(Q50_INDEX):
        upper = len(QUANTILES) - lower - 1
        if not math.isclose(QUANTILES[lower] + QUANTILES[upper], 1.0):
            continue
        alpha = 2 * QUANTILES[lower]
        low = forecast[:, :, lower]
        high = forecast[:, :, upper]
        interval = (
            high - low
            + (2 / alpha) * (low - actual) * (actual < low)
            + (2 / alpha) * (actual - high) * (actual > high)
        )
        weighted += (alpha / 2) * interval
        pairs += 1
    return weighted / (pairs + 0.5)


def ece10(probability: np.ndarray, outcome: np.ndarray) -> float:
    probability = probability.reshape(-1)
    outcome = outcome.reshape(-1)
    bins = np.minimum((probability * 10).astype(int), 9)
    result = 0.0
    for index in range(10):
        selected = bins == index
        if selected.any():
            result += selected.mean() * abs(
                float(probability[selected].mean())
                - float(outcome[selected].mean())
            )
    return result


def metric_bundle(
    actual: np.ndarray,
    forecast: np.ndarray,
    last_close: np.ndarray,
) -> dict[str, Any]:
    pinball = pinball_losses(actual, forecast)
    q50 = forecast[:, :, Q50_INDEX]
    error = q50 - actual
    probability = probability_up(forecast, last_close)
    outcome = actual > last_close
    return {
        "mean_pinball_loss": float(pinball.mean()),
        "pinball_by_quantile": {
            f"q{int(round(value * 100)):02d}": float(pinball[:, :, index].mean())
            for index, value in enumerate(QUANTILES)
        },
        "wis": float(wis_losses(actual, forecast).mean()),
        "q50_mae": float(np.abs(error).mean()),
        "q50_rmse": float(np.sqrt(np.square(error).mean())),
        "q50_bias": float(error.mean()),
        "brier": float(np.square(probability - outcome).mean()),
        "ece_10_bin": ece10(probability, outcome),
        "q10_q90_coverage": float(
            ((actual >= forecast[:, :, 2]) & (actual <= forecast[:, :, 18])).mean()
        ),
        "q10_q90_width": float((forecast[:, :, 18] - forecast[:, :, 2]).mean()),
        "direction_accuracy": float(
            (np.sign(q50 - last_close) == np.sign(actual - last_close)).mean()
        ),
        "observation_count": int(actual.size),
    }


def bootstrap(
    reference: np.ndarray,
    candidate: np.ndarray,
    labels: list[str],
    *,
    iterations: int,
    seed: int,
) -> dict[str, Any]:
    if reference.shape != candidate.shape or len(reference) != len(labels):
        raise ValueError("paired bootstrap inputs are misaligned")
    grouped: dict[str, list[int]] = defaultdict(list)
    for index, label in enumerate(labels):
        grouped[label].append(index)
    blocks = [np.asarray(grouped[label], dtype=np.int64) for label in sorted(grouped)]
    rng = np.random.default_rng(seed)
    observed = float((candidate - reference).mean())
    samples = np.empty(iterations, dtype=np.float64)
    for iteration in range(iterations):
        selected = rng.integers(0, len(blocks), size=len(blocks))
        indices = np.concatenate([blocks[index] for index in selected])
        samples[iteration] = float((candidate[indices] - reference[indices]).mean())
    p_value = min(
        1.0,
        2 * min(float((samples <= 0).mean()), float((samples >= 0).mean())),
    )
    return {
        "observed_difference": observed,
        "ci95": [
            float(np.percentile(samples, 2.5)),
            float(np.percentile(samples, 97.5)),
        ],
        "two_sided_p_value": p_value,
        "block_count": len(blocks),
        "iterations": iterations,
        "seed": seed,
    }


def holm(values: dict[int, float]) -> dict[int, float]:
    ordered = sorted(values, key=values.get)
    adjusted: dict[int, float] = {}
    running = 0.0
    count = len(ordered)
    for rank, context in enumerate(ordered):
        running = max(running, (count - rank) * values[context])
        adjusted[context] = min(1.0, running)
    return adjusted


def near(left: float, right: float) -> bool:
    scale = max(abs(left), abs(right), 1e-12)
    return abs(left - right) / scale <= 0.001


def select(metrics: dict[int, dict[str, Any]], eligible: set[int]) -> int:
    candidates = sorted(eligible)
    if not candidates:
        raise ValueError("no context has a qualifying batch/backend")
    for key in ("mean_pinball_loss", "wis", "q50_mae", "brier"):
        best_value = min(float(metrics[context][key]) for context in candidates)
        candidates = [
            context
            for context in candidates
            if near(float(metrics[context][key]), best_value)
        ]
        if len(candidates) == 1:
            break
    return min(candidates)


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
    parser.add_argument("--market-bars", type=absolute_file, required=True)
    parser.add_argument("--context-input", action="append", type=pair, required=True)
    parser.add_argument("--context-output", action="append", type=pair, required=True)
    parser.add_argument("--selection", type=absolute_file, required=True)
    parser.add_argument("--output", type=new_file, required=True)
    parser.add_argument("--bootstrap-iterations", type=int, default=5_000)
    parser.add_argument("--seed", type=int, default=17)
    arguments = parser.parse_args()
    if arguments.bootstrap_iterations < 100 or arguments.bootstrap_iterations > 100_000:
        raise ValueError("bootstrap iterations must be in 100..100000")

    inputs = dict(arguments.context_input)
    outputs = dict(arguments.context_output)
    if set(inputs) != set(CONTEXTS) or set(outputs) != set(CONTEXTS):
        raise ValueError("all five context input/output mappings are required")
    selection = load_json(arguments.selection)
    eligible = {
        int(context)
        for context, value in selection.get("contexts", {}).items()
        if isinstance(value, dict) and value.get("status") == "passed"
    }
    closes = market_closes(arguments.market_bars)
    all_origins: dict[int, list[dict[str, Any]]] = {}
    origin_digests: dict[int, str] = {}
    arrays: dict[int, np.ndarray] = {}
    output_manifests: dict[int, dict[str, Any]] = {}
    for context in CONTEXTS:
        all_origins[context], origin_digests[context] = origins(inputs[context])
        arrays[context], output_manifests[context] = predictions(outputs[context])
    if len(set(origin_digests.values())) != 1:
        raise ValueError("context artifacts do not have exact scored-origin parity")

    reference_origins = all_origins[512]
    rows = len(reference_origins)
    actual = np.empty((rows, 4), dtype=np.float64)
    last_close = np.empty((rows, 4), dtype=np.float64)
    symbols: list[str] = []
    origin_times: list[datetime] = []
    for row, origin in enumerate(reference_origins):
        row_symbol = symbol(origin)
        origin_time = parse_timestamp(origin["origin"])
        future = origin["future_timestamps"]
        previous = closes.get((row_symbol, origin_time))
        if previous is None:
            raise ValueError(f"market bars omit {row_symbol} origin close")
        symbols.append(row_symbol)
        origin_times.append(origin_time)
        for horizon_index, horizon in enumerate(HORIZONS):
            realized = closes.get((row_symbol, parse_timestamp(future[horizon - 1])))
            if realized is None:
                raise ValueError(f"market bars omit {row_symbol} realized close")
            actual[row, horizon_index] = realized
            last_close[row, horizon_index] = previous

    metrics: dict[int, dict[str, Any]] = {}
    row_losses: dict[int, np.ndarray] = {}
    for context in CONTEXTS:
        forecast = arrays[context][:, :, 1:].astype(np.float64)
        metrics[context] = metric_bundle(actual, forecast, last_close)
        row_losses[context] = pinball_losses(actual, forecast).mean(axis=(1, 2))
        decomposed: dict[str, dict[str, Any]] = {}
        groups: dict[str, list[int]] = defaultdict(list)
        for row, (row_symbol, origin_time) in enumerate(zip(symbols, origin_times, strict=True)):
            groups[f"symbol:{row_symbol}"].append(row)
            groups[f"week:{origin_time.date().isocalendar().year}-W{origin_time.date().isocalendar().week:02d}"].append(row)
        for label, indices in groups.items():
            selected_rows = np.asarray(indices, dtype=np.int64)
            decomposed[label] = metric_bundle(
                actual[selected_rows],
                forecast[selected_rows],
                last_close[selected_rows],
            )
        for horizon_index, horizon in enumerate(HORIZONS):
            decomposed[f"horizon:{horizon}m"] = metric_bundle(
                actual[:, horizon_index : horizon_index + 1],
                forecast[:, horizon_index : horizon_index + 1],
                last_close[:, horizon_index : horizon_index + 1],
            )
        metrics[context]["decomposition"] = decomposed

    three_hour_labels = [
        f"{value:%Y-%m-%dT}{(value.hour // 3) * 3:02d}"
        for value in origin_times
    ]
    day_labels = [f"{value:%Y-%m-%d}" for value in origin_times]
    comparisons: dict[int, dict[str, Any]] = {}
    p_values: dict[int, float] = {}
    for context in CONTEXTS[1:]:
        primary = bootstrap(
            row_losses[512],
            row_losses[context],
            three_hour_labels,
            iterations=arguments.bootstrap_iterations,
            seed=arguments.seed,
        )
        sensitivity = bootstrap(
            row_losses[512],
            row_losses[context],
            day_labels,
            iterations=arguments.bootstrap_iterations,
            seed=arguments.seed,
        )
        comparisons[context] = {
            "versus_context_bars": 512,
            "three_hour_blocks": primary,
            "daily_blocks_sensitivity": sensitivity,
            "selection_gate": False,
        }
        p_values[context] = float(primary["two_sided_p_value"])
    adjusted = holm(p_values)
    for context, value in adjusted.items():
        comparisons[context]["holm_adjusted_p_value"] = value

    selected = select(metrics, eligible)
    result = {
        "schema_version": "chronos2-context-window-analysis/v1",
        "status": "development_context_selected_holdout_pending",
        "selected_context_bars": selected,
        "selection_policy": {
            "order": ["mean_pinball_loss", "wis", "q50_mae", "brier", "shorter_context"],
            "relative_tie_tolerance": 0.001,
            "bootstrap_ci_is_hard_gate": False,
            "latency_vram_changes_accuracy_rank": False,
        },
        "contexts": {
            str(context): {
                "metrics": metrics[context],
                "input_manifest_sha256": sha256(inputs[context]),
                "input_artifact_digest": output_manifests[context]["input_artifact_digest"],
                "output_manifest_sha256": sha256(outputs[context]),
                "backend": output_manifests[context]["backend"],
                "batch_size": output_manifests[context]["variate_batch_size"],
                "qualifying_candidate": context in eligible,
            }
            for context in CONTEXTS
        },
        "paired_comparisons": {
            str(context): value
            for context, value in comparisons.items()
        },
        "origin_identity_digest": origin_digests[512],
        "row_count": rows,
        "forecast_observation_count": rows * len(HORIZONS),
        "bootstrap": {
            "primary_block_hours": 3,
            "sensitivity_block": "UTC_day",
            "iterations": arguments.bootstrap_iterations,
            "seed": arguments.seed,
            "multiple_comparison_adjustment": "Holm",
        },
        "automatic_live_promotion": False,
        "live_default_changed": False,
        "holdout_run": False,
    }
    atomic_json(arguments.output, result)
    print(
        json.dumps(
            {
                "status": result["status"],
                "selected_context_bars": selected,
                "output": str(arguments.output),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
