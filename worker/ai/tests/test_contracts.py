from __future__ import annotations

from datetime import datetime, timezone

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
    PriceBar,
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
