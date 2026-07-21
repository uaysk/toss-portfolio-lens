from __future__ import annotations

import math
from collections import Counter
from datetime import datetime
from typing import Iterable, Sequence

from .adapters import PredictedBar, RawPrediction
from .contracts import (
    DistributionShift,
    FIXED_HORIZONS,
    FIXED_QUANTILES,
    ForecastSeries,
    HorizonForecast,
    InputQuality,
    PriceBar,
    QuantileValue,
    SeriesForecastResult,
    TargetStopBounds,
    TargetStopSpec,
    UnavailableDetail,
)

_NORMAL_90 = 1.2815515655446004


def input_quality(bars: Sequence[PriceBar]) -> InputQuality:
    count = len(bars)
    missing_volume = sum(bar.volume is None for bar in bars)
    missing_amount = sum(bar.amount is None for bar in bars)
    deltas = [
        int((current.timestamp - previous.timestamp).total_seconds())
        for previous, current in zip(bars, bars[1:], strict=False)
    ]
    positive = [delta for delta in deltas if delta > 0]
    expected = Counter(positive).most_common(1)[0][0] if positive else None
    irregular = sum(delta != expected for delta in deltas) if expected is not None else 0
    warnings: list[str] = []
    if missing_volume:
        warnings.append("volume is missing from one or more input bars")
    if missing_amount:
        warnings.append("amount is missing from one or more input bars")
    if irregular:
        warnings.append("input timestamps contain irregular intervals or market-session gaps")
    return InputQuality(
        status="partial" if warnings else "good",
        bar_count=count,
        missing_volume_ratio=missing_volume / count if count else 0,
        missing_amount_ratio=missing_amount / count if count else 0,
        irregular_interval_count=irregular,
        warnings=tuple(warnings),
    )


def unavailable_series(
    instrument_key: str,
    input_end_at: datetime,
    bars: Sequence[PriceBar],
    code: str,
    message: str,
) -> SeriesForecastResult:
    return SeriesForecastResult(
        instrument_key=instrument_key,
        status="unavailable",
        input_end_at=input_end_at,
        input_quality=input_quality(bars),
        distribution_shift=DistributionShift(
            status="unavailable",
            reason="reference_statistics_not_published",
        ),
        unavailable=UnavailableDetail(code=code, message=message),
    )


def _quantile(values: Sequence[float], quantile: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("cannot calculate a quantile without observations")
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _quantile_values(values: Sequence[float]) -> tuple[QuantileValue, ...]:
    return tuple(QuantileValue(quantile=quantile, value=_quantile(values, quantile)) for quantile in FIXED_QUANTILES)


def _valid_bar(bar: PredictedBar) -> bool:
    values = (bar.open, bar.high, bar.low, bar.close)
    return (
        all(math.isfinite(value) and value > 0 for value in values)
        and bar.low <= min(bar.open, bar.close)
        and bar.high >= max(bar.open, bar.close)
        and bar.low <= bar.high
        and (bar.volume is None or (math.isfinite(bar.volume) and bar.volume >= 0))
        and (bar.amount is None or (math.isfinite(bar.amount) and bar.amount >= 0))
    )


def _path_volatility(path: Sequence[PredictedBar], base_price: float) -> float:
    previous = base_price
    squared = 0.0
    for bar in path:
        change = math.log(bar.close / previous)
        squared += change * change
        previous = bar.close
    return math.sqrt(squared)


def _target_stop_bounds(paths: Sequence[Sequence[PredictedBar]], spec: TargetStopSpec | None) -> TargetStopBounds:
    if spec is None:
        return TargetStopBounds(status="unavailable", reason="target_stop_not_requested")
    target = stop = ambiguous = neither = 0
    for path in paths:
        outcome = "neither"
        for bar in path:
            if spec.side == "long":
                target_hit = bar.high >= spec.target_price
                stop_hit = bar.low <= spec.stop_price
            else:
                target_hit = bar.low <= spec.target_price
                stop_hit = bar.high >= spec.stop_price
            if target_hit and stop_hit:
                outcome = "ambiguous"
                break
            if target_hit:
                outcome = "target"
                break
            if stop_hit:
                outcome = "stop"
                break
        if outcome == "target":
            target += 1
        elif outcome == "stop":
            stop += 1
        elif outcome == "ambiguous":
            ambiguous += 1
        else:
            neither += 1
    total = len(paths)
    return TargetStopBounds(
        status="available",
        target_first_probability_lower=target / total,
        target_first_probability_upper=(target + ambiguous) / total,
        stop_first_probability_lower=stop / total,
        stop_first_probability_upper=(stop + ambiguous) / total,
        ambiguous_probability=ambiguous / total,
        neither_probability=neither / total,
    )


def _path_horizons(series: ForecastSeries, raw: RawPrediction) -> tuple[HorizonForecast, ...] | None:
    assert raw.paths is not None
    base = series.bars[-1].close
    output: list[HorizonForecast] = []
    for horizon in FIXED_HORIZONS:
        valid = [
            path[:horizon]
            for path in raw.paths
            if len(path) >= horizon and all(_valid_bar(bar) for bar in path[:horizon])
        ]
        invalid_count = len(raw.paths) - len(valid)
        if not valid:
            return None
        prices = [path[-1].close for path in valid]
        returns = [price / base - 1 for price in prices]
        up = sum(price > base for price in prices)
        down = sum(price < base for price in prices)
        flat = len(prices) - up - down
        p10 = _quantile(prices, 0.1)
        p90 = _quantile(prices, 0.9)
        output.append(
            HorizonForecast(
                horizon_minutes=horizon,
                target_timestamp=series.future_timestamps[horizon - 1],
                return_quantiles=_quantile_values(returns),
                price_quantiles=_quantile_values(prices),
                up_probability=up / len(prices),
                down_probability=down / len(prices),
                flat_probability=flat / len(prices),
                probability_method="sample_paths",
                expected_volatility=sum(_path_volatility(path, base) for path in valid) / len(valid),
                volatility_method="path_realized",
                uncertainty_interval_width=(p90 - p10) / base,
                target_stop=_target_stop_bounds(valid, series.target_stop),
                valid_path_count=len(valid),
                invalid_path_count=invalid_count,
            )
        )
    return tuple(output)


def _cdf_probability(points: Sequence[tuple[float, float]], value: float) -> float:
    if value < points[0][1]:
        return 0.0
    if value >= points[-1][1]:
        return 1.0
    for (left_q, left_value), (right_q, right_value) in zip(points, points[1:], strict=False):
        if value > right_value:
            continue
        if right_value == left_value:
            return right_q
        fraction = (value - left_value) / (right_value - left_value)
        return left_q + fraction * (right_q - left_q)
    return 1.0


def _direct_horizons(series: ForecastSeries, raw: RawPrediction) -> tuple[HorizonForecast, ...] | None:
    assert raw.close_quantiles is not None
    base = series.bars[-1].close
    output: list[HorizonForecast] = []
    for horizon in FIXED_HORIZONS:
        provided = raw.close_quantiles.get(horizon)
        if provided is None or any(quantile not in provided for quantile in FIXED_QUANTILES):
            return None
        points = [(quantile, provided[quantile]) for quantile in FIXED_QUANTILES]
        prices = [price for _, price in points]
        if any(not math.isfinite(price) or price <= 0 for price in prices) or any(
            right < left for left, right in zip(prices, prices[1:], strict=False)
        ):
            return None
        cdf_at_base = min(1.0, max(0.0, _cdf_probability(points, base)))
        p10 = provided[0.1]
        p90 = provided[0.9]
        implied_sigma = max(0.0, math.log(p90 / p10) / (2 * _NORMAL_90))
        output.append(
            HorizonForecast(
                horizon_minutes=horizon,
                target_timestamp=series.future_timestamps[horizon - 1],
                return_quantiles=tuple(
                    QuantileValue(quantile=quantile, value=price / base - 1) for quantile, price in points
                ),
                price_quantiles=tuple(QuantileValue(quantile=quantile, value=price) for quantile, price in points),
                up_probability=1 - cdf_at_base,
                down_probability=cdf_at_base,
                flat_probability=0,
                probability_method="derived_quantile_cdf",
                expected_volatility=implied_sigma,
                volatility_method="quantile_implied_sigma",
                uncertainty_interval_width=(p90 - p10) / base,
                target_stop=TargetStopBounds(
                    status="unavailable",
                    reason="marginal_quantiles_do_not_identify_first_passage_order",
                ),
                valid_path_count=0,
                invalid_path_count=0,
            )
        )
    return tuple(output)


def postprocess_prediction(series: ForecastSeries, raw: RawPrediction) -> SeriesForecastResult:
    if raw.instrument_key != series.instrument_key:
        return unavailable_series(
            series.instrument_key,
            series.input_end_at,
            series.bars,
            "MODEL_PROTOCOL_ERROR",
            "The model returned a result for a different instrument.",
        )
    if raw.unavailable_code:
        return unavailable_series(
            series.instrument_key,
            series.input_end_at,
            series.bars,
            raw.unavailable_code,
            raw.unavailable_message or "The model did not provide a forecast.",
        )
    if (raw.paths is None) == (raw.close_quantiles is None):
        return unavailable_series(
            series.instrument_key,
            series.input_end_at,
            series.bars,
            "MODEL_PROTOCOL_ERROR",
            "The model must return exactly one supported forecast representation.",
        )
    horizons = _path_horizons(series, raw) if raw.paths is not None else _direct_horizons(series, raw)
    if horizons is None:
        return unavailable_series(
            series.instrument_key,
            series.input_end_at,
            series.bars,
            "INVALID_MODEL_OUTPUT",
            "The model output was incomplete, non-finite, non-positive, or internally inconsistent.",
        )
    return SeriesForecastResult(
        instrument_key=series.instrument_key,
        status="available",
        input_end_at=series.input_end_at,
        horizons=horizons,
        input_quality=input_quality(series.bars),
        distribution_shift=DistributionShift(
            status="unavailable",
            reason="reference_statistics_not_published",
        ),
    )


def median_return(horizon: HorizonForecast) -> float:
    return next(item.value for item in horizon.return_quantiles if item.quantile == 0.5)


def quantile_returns(horizon: HorizonForecast) -> dict[float, float]:
    return {item.quantile: item.value for item in horizon.return_quantiles}


def first_passage_outcome(path: Iterable[PriceBar], spec: TargetStopSpec | None) -> str | None:
    if spec is None:
        return None
    for bar in path:
        if spec.side == "long":
            target_hit = bar.high >= spec.target_price
            stop_hit = bar.low <= spec.stop_price
        else:
            target_hit = bar.low <= spec.target_price
            stop_hit = bar.high >= spec.stop_price
        if target_hit and stop_hit:
            return "ambiguous"
        if target_hit:
            return "target"
        if stop_hit:
            return "stop"
    return "neither"
