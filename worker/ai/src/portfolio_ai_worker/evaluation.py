from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Iterable, Sequence

from .contracts import (
    CalibrationBin,
    CostAssumptions,
    EvaluationRecord,
    EvaluationResult,
    FIXED_HORIZONS,
    FIXED_QUANTILES,
    HorizonEvaluationMetrics,
    MetricGroup,
    QuantileValue,
    StrategyComparison,
    UnavailableDetail,
)


@dataclass(frozen=True, slots=True)
class EvaluationObservation:
    instrument_key: str
    origin: datetime
    local_hour: str
    horizon_minutes: int
    target_timestamp: datetime
    technical_signal: int | None
    regime: str | None
    unavailable: UnavailableDetail | None
    predicted_median_return: float | None = None
    actual_return: float | None = None
    up_probability: float | None = None
    predicted_quantiles: dict[float, float] | None = None
    execution_return: float | None = None
    predicted_first_passage: str | None = None
    actual_first_passage: str | None = None

    @property
    def available(self) -> bool:
        return (
            self.unavailable is None
            and self.predicted_median_return is not None
            and self.actual_return is not None
            and self.up_probability is not None
            and self.predicted_quantiles is not None
        )

    def record(self, costs: CostAssumptions) -> EvaluationRecord:
        round_trip_cost_rate = costs.round_trip_bps / 10_000
        technical_net_return = None
        if self.technical_signal in (-1, 1) and self.execution_return is not None:
            technical_net_return = self.technical_signal * self.execution_return - round_trip_cost_rate
        ai_filtered_net_return = None
        if (
            self.available
            and self.technical_signal in (-1, 1)
            and self.predicted_median_return is not None
            and _direction(self.predicted_median_return) == self.technical_signal
        ):
            ai_filtered_net_return = technical_net_return

        realized = dict(
            actual_return=self.actual_return,
            execution_return=self.execution_return,
            actual_first_passage=self.actual_first_passage,
            technical_signal=self.technical_signal,
            regime=self.regime,
            round_trip_cost_rate=round_trip_cost_rate,
            technical_net_return=technical_net_return,
            ai_filtered_net_return=ai_filtered_net_return,
        )
        if not self.available:
            return EvaluationRecord(
                instrument_key=self.instrument_key,
                origin=self.origin,
                horizon_minutes=self.horizon_minutes,
                target_timestamp=self.target_timestamp,
                status="unavailable",
                **realized,
                unavailable=self.unavailable
                or UnavailableDetail(code="EVALUATION_UNAVAILABLE", message="This evaluation point is unavailable."),
            )
        assert self.predicted_quantiles is not None
        return EvaluationRecord(
            instrument_key=self.instrument_key,
            origin=self.origin,
            horizon_minutes=self.horizon_minutes,
            target_timestamp=self.target_timestamp,
            status="available",
            predicted_median_return=self.predicted_median_return,
            predicted_quantiles=tuple(
                QuantileValue(quantile=quantile, value=self.predicted_quantiles[quantile])
                for quantile in FIXED_QUANTILES
            ),
            up_probability=self.up_probability,
            predicted_first_passage=self.predicted_first_passage,
            **realized,
        )


def _direction(value: float) -> int:
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


def _metric_group(observations: Sequence[EvaluationObservation]) -> MetricGroup:
    available = [item for item in observations if item.available]
    if not available:
        return MetricGroup(count=0)
    errors = [item.predicted_median_return - item.actual_return for item in available]  # type: ignore[operator]
    correct = sum(
        _direction(item.predicted_median_return) == _direction(item.actual_return)  # type: ignore[arg-type]
        for item in available
    )
    return MetricGroup(
        count=len(available),
        direction_accuracy=correct / len(available),
        mae=sum(abs(error) for error in errors) / len(errors),
        rmse=math.sqrt(sum(error * error for error in errors) / len(errors)),
    )


def _group_metrics(
    observations: Sequence[EvaluationObservation],
    key: Callable[[EvaluationObservation], str | None],
) -> dict[str, MetricGroup]:
    grouped: dict[str, list[EvaluationObservation]] = defaultdict(list)
    for item in observations:
        group = key(item)
        if group is not None:
            grouped[group].append(item)
    return {group: _metric_group(values) for group, values in sorted(grouped.items())}


def _calibration(observations: Sequence[EvaluationObservation]) -> tuple[CalibrationBin, ...]:
    available = [item for item in observations if item.available]
    bins: list[CalibrationBin] = []
    for index in range(10):
        lower = index / 10
        upper = (index + 1) / 10
        values = [
            item
            for item in available
            if item.up_probability is not None
            and lower <= item.up_probability
            and (item.up_probability < upper or (index == 9 and item.up_probability <= upper))
        ]
        bins.append(
            CalibrationBin(
                lower=lower,
                upper=upper,
                count=len(values),
                mean_probability=(
                    sum(item.up_probability for item in values if item.up_probability is not None) / len(values)
                )
                if values
                else None,
                observed_frequency=(
                    sum(item.actual_return > 0 for item in values if item.actual_return is not None) / len(values)
                )
                if values
                else None,
            )
        )
    return tuple(bins)


def _quantile_coverage(observations: Sequence[EvaluationObservation]) -> tuple[QuantileValue, ...]:
    available = [item for item in observations if item.available]
    if not available:
        return ()
    return tuple(
        QuantileValue(
            quantile=quantile,
            value=sum(
                item.actual_return <= item.predicted_quantiles[quantile]  # type: ignore[index,operator]
                for item in available
            )
            / len(available),
        )
        for quantile in FIXED_QUANTILES
    )


def _return_and_drawdown(returns: Iterable[float]) -> tuple[float, float]:
    equity = 1.0
    peak = 1.0
    drawdown = 0.0
    for value in returns:
        equity *= 1 + value
        peak = max(peak, equity)
        drawdown = max(drawdown, (peak - equity) / peak)
    return equity - 1, drawdown


def _strategy_comparison(records: Sequence[EvaluationRecord]) -> StrategyComparison:
    ordered = sorted(records, key=lambda item: (item.origin, item.instrument_key))
    technical = [item.technical_net_return for item in ordered if item.technical_net_return is not None]
    filtered = [item.ai_filtered_net_return for item in ordered if item.ai_filtered_net_return is not None]
    technical_return, technical_drawdown = _return_and_drawdown(technical)
    filtered_return, filtered_drawdown = _return_and_drawdown(filtered)
    return StrategyComparison(
        technical_trade_count=len(technical),
        ai_filtered_trade_count=len(filtered),
        technical_net_return=technical_return,
        ai_filtered_net_return=filtered_return,
        technical_max_drawdown=technical_drawdown,
        ai_filtered_max_drawdown=filtered_drawdown,
    )


def _target_stop_accuracy(observations: Sequence[EvaluationObservation]) -> tuple[int, float | None]:
    comparable = [
        item
        for item in observations
        if item.available
        and item.predicted_first_passage in {"target", "stop"}
        and item.actual_first_passage in {"target", "stop"}
    ]
    if not comparable:
        return 0, None
    correct = sum(item.predicted_first_passage == item.actual_first_passage for item in comparable)
    return len(comparable), correct / len(comparable)


def build_evaluation_result(
    observations: Sequence[EvaluationObservation],
    costs: CostAssumptions,
) -> EvaluationResult:
    ordered = sorted(observations, key=lambda item: (item.origin, item.instrument_key, item.horizon_minutes))
    records = tuple(item.record(costs) for item in ordered)
    metrics: list[HorizonEvaluationMetrics] = []
    for horizon in FIXED_HORIZONS:
        values = [item for item in ordered if item.horizon_minutes == horizon]
        horizon_records = [item for item in records if item.horizon_minutes == horizon]
        available = [item for item in values if item.available]
        brier = (
            sum(
                (item.up_probability - float(item.actual_return > 0)) ** 2  # type: ignore[operator]
                for item in available
            )
            / len(available)
            if available
            else None
        )
        first_count, first_accuracy = _target_stop_accuracy(values)
        metrics.append(
            HorizonEvaluationMetrics(
                horizon_minutes=horizon,
                overall=_metric_group(values),
                quantile_coverage=_quantile_coverage(values),
                up_probability_brier=brier,
                target_stop_first_count=first_count,
                target_stop_first_accuracy=first_accuracy,
                calibration=_calibration(values),
                by_symbol=_group_metrics(values, lambda item: item.instrument_key),
                by_time=_group_metrics(values, lambda item: item.local_hour),
                by_regime=_group_metrics(values, lambda item: item.regime),
                strategy_comparison=_strategy_comparison(horizon_records),
            )
        )
    return EvaluationResult(
        retrospective=True,
        cost_assumptions=costs,
        records=records,
        metrics=tuple(metrics),
    )
