#!/usr/bin/env python3
"""Extract the bounded dashboard metrics from Chronos-2 result artifacts."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
from typing import Any


def read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--eta", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def atomic(path: Path, value: object) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
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
    args = arguments()
    summary = read(args.summary)
    selection = summary.get("profile_selection")
    metrics: dict[str, Any] = {}
    if isinstance(selection, dict):
        profile = selection.get("selected_profile")
        metrics["selectedProfile"] = profile if isinstance(profile, str) else None
        improved = selection.get("additional_covariates_improved_holdout")
        metrics["additionalCovariatesImprovedHoldout"] = (
            improved if isinstance(improved, bool) else None
        )
        profiles = summary.get("profiles")
        if isinstance(profile, str) and isinstance(profiles, dict):
            selected = profiles.get(profile)
            if isinstance(selected, dict):
                batch = selected.get("batch_sweep")
                optimization = selected.get("optimization")
                if isinstance(batch, dict):
                    value = batch.get("selected_variate_batch_size")
                    metrics["selectedBatchSize"] = value if isinstance(value, int) else None
                if isinstance(optimization, dict):
                    value = optimization.get("selected_backend")
                    metrics["selectedBackend"] = value if isinstance(value, str) else None
        comparisons = summary.get("model_comparisons")
        if isinstance(profile, str) and isinstance(comparisons, dict):
            model = comparisons.get(profile)
            if isinstance(model, dict):
                reference = model.get("reference")
                candidate = model.get("candidate")
                if isinstance(reference, dict):
                    metrics["fincastDirectionAccuracy"] = reference.get(
                        "direction_accuracy"
                    )
                    metrics["fincastMedianPolicyReturn"] = reference.get(
                        "median_policy_total_return"
                    )
                if isinstance(candidate, dict):
                    metrics["chronos2DirectionAccuracy"] = candidate.get(
                        "direction_accuracy"
                    )
                    metrics["chronos2MedianPolicyReturn"] = candidate.get(
                        "median_policy_total_return"
                    )
    if args.eta is not None:
        eta = read(args.eta).get("full")
        if isinstance(eta, dict):
            metrics["estimatedFullDurationMs"] = eta.get("estimated_duration_ms")
            metrics["estimatedFullDurationUpperMs"] = eta.get(
                "estimated_duration_upper_ms"
            )
    atomic(args.output, metrics)
    print(json.dumps(metrics, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
