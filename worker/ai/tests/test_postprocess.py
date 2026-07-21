from __future__ import annotations

import math

from portfolio_ai_worker.adapters import PredictedBar, RawPrediction
from portfolio_ai_worker.contracts import ForecastSeries, PriceBar, TargetStopSpec
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


def test_nonfinite_or_invalid_model_paths_never_get_clamped_into_a_forecast() -> None:
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
