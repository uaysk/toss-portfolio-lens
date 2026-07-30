#!/usr/bin/env python3
"""Select Chronos-2 batches/backends and summarize five-week comparisons."""

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
BATCHES = (16, 24, 32, 48, 50)
STAGES = (
    "pipeline_eager",
    "worker_local",
    "no_padding",
    "gpu_gather",
    "cuda_graph",
)


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


def absolute_output(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=False) != path:
        raise argparse.ArgumentTypeError("output must be absolute and normalized")
    return path


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=absolute_directory, required=True)
    parser.add_argument("--output", type=absolute_output, required=True)
    parser.add_argument("--selection-only", action="store_true")
    return parser.parse_args()


def read_object(path: Path) -> dict[str, Any] | None:
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 4 << 20:
        return None
    value = json.loads(path.read_bytes())
    return value if isinstance(value, dict) else None


def nested_number(value: object, *path: str) -> float | None:
    current = value
    for key in path:
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


def numeric_batch_eligible(result: dict[str, Any]) -> bool:
    return (
        result.get("schema_version") == "chronos2-p40-raw-benchmark/v1"
        and nested_number(result, "accuracy_gate", "direction_match_rate") is not None
        and result.get("accuracy_gate", {}).get("passed") is True
        and result.get("repeat_output_digest", {}).get("stable") is True
        and result.get("memory", {}).get("headroom_passed") is True
        and "unexpected_tail_in_fixed_batch_benchmark"
        not in result.get("rejection_reasons", [])
        and nested_number(result, "timing", "tasks_per_second", "median") is not None
        and nested_number(result, "timing", "wall_ms", "p95") is not None
    )


def select_batch(results: list[dict[str, Any]]) -> tuple[int, str]:
    eligible = [value for value in results if numeric_batch_eligible(value)]
    if not eligible:
        return 48, "fallback_b48_no_numerically_eligible_worker_local_result"
    fastest = max(
        nested_number(value, "timing", "tasks_per_second", "median") or 0
        for value in eligible
    )
    near = [
        value
        for value in eligible
        if (nested_number(value, "timing", "tasks_per_second", "median") or 0)
        >= fastest * 0.97
    ]
    selected = min(
        near,
        key=lambda value: (
            nested_number(value, "timing", "wall_ms", "p95")
            or math.inf,
            int(value["variate_batch_size"]),
        ),
    )
    return int(selected["variate_batch_size"]), "qualified_three_percent_tie_rule"


def batch_view(run: Path, profile: str) -> dict[str, Any]:
    results = [
        value
        for batch in BATCHES
        if (
            value := read_object(
                run
                / "benchmarks"
                / profile
                / f"batch-worker-local-b{batch}.json"
            )
        )
        is not None
    ]
    selected, reason = select_batch(results)
    return {
        "selected_variate_batch_size": selected,
        "selection_reason": reason,
        "candidate_count": len(results),
        "eligible_count": sum(numeric_batch_eligible(value) for value in results),
        "candidates": results,
    }


def stage_view(
    run: Path,
    profile: str,
    selected_batch: int,
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    accepted: list[dict[str, Any]] = []
    last_throughput: float | None = None
    reference_throughput: float | None = None
    for stage in STAGES:
        raw = read_object(
            run / "benchmarks" / profile / f"stage-{stage}-b{selected_batch}.json"
        )
        if raw is None:
            results.append(
                {
                    "backend": stage,
                    "status": "pending",
                    "reason": "benchmark_artifact_unavailable",
                }
            )
            continue
        throughput = nested_number(raw, "timing", "tasks_per_second", "median")
        accepted_stage = raw.get("status") == "passed" and throughput is not None
        view = {
            "backend": stage,
            "status": raw.get("status", "unavailable"),
            "rejection_reasons": raw.get("rejection_reasons", []),
            "tasks_per_second": throughput,
            "variates_per_second": nested_number(
                raw,
                "timing",
                "variates_per_second",
                "median",
            ),
            "wall_p50_ms": nested_number(raw, "timing", "wall_ms", "p50"),
            "wall_p95_ms": nested_number(raw, "timing", "wall_ms", "p95"),
            "graph_capture_ms": nested_number(raw, "graph_capture_ms"),
            "peak_vram_bytes": nested_number(
                raw,
                "memory",
                "torch_peak_reserved_bytes",
            ),
            "accuracy_gate": raw.get("accuracy_gate"),
            "stage_exact_gate": raw.get("stage_exact_gate"),
            "repeat_output_digest": raw.get("repeat_output_digest"),
            "structure": raw.get("structure"),
            "accepted": accepted_stage,
        }
        if accepted_stage:
            if reference_throughput is None:
                reference_throughput = throughput
            view["incremental_speedup_ratio"] = (
                throughput / last_throughput
                if last_throughput is not None and last_throughput > 0
                else 1.0
            )
            view["cumulative_speedup_ratio"] = (
                throughput / reference_throughput
                if reference_throughput is not None and reference_throughput > 0
                else 1.0
            )
            view["cumulative_speedup_percent"] = (
                float(view["cumulative_speedup_ratio"]) - 1
            ) * 100
            last_throughput = throughput
            accepted.append(view)
        results.append(view)
    selected = (
        max(
            accepted,
            key=lambda value: (
                float(value["tasks_per_second"]),
                -STAGES.index(str(value["backend"])),
            ),
        )
        if accepted
        else None
    )
    return {
        "stages": results,
        "selected_backend": (
            selected["backend"] if selected is not None else "pipeline_eager"
        ),
        "selected_tasks_per_second": (
            selected["tasks_per_second"] if selected is not None else None
        ),
        "accepted_stage_count": len(accepted),
        "moe_packed_experts": {
            "status": "not_applicable",
            "reason": "Chronos-2 uses dense feed-forward layers and has no MoE experts.",
        },
        "tensorrt": {
            "status": "unavailable",
            "reason": (
                "TensorRT containers and artifacts remain operator-deleted; "
                "the Chronos-2 qualification does not rebuild them."
            ),
        },
    }


def comparison_metrics(value: dict[str, Any]) -> dict[str, Any] | None:
    accuracy = value.get("realized_accuracy")
    returns = value.get("model_signal_returns")
    if not isinstance(accuracy, dict) or not isinstance(returns, dict):
        return None
    reference = accuracy.get("reference")
    candidate = accuracy.get("candidate")
    profiles = returns.get("profiles")
    if (
        not isinstance(reference, dict)
        or not isinstance(candidate, dict)
        or not isinstance(profiles, list)
    ):
        return None
    candidate_returns: list[float] = []
    reference_returns: list[float] = []
    candidate_drawdowns: list[float] = []
    reference_drawdowns: list[float] = []
    wins = 0
    for profile in profiles:
        if not isinstance(profile, dict):
            continue
        left = profile.get("reference")
        right = profile.get("candidate")
        if not isinstance(left, dict) or not isinstance(right, dict):
            continue
        left_return = nested_number(left, "total_return")
        right_return = nested_number(right, "total_return")
        left_drawdown = nested_number(left, "maximum_drawdown")
        right_drawdown = nested_number(right, "maximum_drawdown")
        if None in {left_return, right_return, left_drawdown, right_drawdown}:
            continue
        reference_returns.append(float(left_return))
        candidate_returns.append(float(right_return))
        reference_drawdowns.append(float(left_drawdown))
        candidate_drawdowns.append(float(right_drawdown))
        wins += int(float(right_return) > float(left_return))
    if not candidate_returns:
        return None
    return {
        "reference": {
            "direction_accuracy": nested_number(reference, "direction_accuracy"),
            "q50_return_mae": nested_number(reference, "q50_return_mae"),
            "q50_return_rmse": nested_number(reference, "q50_return_rmse"),
            "up_probability_brier": nested_number(reference, "up_probability_brier"),
            "q10_q90_interval_coverage": nested_number(
                reference,
                "q10_q90_interval_coverage",
            ),
            "mean_pinball_loss": nested_number(reference, "mean_pinball_loss"),
            "median_policy_total_return": statistics.median(reference_returns),
            "mean_policy_total_return": statistics.fmean(reference_returns),
            "median_policy_maximum_drawdown": statistics.median(reference_drawdowns),
        },
        "candidate": {
            "direction_accuracy": nested_number(candidate, "direction_accuracy"),
            "q50_return_mae": nested_number(candidate, "q50_return_mae"),
            "q50_return_rmse": nested_number(candidate, "q50_return_rmse"),
            "up_probability_brier": nested_number(candidate, "up_probability_brier"),
            "q10_q90_interval_coverage": nested_number(
                candidate,
                "q10_q90_interval_coverage",
            ),
            "mean_pinball_loss": nested_number(candidate, "mean_pinball_loss"),
            "median_policy_total_return": statistics.median(candidate_returns),
            "mean_policy_total_return": statistics.fmean(candidate_returns),
            "median_policy_maximum_drawdown": statistics.median(candidate_drawdowns),
        },
        "paired": {
            "candidate_q50_error_wins": nested_number(
                accuracy,
                "paired",
                "candidate_q50_error_wins",
            ),
            "candidate_q50_error_losses": nested_number(
                accuracy,
                "paired",
                "candidate_q50_error_losses",
            ),
            "direction_disagreements": nested_number(
                accuracy,
                "paired",
                "direction_disagreements",
            ),
            "policy_profile_count": len(candidate_returns),
            "candidate_return_wins": wins,
            "candidate_return_win_rate": wins / len(candidate_returns),
            "median_total_return_delta": statistics.median(
                [
                    right - left
                    for left, right in zip(
                        reference_returns,
                        candidate_returns,
                        strict=True,
                    )
                ]
            ),
            "mean_total_return_delta": statistics.fmean(
                [
                    right - left
                    for left, right in zip(
                        reference_returns,
                        candidate_returns,
                        strict=True,
                    )
                ]
            ),
        },
        "reason_difference_analysis": value.get("reason_difference_analysis"),
        "threshold_margin_audit": value.get("threshold_margin_audit"),
        "probability_only_near_threshold": value.get(
            "probability_only_near_threshold"
        ),
    }


def choose_profile(comparisons: dict[str, dict[str, Any]]) -> dict[str, Any]:
    close = comparisons.get("close_only")
    if close is None:
        return {
            "selected_profile": None,
            "additional_covariates_improved_holdout": None,
            "reason": "close_only_comparison_unavailable",
        }
    close_candidate = close["candidate"]
    close_pinball = close_candidate.get("mean_pinball_loss")
    close_mae = close_candidate.get("q50_return_mae")
    close_direction = close_candidate.get("direction_accuracy")
    close_return = close_candidate.get("median_policy_total_return")
    if None in {close_pinball, close_mae, close_direction, close_return}:
        return {
            "selected_profile": None,
            "additional_covariates_improved_holdout": None,
            "reason": "close_only_metrics_incomplete",
        }
    guard_thresholds = {
        "q50_mae_ratio_maximum": 1.01,
        "direction_accuracy_delta_minimum": -0.001,
        "median_policy_total_return_delta_minimum": -0.001,
    }
    guarded: list[tuple[str, dict[str, Any]]] = []
    evaluations: dict[str, dict[str, Any]] = {}
    for profile, metrics in comparisons.items():
        candidate = metrics["candidate"]
        pinball = candidate.get("mean_pinball_loss")
        mae = candidate.get("q50_return_mae")
        direction = candidate.get("direction_accuracy")
        total_return = candidate.get("median_policy_total_return")
        complete = None not in {pinball, mae, direction, total_return}
        mae_ratio = (
            float(mae) / float(close_mae)
            if complete and float(close_mae) > 0
            else None
        )
        direction_delta = (
            float(direction) - float(close_direction) if complete else None
        )
        return_delta = (
            float(total_return) - float(close_return) if complete else None
        )
        pinball_improvement = (
            (float(close_pinball) - float(pinball)) / float(close_pinball)
            if complete and float(close_pinball) > 0
            else None
        )
        guards = {
            "metrics_complete": complete,
            "q50_mae_non_regression": (
                mae_ratio is not None
                and mae_ratio <= guard_thresholds["q50_mae_ratio_maximum"]
            ),
            "direction_accuracy_non_regression": (
                direction_delta is not None
                and direction_delta
                >= guard_thresholds["direction_accuracy_delta_minimum"]
            ),
            "median_policy_total_return_non_regression": (
                return_delta is not None
                and return_delta
                >= guard_thresholds[
                    "median_policy_total_return_delta_minimum"
                ]
            ),
        }
        rejection_reasons = [
            name for name, passed in guards.items() if not passed
        ]
        eligible = not rejection_reasons
        evaluations[profile] = {
            "eligible": eligible,
            "guard_results": guards,
            "rejection_reasons": rejection_reasons,
            "q50_mae_ratio_vs_close_only": mae_ratio,
            "direction_accuracy_delta_vs_close_only": direction_delta,
            "median_policy_total_return_delta_vs_close_only": return_delta,
            "mean_pinball_loss_improvement_ratio_vs_close_only": (
                pinball_improvement
            ),
        }
        if eligible:
            guarded.append((profile, metrics))
    selected_profile, selected_metrics = min(
        guarded or [("close_only", close)],
        key=lambda item: (
            float(item[1]["candidate"]["mean_pinball_loss"]),
            float(item[1]["candidate"]["q50_return_mae"]),
            -float(item[1]["candidate"]["direction_accuracy"]),
        ),
    )
    selected_pinball = float(
        selected_metrics["candidate"]["mean_pinball_loss"]
    )
    improved = (
        selected_profile != "close_only"
        and selected_pinball < float(close_pinball)
    )
    return {
        "selected_profile": selected_profile,
        "additional_covariates_improved_holdout": improved,
        "selection_policy": (
            "minimum_mean_pinball_loss_with_q50_mae_1pct_direction_0.1pp_"
            "median_return_10bp_non_regression_guards/v1"
        ),
        "close_only_mean_pinball_loss": close_pinball,
        "selected_mean_pinball_loss": selected_pinball,
        "mean_pinball_loss_improvement_ratio": (
            (float(close_pinball) - selected_pinball) / float(close_pinball)
            if float(close_pinball) > 0
            else 0
        ),
        "guard_thresholds": guard_thresholds,
        "candidate_evaluations": evaluations,
        "automatic_live_promotion": False,
    }


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
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    args = arguments()
    profile_results: dict[str, Any] = {}
    for profile in PROFILES:
        batch = batch_view(args.run_dir, profile)
        profile_results[profile] = {
            "batch_sweep": batch,
            "optimization": stage_view(
                args.run_dir,
                profile,
                int(batch["selected_variate_batch_size"]),
            ),
        }
    result: dict[str, Any] = {
        "schema_version": "chronos2-p40-qualification-summary/v1",
        "status": "selection_ready",
        "profiles": profile_results,
        "fixed_conditions": {
            "gpu": "Tesla P40",
            "power_cap_watts": 160,
            "dtype": "float32",
            "cross_learning": False,
            "context_bars": 512,
            "cadence_seconds": 60,
            "batch_candidates": list(BATCHES),
            "tensorrt": "unavailable_operator_deleted",
        },
    }
    if not args.selection_only:
        comparisons = {
            profile: metrics
            for profile in PROFILES
            if (
                value := read_object(
                    args.run_dir / "comparisons" / f"{profile}.json"
                )
            )
            is not None
            and (metrics := comparison_metrics(value)) is not None
        }
        result["status"] = (
            "completed" if len(comparisons) == len(PROFILES) else "incomplete"
        )
        result["model_comparisons"] = comparisons
        result["profile_selection"] = choose_profile(comparisons)
    atomic_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
