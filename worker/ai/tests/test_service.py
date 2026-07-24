from __future__ import annotations

import pytest
from pydantic import ValidationError

from portfolio_ai_worker.adapters import ProductionModelBinding, UnavailableAdapter
from portfolio_ai_worker.contracts import ForecastRequest, ForecastSeries, ModelProvenance, ModelRun
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


def _model(model_id: str, *, fallback: bool = False) -> ModelProvenance:
    return ModelProvenance(
        model_id=model_id,
        model_revision="pinned-test-revision",
        source_revision="pinned-test-source",
        loader_version="test-loader",
        license="test-only",
        device="cpu",
        dtype="float32",
        attention_backend="math",
        loaded=True,
        fallback_from="amazon/chronos-2" if fallback else None,
        fallback_reason="Chronos-2 cache missing" if fallback else None,
    )


def test_dual_model_runs_share_the_exact_confirmed_bar_origin(tmp_path) -> None:
    chronos = DeterministicAdapter(_model("amazon/chronos-2"))
    kronos = DeterministicAdapter(_model("NeoQuasar/Kronos-small"))
    bindings = (
        ProductionModelBinding("chronos2", "amazon/chronos-2", chronos),
        ProductionModelBinding("kronos_small", "NeoQuasar/Kronos-small", kronos),
    )
    service = AIService(settings(tmp_path), chronos, bindings)
    requested = _series("US:TSLA", 180)
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v1",
            request_id="dual-origin",
            mode="forecast",
            series=(requested,),
        )
    )

    assert response.model_runs is not None
    assert tuple(run.role for run in response.model_runs) == ("chronos2", "kronos_small")
    assert response.model_runs[0].input_origins == response.model_runs[1].input_origins
    input_origin = response.model_runs[0].input_origins[0]
    expected_context = requested.bars[-service.settings.max_context_bars :]
    assert input_origin.context_start_at == expected_context[0].timestamp
    assert input_origin.input_end_at == requested.input_end_at
    assert input_origin.bar_count == service.settings.max_context_bars
    assert input_origin.input_digest == _canonical_input_digest(expected_context)
    assert len(input_origin.input_digest) == 64
    assert all(run.input_end_aligned for run in response.model_runs)
    assert all(run.latency_ms >= 0 for run in response.model_runs)
    assert response.model == response.model_runs[0].model
    assert response.series == response.model_runs[0].raw_series
    assert chronos.calls[0][0].bars == expected_context
    assert chronos.calls[0][0].bars == kronos.calls[0][0].bars
    assert chronos.calls[0][0].future_timestamps == kronos.calls[0][0].future_timestamps

    changed = list(expected_context)
    changed[0] = changed[0].model_copy(update={"volume": changed[0].volume + 1})
    assert _canonical_input_digest(tuple(changed)) != input_origin.input_digest


def test_model_unavailability_is_independent_and_does_not_promote_the_companion(tmp_path) -> None:
    unavailable_provenance = ModelProvenance(
        model_id="amazon/chronos-2",
        model_revision="pinned-test-revision",
        source_revision="pinned-test-source",
        loader_version="test-loader",
        license="test-only",
        device="unavailable",
        dtype="float32",
        attention_backend="unavailable",
        loaded=False,
    )
    chronos = UnavailableAdapter(unavailable_provenance, "MODEL_UNAVAILABLE", "P40 unavailable")
    kronos = DeterministicAdapter(_model("NeoQuasar/Kronos-small"))
    service = AIService(
        settings(tmp_path),
        chronos,
        (
            ProductionModelBinding("chronos2", "amazon/chronos-2", chronos),
            ProductionModelBinding("kronos_small", "NeoQuasar/Kronos-small", kronos),
        ),
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v1",
            request_id="independent-unavailable",
            mode="forecast",
            series=(_series("US:TSLA"),),
        )
    )

    assert response.status == "unavailable"
    assert response.model_runs is not None
    assert tuple(run.status for run in response.model_runs) == ("unavailable", "available")
    assert response.model.model_id == "amazon/chronos-2"
    assert response.series[0].unavailable is not None
    assert response.series[0].unavailable.code == "MODEL_UNAVAILABLE"


def test_explicit_bolt_fallback_is_marked_degraded_with_the_actual_model_id(tmp_path) -> None:
    bolt = DeterministicAdapter(_model("amazon/chronos-bolt-small", fallback=True))
    kronos = DeterministicAdapter(_model("NeoQuasar/Kronos-small"))
    service = AIService(
        settings(tmp_path),
        bolt,
        (
            ProductionModelBinding("chronos2", "amazon/chronos-2", bolt),
            ProductionModelBinding("kronos_small", "NeoQuasar/Kronos-small", kronos),
        ),
    )
    response = service.handle(
        ForecastRequest(
            schema_version="scalping-ai/v1",
            request_id="explicit-bolt-fallback",
            mode="forecast",
            series=(_series("US:TSLA"),),
        )
    )

    assert response.model_runs is not None
    chronos_run = response.model_runs[0]
    assert chronos_run.expected_model_id == "amazon/chronos-2"
    assert chronos_run.model.model_id == "amazon/chronos-bolt-small"
    assert chronos_run.fallback_used is True
    assert chronos_run.degraded is True
    assert chronos_run.fallback_reason == "Chronos-2 cache missing"
    assert chronos_run.model.fallback_from == "amazon/chronos-2"

    invalid = chronos_run.model_dump(mode="python")
    invalid["model"]["fallback_from"] = "unexpected/model"
    with pytest.raises(ValidationError, match="degraded Chronos-2 fallback"):
        ModelRun.model_validate(invalid)


def test_non_fallback_model_run_rejects_fallback_provenance(tmp_path) -> None:
    chronos = DeterministicAdapter(_model("amazon/chronos-2"))
    kronos = DeterministicAdapter(_model("NeoQuasar/Kronos-small"))
    service = AIService(
        settings(tmp_path),
        chronos,
        (
            ProductionModelBinding("chronos2", "amazon/chronos-2", chronos),
            ProductionModelBinding("kronos_small", "NeoQuasar/Kronos-small", kronos),
        ),
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
    payload["fallback_reason"] = "unexpected fallback"
    payload["model"]["fallback_from"] = "amazon/chronos-2"
    payload["model"]["fallback_reason"] = "unexpected fallback"
    with pytest.raises(ValidationError, match="cannot contain fallback provenance"):
        ModelRun.model_validate(payload)
