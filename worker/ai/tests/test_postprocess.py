from __future__ import annotations

import math

import pytest
from pydantic import ValidationError

from portfolio_ai_worker.adapters import PredictedBar, RawPrediction
from portfolio_ai_worker.contracts import (
    ForecastSeries,
    HorizonForecast,
    PriceBar,
    TargetStopSpec,
)
from portfolio_ai_worker.postprocess import first_passage_outcome, postprocess_prediction

from .helpers import bars, future


def _constant_path(base: float, first: PredictedBar) -> tuple[PredictedBar, ...]:
    rest = PredictedBar(open=base, high=base, low=base, close=base)
    return (first, *(rest for _ in range(59)))


def test_sample_paths_return_quantiles_and_first_passage_bounds() -> None:
    history = bars(80, drift=0)
    base = history[-1].close
    series = ForecastSeries(
        instrument_key="KRX:005930",
        timezone="Asia/Seoul",
        input_end_at=history[-1].timestamp,
        future_timestamps=future(history[-1].timestamp),
        bars=history,
        target_stop=TargetStopSpec(side="long", target_price=base * 1.01, stop_price=base * 0.99),
    )
    paths = (
        _constant_path(base, PredictedBar(open=base, high=base * 1.02, low=base, close=base)),
        _constant_path(base, PredictedBar(open=base, high=base, low=base * 0.98, close=base)),
        _constant_path(base, PredictedBar(open=base, high=base * 1.02, low=base * 0.98, close=base)),
        _constant_path(base, PredictedBar(open=base, high=base, low=base, close=base)),
    )
    result = postprocess_prediction(series, RawPrediction(instrument_key=series.instrument_key, paths=paths))
    assert result.status == "available"
    first = result.horizons[0]
    assert first.valid_path_count == 4
    assert first.target_stop.target_first_probability_lower == 0.25
    assert first.target_stop.target_first_probability_upper == 0.5
    assert first.target_stop.stop_first_probability_lower == 0.25
    assert first.target_stop.ambiguous_probability == 0.25
    assert first.target_stop.neither_probability == 0.25

    inconsistent = first.model_dump(mode="python")
    inconsistent["flat_probability"] = 0.5
    with pytest.raises(ValidationError, match="sum to one"):
        HorizonForecast.model_validate(inconsistent)

    unavailable = first.model_dump(mode="python")
    unavailable["probability_method"] = "unavailable"
    with pytest.raises(ValidationError, match="must all be null"):
        HorizonForecast.model_validate(unavailable)


def test_inconsistent_ohlc_envelopes_keep_raw_returns_but_disable_first_passage() -> None:
    history = bars(80, drift=0)
    base = history[-1].close
    series = ForecastSeries(
        instrument_key="NASDAQ:TSLA",
        timezone="America/New_York",
        input_end_at=history[-1].timestamp,
        future_timestamps=future(history[-1].timestamp),
        bars=history,
        target_stop=TargetStopSpec(side="long", target_price=base * 1.01, stop_price=base * 0.99),
    )
    up = tuple(
        PredictedBar(
            open=base * 1.02,
            high=base * 1.01,
            low=base * 0.99,
            close=base * 1.01,
        )
        for _ in range(60)
    )
    down = tuple(
        PredictedBar(
            open=base * 0.99,
            high=base,
            low=base * 0.98,
            close=base * 0.99,
        )
        for _ in range(60)
    )

    result = postprocess_prediction(
        series,
        RawPrediction(
            instrument_key=series.instrument_key,
            paths=(*(up for _ in range(10)), *(down for _ in range(10))),
        ),
    )

    assert result.status == "available"
    for horizon in result.horizons:
        returns = {item.quantile: item.value for item in horizon.return_quantiles}
        assert math.isclose(returns[0.05], -0.01, rel_tol=0, abs_tol=1e-12)
        assert math.isclose(returns[0.5], 0, rel_tol=0, abs_tol=1e-12)
        assert math.isclose(returns[0.95], 0.01, rel_tol=0, abs_tol=1e-12)
        assert horizon.up_probability == 0.5
        assert horizon.down_probability == 0.5
        assert horizon.valid_path_count == 20
        assert horizon.invalid_path_count == 0
        assert horizon.target_stop.status == "unavailable"
        assert horizon.target_stop.reason == "predicted_ohlc_path_inconsistent"


def test_nonfinite_or_nonpositive_model_prices_remain_unavailable() -> None:
    history = bars(80)
    series = ForecastSeries(
        instrument_key="KRX:000660",
        timezone="Asia/Seoul",
        input_end_at=history[-1].timestamp,
        future_timestamps=future(history[-1].timestamp),
        bars=history,
    )
    invalid = tuple(PredictedBar(open=math.nan, high=1, low=1, close=1) for _ in range(60))
    result = postprocess_prediction(
        series,
        RawPrediction(instrument_key=series.instrument_key, paths=(invalid,)),
    )
    assert result.status == "unavailable"
    assert result.unavailable is not None
    assert result.unavailable.code == "INVALID_MODEL_OUTPUT"

    nonpositive = tuple(PredictedBar(open=1, high=1, low=0, close=1) for _ in range(60))
    result = postprocess_prediction(
        series,
        RawPrediction(instrument_key=series.instrument_key, paths=(nonpositive,)),
    )
    assert result.status == "unavailable"
    assert result.unavailable is not None
    assert result.unavailable.code == "INVALID_MODEL_OUTPUT"


def test_crossing_direct_quantiles_are_unavailable() -> None:
    history = bars(80)
    series = ForecastSeries(
        instrument_key="NASDAQ:AAPL",
        timezone="America/New_York",
        input_end_at=history[-1].timestamp,
        future_timestamps=future(history[-1].timestamp),
        bars=history,
    )
    crossing = {
        horizon: {0.05: 99.0, 0.1: 98.0, 0.25: 100.0, 0.5: 101.0, 0.75: 102.0, 0.9: 103.0, 0.95: 104.0}
        for horizon in (5, 15, 30, 60)
    }
    result = postprocess_prediction(
        series,
        RawPrediction(instrument_key=series.instrument_key, close_quantiles=crossing),
    )
    assert result.status == "unavailable"
    assert result.unavailable is not None
    assert result.unavailable.code == "INVALID_MODEL_OUTPUT"


def test_actual_target_and_stop_in_same_ohlc_bar_remains_ambiguous() -> None:
    history = bars(1, drift=0)
    timestamp = history[0].timestamp
    outcome = first_passage_outcome(
        (
            PriceBar(
                timestamp=timestamp,
                open=100,
                high=102,
                low=98,
                close=100,
                complete=True,
            ),
        ),
        TargetStopSpec(side="long", target_price=101, stop_price=99),
    )
    assert outcome == "ambiguous"
