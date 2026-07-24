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
    with pytest.raises(ValidationError, match="exactly one Kronos-base"):
        type(response).model_validate(payload)
