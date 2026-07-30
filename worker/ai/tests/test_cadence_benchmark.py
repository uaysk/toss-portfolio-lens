from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from portfolio_ai_worker.cadence_benchmark import (
    Trade,
    aggregate_trades,
    asof_indices,
    cadence_close_time_ms,
    contiguous_origin_times,
    context_slice,
    fold_candles,
    prediction_steps,
)


def sample_trades() -> tuple[Trade, ...]:
    return (
        Trade(1_704_067_199_100, 100, 1, 1, 1, False),
        Trade(1_704_067_199_900, 101, 2, 2, 3, True),
        Trade(1_704_067_200_100, 102, 3, 4, 4, False),
        Trade(1_704_067_204_900, 103, 4, 5, 6, False),
        # The following observed second starts after a genuine empty 5s bin.
        Trade(1_704_067_210_100, 104, 5, 7, 7, True),
    )


def test_trade_aggregation_and_utc_boundaries_are_exact() -> None:
    seconds = aggregate_trades(sample_trades(), 1)

    assert seconds.close_time_ms.tolist()[:3] == [
        1_704_067_199_999,
        1_704_067_200_999,
        1_704_067_204_999,
    ]
    assert seconds.open.tolist() == [100, 102, 103, 104]
    assert seconds.close.tolist() == [101, 102, 103, 104]
    assert seconds.volume.tolist() == [3, 3, 4, 5]
    assert seconds.trade_count.tolist() == [3, 1, 2, 1]
    assert cadence_close_time_ms(1_704_067_199_999, 60) == 1_704_067_199_999
    assert cadence_close_time_ms(1_704_067_200_000, 60) == 1_704_067_259_999


@pytest.mark.parametrize("cadence", [5, 15, 30, 60])
def test_all_cadences_fold_from_the_same_one_second_source(cadence: int) -> None:
    seconds = aggregate_trades(sample_trades(), 1)
    folded = fold_candles(seconds, cadence)

    assert folded.volume.sum() == pytest.approx(seconds.volume.sum())
    assert folded.amount.sum() == pytest.approx(seconds.amount.sum())
    assert folded.trade_count.sum() == seconds.trade_count.sum()
    assert np.all((folded.close_time_ms + 1) % (cadence * 1_000) == 0)


def test_empty_candles_are_not_interpolated_and_context_rejects_gap() -> None:
    folded = fold_candles(aggregate_trades(sample_trades(), 1), 5)

    assert len(folded) == 3
    assert np.diff(folded.close_time_ms).tolist() == [5_000, 10_000]
    with pytest.raises(ValueError, match="genuinely empty"):
        context_slice(
            folded.close_time_ms,
            int(folded.close_time_ms[-1]),
            3,
            5,
        )


def test_context_slice_never_reads_after_the_decision_origin() -> None:
    times = np.arange(999, 20_000, 1_000, dtype=np.int64)
    section = context_slice(times, 9_999, 4, 1)

    assert times[section].tolist() == [6_999, 7_999, 8_999, 9_999]
    assert int(times[section][-1]) <= 9_999
    with pytest.raises(ValueError, match="origin"):
        context_slice(times, 10_500, 4, 1)


def test_contiguous_origin_times_excludes_windows_crossing_real_gaps() -> None:
    times = np.asarray(
        [
            4_999,
            9_999,
            14_999,
            19_999,
            24_999,
            # 29_999 is a genuinely empty 5-second interval.
            34_999,
            39_999,
            44_999,
        ],
        dtype=np.int64,
    )

    assert contiguous_origin_times(
        times,
        3,
        5,
        origin_interval_seconds=15,
    ).tolist() == [14_999, 44_999]


def test_horizon_step_conversion_has_no_silent_truncation() -> None:
    assert {cadence: prediction_steps(cadence) for cadence in (60, 30, 15, 5)} == {60: 60, 30: 120, 15: 240, 5: 720}


def test_asof_join_uses_only_observation_at_or_before_decision() -> None:
    observations = np.asarray([1_000, 3_000, 7_000], dtype=np.int64)
    decisions = np.asarray([500, 1_000, 2_999, 3_000, 6_999], dtype=np.int64)

    assert asof_indices(observations, decisions).tolist() == [-1, 0, 0, 1, 1]


def test_completed_phase_is_skipped_after_resume(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[3] / "scripts" / "cadence-context-3w.py"
    specification = importlib.util.spec_from_file_location(
        "cadence_context_3w",
        script,
    )
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    start = datetime(2026, 7, 6, tzinfo=timezone.utc)
    end = datetime(2026, 7, 27, tzinfo=timezone.utc)
    state = module.PipelineState(
        tmp_path,
        run_id="resume-test",
        evaluation_start=start,
        evaluation_end=end,
    )
    assert state.begin_phase("prepare")
    state.complete_phase("prepare", "done")

    resumed = module.PipelineState(
        tmp_path,
        run_id="resume-test",
        evaluation_start=start,
        evaluation_end=end,
    )
    assert resumed.begin_phase("prepare") is False


def test_skipped_phases_count_toward_terminal_progress(tmp_path: Path) -> None:
    module = load_pipeline_module("cadence_context_skipped_progress")
    state = module.PipelineState(
        tmp_path,
        run_id="skipped-progress-test",
        evaluation_start=datetime(2026, 7, 6, tzinfo=timezone.utc),
        evaluation_end=datetime(2026, 7, 27, tzinfo=timezone.utc),
    )
    for step in state.value["steps"]:
        step["status"] = "skipped"
    state.save()

    assert state.value["progress"]["percent"] == 100
    assert state.value["progress"]["skippedSteps"] == len(state.value["steps"])


def test_failed_run_resume_archives_marker_and_clears_terminal_state(
    tmp_path: Path,
) -> None:
    script = Path(__file__).resolve().parents[3] / "scripts" / "cadence-context-3w.py"
    specification = importlib.util.spec_from_file_location(
        "cadence_context_3w_resume",
        script,
    )
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    start = datetime(2026, 7, 6, tzinfo=timezone.utc)
    end = datetime(2026, 7, 27, tzinfo=timezone.utc)
    state = module.PipelineState(
        tmp_path,
        run_id="failed-resume-test",
        evaluation_start=start,
        evaluation_end=end,
    )
    state.start()
    assert state.begin_phase("full-test")
    state.fail(ValueError("expected failure"))
    assert (tmp_path / "FAILED").is_file()

    resumed = module.PipelineState(
        tmp_path,
        run_id="failed-resume-test",
        evaluation_start=start,
        evaluation_end=end,
    )
    resumed.start()

    assert resumed.value["status"] == "running"
    assert resumed.value["resumeCount"] == 1
    assert "finishedAt" not in resumed.value
    assert not (tmp_path / "FAILED").exists()
    archived = list((tmp_path / "failures").glob("FAILED-*.json"))
    assert len(archived) == 1
    assert json.loads(archived[0].read_text(encoding="utf-8"))["error"] == ("ValueError: expected failure")


def test_missing_realized_target_is_unavailable_without_aborting_combination(
    tmp_path: Path,
) -> None:
    script = Path(__file__).resolve().parents[3] / "scripts" / "cadence-context-3w.py"
    specification = importlib.util.spec_from_file_location(
        "cadence_context_3w_gap",
        script,
    )
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    start = datetime(2026, 7, 6, tzinfo=timezone.utc)
    end = datetime(2026, 7, 27, tzinfo=timezone.utc)
    state = module.PipelineState(
        tmp_path / "run",
        run_id="target-gap-test",
        evaluation_start=start,
        evaluation_end=end,
    )
    combination = state.combination("fincast-c512-s5")
    origin_ms = int(datetime(2026, 7, 24, 21, 29, 59, 999000, tzinfo=timezone.utc).timestamp() * 1_000)

    class Repository:
        def bars(
            self,
            symbol: str,
            cadence: int,
            origin: int,
            context: int,
        ) -> tuple[list[dict[str, Any]], float, None]:
            del symbol, cadence, origin, context
            return [{"timestamp": module.iso_ms(origin_ms), "close": 100.0}], 100.0, None

        def value_at(
            self,
            symbol: str,
            cadence: int,
            timestamp_ms: int,
        ) -> float:
            del cadence
            if symbol == "ETHUSDT" and timestamp_ms == origin_ms + 5 * 60_000:
                raise ValueError("realized target candle is unavailable")
            return 101.0

    class Client:
        calls = 0

        def request(self, payload: dict[str, Any]) -> dict[str, Any]:
            self.calls += 1
            origin = int(module.from_iso(payload["series"][0]["input_end_at"]).timestamp() * 1_000)
            quantiles = [{"quantile": quantile, "value": (quantile - 0.5) / 100} for quantile in module.FIXED_QUANTILES]
            return {
                "status": "available",
                "model": {
                    "model_id": module.MODEL_IDS["fincast"],
                    "model_revision": module.FINCAST_REVISION,
                },
                "series": [
                    {
                        "status": "available",
                        "horizons": [
                            {
                                "horizon_minutes": minutes,
                                "target_timestamp": module.iso_ms(origin + minutes * 60_000),
                                "return_quantiles": quantiles,
                                "native_return_quantiles": quantiles,
                            }
                            for minutes in module.EVALUATION_HORIZONS_MINUTES
                        ],
                    }
                ],
            }

    client = Client()
    summary = module.run_combination(
        state,
        Repository(),
        client,
        combination,
        [(origin_ms, None)],
        tmp_path / "results",
    )

    records = module.read_jsonl(tmp_path / "results" / "predictions.jsonl")
    missing = [record for record in records if record["symbol"] == "ETHUSDT" and record["horizonMinutes"] == 5]
    assert client.calls == 2
    assert summary["recordCount"] == 8
    assert summary["availableRatio"] == pytest.approx(7 / 8)
    assert len(missing) == 1
    assert missing[0]["status"] == "unavailable"
    assert "no interpolation" in missing[0]["reason"]
    assert missing[0]["returnQuantiles"]
    checkpoint = json.loads((tmp_path / "results" / "checkpoint.json").read_text(encoding="utf-8"))
    assert checkpoint["schemaVersion"] == "cadence-context-checkpoint/v2"
    assert checkpoint["completedTaskCount"] == 2
    assert checkpoint["lastCompletedTaskKey"] == f"ETHUSDT|{origin_ms}"
    assert "completedTasks" not in checkpoint


def test_chronos_runner_batches_four_tasks_and_preserves_series_alignment(
    tmp_path: Path,
) -> None:
    module = load_pipeline_module("cadence_context_chronos_batch")
    start = datetime(2026, 7, 6, tzinfo=timezone.utc)
    end = datetime(2026, 7, 27, tzinfo=timezone.utc)
    state = module.PipelineState(
        tmp_path / "run",
        run_id="chronos-batch-test",
        evaluation_start=start,
        evaluation_end=end,
    )
    combination = state.combination("chronos2-c2048-s30")
    first_origin = int(
        datetime(
            2026,
            7,
            24,
            21,
            29,
            59,
            999000,
            tzinfo=timezone.utc,
        ).timestamp()
        * 1_000
    )
    origin_values = [
        (first_origin, None),
        (first_origin + 15 * 60_000, None),
    ]

    class Repository:
        def bars(
            self,
            symbol: str,
            cadence: int,
            origin: int,
            context: int,
        ) -> tuple[list[dict[str, Any]], float, None]:
            del symbol, cadence, context
            return [
                {"timestamp": module.iso_ms(origin), "close": 100.0}
            ], 100.0, None

        def value_at(
            self,
            symbol: str,
            cadence: int,
            timestamp_ms: int,
        ) -> float:
            del symbol, cadence
            return 100 + (timestamp_ms - first_origin) / 60_000_000

    class Client:
        calls = 0
        batch_keys: list[str] = []

        def request(self, payload: dict[str, Any]) -> dict[str, Any]:
            self.calls += 1
            self.batch_keys = [
                str(item["instrument_key"]) for item in payload["series"]
            ]
            quantiles = [
                {
                    "quantile": quantile,
                    "value": (quantile - 0.5) / 100,
                }
                for quantile in module.FIXED_QUANTILES
            ]
            return {
                "status": "available",
                "model": {
                    "model_id": module.MODEL_IDS["chronos-2"],
                    "model_revision": module.CHRONOS2_MODEL_REVISION,
                },
                "series": [
                    {
                        "instrument_key": item["instrument_key"],
                        "status": "available",
                        "horizons": [
                            {
                                "horizon_minutes": minutes,
                                "target_timestamp": module.iso_ms(
                                    int(
                                        module.from_iso(
                                            item["input_end_at"]
                                        ).timestamp()
                                        * 1_000
                                    )
                                    + minutes * 60_000
                                ),
                                "return_quantiles": quantiles,
                                "native_return_quantiles": quantiles,
                            }
                            for minutes in module.EVALUATION_HORIZONS_MINUTES
                        ],
                    }
                    for item in payload["series"]
                ],
            }

    client = Client()
    summary = module.run_combination(
        state,
        Repository(),
        client,
        combination,
        origin_values,
        tmp_path / "results",
    )

    assert client.calls == 1
    assert len(client.batch_keys) == 4
    assert len(set(client.batch_keys)) == 4
    assert summary["recordCount"] == 16
    assert summary["execution"]["taskBatchSize"] == 4
    records = module.read_jsonl(
        tmp_path / "results" / "predictions.jsonl"
    )
    assert {record["inferenceBatchSize"] for record in records} == {4}
    checkpoint = json.loads(
        (tmp_path / "results" / "checkpoint.json").read_text(
            encoding="utf-8"
        )
    )
    assert checkpoint["completedTaskCount"] == 4
    assert checkpoint["executionOptimizationVersion"] == (
        module.EXECUTION_OPTIMIZATION_VERSION
    )
    summary_text = (
        tmp_path / "results" / "summary.json"
    ).read_text(encoding="utf-8")
    resumed = module.run_combination(
        state,
        Repository(),
        client,
        combination,
        origin_values,
        tmp_path / "results",
    )
    assert client.calls == 1
    assert resumed == summary
    assert (
        tmp_path / "results" / "summary.json"
    ).read_text(encoding="utf-8") == summary_text


def test_incremental_metrics_match_full_recomputation() -> None:
    module = load_pipeline_module("cadence_context_incremental_metrics")
    records: list[dict[str, Any]] = []
    base_origin = datetime(2026, 7, 24, tzinfo=timezone.utc)
    for origin_index in range(4):
        origin = base_origin.replace(hour=origin_index)
        for symbol_index, symbol in enumerate(module.SYMBOLS):
            actual = (
                0.008 + origin_index * 0.001
                if symbol_index == 0
                else -0.007 - origin_index * 0.0005
            )
            for horizon in module.EVALUATION_HORIZONS_MINUTES:
                center = actual * (0.8 + horizon / 300)
                quantiles = {
                    str(quantile): center + (quantile - 0.5) * 0.04
                    for quantile in module.FIXED_QUANTILES
                }
                records.append(
                    {
                        "status": "available",
                        "executionStatus": "available",
                        "symbol": symbol,
                        "origin": module.iso(origin),
                        "horizonMinutes": horizon,
                        "returnQuantiles": quantiles,
                        "actualReturn": actual,
                        "originClose": 100.0,
                        "nextBarClose": 100.0,
                        "targetClose": 100.0 * (1 + actual),
                        "fundingRate": 0.0,
                    }
                )

    accumulator = module.PartialMetricsAccumulator()
    midpoint = len(records) // 2
    accumulator.add(records[:midpoint])
    accumulator.add(records[midpoint:])
    incremental = accumulator.summary()

    assert incremental["prediction"] == pytest.approx(
        module.summarize_prediction_records(records)
    )
    for scale, key in (
        (1.0, "base"),
        (1.5, "spreadSlippage1_5x"),
        (2.0, "spreadSlippage2x"),
    ):
        assert incremental["costStress"][key] == pytest.approx(
            module.trading_metrics(records, cost_scale=scale)
        )


def load_pipeline_module(name: str) -> Any:
    script = Path(__file__).resolve().parents[3] / "scripts" / "cadence-context-3w.py"
    specification = importlib.util.spec_from_file_location(name, script)
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def screening_summary(
    *,
    wis: float,
    pinball: float,
    direction: float,
    net_return: float,
    sharpe: float,
    max_drawdown: float = 0.05,
    latency_ms: float = 100,
) -> dict[str, Any]:
    prediction = {
        "count": 100,
        "wis": wis,
        "meanPinballLoss": pinball,
        "directionAccuracy": direction,
    }
    trading = {
        "netReturn": net_return,
        "sharpe": sharpe,
        "maxDrawdown": max_drawdown,
    }
    return {
        "availableRatio": 1,
        "prediction": prediction,
        "trading": trading,
        "execution": {"latencyP95Ms": latency_ms},
        "predictionByHorizon": {str(horizon): dict(prediction) for horizon in (5, 15, 30, 60)},
        "byScreeningWindow": {
            regime: {
                "prediction": dict(prediction),
                "trading": dict(trading),
            }
            for regime in ("low", "medium", "high")
        },
    }


def test_reduced_matrix_has_ten_defaults_seven_conditional_and_three_static() -> None:
    module = load_pipeline_module("cadence_context_reduced_matrix")
    values = module.combinations()

    assert len(values) == 20
    assert sum(item["planRole"] == "default" for item in values) == 10
    assert sum(item["planRole"] == "conditional" for item in values) == 7
    assert sum(item["planRole"] in {"excluded", "followup_only"} for item in values) == 3
    followup = next(item for item in values if item["id"] == "chronos2-c8192-s5")
    assert followup["status"] == "followup_only"
    assert followup["smokeStatus"] == "not_run"
    assert "chronos2-c8192-s5" not in module.SMOKE_COMBINATION_IDS
    assert tuple(module.DEFAULT_FINAL_COMBINATION_IDS) == (
        "fincast-c512-s60",
        "fincast-c512-s30",
        "fincast-c512-s15",
        "chronos2-c1024-s60",
        "chronos2-c1024-s30",
        "chronos2-c1024-s15",
        "chronos2-c2048-s60",
        "chronos2-c2048-s30",
        "chronos2-c4096-s60",
        "chronos2-c4096-s15",
    )


def test_common_screening_gate_requires_two_windows_and_two_horizons() -> None:
    module = load_pipeline_module("cadence_context_common_gate")
    comparator = screening_summary(
        wis=1,
        pinball=1,
        direction=0.52,
        net_return=0.01,
        sharpe=0.4,
    )
    candidate = screening_summary(
        wis=0.98,
        pinball=0.98,
        direction=0.521,
        net_return=0.011,
        sharpe=0.42,
    )

    result = module.common_screening_gate(candidate, comparator)

    assert result["decision"] == "passed"
    assert result["thresholdEvidence"]["predictionImprovedWindows"] == 3
    assert result["thresholdEvidence"]["predictionImprovedHorizons"] == 4


def test_five_second_gate_rejects_single_window_only_improvement() -> None:
    module = load_pipeline_module("cadence_context_five_second_gate")
    comparator = screening_summary(
        wis=1,
        pinball=1,
        direction=0.52,
        net_return=0.01,
        sharpe=0.4,
    )
    candidate = screening_summary(
        wis=0.98,
        pinball=0.98,
        direction=0.526,
        net_return=0.011,
        sharpe=0.52,
    )
    for regime in ("medium", "high"):
        candidate["byScreeningWindow"][regime] = comparator["byScreeningWindow"][regime]

    result = module.five_second_screening_gate(candidate, comparator)

    assert result["decision"] == "excluded"
    assert result["include"] is False


def test_selected_plan_decisions_never_auto_select_static_exclusions(
    tmp_path: Path,
) -> None:
    module = load_pipeline_module("cadence_context_selected_plan")
    state = module.PipelineState(
        tmp_path,
        run_id="selected-plan-test",
        evaluation_start=datetime(2026, 7, 6, tzinfo=timezone.utc),
        evaluation_end=datetime(2026, 7, 27, tzinfo=timezone.utc),
    )
    metrics = {
        combination_id: screening_summary(
            wis=1,
            pinball=1,
            direction=0.52,
            net_return=0.01,
            sharpe=0.4,
        )
        for combination_id in module.DEFAULT_FINAL_COMBINATION_IDS
    }
    for combination_id in module.CONDITIONAL_COMBINATION_IDS:
        value = state.combination(combination_id)
        value["screeningStatus"] = "dependency_failed" if value["dependencyIds"] else "not_triggered"
        value["screeningReason"] = "test trigger exclusion"

    decisions, selected, followups = module.build_screening_decisions(
        state,
        metrics,
    )

    assert selected == list(module.DEFAULT_FINAL_COMBINATION_IDS)
    assert followups == []
    decisions_by_id = {item["combinationId"]: item for item in decisions}
    assert decisions_by_id["fincast-c512-s5"]["decision"] == "exclude"
    assert decisions_by_id["chronos2-c8192-s5"]["decision"] == "followup_only"
    assert "chronos2-c8192-s5" not in selected


def test_five_second_dependency_only_triggers_after_clear_pass() -> None:
    module = load_pipeline_module("cadence_context_dependency")

    failed = module.conditional_trigger(
        "chronos2-c4096-s5",
        {},
        {"chronos2-c2048-s5": {"decision": "borderline"}},
    )
    passed = module.conditional_trigger(
        "chronos2-c4096-s5",
        {},
        {"chronos2-c2048-s5": {"decision": "passed"}},
    )

    assert failed[0] is False
    assert "dependency_failed" in failed[1]
    assert passed[0] is True
