from __future__ import annotations

from portfolio_ai_worker.contracts import ForecastRequest, ForecastSeries
from portfolio_ai_worker.service import AIService

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
