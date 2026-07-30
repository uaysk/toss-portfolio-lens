from __future__ import annotations

import numpy as np

from portfolio_ai_worker.raw_benchmark import (
    numerical_gate,
    select_batch_candidate,
)


def _candidate(batch: int, throughput: float, p95: float, *, status: str = "passed"):
    return {
        "status": status,
        "batch_size": batch,
        "memory": {"headroom_passed": True},
        "timing": {
            "series_per_second": {"median": throughput},
            "wall_ms": {"p95": p95},
        },
    }


def test_batch_selection_applies_three_percent_p95_and_small_batch_tiebreaks() -> None:
    results = [
        _candidate(16, 100, 180),
        _candidate(24, 102, 170),
        _candidate(32, 103, 190),
        _candidate(48, 120, 500, status="rejected"),
    ]
    assert select_batch_candidate(results)["batch_size"] == 24

    tied = [
        _candidate(16, 100, 170),
        _candidate(24, 100, 170),
    ]
    assert select_batch_candidate(tied)["batch_size"] == 16


def test_numerical_gate_accepts_exact_output_and_rejects_direction_drift() -> None:
    contexts = np.full((2, 512), 100, dtype=np.float32)
    reference = np.empty((2, 4, 10), dtype=np.float32)
    reference[..., 0] = 101
    reference[..., 1:] = np.asarray(
        [98, 99, 99.5, 100, 101, 102, 103, 104, 105],
        dtype=np.float32,
    )
    exact = numerical_gate(reference, reference.copy(), contexts)
    assert exact["passed"] is True

    drifted = reference.copy()
    drifted[..., 5] = 99.75
    drifted[..., 1:] = np.sort(drifted[..., 1:], axis=-1)
    rejected = numerical_gate(reference, drifted, contexts)
    assert rejected["passed"] is False
    assert rejected["direction_match_rate"] < 0.99
