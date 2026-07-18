from __future__ import annotations

from datetime import date, timedelta

from portfolio_worker.optimization import DeterministicRng, build_walk_forward_windows, optimize_portfolio


def series(key: str, drift: float, phase: float) -> dict:
    value = 100.0
    points = []
    for index in range(90):
        import math

        value *= 1 + drift + math.sin(index / 5 + phase) * 0.004
        points.append({"date": (date(2024, 1, 1) + timedelta(days=index)).isoformat(), "value": value})
    return {"key": key, "label": key, "points": points}


def test_mulberry_rng_is_stable() -> None:
    rng = DeterministicRng(12345)
    assert [rng.next() for _ in range(3)] == [
        0.9797282677609473,
        0.3067522644996643,
        0.484205421525985,
    ]


def test_optimization_is_deterministic_and_respects_constraints() -> None:
    input_value = {
        "priceSeries": [series("A", 0.001, 0), series("B", 0.0005, 1), series("C", 0.0008, 2)],
        "constraints": {"minWeights": {"A": 0.2}, "maxWeights": {"A": 0.4}, "maxAssets": 3},
        "seed": 7,
        "candidateBudget": 25,
        "minimumSamples": 20,
    }
    first = optimize_portfolio(input_value, batch_size=16)
    second = optimize_portfolio(input_value, batch_size=16)
    assert first == second
    assert first["candidateCount"] > 0
    assert all(0.2 <= candidate["weights"].get("A", 0) <= 0.4 for candidate in first["candidates"])


def test_walk_forward_windows_do_not_overlap() -> None:
    windows = build_walk_forward_windows(
        30,
        {
            "trainWindow": 15,
            "testWindow": 5,
            "step": 5,
            "minimumTrainObservations": 10,
            "minimumTestObservations": 5,
        },
    )
    assert len(windows) == 3
    assert all(item["trainEndIndex"] < item["testStartIndex"] for item in windows)
