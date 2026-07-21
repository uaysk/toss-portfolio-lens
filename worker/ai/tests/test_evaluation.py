from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from portfolio_ai_worker.adapters import UnavailableAdapter
from portfolio_ai_worker.contracts import (
    CostAssumptions,
    EvaluateRequest,
    EvaluationOrigin,
    EvaluationRecord,
    EvaluationSeries,
    PriceBar,
    TargetStopBounds,
    TargetStopSpec,
)
from portfolio_ai_worker.evaluation import EvaluationObservation, build_evaluation_result
from portfolio_ai_worker.service import AIService, _predicted_first_passage

from .helpers import DeterministicAdapter, bars, provenance, settings


def _request(
    history,
    request_id: str = "evaluate-1",
    target_stop: TargetStopSpec | None = None,
) -> EvaluateRequest:
    origin_bar = history[79]
    future_timestamps = tuple(bar.timestamp for bar in history[80:140])
    return EvaluateRequest(
        schema_version="scalping-ai/v1",
        request_id=request_id,
        mode="evaluate",
        series=(
            EvaluationSeries(
                instrument_key="KRX:005930",
                timezone="Asia/Seoul",
                bars=history,
                origins=(
                    EvaluationOrigin(
                        origin=origin_bar.timestamp,
                        future_timestamps=future_timestamps,
                        technical_signal=1,
                        regime="trend",
                        target_stop=target_stop,
                    ),
                ),
            ),
        ),
        cost_assumptions=CostAssumptions(
            commission_bps_per_side=1,
            tax_bps_on_exit=2,
            spread_bps_round_trip=3,
            slippage_bps_per_side=4,
        ),
    )


def test_walk_forward_evaluation_is_causal_and_charges_next_bar_execution_costs(tmp_path) -> None:
    history = bars(160, drift=0.001)
    adapter = DeterministicAdapter()
    response = AIService(settings(tmp_path), adapter).handle(_request(history))
    assert response.status == "available"
    assert response.evaluation is not None
    assert response.evaluation.retrospective is True
    assert len(response.evaluation.records) == 4
    assert all(record.status == "available" for record in response.evaluation.records)
    assert all(item.bars[-1].timestamp <= history[79].timestamp for call in adapter.calls for item in call)
    metric = response.evaluation.metrics[0]
    assert metric.overall.count == 1
    assert metric.by_symbol["KRX:005930"].count == 1
    assert metric.by_regime["trend"].count == 1
    assert metric.strategy_comparison.technical_trade_count == 1
    assert metric.strategy_comparison.technical_net_return < response.evaluation.records[0].actual_return
    record = response.evaluation.records[0]
    assert tuple(item.quantile for item in record.predicted_quantiles) == (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)
    assert record.execution_return is not None
    assert record.round_trip_cost_rate == pytest.approx(0.0015)
    assert record.technical_net_return == pytest.approx(record.execution_return - record.round_trip_cost_rate)
    expected_filtered = record.technical_net_return if record.predicted_median_return > 0 else None
    assert record.ai_filtered_net_return == expected_filtered


def test_future_price_changes_cannot_change_forecast_at_same_origin(tmp_path) -> None:
    original = bars(160, drift=0.001)
    changed = tuple(
        bar
        if index <= 79
        else bar.model_copy(
            update={
                "open": bar.open * 1.2,
                "high": bar.high * 1.2,
                "low": bar.low * 1.2,
                "close": bar.close * 1.2,
            }
        )
        for index, bar in enumerate(original)
    )
    first = AIService(settings(tmp_path), DeterministicAdapter()).handle(_request(original, "causal-a"))
    second = AIService(settings(tmp_path), DeterministicAdapter()).handle(_request(changed, "causal-b"))
    assert first.series[0].horizons == second.series[0].horizons
    assert first.evaluation is not None and second.evaluation is not None
    assert first.evaluation.records[0].actual_return != second.evaluation.records[0].actual_return


def test_appending_bars_after_the_evaluation_window_changes_nothing(tmp_path) -> None:
    original = bars(160, drift=0.001)
    close = original[-1].close * 4
    appended = tuple(
        PriceBar(
            timestamp=original[-1].timestamp + timedelta(minutes=index),
            open=close,
            high=close * 1.01,
            low=close * 0.99,
            close=close,
            volume=10_000_000,
            amount=close * 10_000_000,
            complete=True,
        )
        for index in range(1, 21)
    )
    first = AIService(settings(tmp_path), DeterministicAdapter()).handle(_request(original, "append-a"))
    second = AIService(settings(tmp_path), DeterministicAdapter()).handle(_request((*original, *appended), "append-b"))
    assert first.series[0].horizons == second.series[0].horizons
    assert first.evaluation is not None and second.evaluation is not None
    assert first.evaluation.records == second.evaluation.records
    assert first.evaluation.metrics == second.evaluation.metrics


def test_strategy_uses_next_bar_open_and_each_configured_cost_side(tmp_path) -> None:
    history = list(bars(160, drift=0.001))
    next_bar = history[80]
    gapped_open = next_bar.open * 1.03
    history[80] = next_bar.model_copy(
        update={
            "open": gapped_open,
            "high": max(gapped_open, next_bar.close) * 1.001,
            "low": min(gapped_open, next_bar.close) * 0.999,
        }
    )
    request = _request(tuple(history), "next-open-costs")
    response = AIService(settings(tmp_path), DeterministicAdapter()).handle(request)
    assert response.evaluation is not None
    five_minute = response.evaluation.metrics[0].strategy_comparison
    raw_execution_return = history[84].close / gapped_open - 1
    # 1 bp commission and 4 bp slippage on each side, plus 2 bp exit tax
    # and a 3 bp round-trip spread: 15 bp in total.
    expected_net = raw_execution_return - 0.0015
    assert five_minute.technical_trade_count == 1
    assert five_minute.technical_net_return == pytest.approx(expected_net)
    first_record = response.evaluation.records[0]
    assert first_record.actual_return == pytest.approx(history[84].close / history[79].close - 1)
    assert first_record.execution_return == pytest.approx(raw_execution_return)
    assert first_record.round_trip_cost_rate == pytest.approx(0.0015)
    assert first_record.technical_net_return == pytest.approx(expected_net)
    assert five_minute.technical_net_return != pytest.approx(first_record.actual_return - 0.0015)


def test_model_unavailable_does_not_erase_technical_only_baseline(tmp_path) -> None:
    history = bars(160, drift=0.001)
    adapter = UnavailableAdapter(provenance(loaded=False), "MODEL_UNAVAILABLE", "offline model missing")
    origin_close = history[79].close
    response = AIService(settings(tmp_path), adapter).handle(
        _request(
            history,
            "baseline-without-model",
            TargetStopSpec(side="long", target_price=origin_close * 1.002, stop_price=origin_close * 0.98),
        )
    )
    assert response.status == "unavailable"
    assert response.evaluation is not None
    comparison = response.evaluation.metrics[0].strategy_comparison
    assert comparison.technical_trade_count == 1
    assert comparison.ai_filtered_trade_count == 0
    assert comparison.technical_net_return != 0
    assert comparison.ai_filtered_net_return == 0
    record = response.evaluation.records[0]
    assert record.status == "unavailable"
    assert record.actual_return is not None
    assert record.execution_return is not None
    assert record.round_trip_cost_rate == pytest.approx(0.0015)
    assert record.technical_net_return == pytest.approx(record.execution_return - record.round_trip_cost_rate)
    assert record.predicted_median_return is None
    assert record.predicted_quantiles == ()
    assert record.up_probability is None
    assert record.predicted_first_passage is None
    assert record.actual_first_passage == "target"
    assert record.ai_filtered_net_return is None


def test_predicted_first_passage_does_not_resolve_ohlc_ambiguity_optimistically() -> None:
    ambiguous = TargetStopBounds(
        status="available",
        target_first_probability_lower=0.4,
        target_first_probability_upper=0.9,
        stop_first_probability_lower=0.1,
        stop_first_probability_upper=0.6,
        ambiguous_probability=0.5,
        neither_probability=0,
    )
    decisive = TargetStopBounds(
        status="available",
        target_first_probability_lower=0.7,
        target_first_probability_upper=0.8,
        stop_first_probability_lower=0.1,
        stop_first_probability_upper=0.2,
        ambiguous_probability=0.1,
        neither_probability=0.1,
    )
    assert _predicted_first_passage(ambiguous) == "ambiguous"
    assert _predicted_first_passage(decisive) == "target"


def test_metrics_grouping_calibration_coverage_drawdown_and_trade_counts() -> None:
    first_origin = datetime(2025, 1, 2, 0, 0, tzinfo=timezone.utc)
    quantiles_up = {quantile: 0.01 for quantile in (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)}
    quantiles_down = {quantile: -0.01 for quantile in (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)}
    observations = (
        EvaluationObservation(
            instrument_key="KRX:A",
            origin=first_origin,
            local_hour="09",
            horizon_minutes=5,
            target_timestamp=first_origin + timedelta(minutes=5),
            technical_signal=1,
            regime="trend",
            unavailable=None,
            predicted_median_return=0.01,
            actual_return=0.02,
            up_probability=0.8,
            predicted_quantiles=quantiles_up,
            execution_return=0.02,
        ),
        EvaluationObservation(
            instrument_key="KRX:B",
            origin=first_origin + timedelta(minutes=1),
            local_hour="10",
            horizon_minutes=5,
            target_timestamp=first_origin + timedelta(minutes=6),
            technical_signal=1,
            regime="mean_reversion",
            unavailable=None,
            predicted_median_return=-0.01,
            actual_return=-0.02,
            up_probability=0.2,
            predicted_quantiles=quantiles_down,
            execution_return=-0.02,
        ),
    )
    costs = CostAssumptions(
        commission_bps_per_side=1,
        tax_bps_on_exit=2,
        spread_bps_round_trip=3,
        slippage_bps_per_side=4,
    )
    result = build_evaluation_result(observations, costs)
    metric = result.metrics[0]
    assert metric.overall.count == 2
    assert metric.overall.direction_accuracy == 1
    assert metric.overall.mae == pytest.approx(0.01)
    assert metric.overall.rmse == pytest.approx(0.01)
    assert metric.up_probability_brier == pytest.approx(0.04)
    assert metric.by_symbol["KRX:A"].count == 1
    assert metric.by_symbol["KRX:B"].count == 1
    assert metric.by_time["09"].count == 1
    assert metric.by_time["10"].count == 1
    assert metric.by_regime["trend"].count == 1
    assert metric.by_regime["mean_reversion"].count == 1
    assert next(item.value for item in metric.quantile_coverage if item.quantile == 0.5) == pytest.approx(0.5)
    assert sum(item.count for item in metric.calibration) == 2
    comparison = metric.strategy_comparison
    assert comparison.technical_trade_count == 2
    assert comparison.ai_filtered_trade_count == 1
    assert comparison.technical_net_return == pytest.approx((1 + 0.0185) * (1 - 0.0215) - 1)
    assert comparison.ai_filtered_net_return == pytest.approx(0.0185)
    assert comparison.technical_max_drawdown == pytest.approx(0.0215)
    assert comparison.ai_filtered_max_drawdown == 0
    records = [item for item in result.records if item.horizon_minutes == 5]
    expected_coverage = sum(
        item.actual_return <= next(value.value for value in item.predicted_quantiles if value.quantile == 0.5)
        for item in records
    ) / len(records)
    assert next(item.value for item in metric.quantile_coverage if item.quantile == 0.5) == expected_coverage
    assert comparison.technical_net_return == pytest.approx(
        (1 + records[0].technical_net_return) * (1 + records[1].technical_net_return) - 1
    )
    assert comparison.ai_filtered_net_return == pytest.approx(records[0].ai_filtered_net_return)


def test_short_signal_uses_next_open_return_direction_and_round_trip_cost() -> None:
    origin = datetime(2025, 1, 2, 0, 0, tzinfo=timezone.utc)
    quantiles = {quantile: -0.01 for quantile in (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)}
    observation = EvaluationObservation(
        instrument_key="KRX:SHORT",
        origin=origin,
        local_hour="09",
        horizon_minutes=5,
        target_timestamp=origin + timedelta(minutes=5),
        technical_signal=-1,
        regime="downtrend",
        unavailable=None,
        predicted_median_return=-0.01,
        actual_return=-0.02,
        up_probability=0.1,
        predicted_quantiles=quantiles,
        execution_return=-0.02,
    )
    costs = CostAssumptions(
        commission_bps_per_side=1,
        tax_bps_on_exit=2,
        spread_bps_round_trip=3,
        slippage_bps_per_side=4,
    )
    comparison = build_evaluation_result((observation,), costs).metrics[0].strategy_comparison
    assert comparison.technical_trade_count == 1
    assert comparison.ai_filtered_trade_count == 1
    assert comparison.technical_net_return == pytest.approx(0.02 - 0.0015)
    assert comparison.ai_filtered_net_return == pytest.approx(0.02 - 0.0015)


def test_first_passage_accuracy_excludes_unresolved_ohlc_order() -> None:
    origin = datetime(2025, 1, 2, 0, 0, tzinfo=timezone.utc)
    quantiles = {quantile: 0.01 for quantile in (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)}

    def observation(index: int, predicted: str, actual: str) -> EvaluationObservation:
        return EvaluationObservation(
            instrument_key=f"KRX:{index}",
            origin=origin + timedelta(minutes=index),
            local_hour="09",
            horizon_minutes=5,
            target_timestamp=origin + timedelta(minutes=index + 5),
            technical_signal=None,
            regime=None,
            unavailable=None,
            predicted_median_return=0.01,
            actual_return=0.01,
            up_probability=0.8,
            predicted_quantiles=quantiles,
            execution_return=0.01,
            predicted_first_passage=predicted,
            actual_first_passage=actual,
        )

    result = build_evaluation_result(
        (
            observation(0, "target", "target"),
            observation(1, "ambiguous", "target"),
            observation(2, "target", "ambiguous"),
        ),
        CostAssumptions(),
    )
    metric = result.metrics[0]
    assert metric.target_stop_first_count == 1
    assert metric.target_stop_first_accuracy == 1
    assert [(item.predicted_first_passage, item.actual_first_passage) for item in result.records] == [
        ("target", "target"),
        ("ambiguous", "target"),
        ("target", "ambiguous"),
    ]


def test_evaluation_record_rejects_prediction_or_strategy_status_drift(tmp_path) -> None:
    history = bars(160, drift=0.001)
    response = AIService(settings(tmp_path), DeterministicAdapter()).handle(_request(history, "strict-record"))
    assert response.evaluation is not None
    available = response.evaluation.records[0].model_dump()

    missing_quantiles = {**available, "predicted_quantiles": ()}
    with pytest.raises(ValidationError, match="require predictions and realized returns"):
        EvaluationRecord.model_validate(missing_quantiles)

    wrong_technical_net = {**available, "technical_net_return": available["technical_net_return"] + 0.01}
    with pytest.raises(ValidationError, match="technical net return"):
        EvaluationRecord.model_validate(wrong_technical_net)

    unavailable_with_prediction = {
        **available,
        "status": "unavailable",
        "unavailable": {"code": "MODEL_UNAVAILABLE", "message": "offline model missing"},
    }
    with pytest.raises(ValidationError, match="cannot contain model predictions"):
        EvaluationRecord.model_validate(unavailable_with_prediction)


def test_missing_actual_horizon_is_unavailable_not_invented(tmp_path) -> None:
    history = bars(140, drift=0.001)
    request = _request(history)
    truncated = request.model_copy(
        update={"series": (request.series[0].model_copy(update={"bars": request.series[0].bars[:-1]}),)}
    )
    response = AIService(settings(tmp_path), DeterministicAdapter()).handle(truncated)
    assert response.status == "partial"
    assert response.evaluation is not None
    record = next(item for item in response.evaluation.records if item.horizon_minutes == 60)
    assert record.status == "unavailable"
    assert record.unavailable is not None
    assert record.unavailable.code == "ACTUAL_UNAVAILABLE"
