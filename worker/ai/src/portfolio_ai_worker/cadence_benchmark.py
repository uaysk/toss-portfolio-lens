from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
import math
from typing import Any

import numpy as np

SUPPORTED_CADENCES = (5, 15, 30, 60)
SUPPORTED_CONTEXTS = (1024, 2048, 4096, 8192)
EVALUATION_HORIZONS_MINUTES = (5, 15, 30, 60)
FIXED_QUANTILES = (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)
NATIVE_CHRONOS2_QUANTILES = (
    0.01,
    0.05,
    0.1,
    0.15,
    0.2,
    0.25,
    0.3,
    0.35,
    0.4,
    0.45,
    0.5,
    0.55,
    0.6,
    0.65,
    0.7,
    0.75,
    0.8,
    0.85,
    0.9,
    0.95,
    0.99,
)
CHRONOS2_OUTPUT_PATCH_SIZE = 16
CHRONOS2_MAX_OUTPUT_PATCHES = 64


@dataclass(frozen=True, slots=True)
class Trade:
    timestamp_ms: int
    price: float
    quantity: float
    first_trade_id: int
    last_trade_id: int
    buyer_is_maker: bool


@dataclass(frozen=True, slots=True)
class CandleArrays:
    close_time_ms: np.ndarray
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    amount: np.ndarray
    trade_count: np.ndarray
    taker_buy_volume: np.ndarray
    taker_buy_amount: np.ndarray

    def __len__(self) -> int:
        return int(self.close_time_ms.shape[0])

    def validate(self, cadence_seconds: int) -> CandleArrays:
        if cadence_seconds not in SUPPORTED_CADENCES and cadence_seconds != 1:
            raise ValueError("unsupported candle cadence")
        lengths = {
            int(getattr(self, field).shape[0])
            for field in self.__dataclass_fields__
        }
        if len(lengths) != 1:
            raise ValueError("candle columns have different lengths")
        if not len(self):
            raise ValueError("candle store cannot be empty")
        cadence_ms = cadence_seconds * 1_000
        if np.any(self.close_time_ms < 0):
            raise ValueError("candle timestamps must be nonnegative")
        if np.any((self.close_time_ms + 1) % cadence_ms != 0):
            raise ValueError("candle closes are not UTC cadence-boundary aligned")
        if np.any(np.diff(self.close_time_ms) <= 0):
            raise ValueError("candle timestamps must be strictly increasing")
        if not all(
            np.isfinite(getattr(self, field)).all()
            for field in (
                "open",
                "high",
                "low",
                "close",
                "volume",
                "amount",
                "trade_count",
                "taker_buy_volume",
                "taker_buy_amount",
            )
        ):
            raise ValueError("candle values must be finite")
        if np.any(self.low > np.minimum(self.open, self.close)):
            raise ValueError("candle low exceeds open/close")
        if np.any(self.high < np.maximum(self.open, self.close)):
            raise ValueError("candle high is below open/close")
        if np.any(self.low > self.high):
            raise ValueError("candle high/low are inverted")
        if np.any(self.close <= 0) or np.any(self.volume < 0):
            raise ValueError("candle price/volume bounds are invalid")
        return self


def cadence_close_time_ms(timestamp_ms: int, cadence_seconds: int) -> int:
    if timestamp_ms < 0:
        raise ValueError("trade timestamp must be nonnegative")
    if cadence_seconds <= 0:
        raise ValueError("cadence must be positive")
    cadence_ms = cadence_seconds * 1_000
    return timestamp_ms // cadence_ms * cadence_ms + cadence_ms - 1


def aggregate_trades(
    trades: Iterable[Trade],
    cadence_seconds: int = 1,
) -> CandleArrays:
    """Aggregate only observed trades; an empty interval is never fabricated."""

    rows: list[list[float | int]] = []
    active_close: int | None = None
    active: list[float | int] | None = None
    previous_timestamp = -1
    for trade in trades:
        if trade.timestamp_ms < previous_timestamp:
            raise ValueError("trade source must be ordered by event timestamp")
        previous_timestamp = trade.timestamp_ms
        if (
            not math.isfinite(trade.price)
            or not math.isfinite(trade.quantity)
            or trade.price <= 0
            or trade.quantity < 0
            or trade.last_trade_id < trade.first_trade_id
        ):
            raise ValueError("trade source contains an invalid row")
        close_time = cadence_close_time_ms(trade.timestamp_ms, cadence_seconds)
        quote = trade.price * trade.quantity
        count = trade.last_trade_id - trade.first_trade_id + 1
        taker_volume = 0.0 if trade.buyer_is_maker else trade.quantity
        taker_amount = 0.0 if trade.buyer_is_maker else quote
        if close_time != active_close:
            if active is not None:
                rows.append(active)
            active_close = close_time
            active = [
                close_time,
                trade.price,
                trade.price,
                trade.price,
                trade.price,
                trade.quantity,
                quote,
                count,
                taker_volume,
                taker_amount,
            ]
            continue
        assert active is not None
        active[2] = max(float(active[2]), trade.price)
        active[3] = min(float(active[3]), trade.price)
        active[4] = trade.price
        active[5] = float(active[5]) + trade.quantity
        active[6] = float(active[6]) + quote
        active[7] = int(active[7]) + count
        active[8] = float(active[8]) + taker_volume
        active[9] = float(active[9]) + taker_amount
    if active is not None:
        rows.append(active)
    if not rows:
        raise ValueError("trade source did not contain an observed trade")
    values = np.asarray(rows, dtype=np.float64)
    return CandleArrays(
        close_time_ms=values[:, 0].astype(np.int64),
        open=values[:, 1],
        high=values[:, 2],
        low=values[:, 3],
        close=values[:, 4],
        volume=values[:, 5],
        amount=values[:, 6],
        trade_count=values[:, 7].astype(np.int64),
        taker_buy_volume=values[:, 8],
        taker_buy_amount=values[:, 9],
    ).validate(cadence_seconds)


def fold_candles(source: CandleArrays, cadence_seconds: int) -> CandleArrays:
    """Fold a common observed one-second source without inventing empty bins."""

    source.validate(1)
    if cadence_seconds not in SUPPORTED_CADENCES:
        raise ValueError("unsupported benchmark cadence")
    destination_close = (
        source.close_time_ms // (cadence_seconds * 1_000)
        * (cadence_seconds * 1_000)
        + cadence_seconds * 1_000
        - 1
    )
    starts = np.r_[0, np.flatnonzero(np.diff(destination_close)) + 1]
    ends = np.r_[starts[1:], len(source)]
    return CandleArrays(
        close_time_ms=destination_close[ends - 1],
        open=source.open[starts],
        high=np.maximum.reduceat(source.high, starts),
        low=np.minimum.reduceat(source.low, starts),
        close=source.close[ends - 1],
        volume=np.add.reduceat(source.volume, starts),
        amount=np.add.reduceat(source.amount, starts),
        trade_count=np.add.reduceat(source.trade_count, starts),
        taker_buy_volume=np.add.reduceat(source.taker_buy_volume, starts),
        taker_buy_amount=np.add.reduceat(source.taker_buy_amount, starts),
    ).validate(cadence_seconds)


def prediction_steps(cadence_seconds: int, horizon_minutes: int = 60) -> int:
    if cadence_seconds not in SUPPORTED_CADENCES:
        raise ValueError("unsupported benchmark cadence")
    seconds = horizon_minutes * 60
    if seconds % cadence_seconds:
        raise ValueError("forecast horizon is not divisible by cadence")
    return seconds // cadence_seconds


def chronos2_direct_prediction_supported(
    cadence_seconds: int,
    horizon_minutes: int = 60,
) -> bool:
    return prediction_steps(cadence_seconds, horizon_minutes) <= (
        CHRONOS2_OUTPUT_PATCH_SIZE * CHRONOS2_MAX_OUTPUT_PATCHES
    )


def context_slice(
    close_times_ms: np.ndarray,
    origin_ms: int,
    context_bars: int,
    cadence_seconds: int,
) -> slice:
    if context_bars <= 0:
        raise ValueError("context size must be positive")
    right = int(np.searchsorted(close_times_ms, origin_ms, side="right"))
    if right <= 0 or int(close_times_ms[right - 1]) != origin_ms:
        raise ValueError("origin does not match a finalized candle close")
    left = right - context_bars
    if left < 0:
        raise ValueError("insufficient pre-origin context")
    expected = cadence_seconds * 1_000
    if np.any(np.diff(close_times_ms[left:right]) != expected):
        raise ValueError("context contains a genuinely empty trade interval")
    return slice(left, right)


def contiguous_origin_times(
    close_times_ms: np.ndarray,
    context_bars: int,
    cadence_seconds: int,
    *,
    origin_interval_seconds: int = 15 * 60,
) -> np.ndarray:
    """Return aligned origins with a complete observed context.

    The function never fills missing trade intervals.  A timestamp becomes
    eligible only after ``context_bars`` consecutive observed candles, and
    origins are aligned by their exclusive right edge (close time + 1 ms).
    """

    times = np.asarray(close_times_ms, dtype=np.int64)
    if times.ndim != 1 or len(times) == 0:
        raise ValueError("close times must be a non-empty one-dimensional array")
    if context_bars <= 0:
        raise ValueError("context size must be positive")
    if cadence_seconds not in SUPPORTED_CADENCES:
        raise ValueError("unsupported benchmark cadence")
    if origin_interval_seconds <= 0:
        raise ValueError("origin interval must be positive")
    if np.any(np.diff(times) <= 0):
        raise ValueError("close times must be strictly increasing")
    positions = np.arange(len(times), dtype=np.int64)
    new_run = np.r_[True, np.diff(times) != cadence_seconds * 1_000]
    run_starts = np.maximum.accumulate(np.where(new_run, positions, 0))
    run_lengths = positions - run_starts + 1
    origin_interval_ms = origin_interval_seconds * 1_000
    eligible = (
        (run_lengths >= context_bars)
        & ((times + 1) % origin_interval_ms == 0)
    )
    return times[eligible]


def asof_indices(
    observation_times_ms: np.ndarray,
    decision_times_ms: np.ndarray,
) -> np.ndarray:
    """Return last observation <= decision, with -1 for unavailable history."""

    if np.any(np.diff(observation_times_ms) <= 0):
        raise ValueError("observations must be strictly increasing")
    indices = np.searchsorted(observation_times_ms, decision_times_ms, side="right") - 1
    valid = indices >= 0
    if np.any(
        observation_times_ms[indices[valid]] > decision_times_ms[valid]
    ):
        raise AssertionError("as-of join selected a future observation")
    return indices.astype(np.int64)


def quantile_cdf(
    quantiles: Mapping[float, float],
    threshold: float,
) -> float:
    points = sorted((float(q), float(value)) for q, value in quantiles.items())
    if len(points) < 2:
        raise ValueError("at least two quantiles are required")
    probabilities = np.asarray([item[0] for item in points], dtype=np.float64)
    values = np.maximum.accumulate(
        np.asarray([item[1] for item in points], dtype=np.float64)
    )
    if threshold <= values[0]:
        return float(probabilities[0])
    if threshold >= values[-1]:
        return float(probabilities[-1])
    right = int(np.searchsorted(values, threshold, side="right"))
    left = right - 1
    width = values[right] - values[left]
    if width <= 0:
        return float(probabilities[right])
    ratio = (threshold - values[left]) / width
    return float(
        probabilities[left] + ratio * (probabilities[right] - probabilities[left])
    )


def pinball_loss(actual: float, forecast: float, quantile: float) -> float:
    error = actual - forecast
    return max(quantile * error, (quantile - 1) * error)


def weighted_interval_score(
    actual: float,
    quantiles: Mapping[float, float],
) -> float:
    """WIS using the fixed 50/80/90% central intervals plus the median."""

    median = float(quantiles[0.5])
    total = 0.5 * abs(actual - median)
    weight = 0.5
    for lower, upper in ((0.25, 0.75), (0.1, 0.9), (0.05, 0.95)):
        alpha = 2 * lower
        low = float(quantiles[lower])
        high = float(quantiles[upper])
        interval = high - low
        score = interval
        if actual < low:
            score += 2 / alpha * (low - actual)
        elif actual > high:
            score += 2 / alpha * (actual - high)
        interval_weight = alpha / 2
        total += interval_weight * score
        weight += interval_weight
    return total / weight


def summarize_prediction_records(
    records: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    available = [record for record in records if record.get("status") == "available"]
    if not available:
        return {
            "count": 0,
            "mae": None,
            "rmse": None,
            "meanPinballLoss": None,
            "wis": None,
            "coverage": None,
            "calibrationError": None,
            "directionAccuracy": None,
        }
    errors: list[float] = []
    pinballs: list[float] = []
    interval_hits = 0
    direction_hits = 0
    quantile_hits = {quantile: 0 for quantile in FIXED_QUANTILES}
    wis_values: list[float] = []
    for record in available:
        actual = float(record["actualReturn"])
        quantiles = {
            float(key): float(value)
            for key, value in dict(record["returnQuantiles"]).items()
        }
        q50 = quantiles[0.5]
        errors.append(q50 - actual)
        direction_hits += int((q50 > 0) == (actual > 0))
        interval_hits += int(quantiles[0.1] <= actual <= quantiles[0.9])
        wis_values.append(weighted_interval_score(actual, quantiles))
        for quantile in FIXED_QUANTILES:
            quantile_hits[quantile] += int(actual <= quantiles[quantile])
            pinballs.append(pinball_loss(actual, quantiles[quantile], quantile))
    count = len(available)
    return {
        "count": count,
        "mae": sum(abs(value) for value in errors) / count,
        "rmse": math.sqrt(sum(value * value for value in errors) / count),
        "meanPinballLoss": sum(pinballs) / len(pinballs),
        "wis": sum(wis_values) / count,
        "coverage": interval_hits / count,
        "calibrationError": sum(
            abs(quantile_hits[quantile] / count - quantile)
            for quantile in FIXED_QUANTILES
        ) / len(FIXED_QUANTILES),
        "directionAccuracy": direction_hits / count,
    }
