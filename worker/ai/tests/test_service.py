from __future__ import annotations

import pytest
from pydantic import ValidationError

from portfolio_ai_worker.adapters import ProductionModelBinding, UnavailableAdapter
from portfolio_ai_worker.contracts import (
    ForecastRequest,
    ForecastSeries,
    ModelProvenance,
    ModelRun,
    QuantileRearrangementObservations,
)
from portfolio_ai_worker.service import AIService, _canonical_input_digest

from .helpers import DeterministicAdapter, bars, future, settings


def _series(key: str, count: int = 80) -> ForecastSeries:
    history = bars(count)
    return ForecastSeries(
        instrument_key=key,
        timezone="Asia/Seoul",
        input_end_at=history[-1].timestamp,
        future_timestamps=future(history[-1].timestamp),
        bars=history,
    )


def _model(*, loaded: bool = True) -> ModelProvenance:
    return ModelProvenance(
        model_id="NeoQuasar/Kronos-base",
        model_revision="pinned-test-revision",
        tokenizer_id="NeoQuasar/Kronos-Tokenizer-base",
        tokenizer_revision="pinned-tokenizer-revision",
        source_revision="pinned-test-source",
        loader_version="test-loader",
        license="MIT",
        device="cpu" if loaded else "unavailable",
        dtype="float32",
        attention_backend="math" if loaded else "unavailable",
        loaded=loaded,
        quantile_monotonicity_policy="native" if loaded else "unavailable",
    )


def test_service_microbatches_and_returns_partial_unavailable_without_fabrication(tmp_path) -> None:
    adapter = DeterministicAdapter()
    service = AIService(settings(tmp_path), adapter)
    requested = tuple(_series(f"KRX:{index:06d}") for index in range(5)) + (_series("KRX:SHORT", 20),)
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v1",
            request_id="batch-1",
            mode="forecast",
            series=requested,
        )
    )
    assert response.status == "partial"
    assert [item.instrument_key for item in response.series] == [item.instrument_key for item in requested]
    assert len(adapter.calls) == 3
    assert all(len(call) <= 2 for call in adapter.calls)
    assert all(len(item.bars) == 80 for call in adapter.calls for item in call)
    assert response.series[-1].status == "unavailable"
    assert response.series[-1].unavailable is not None
    assert response.series[-1].unavailable.code == "INSUFFICIENT_HISTORY"


def test_service_enforces_environment_backed_series_limit(tmp_path) -> None:
    service = AIService(settings(tmp_path, max_series=1), DeterministicAdapter())
    request = ForecastRequest(
        schema_version="scalping-ai/v1",
        request_id="batch-limit",
        mode="forecast",
        series=(_series("KRX:1"), _series("KRX:2")),
    )
    response = service.handle(request)
    assert response.status == "unavailable"
    assert response.error is not None
    assert response.error.code == "REQUEST_LIMIT_EXCEEDED"
    assert response.series == ()


def test_single_kronos_base_run_records_exact_confirmed_bar_origin(tmp_path) -> None:
    kronos = DeterministicAdapter(_model())
    bindings = (ProductionModelBinding("kronos_base", "NeoQuasar/Kronos-base", kronos),)
    service = AIService(settings(tmp_path), kronos, bindings)
    requested = _series("US:TSLA", 180)
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v1",
            request_id="kronos-base-origin",
            mode="forecast",
            series=(requested,),
        )
    )

    assert response.model_runs is not None
    assert tuple(run.role for run in response.model_runs) == ("kronos_base",)
    run = response.model_runs[0]
    input_origin = run.input_origins[0]
    expected_context = requested.bars[-service.settings.max_context_bars :]
    assert input_origin.context_start_at == expected_context[0].timestamp
    assert input_origin.input_end_at == requested.input_end_at
    assert input_origin.bar_count == service.settings.max_context_bars
    assert input_origin.input_digest == _canonical_input_digest(expected_context)
    assert len(input_origin.input_digest) == 64
    assert run.input_end_aligned is True
    assert run.latency_ms >= 0
    assert run.degraded is False
    assert run.fallback_used is False
    assert response.model == run.model
    assert response.series == run.raw_series
    assert response.status == run.status
    assert kronos.calls[0][0].bars == expected_context

    changed = list(expected_context)
    assert changed[0].volume is not None
    changed[0] = changed[0].model_copy(update={"volume": changed[0].volume + 1})
    assert _canonical_input_digest(tuple(changed)) != input_origin.input_digest


def test_kronos_base_unavailability_fails_closed(tmp_path) -> None:
    kronos = UnavailableAdapter(_model(loaded=False), "MODEL_UNAVAILABLE", "P40 or cache unavailable")
    service = AIService(
        settings(tmp_path),
        kronos,
        (ProductionModelBinding("kronos_base", "NeoQuasar/Kronos-base", kronos),),
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v1",
            request_id="kronos-base-unavailable",
            mode="forecast",
            series=(_series("US:TSLA"),),
        )
    )

    assert response.status == "unavailable"
    assert response.model_runs is not None
    assert len(response.model_runs) == 1
    assert response.model_runs[0].status == "unavailable"
    assert response.model.model_id == "NeoQuasar/Kronos-base"
    assert response.series[0].unavailable is not None
    assert response.series[0].unavailable.code == "MODEL_UNAVAILABLE"


def test_kronos_base_model_run_rejects_fallback_provenance(tmp_path) -> None:
    kronos = DeterministicAdapter(_model())
    service = AIService(
        settings(tmp_path),
        kronos,
        (ProductionModelBinding("kronos_base", "NeoQuasar/Kronos-base", kronos),),
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v1",
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
    kronos = DeterministicAdapter(_model())
    service = AIService(
        settings(tmp_path),
        kronos,
        (ProductionModelBinding("kronos_base", "NeoQuasar/Kronos-base", kronos),),
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v1",
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


def test_fincast_lane_preserves_same_512_bar_origin_digest(tmp_path) -> None:
    quantile_observations = QuantileRearrangementObservations(
        row_count=7_680,
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
    requested = _series("BINANCE_USDM:BTCUSDT", 512)
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v1",
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
