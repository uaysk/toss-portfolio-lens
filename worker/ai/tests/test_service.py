from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Sequence

import pytest
from pydantic import ValidationError

from portfolio_ai_worker.adapters import (
    InferenceSeries,
    ProductionModelBinding,
    RawPrediction,
    UnavailableAdapter,
)
from portfolio_ai_worker.contracts import (
    ForecastRequest,
    ForecastSeries,
    ModelProvenance,
    ModelRun,
    PriceBar,
    QuantileRearrangementObservations,
    SeriesCadence,
)
from portfolio_ai_worker.service import AIService, _canonical_input_digest

from .helpers import (
    DeterministicAdapter,
    bars,
    fincast_provenance,
    future,
    provenance,
    settings,
)


def _series(key: str, count: int = 80) -> ForecastSeries:
    history = bars(count)
    return ForecastSeries(
        instrument_key=key,
        timezone="Asia/Seoul",
        input_end_at=history[-1].timestamp,
        future_timestamps=future(history[-1].timestamp),
        bars=history,
    )


def _native_series(
    key: str,
    candle_seconds: int,
    *,
    input_cadence: SeriesCadence | None = None,
) -> ForecastSeries:
    start = datetime(2025, 1, 2, tzinfo=timezone.utc)
    history = tuple(
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
        for index in range(512)
    )
    return ForecastSeries(
        instrument_key=key,
        timezone="UTC",
        input_end_at=history[-1].timestamp,
        future_timestamps=future(history[-1].timestamp),
        bars=history,
        input_cadence=input_cadence,
    )


class _CadenceFailingAdapter(DeterministicAdapter):
    def __init__(
        self,
        failing_candle_seconds: int,
        model_provenance: ModelProvenance | None = None,
    ) -> None:
        super().__init__(model_provenance)
        self.failing_candle_seconds = failing_candle_seconds
        self.attempts: list[tuple[InferenceSeries, ...]] = []

    def predict_batch(
        self,
        series: Sequence[InferenceSeries],
        *,
        seed: int,
    ) -> list[RawPrediction]:
        self.attempts.append(tuple(series))
        intervals = {
            int((item.bars[1].timestamp - item.bars[0].timestamp).total_seconds())
            for item in series
        }
        if len(intervals) != 1:
            raise RuntimeError("mixed cadence reached the adapter")
        if next(iter(intervals)) == self.failing_candle_seconds:
            raise RuntimeError("simulated cadence-specific failure")
        return super().predict_batch(series, seed=seed)


def _model(*, loaded: bool = True) -> ModelProvenance:
    return provenance(loaded=loaded)


def test_service_microbatches_and_returns_partial_unavailable_without_fabrication(tmp_path) -> None:
    adapter = DeterministicAdapter()
    service = AIService(settings(tmp_path), adapter)
    requested = tuple(_series(f"KRX:{index:06d}") for index in range(5)) + (_series("KRX:SHORT", 20),)
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="batch-1",
            mode="forecast",
            series=requested,
        )
    )
    assert response.status == "partial"
    assert [item.instrument_key for item in response.series] == [item.instrument_key for item in requested]
    assert len(adapter.calls) == 3
    assert all(len(call) <= 2 for call in adapter.calls)
    assert all(item.timezone == "Asia/Seoul" for call in adapter.calls for item in call)
    assert all(len(item.bars) == 80 for call in adapter.calls for item in call)
    assert response.series[-1].status == "unavailable"
    assert response.series[-1].unavailable is not None
    assert response.series[-1].unavailable.code == "INSUFFICIENT_HISTORY"


def test_chronos2_microbatching_remains_cadence_agnostic(tmp_path) -> None:
    adapter = DeterministicAdapter()
    service = AIService(
        settings(
            tmp_path,
            model_lane="chronos_2",
            min_context_bars=64,
            max_context_bars=512,
            chronos2_context_bars=512,
            microbatch_size=2,
        ),
        adapter,
    )
    requested = (
        _native_series("BINANCE_USDM:FAST", 15),
        _native_series("BINANCE_USDM:SLOW", 60),
    )

    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="chronos2-monolithic-cadence-regression",
            mode="forecast",
            series=requested,
        )
    )

    assert response.status == "available"
    assert len(adapter.calls) == 1
    assert tuple(item.instrument_key for item in adapter.calls[0]) == (
        "BINANCE_USDM:FAST",
        "BINANCE_USDM:SLOW",
    )


def test_fincast_mixed_cadences_are_isolated_before_inference(tmp_path) -> None:
    adapter = _CadenceFailingAdapter(
        failing_candle_seconds=30,
        model_provenance=fincast_provenance(),
    )
    service = AIService(
        settings(
            tmp_path,
            model_lane="fincast",
            min_context_bars=512,
            max_context_bars=512,
            microbatch_size=10,
        ),
        adapter,
    )
    requested = (
        _native_series("BINANCE_USDM:FAST-A", 15),
        _native_series("BINANCE_USDM:FAIL", 30),
        _native_series("BINANCE_USDM:SLOW", 60),
        _native_series("BINANCE_USDM:FAST-B", 15),
    )

    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="fincast-mixed-cadence-isolation",
            mode="forecast",
            series=requested,
        )
    )

    assert response.status == "partial"
    assert [
        tuple(
            int((item.bars[1].timestamp - item.bars[0].timestamp).total_seconds())
            for item in attempt
        )
        for attempt in adapter.attempts
    ] == [(15, 15), (30,), (60,)]
    by_key = {item.instrument_key: item for item in response.series}
    assert by_key["BINANCE_USDM:FAIL"].status == "unavailable"
    assert by_key["BINANCE_USDM:FAIL"].unavailable is not None
    assert by_key["BINANCE_USDM:FAIL"].unavailable.code == "INFERENCE_FAILED"
    assert all(
        by_key[key].status == "available"
        for key in (
            "BINANCE_USDM:FAST-A",
            "BINANCE_USDM:FAST-B",
            "BINANCE_USDM:SLOW",
        )
    )


def test_fincast_replay_origins_are_processed_in_microbatches_of_four(tmp_path) -> None:
    adapter = _CadenceFailingAdapter(
        failing_candle_seconds=30,
        model_provenance=fincast_provenance(),
    )
    service = AIService(
        settings(
            tmp_path,
            model_lane="fincast",
            min_context_bars=512,
            max_context_bars=512,
            microbatch_size=4,
        ),
        adapter,
    )
    requested = tuple(
        _native_series(f"BINANCE_USDM:ORIGIN-{index}", 15)
        for index in range(9)
    )

    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="fincast-microbatch-four",
            mode="forecast",
            series=requested,
        )
    )

    assert response.status == "available"
    assert [len(attempt) for attempt in adapter.attempts] == [4, 4, 1]


def test_realtime_forecast_returns_only_requested_horizons(tmp_path) -> None:
    adapter = DeterministicAdapter()
    service = AIService(settings(tmp_path), adapter)
    full = _series("BINANCE_USDM:BTCUSDT")
    requested = full.model_copy(
        update={
            "timezone": "UTC",
            "future_timestamps": future(full.input_end_at, 15),
        }
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="realtime-horizon-profile",
            mode="forecast",
            forecast_profile="realtime_5_15",
            horizons_minutes=(5, 15),
            series=(requested,),
        )
    )

    assert response.status == "available"
    assert tuple(item.horizon_minutes for item in response.series[0].horizons) == (5, 15)
    assert len(adapter.calls[0][0].future_timestamps) == 15


def test_service_enforces_environment_backed_series_limit(tmp_path) -> None:
    service = AIService(settings(tmp_path, max_series=1), DeterministicAdapter())
    request = ForecastRequest(
        schema_version="scalping-ai/v2",
        request_id="batch-limit",
        mode="forecast",
        series=(_series("KRX:1"), _series("KRX:2")),
    )
    response = service.handle(request)
    assert response.status == "unavailable"
    assert response.error is not None
    assert response.error.code == "REQUEST_LIMIT_EXCEEDED"
    assert response.series == ()


def test_single_chronos_2_run_records_exact_confirmed_bar_origin(tmp_path) -> None:
    chronos2 = DeterministicAdapter(_model())
    bindings = (ProductionModelBinding("chronos_2", "amazon/chronos-2", chronos2),)
    service = AIService(settings(tmp_path), chronos2, bindings)
    requested = _series("US:TSLA", 180)
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="chronos2-base-origin",
            mode="forecast",
            series=(requested,),
        )
    )

    assert response.model_runs is not None
    assert tuple(run.role for run in response.model_runs) == ("chronos_2",)
    run = response.model_runs[0]
    input_origin = run.input_origins[0]
    expected_context = requested.bars[-service.settings.max_context_bars :]
    assert input_origin.context_start_at == expected_context[0].timestamp
    assert input_origin.input_end_at == requested.input_end_at
    assert input_origin.bar_count == len(expected_context)
    assert input_origin.input_digest == _canonical_input_digest(expected_context)
    assert len(input_origin.input_digest) == 64
    assert run.input_end_aligned is True
    assert run.latency_ms >= 0
    assert run.degraded is False
    assert run.fallback_used is False
    assert response.model == run.model
    assert response.series == run.raw_series
    assert response.status == run.status
    assert chronos2.calls[0][0].bars == expected_context

    changed = list(expected_context)
    assert changed[0].volume is not None
    changed[0] = changed[0].model_copy(update={"volume": changed[0].volume + 1})
    assert _canonical_input_digest(tuple(changed)) != input_origin.input_digest


def test_chronos_2_unavailability_fails_closed(tmp_path) -> None:
    chronos2 = UnavailableAdapter(_model(loaded=False), "MODEL_UNAVAILABLE", "P40 or cache unavailable")
    service = AIService(
        settings(tmp_path),
        chronos2,
        (ProductionModelBinding("chronos_2", "amazon/chronos-2", chronos2),),
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="chronos2-base-unavailable",
            mode="forecast",
            series=(_series("US:TSLA"),),
        )
    )

    assert response.status == "unavailable"
    assert response.model_runs is not None
    assert len(response.model_runs) == 1
    assert response.model_runs[0].status == "unavailable"
    assert response.model.model_id == "amazon/chronos-2"
    assert response.series[0].unavailable is not None
    assert response.series[0].unavailable.code == "MODEL_UNAVAILABLE"


def test_chronos_2_model_run_rejects_fallback_provenance(tmp_path) -> None:
    chronos2 = DeterministicAdapter(_model())
    service = AIService(
        settings(tmp_path),
        chronos2,
        (ProductionModelBinding("chronos_2", "amazon/chronos-2", chronos2),),
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="forged-fallback-provenance",
            mode="forecast",
            series=(_series("US:TSLA"),),
        )
    )
    assert response.model_runs is not None
    payload = response.model_runs[0].model_dump(mode="python")
    payload["model"]["fallback_from"] = "unexpected/model"
    payload["model"]["fallback_reason"] = "unexpected fallback"
    with pytest.raises(ValidationError, match="cannot contain fallback provenance"):
        ModelRun.model_validate(payload)


def test_response_rejects_multiple_or_wrong_model_roles(tmp_path) -> None:
    chronos2 = DeterministicAdapter(_model())
    service = AIService(
        settings(tmp_path),
        chronos2,
        (ProductionModelBinding("chronos_2", "amazon/chronos-2", chronos2),),
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="single-role-only",
            mode="forecast",
            series=(_series("US:TSLA"),),
        )
    )
    payload = response.model_dump(mode="python")
    assert payload["model_runs"] is not None
    payload["model_runs"] = (*payload["model_runs"], payload["model_runs"][0])
    with pytest.raises(ValidationError, match="exactly one model lane"):
        type(response).model_validate(payload)


def test_stock_fincast_lane_preserves_cadence_and_same_512_bar_origin_digest(
    tmp_path,
) -> None:
    quantile_observations = QuantileRearrangementObservations(
        row_count=54_600,
        non_finite_value_count=0,
        crossing_row_count=1,
        crossing_adjacent_pair_count=1,
        adjusted_row_count=1,
        q50_adjustment_iqr_ratio_median=0.01,
        q50_adjustment_iqr_ratio_p95=0.02,
        q50_adjustment_iqr_ratio_max=0.03,
        postprocessed_monotonic=True,
    )
    fincast_model = ModelProvenance(
        model_id="Vincent05R/FinCast",
        model_revision="2d7d90b159db8961d27c2cf165d51195902ef92b",
        source_revision="488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
        loader_version="fincast-source-488b19d",
        license="Apache-2.0",
        device="cuda",
        device_name="Tesla P40",
        cuda_capability="6.1",
        dtype="float32",
        attention_backend="math",
        loaded=True,
        precision_validation="fallback_fp32",
        peak_vram_bytes=10_000,
        peak_vram_measurement="cuda_allocated_or_reserved",
        memory_status="ok",
        quantile_tail_policy="tail_clamped_q10_q90",
        quantile_monotonicity_policy="fp32_monotone_rearrangement_v1",
        fp32_quantile_observations=quantile_observations,
        mixed_quantile_observations=quantile_observations,
        precision_failure_reasons=("peak_vram_reduction_below_25pct",),
    )
    fincast = DeterministicAdapter(fincast_model)
    configured = settings(
        tmp_path,
        model_lane="fincast",
        min_context_bars=512,
        max_context_bars=512,
    )
    service = AIService(
        configured,
        fincast,
        (ProductionModelBinding("fincast", "Vincent05R/FinCast", fincast),),
    )
    requested = _series("AAPL", 512).model_copy(
        update={
            "timezone": "America/New_York",
            "input_cadence": SeriesCadence(
                candle_seconds=60,
                gap_policy="market_session_prevalidated",
            ),
        }
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v2",
            request_id="fincast-origin",
            mode="forecast",
            series=(requested,),
        )
    )

    assert response.model_runs is not None
    run = response.model_runs[0]
    assert run.role == "fincast"
    assert run.expected_model_id == "Vincent05R/FinCast"
    assert run.input_origins[0].bar_count == 512
    assert run.input_origins[0].input_digest == _canonical_input_digest(requested.bars)
    assert fincast.calls[0][0].bars == requested.bars
    assert fincast.calls[0][0].timezone == "America/New_York"
    assert fincast.calls[0][0].input_cadence == requested.input_cadence
