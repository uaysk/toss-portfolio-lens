from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from portfolio_ai_worker.contracts import (
    AI_REQUEST_ADAPTER,
    CostAssumptions,
    EvaluateRequest,
    EvaluationOrigin,
    EvaluationSeries,
    ForecastRequest,
    ForecastSeries,
    ModelProvenance,
    PriceBar,
    QuantileRearrangementObservations,
    SeriesCadence,
    TargetStopSpec,
)

from .helpers import bars, future


def valid_series(key: str = "KRX:005930") -> ForecastSeries:
    history = bars(80)
    return ForecastSeries(
        instrument_key=key,
        timezone="Asia/Seoul",
        input_end_at=history[-1].timestamp,
        future_timestamps=future(history[-1].timestamp),
        bars=history,
    )


def test_versioned_request_round_trips_through_strict_json_contract() -> None:
    request = ForecastRequest(
        schema_version="scalping-ai/v1",
        request_id="contract-1",
        mode="forecast",
        series=(valid_series(),),
    )
    parsed = AI_REQUEST_ADAPTER.validate_json(request.model_dump_json())
    assert parsed == request
    assert parsed.horizons_minutes == (5, 15, 30, 60)
    assert parsed.quantiles == (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)


def test_realtime_forecast_profile_is_explicit_and_bounded_to_fifteen_minutes() -> None:
    full = valid_series()
    realtime = full.model_copy(
        update={"future_timestamps": future(full.input_end_at, 15)}
    )
    request = ForecastRequest(
        schema_version="scalping-ai/v1",
        request_id="contract-realtime",
        mode="forecast",
        forecast_profile="realtime_5_15",
        horizons_minutes=(5, 15),
        series=(realtime,),
    )

    parsed = AI_REQUEST_ADAPTER.validate_json(request.model_dump_json())

    assert parsed == request
    assert parsed.forecast_profile == "realtime_5_15"
    assert len(parsed.series[0].future_timestamps) == 15

    with pytest.raises(ValidationError, match="requires exactly 15"):
        ForecastRequest(
            schema_version="scalping-ai/v1",
            request_id="contract-realtime-full-data",
            mode="forecast",
            forecast_profile="realtime_5_15",
            horizons_minutes=(5, 15),
            series=(full,),
        )
    with pytest.raises(ValidationError, match="requires horizons_minutes"):
        ForecastRequest(
            schema_version="scalping-ai/v1",
            request_id="contract-realtime-full-horizons",
            mode="forecast",
            forecast_profile="realtime_5_15",
            series=(realtime,),
        )


def test_stock_fincast_cadence_round_trips_as_explicit_prevalidated_policy() -> None:
    series = valid_series().model_copy(
        update={
            "input_cadence": SeriesCadence(
                candle_seconds=60,
                gap_policy="market_session_prevalidated",
            )
        }
    )
    request = ForecastRequest(
        schema_version="scalping-ai/v1",
        request_id="stock-fincast-cadence",
        mode="forecast",
        series=(series,),
    )

    parsed = AI_REQUEST_ADAPTER.validate_json(request.model_dump_json())

    assert parsed.series[0].input_cadence == SeriesCadence(
        candle_seconds=60,
        gap_policy="market_session_prevalidated",
    )
    with pytest.raises(ValidationError, match="one-minute candles"):
        SeriesCadence(
            candle_seconds=30,
            gap_policy="market_session_prevalidated",
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("horizons_minutes", (1, 5, 15, 30)),
        ("quantiles", (0.1, 0.5, 0.9)),
        ("schema_version", "scalping-ai/v2"),
    ],
)
def test_fixed_contract_fields_reject_drift(field: str, value: object) -> None:
    values = {
        "schema_version": "scalping-ai/v1",
        "request_id": "contract-invalid",
        "mode": "forecast",
        "series": (valid_series(),),
        field: value,
    }
    with pytest.raises(ValidationError):
        ForecastRequest(**values)


def test_bars_must_be_aware_sorted_complete_and_end_at_input_boundary() -> None:
    history = bars(80)
    common = dict(
        instrument_key="KRX:000660",
        timezone="Asia/Seoul",
        input_end_at=history[-1].timestamp,
        future_timestamps=future(history[-1].timestamp),
    )
    with pytest.raises(ValidationError, match="strictly increasing"):
        ForecastSeries(**common, bars=tuple(reversed(history)))
    with pytest.raises(ValidationError, match="final complete bar"):
        ForecastSeries(**common, bars=history[:-1])
    with pytest.raises(ValidationError, match="UTC offset"):
        PriceBar(
            timestamp=datetime(2025, 1, 2),
            open=100,
            high=101,
            low=99,
            close=100,
            complete=True,
        )


def test_unknown_wire_fields_are_rejected() -> None:
    request = ForecastRequest(
        schema_version="scalping-ai/v1",
        request_id="contract-extra",
        mode="forecast",
        series=(valid_series(),),
    )
    payload = request.model_dump_json()[:-1] + ',"surprise":true}'
    with pytest.raises(ValidationError, match="Extra inputs"):
        AI_REQUEST_ADAPTER.validate_json(payload)


def test_cuda_device_provenance_is_optional_for_legacy_but_atomic_when_present() -> None:
    common = {
        "model_id": "NeoQuasar/Kronos-base",
        "model_revision": "pinned",
        "source_revision": "pinned-loader",
        "loader_version": "kronos-source-test",
        "license": "MIT",
        "device": "cuda",
        "dtype": "float32",
        "attention_backend": "math",
        "loaded": True,
    }
    assert ModelProvenance(**common).device_name is None
    observed = ModelProvenance(
        **common,
        device_name="Tesla P40",
        cuda_capability="6.1",
    )
    assert (observed.device_name, observed.cuda_capability) == ("Tesla P40", "6.1")
    with pytest.raises(ValidationError, match="recorded together"):
        ModelProvenance(**common, device_name="Tesla P40")
    with pytest.raises(ValidationError, match="valid only"):
        ModelProvenance(
            **{
                **common,
                "device": "cpu",
                "device_name": "not-a-cuda-device",
                "cuda_capability": "6.1",
            }
        )


def test_fincast_provenance_carries_strict_bounded_rearrangement_observations() -> None:
    observations = QuantileRearrangementObservations(
        row_count=54_600,
        non_finite_value_count=0,
        crossing_row_count=11,
        crossing_adjacent_pair_count=14,
        adjusted_row_count=11,
        q50_adjustment_iqr_ratio_median=0.01,
        q50_adjustment_iqr_ratio_p95=0.04,
        q50_adjustment_iqr_ratio_max=0.08,
        postprocessed_monotonic=True,
    )
    common = {
        "model_id": "Vincent05R/FinCast",
        "model_revision": "pinned",
        "source_revision": "pinned-source",
        "loader_version": "fincast-source-test",
        "license": "Apache-2.0",
        "device": "cuda",
        "device_name": "Tesla P40",
        "cuda_capability": "6.1",
        "dtype": "float32",
        "attention_backend": "math",
        "loaded": True,
        "precision_validation": "fallback_fp32",
        "quantile_tail_policy": "tail_clamped_q10_q90",
        "quantile_monotonicity_policy": "fp32_monotone_rearrangement_v1",
    }

    with pytest.raises(ValidationError, match="FP32 quantile observations"):
        ModelProvenance(**common)

    provenance = ModelProvenance(
        **common,
        fp32_quantile_observations=observations,
        mixed_quantile_observations=observations,
    )
    assert provenance.fp32_quantile_observations == observations
    assert provenance.mixed_quantile_observations == observations
    assert set(observations.model_dump()) == {
        "row_count",
        "non_finite_value_count",
        "crossing_row_count",
        "crossing_adjacent_pair_count",
        "adjusted_row_count",
        "q50_adjustment_iqr_ratio_median",
        "q50_adjustment_iqr_ratio_p95",
        "q50_adjustment_iqr_ratio_max",
        "postprocessed_monotonic",
    }

    extra_nested_field = provenance.model_dump(mode="python")
    extra_nested_field["fp32_quantile_observations"]["unexpected"] = True
    with pytest.raises(ValidationError, match="Extra inputs"):
        ModelProvenance.model_validate(extra_nested_field)

    mixed_without_observations = {
        **common,
        "dtype": "mixed_float16",
        "precision_validation": "passed",
        "fp32_quantile_observations": observations,
    }
    with pytest.raises(ValidationError, match="mixed quantile observations"):
        ModelProvenance(**mixed_without_observations)

    kronos_with_observations = {
        **common,
        "model_id": "NeoQuasar/Kronos-base",
        "quantile_tail_policy": "native",
        "quantile_monotonicity_policy": "native",
        "fp32_quantile_observations": observations,
    }
    with pytest.raises(ValidationError, match="only for loaded FinCast"):
        ModelProvenance(**kronos_with_observations)


def test_naive_input_end_is_rejected() -> None:
    history = bars(80, start=datetime(2025, 1, 2, tzinfo=timezone.utc))
    with pytest.raises(ValidationError, match="UTC offset"):
        ForecastSeries(
            instrument_key="KRX:035420",
            timezone="Asia/Seoul",
            input_end_at=datetime(2025, 1, 2),
            future_timestamps=future(history[-1].timestamp),
            bars=history,
        )


def test_evaluation_rejects_cherry_picked_or_skipped_future_bars() -> None:
    history = bars(160)
    origin = history[79]
    skipped_next_bar = tuple(bar.timestamp for bar in history[81:141])
    with pytest.raises(ValidationError, match="consecutive bars immediately after origin"):
        EvaluationSeries(
            instrument_key="KRX:005930",
            timezone="Asia/Seoul",
            bars=history,
            origins=(
                EvaluationOrigin(
                    origin=origin.timestamp,
                    future_timestamps=skipped_next_bar,
                    technical_signal=1,
                ),
            ),
        )


def _native_bars(candle_seconds: int, count: int) -> tuple[PriceBar, ...]:
    start = datetime(2025, 1, 2, tzinfo=timezone.utc)
    return tuple(
        PriceBar(
            timestamp=start + timedelta(seconds=candle_seconds * index),
            open=100 + index / 1_000,
            high=101 + index / 1_000,
            low=99 + index / 1_000,
            close=100.5 + index / 1_000,
            volume=1_000 + index,
            amount=(1_000 + index) * (100.5 + index / 1_000),
            complete=True,
        )
        for index in range(count)
    )


@pytest.mark.parametrize("candle_seconds", [15, 30])
def test_native_evaluation_maps_exact_one_minute_outcomes(candle_seconds: int) -> None:
    steps_per_minute = 60 // candle_seconds
    history = _native_bars(candle_seconds, 512 + 60 * steps_per_minute)
    origin_index = 511
    origin = history[origin_index]
    future_timestamps = tuple(
        history[origin_index + minute * steps_per_minute].timestamp
        for minute in range(1, 61)
    )

    series = EvaluationSeries(
        instrument_key=f"BINANCE_USDM:NATIVE-{candle_seconds}",
        timezone="UTC",
        bars=history,
        input_cadence=SeriesCadence(
            candle_seconds=candle_seconds,
            gap_policy="continuous",
        ),
        origins=(
            EvaluationOrigin(
                origin=origin.timestamp,
                future_timestamps=future_timestamps,
            ),
        ),
    )

    assert series.origins[0].future_timestamps == tuple(
        origin.timestamp + timedelta(minutes=minute) for minute in range(1, 61)
    )

    consecutive_native = tuple(
        bar.timestamp for bar in history[origin_index + 1 : origin_index + 61]
    )
    payload = series.model_dump(mode="python")
    payload["origins"] = (
        EvaluationOrigin(
            origin=origin.timestamp,
            future_timestamps=consecutive_native,
        ),
    )
    with pytest.raises(ValidationError, match="exact one-minute outcomes"):
        EvaluationSeries.model_validate(payload)


@pytest.mark.parametrize("candle_seconds", [15, 30, 60])
def test_continuous_evaluation_rejects_missing_native_outcome_bar(
    candle_seconds: int,
) -> None:
    steps_per_minute = 60 // candle_seconds
    history = _native_bars(candle_seconds, 512 + 60 * steps_per_minute + 1)
    origin_index = 511
    origin = history[origin_index]
    future_timestamps = tuple(
        history[origin_index + minute * steps_per_minute].timestamp
        for minute in range(1, 61)
    )
    missing_native = (*history[: origin_index + 5], *history[origin_index + 6 :])

    with pytest.raises(ValidationError, match="declared native cadence"):
        EvaluationSeries(
            instrument_key=f"BINANCE_USDM:GAPPED-{candle_seconds}",
            timezone="UTC",
            bars=missing_native,
            input_cadence=SeriesCadence(
                candle_seconds=candle_seconds,
                gap_policy="continuous",
            ),
            origins=(
                EvaluationOrigin(
                    origin=origin.timestamp,
                    future_timestamps=future_timestamps,
                ),
            ),
        )


def test_evaluation_target_stop_is_anchored_to_origin_close() -> None:
    history = bars(160)
    origin = history[79]
    future_timestamps = tuple(bar.timestamp for bar in history[80:140])
    with pytest.raises(ValidationError, match="origin close"):
        EvaluateRequest(
            schema_version="scalping-ai/v1",
            request_id="tampered-target-stop",
            mode="evaluate",
            series=(
                EvaluationSeries(
                    instrument_key="KRX:005930",
                    timezone="Asia/Seoul",
                    bars=history,
                    origins=(
                        EvaluationOrigin(
                            origin=origin.timestamp,
                            future_timestamps=future_timestamps,
                            technical_signal=1,
                            target_stop=TargetStopSpec(
                                side="long",
                                stop_price=origin.close * 1.01,
                                target_price=origin.close * 1.02,
                            ),
                        ),
                    ),
                ),
            ),
            cost_assumptions=CostAssumptions(),
        )
