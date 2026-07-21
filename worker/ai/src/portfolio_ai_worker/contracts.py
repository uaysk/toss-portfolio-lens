from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator

SCHEMA_VERSION = "scalping-ai/v1"
FIXED_HORIZONS = (5, 15, 30, 60)
FIXED_QUANTILES = (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)
FORECAST_STEPS = max(FIXED_HORIZONS)
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


def _aware(value: datetime, name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must include a UTC offset")
    return value


def _strictly_increasing(values: tuple[datetime, ...], name: str) -> tuple[datetime, ...]:
    if any(current <= previous for previous, current in zip(values, values[1:], strict=False)):
        raise ValueError(f"{name} must be strictly increasing and unique")
    return values


class PriceBar(StrictModel):
    timestamp: datetime
    open: float = Field(gt=0)
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    close: float = Field(gt=0)
    volume: float | None = Field(default=None, ge=0)
    amount: float | None = Field(default=None, ge=0)
    complete: Literal[True]

    @field_validator("timestamp")
    @classmethod
    def validate_timestamp(cls, value: datetime) -> datetime:
        return _aware(value, "bar timestamp")

    @field_validator("open", "high", "low", "close", "volume", "amount")
    @classmethod
    def finite_number(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("bar values must be finite")
        return value

    @model_validator(mode="after")
    def validate_ohlc(self) -> "PriceBar":
        if self.low > min(self.open, self.close) or self.high < max(self.open, self.close) or self.low > self.high:
            raise ValueError("bar OHLC bounds are invalid")
        return self


class TargetStopSpec(StrictModel):
    side: Literal["long", "short"]
    target_price: float = Field(gt=0)
    stop_price: float = Field(gt=0)

    @model_validator(mode="after")
    def distinct_prices(self) -> "TargetStopSpec":
        if self.target_price == self.stop_price:
            raise ValueError("target and stop prices must differ")
        return self


class RequestBase(StrictModel):
    schema_version: Literal["scalping-ai/v1"]
    request_id: str
    horizons_minutes: tuple[int, ...] = FIXED_HORIZONS
    quantiles: tuple[float, ...] = FIXED_QUANTILES
    seed: int = Field(default=0, ge=0, le=2_147_483_647)

    @field_validator("request_id")
    @classmethod
    def valid_request_id(cls, value: str) -> str:
        if not REQUEST_ID_RE.fullmatch(value):
            raise ValueError("request_id contains unsupported characters or length")
        return value

    @field_validator("horizons_minutes")
    @classmethod
    def fixed_horizons(cls, value: tuple[int, ...]) -> tuple[int, ...]:
        if value != FIXED_HORIZONS:
            raise ValueError(f"horizons_minutes must be exactly {list(FIXED_HORIZONS)}")
        return value

    @field_validator("quantiles")
    @classmethod
    def fixed_quantiles(cls, value: tuple[float, ...]) -> tuple[float, ...]:
        if len(value) != len(FIXED_QUANTILES) or any(
            not math.isclose(actual, expected, rel_tol=0, abs_tol=1e-12)
            for actual, expected in zip(value, FIXED_QUANTILES, strict=True)
        ):
            raise ValueError(f"quantiles must be exactly {list(FIXED_QUANTILES)}")
        return value


class ForecastSeries(StrictModel):
    instrument_key: str = Field(min_length=1, max_length=128)
    timezone: str = Field(min_length=1, max_length=64)
    input_end_at: datetime
    future_timestamps: tuple[datetime, ...] = Field(min_length=FORECAST_STEPS, max_length=FORECAST_STEPS)
    bars: tuple[PriceBar, ...] = Field(min_length=1)
    target_stop: TargetStopSpec | None = None

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as error:
            raise ValueError("timezone must be an IANA timezone") from error
        return value

    @field_validator("input_end_at")
    @classmethod
    def aware_end(cls, value: datetime) -> datetime:
        return _aware(value, "input_end_at")

    @field_validator("future_timestamps")
    @classmethod
    def valid_future_timestamps(cls, value: tuple[datetime, ...]) -> tuple[datetime, ...]:
        for item in value:
            _aware(item, "future timestamp")
        return _strictly_increasing(value, "future_timestamps")

    @model_validator(mode="after")
    def validate_series(self) -> "ForecastSeries":
        timestamps = tuple(item.timestamp for item in self.bars)
        _strictly_increasing(timestamps, "bars")
        if timestamps[-1] != self.input_end_at:
            raise ValueError("input_end_at must equal the final complete bar timestamp")
        if self.future_timestamps[0] <= self.input_end_at:
            raise ValueError("future_timestamps must be strictly after input_end_at")
        if self.target_stop:
            reference = self.bars[-1].close
            if self.target_stop.side == "long" and not (
                self.target_stop.stop_price < reference < self.target_stop.target_price
            ):
                raise ValueError("long target/stop must satisfy stop < last close < target")
            if self.target_stop.side == "short" and not (
                self.target_stop.target_price < reference < self.target_stop.stop_price
            ):
                raise ValueError("short target/stop must satisfy target < last close < stop")
        return self


class ForecastRequest(RequestBase):
    mode: Literal["forecast"]
    series: tuple[ForecastSeries, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_instruments(self) -> "ForecastRequest":
        keys = [item.instrument_key for item in self.series]
        if len(keys) != len(set(keys)):
            raise ValueError("forecast instrument_key values must be unique")
        return self


class EvaluationOrigin(StrictModel):
    origin: datetime
    future_timestamps: tuple[datetime, ...] = Field(min_length=FORECAST_STEPS, max_length=FORECAST_STEPS)
    technical_signal: Literal[-1, 0, 1] | None = None
    regime: str | None = Field(default=None, min_length=1, max_length=64)
    target_stop: TargetStopSpec | None = None

    @field_validator("origin")
    @classmethod
    def aware_origin(cls, value: datetime) -> datetime:
        return _aware(value, "evaluation origin")

    @field_validator("future_timestamps")
    @classmethod
    def valid_future_timestamps(cls, value: tuple[datetime, ...]) -> tuple[datetime, ...]:
        for item in value:
            _aware(item, "future timestamp")
        return _strictly_increasing(value, "future_timestamps")

    @model_validator(mode="after")
    def future_after_origin(self) -> "EvaluationOrigin":
        if self.future_timestamps[0] <= self.origin:
            raise ValueError("evaluation future_timestamps must be after origin")
        return self


class EvaluationSeries(StrictModel):
    instrument_key: str = Field(min_length=1, max_length=128)
    timezone: str = Field(min_length=1, max_length=64)
    bars: tuple[PriceBar, ...] = Field(min_length=1)
    origins: tuple[EvaluationOrigin, ...] = Field(min_length=1)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as error:
            raise ValueError("timezone must be an IANA timezone") from error
        return value

    @model_validator(mode="after")
    def valid_evaluation_series(self) -> "EvaluationSeries":
        bar_times = tuple(item.timestamp for item in self.bars)
        origin_times = tuple(item.origin for item in self.origins)
        _strictly_increasing(bar_times, "evaluation bars")
        _strictly_increasing(origin_times, "evaluation origins")
        bar_index = {timestamp: index for index, timestamp in enumerate(bar_times)}
        for item in self.origins:
            index = bar_index.get(item.origin)
            if index is None:
                raise ValueError("every evaluation origin must identify a complete input bar")
            # A caller must not be able to cherry-pick later targets or skip the
            # next executable bar. A retrospective point is accepted only when
            # all 60 realized bars are present in their original order.
            known_future = bar_times[index + 1 : index + 1 + FORECAST_STEPS]
            if len(known_future) != FORECAST_STEPS:
                raise ValueError("every evaluation origin must have 60 subsequent complete bars")
            if item.future_timestamps != known_future:
                raise ValueError(
                    "evaluation future_timestamps must match the consecutive bars immediately after origin"
                )
            if item.target_stop:
                reference = self.bars[index].close
                if item.target_stop.side == "long" and not (
                    item.target_stop.stop_price < reference < item.target_stop.target_price
                ):
                    raise ValueError("long evaluation target/stop must satisfy stop < origin close < target")
                if item.target_stop.side == "short" and not (
                    item.target_stop.target_price < reference < item.target_stop.stop_price
                ):
                    raise ValueError("short evaluation target/stop must satisfy target < origin close < stop")
        return self


class CostAssumptions(StrictModel):
    commission_bps_per_side: float = Field(default=0, ge=0, le=1_000)
    tax_bps_on_exit: float = Field(default=0, ge=0, le=1_000)
    spread_bps_round_trip: float = Field(default=0, ge=0, le=5_000)
    slippage_bps_per_side: float = Field(default=0, ge=0, le=5_000)

    @property
    def round_trip_bps(self) -> float:
        return (
            self.commission_bps_per_side * 2
            + self.tax_bps_on_exit
            + self.spread_bps_round_trip
            + self.slippage_bps_per_side * 2
        )


class EvaluateRequest(RequestBase):
    mode: Literal["evaluate"]
    series: tuple[EvaluationSeries, ...] = Field(min_length=1)
    cost_assumptions: CostAssumptions

    @model_validator(mode="after")
    def unique_instruments(self) -> "EvaluateRequest":
        keys = [item.instrument_key for item in self.series]
        if len(keys) != len(set(keys)):
            raise ValueError("evaluation instrument_key values must be unique")
        return self


AIRequest = Annotated[ForecastRequest | EvaluateRequest, Field(discriminator="mode")]
AI_REQUEST_ADAPTER = TypeAdapter(AIRequest)


class ModelProvenance(StrictModel):
    model_id: str = Field(min_length=1, max_length=256)
    model_revision: str = Field(min_length=1, max_length=256)
    tokenizer_id: str | None = Field(default=None, min_length=1, max_length=256)
    tokenizer_revision: str | None = Field(default=None, min_length=1, max_length=256)
    source_revision: str = Field(min_length=1, max_length=256)
    loader_version: str = Field(min_length=1, max_length=128)
    license: str = Field(min_length=1, max_length=64)
    device: Literal["cuda", "cpu", "unavailable"]
    dtype: Literal["float32"]
    attention_backend: Literal["math", "unavailable"]
    loaded: bool
    fallback_from: str | None = Field(default=None, min_length=1, max_length=256)
    fallback_reason: str | None = Field(default=None, min_length=1, max_length=500)

    @model_validator(mode="after")
    def loaded_shape(self) -> "ModelProvenance":
        if self.loaded and (self.device == "unavailable" or self.attention_backend == "unavailable"):
            raise ValueError("loaded model provenance requires an execution device and attention backend")
        if not self.loaded and (self.device != "unavailable" or self.attention_backend != "unavailable"):
            raise ValueError("unloaded model provenance must use unavailable runtime fields")
        return self


class UnavailableDetail(StrictModel):
    code: str = Field(min_length=1, max_length=64)
    message: str = Field(min_length=1, max_length=500)


class QuantileValue(StrictModel):
    quantile: float = Field(gt=0, lt=1)
    value: float


class TargetStopBounds(StrictModel):
    status: Literal["available", "unavailable"]
    target_first_probability_lower: float | None = Field(default=None, ge=0, le=1)
    target_first_probability_upper: float | None = Field(default=None, ge=0, le=1)
    stop_first_probability_lower: float | None = Field(default=None, ge=0, le=1)
    stop_first_probability_upper: float | None = Field(default=None, ge=0, le=1)
    ambiguous_probability: float | None = Field(default=None, ge=0, le=1)
    neither_probability: float | None = Field(default=None, ge=0, le=1)
    reason: str | None = None

    @model_validator(mode="after")
    def status_shape(self) -> "TargetStopBounds":
        probabilities = (
            self.target_first_probability_lower,
            self.target_first_probability_upper,
            self.stop_first_probability_lower,
            self.stop_first_probability_upper,
            self.ambiguous_probability,
            self.neither_probability,
        )
        if self.status == "available":
            if self.reason is not None or any(value is None for value in probabilities):
                raise ValueError("available target/stop bounds require every probability and no reason")
            assert all(value is not None for value in probabilities)
            target_lower, target_upper, stop_lower, stop_upper, ambiguous, neither = probabilities
            if target_lower > target_upper or stop_lower > stop_upper:
                raise ValueError("target/stop probability bounds are inverted")
            if not math.isclose(target_lower + stop_lower + ambiguous + neither, 1, rel_tol=0, abs_tol=1e-9):
                raise ValueError("exclusive target/stop outcomes must sum to one")
            if not math.isclose(target_upper, target_lower + ambiguous, rel_tol=0, abs_tol=1e-9):
                raise ValueError("target upper bound must include ambiguous paths")
            if not math.isclose(stop_upper, stop_lower + ambiguous, rel_tol=0, abs_tol=1e-9):
                raise ValueError("stop upper bound must include ambiguous paths")
        elif self.reason is None or any(value is not None for value in probabilities):
            raise ValueError("unavailable target/stop bounds require only a reason")
        return self


class HorizonForecast(StrictModel):
    horizon_minutes: Literal[5, 15, 30, 60]
    target_timestamp: datetime
    return_quantiles: tuple[QuantileValue, ...]
    price_quantiles: tuple[QuantileValue, ...]
    up_probability: float | None = Field(default=None, ge=0, le=1)
    down_probability: float | None = Field(default=None, ge=0, le=1)
    flat_probability: float | None = Field(default=None, ge=0, le=1)
    probability_method: Literal["sample_paths", "derived_quantile_cdf", "unavailable"]
    expected_volatility: float | None = Field(default=None, ge=0)
    volatility_method: Literal["path_realized", "quantile_implied_sigma", "unavailable"]
    uncertainty_interval_width: float | None = Field(default=None, ge=0)
    target_stop: TargetStopBounds
    valid_path_count: int = Field(ge=0)
    invalid_path_count: int = Field(ge=0)


class InputQuality(StrictModel):
    status: Literal["good", "partial"]
    bar_count: int = Field(ge=0)
    missing_volume_ratio: float = Field(ge=0, le=1)
    missing_amount_ratio: float = Field(ge=0, le=1)
    irregular_interval_count: int = Field(ge=0)
    warnings: tuple[str, ...]


class DistributionShift(StrictModel):
    status: Literal["unavailable"]
    reason: Literal["reference_statistics_not_published"]


class SeriesForecastResult(StrictModel):
    instrument_key: str
    status: Literal["available", "unavailable"]
    input_end_at: datetime
    horizons: tuple[HorizonForecast, ...] = ()
    input_quality: InputQuality
    distribution_shift: DistributionShift
    unavailable: UnavailableDetail | None = None

    @model_validator(mode="after")
    def status_shape(self) -> "SeriesForecastResult":
        if self.status == "available" and (self.unavailable is not None or len(self.horizons) != len(FIXED_HORIZONS)):
            raise ValueError("available series must contain all horizons and no unavailable detail")
        if self.status == "available" and tuple(item.horizon_minutes for item in self.horizons) != FIXED_HORIZONS:
            raise ValueError("available series horizons must be ordered as 5, 15, 30, 60")
        if self.status == "unavailable" and (self.unavailable is None or self.horizons):
            raise ValueError("unavailable series must contain a reason and no horizons")
        return self


class MetricGroup(StrictModel):
    count: int = Field(ge=0)
    direction_accuracy: float | None = Field(default=None, ge=0, le=1)
    mae: float | None = Field(default=None, ge=0)
    rmse: float | None = Field(default=None, ge=0)


class CalibrationBin(StrictModel):
    lower: float = Field(ge=0, le=1)
    upper: float = Field(ge=0, le=1)
    count: int = Field(ge=0)
    mean_probability: float | None = Field(default=None, ge=0, le=1)
    observed_frequency: float | None = Field(default=None, ge=0, le=1)


class StrategyComparison(StrictModel):
    technical_trade_count: int = Field(ge=0)
    ai_filtered_trade_count: int = Field(ge=0)
    technical_net_return: float
    ai_filtered_net_return: float
    technical_max_drawdown: float = Field(ge=0)
    ai_filtered_max_drawdown: float = Field(ge=0)


class HorizonEvaluationMetrics(StrictModel):
    horizon_minutes: Literal[5, 15, 30, 60]
    overall: MetricGroup
    quantile_coverage: tuple[QuantileValue, ...]
    up_probability_brier: float | None = Field(default=None, ge=0)
    target_stop_first_count: int = Field(ge=0)
    target_stop_first_accuracy: float | None = Field(default=None, ge=0, le=1)
    calibration: tuple[CalibrationBin, ...]
    by_symbol: dict[str, MetricGroup]
    by_time: dict[str, MetricGroup]
    by_regime: dict[str, MetricGroup]
    strategy_comparison: StrategyComparison


class EvaluationRecord(StrictModel):
    instrument_key: str = Field(min_length=1, max_length=128)
    origin: datetime
    horizon_minutes: Literal[5, 15, 30, 60]
    target_timestamp: datetime
    status: Literal["available", "unavailable"]
    predicted_median_return: float | None = None
    predicted_quantiles: tuple[QuantileValue, ...] = ()
    actual_return: float | None = None
    execution_return: float | None = None
    up_probability: float | None = Field(default=None, ge=0, le=1)
    predicted_first_passage: Literal["target", "stop", "ambiguous"] | None = None
    actual_first_passage: Literal["target", "stop", "ambiguous", "neither"] | None = None
    technical_signal: Literal[-1, 0, 1] | None = None
    regime: str | None = Field(default=None, min_length=1, max_length=64)
    round_trip_cost_rate: float = Field(ge=0)
    technical_net_return: float | None = None
    ai_filtered_net_return: float | None = None
    unavailable: UnavailableDetail | None = None

    @field_validator("origin", "target_timestamp")
    @classmethod
    def aware_timestamps(cls, value: datetime) -> datetime:
        return _aware(value, "evaluation record timestamp")

    @field_validator("predicted_quantiles")
    @classmethod
    def fixed_prediction_quantiles(cls, value: tuple[QuantileValue, ...]) -> tuple[QuantileValue, ...]:
        if value and (
            len(value) != len(FIXED_QUANTILES)
            or any(
                not math.isclose(item.quantile, expected, rel_tol=0, abs_tol=1e-12)
                for item, expected in zip(value, FIXED_QUANTILES, strict=False)
            )
        ):
            raise ValueError(f"predicted_quantiles must be empty or exactly {list(FIXED_QUANTILES)}")
        return value

    @model_validator(mode="after")
    def status_shape(self) -> "EvaluationRecord":
        prediction_values = (self.predicted_median_return, self.up_probability)
        if self.status == "available":
            if (
                self.unavailable is not None
                or any(value is None for value in prediction_values)
                or len(self.predicted_quantiles) != len(FIXED_QUANTILES)
                or self.actual_return is None
                or self.execution_return is None
            ):
                raise ValueError("available evaluation records require predictions and realized returns")
        elif (
            self.unavailable is None
            or any(value is not None for value in prediction_values)
            or self.predicted_quantiles
            or self.predicted_first_passage is not None
            or self.ai_filtered_net_return is not None
        ):
            raise ValueError("unavailable evaluation records cannot contain model predictions")

        if (self.actual_return is None) != (self.execution_return is None):
            raise ValueError("actual and next-bar execution returns must be present or absent together")
        if self.actual_first_passage is not None and self.actual_return is None:
            raise ValueError("actual first-passage requires realized returns")

        expected_technical = None
        if self.technical_signal in (-1, 1) and self.execution_return is not None:
            expected_technical = self.technical_signal * self.execution_return - self.round_trip_cost_rate
        if (self.technical_net_return is None) != (expected_technical is None) or (
            self.technical_net_return is not None
            and expected_technical is not None
            and not math.isclose(self.technical_net_return, expected_technical, rel_tol=0, abs_tol=1e-12)
        ):
            raise ValueError("technical net return must equal signed execution return minus round-trip cost")

        expected_filtered = None
        if (
            self.status == "available"
            and self.technical_signal in (-1, 1)
            and self.predicted_median_return is not None
            and (1 if self.predicted_median_return > 0 else -1 if self.predicted_median_return < 0 else 0)
            == self.technical_signal
        ):
            expected_filtered = expected_technical
        if (self.ai_filtered_net_return is None) != (expected_filtered is None) or (
            self.ai_filtered_net_return is not None
            and expected_filtered is not None
            and not math.isclose(self.ai_filtered_net_return, expected_filtered, rel_tol=0, abs_tol=1e-12)
        ):
            raise ValueError("AI-filtered net return must match an admitted technical trade")
        return self


class EvaluationResult(StrictModel):
    retrospective: Literal[True]
    cost_assumptions: CostAssumptions
    records: tuple[EvaluationRecord, ...]
    metrics: tuple[HorizonEvaluationMetrics, ...]

    @model_validator(mode="after")
    def chronological_shape(self) -> "EvaluationResult":
        keys = tuple((item.origin, item.instrument_key, item.horizon_minutes) for item in self.records)
        if keys != tuple(sorted(keys)):
            raise ValueError("evaluation records must be chronological and deterministic")
        if len(keys) != len(set(keys)):
            raise ValueError("evaluation records must be unique by origin, instrument, and horizon")
        expected_cost_rate = self.cost_assumptions.round_trip_bps / 10_000
        if any(
            not math.isclose(item.round_trip_cost_rate, expected_cost_rate, rel_tol=0, abs_tol=1e-12)
            for item in self.records
        ):
            raise ValueError("evaluation record cost rates must match cost_assumptions")
        if tuple(item.horizon_minutes for item in self.metrics) != FIXED_HORIZONS:
            raise ValueError("evaluation metrics must be ordered as 5, 15, 30, 60")
        return self


class AIResponse(StrictModel):
    schema_version: Literal["scalping-ai/v1"]
    request_id: str = Field(min_length=1, max_length=128)
    mode: Literal["forecast", "evaluate"]
    status: Literal["available", "partial", "unavailable"]
    model: ModelProvenance
    generated_at: datetime
    series: tuple[SeriesForecastResult, ...]
    evaluation: EvaluationResult | None = None
    error: UnavailableDetail | None = None

    @field_validator("request_id")
    @classmethod
    def valid_request_id(cls, value: str) -> str:
        if not REQUEST_ID_RE.fullmatch(value):
            raise ValueError("request_id contains unsupported characters or length")
        return value

    @field_validator("generated_at")
    @classmethod
    def aware_generated_at(cls, value: datetime) -> datetime:
        return _aware(value, "generated_at")

    @model_validator(mode="after")
    def mode_shape(self) -> "AIResponse":
        if self.mode == "forecast" and self.evaluation is not None:
            raise ValueError("forecast responses cannot include evaluation")
        if self.mode == "evaluate" and self.error is None and self.evaluation is None:
            raise ValueError("successful evaluate responses require evaluation")
        if self.error is not None and (self.series or self.evaluation is not None):
            raise ValueError("protocol errors cannot include series or evaluation results")
        if self.error is not None and self.status != "unavailable":
            raise ValueError("protocol errors must have unavailable status")
        if self.error is None and not self.series:
            raise ValueError("successful responses must contain at least one series result")
        if self.error is None and self.mode == "forecast":
            available = sum(item.status == "available" for item in self.series)
            expected = "available" if available == len(self.series) else "partial" if available else "unavailable"
            if self.status != expected:
                raise ValueError("forecast response status must summarize its series")
        if self.error is None and self.mode == "evaluate" and self.evaluation is not None:
            available = sum(item.status == "available" for item in self.evaluation.records)
            expected = (
                "available"
                if self.evaluation.records and available == len(self.evaluation.records)
                else "partial"
                if available
                else "unavailable"
            )
            if self.status != expected:
                raise ValueError("evaluate response status must summarize its evaluation records")
        return self


AI_RESPONSE_ADAPTER = TypeAdapter(AIResponse)
