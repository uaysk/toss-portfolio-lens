from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import count
from typing import Sequence
from zoneinfo import ZoneInfo

from pydantic import ValidationError

from .adapters import InferenceSeries, ModelAdapter, RawPrediction
from .contracts import (
    AIRequest,
    AIResponse,
    EvaluateRequest,
    EvaluationOrigin,
    EvaluationSeries,
    FIXED_HORIZONS,
    ForecastRequest,
    ForecastSeries,
    REQUEST_ID_RE,
    SCHEMA_VERSION,
    SeriesForecastResult,
    TargetStopBounds,
    UnavailableDetail,
)
from .evaluation import EvaluationObservation, build_evaluation_result
from .postprocess import (
    first_passage_outcome,
    median_return,
    postprocess_prediction,
    quantile_returns,
    unavailable_series,
)
from .settings import AISettings


def _response_status(results: Sequence[SeriesForecastResult]) -> str:
    available = sum(item.status == "available" for item in results)
    if available == len(results) and results:
        return "available"
    if available:
        return "partial"
    return "unavailable"


def _evaluation_key(instrument_key: str, origin: datetime, ordinal: int) -> str:
    suffix = f"@{origin.isoformat()}"
    if len(instrument_key) + len(suffix) <= 128:
        return f"{instrument_key}{suffix}"
    digest = hashlib.sha256(instrument_key.encode("utf-8")).hexdigest()[:10]
    room = 128 - len(suffix) - len(digest) - 1
    if room < 1:
        return f"eval-{ordinal}-{digest}"
    return f"{instrument_key[:room]}-{digest}{suffix}"


def _predicted_first_passage(bounds: TargetStopBounds) -> str | None:
    if bounds.status != "available":
        return None
    assert bounds.target_first_probability_lower is not None
    assert bounds.target_first_probability_upper is not None
    assert bounds.stop_first_probability_lower is not None
    assert bounds.stop_first_probability_upper is not None
    assert bounds.ambiguous_probability is not None
    assert bounds.neither_probability is not None
    target = bounds.target_first_probability_lower
    stop = bounds.stop_first_probability_lower
    # OHLC paths cannot order a target and stop touched in the same bar. Only
    # classify a side when its exclusive lower bound dominates the other
    # side's ambiguity-inclusive upper bound and every non-hit outcome.
    if target > bounds.stop_first_probability_upper and target > bounds.neither_probability:
        return "target"
    if stop > bounds.target_first_probability_upper and stop > bounds.neither_probability:
        return "stop"
    return "ambiguous"


@dataclass(frozen=True, slots=True)
class _EvaluationPoint:
    source: EvaluationSeries
    origin: EvaluationOrigin
    forecast: ForecastSeries


@dataclass(frozen=True, slots=True)
class _RejectedEvaluationPoint:
    source: EvaluationSeries
    origin: EvaluationOrigin
    result: SeriesForecastResult


class AIService:
    def __init__(self, settings: AISettings, adapter: ModelAdapter) -> None:
        self.settings = settings
        self.adapter = adapter
        self._model_lock = threading.Lock()

    def protocol_error(
        self,
        *,
        request_id: str = "invalid-request",
        mode: str = "forecast",
        code: str = "INVALID_REQUEST",
        message: str = "The AI worker request is invalid.",
    ) -> AIResponse:
        safe_mode = "evaluate" if mode == "evaluate" else "forecast"
        safe_request_id = request_id if REQUEST_ID_RE.fullmatch(request_id) else "invalid-request"
        return AIResponse(
            schema_version=SCHEMA_VERSION,
            request_id=safe_request_id,
            mode=safe_mode,
            status="unavailable",
            model=self.adapter.provenance,
            generated_at=datetime.now(timezone.utc),
            series=(),
            error=UnavailableDetail(code=code, message=message[:500]),
        )

    def handle(self, request: AIRequest) -> AIResponse:
        if len(request.series) > self.settings.max_series:
            return self.protocol_error(
                request_id=request.request_id,
                mode=request.mode,
                code="REQUEST_LIMIT_EXCEEDED",
                message=f"The request exceeds the configured AI_MAX_SERIES limit of {self.settings.max_series}.",
            )
        if isinstance(request, ForecastRequest):
            return self._handle_forecast(request)
        origin_count = sum(len(item.origins) for item in request.series)
        if origin_count > self.settings.max_evaluation_origins:
            return self.protocol_error(
                request_id=request.request_id,
                mode=request.mode,
                code="REQUEST_LIMIT_EXCEEDED",
                message=(
                    "The request exceeds the configured AI_MAX_EVALUATION_ORIGINS limit of "
                    f"{self.settings.max_evaluation_origins}."
                ),
            )
        return self._handle_evaluate(request)

    def _run_forecasts(self, series: Sequence[ForecastSeries], seed: int) -> tuple[SeriesForecastResult, ...]:
        results: dict[str, SeriesForecastResult] = {}
        eligible: list[ForecastSeries] = []
        for item in series:
            if len(item.bars) < self.settings.min_context_bars:
                results[item.instrument_key] = unavailable_series(
                    item.instrument_key,
                    item.input_end_at,
                    item.bars,
                    "INSUFFICIENT_HISTORY",
                    f"At least {self.settings.min_context_bars} complete bars are required.",
                )
                continue
            eligible.append(item.model_copy(update={"bars": item.bars[-self.settings.max_context_bars :]}))

        groups: dict[int, list[ForecastSeries]] = {}
        for item in eligible:
            groups.setdefault(len(item.bars), []).append(item)

        batch_ordinal = count()
        for _context_length, group in sorted(groups.items()):
            for offset in range(0, len(group), self.settings.microbatch_size):
                chunk = group[offset : offset + self.settings.microbatch_size]
                inputs = [
                    InferenceSeries(
                        instrument_key=item.instrument_key,
                        bars=item.bars,
                        future_timestamps=item.future_timestamps,
                    )
                    for item in chunk
                ]
                ordinal = next(batch_ordinal)
                try:
                    with self._model_lock:
                        raw = self.adapter.predict_batch(inputs, seed=seed + ordinal)
                    if len(raw) != len(chunk) or any(
                        prediction.instrument_key != expected.instrument_key
                        for prediction, expected in zip(raw, chunk, strict=False)
                    ):
                        raise RuntimeError("adapter returned misaligned batch results")
                except Exception as error:
                    raw = [
                        RawPrediction(
                            instrument_key=item.instrument_key,
                            unavailable_code="INFERENCE_FAILED",
                            unavailable_message=(
                                f"Model inference failed ({type(error).__name__}); no forecast was fabricated."
                            ),
                        )
                        for item in chunk
                    ]
                for item, prediction in zip(chunk, raw, strict=True):
                    results[item.instrument_key] = postprocess_prediction(item, prediction)
        return tuple(results[item.instrument_key] for item in series)

    def _handle_forecast(self, request: ForecastRequest) -> AIResponse:
        results = self._run_forecasts(request.series, request.seed)
        return AIResponse(
            schema_version=SCHEMA_VERSION,
            request_id=request.request_id,
            mode="forecast",
            status=_response_status(results),
            model=self.adapter.provenance,
            generated_at=datetime.now(timezone.utc),
            series=results,
        )

    def _evaluation_points(
        self, request: EvaluateRequest
    ) -> tuple[list[_EvaluationPoint], list[_RejectedEvaluationPoint]]:
        points: list[_EvaluationPoint] = []
        rejected: list[_RejectedEvaluationPoint] = []
        ordinal = 0
        for source in request.series:
            bars_by_time = {bar.timestamp: bar for bar in source.bars}
            for origin in source.origins:
                context = tuple(bar for bar in source.bars if bar.timestamp <= origin.origin)
                key = _evaluation_key(source.instrument_key, origin.origin, ordinal)
                ordinal += 1
                try:
                    forecast = ForecastSeries(
                        instrument_key=key,
                        timezone=source.timezone,
                        input_end_at=origin.origin,
                        future_timestamps=origin.future_timestamps,
                        bars=context,
                        target_stop=origin.target_stop,
                    )
                except ValidationError:
                    reference = bars_by_time[origin.origin]
                    rejected.append(
                        _RejectedEvaluationPoint(
                            source=source,
                            origin=origin,
                            result=unavailable_series(
                                key,
                                origin.origin,
                                context or (reference,),
                                "INVALID_EVALUATION_POINT",
                                "The evaluation target/stop or causal input window is invalid at this origin.",
                            ),
                        )
                    )
                    continue
                points.append(_EvaluationPoint(source=source, origin=origin, forecast=forecast))
        return points, rejected

    def _observation(
        self,
        point: _EvaluationPoint,
        result: SeriesForecastResult,
        horizon: int,
    ) -> EvaluationObservation:
        source = point.source
        origin = point.origin
        target_timestamp = origin.future_timestamps[horizon - 1]
        local_hour = origin.origin.astimezone(ZoneInfo(source.timezone)).strftime("%H")
        common = dict(
            instrument_key=source.instrument_key,
            origin=origin.origin,
            local_hour=local_hour,
            horizon_minutes=horizon,
            target_timestamp=target_timestamp,
            technical_signal=origin.technical_signal,
            regime=origin.regime,
        )
        bars_by_time = {bar.timestamp: bar for bar in source.bars}
        origin_bar = bars_by_time[origin.origin]
        target_bar = bars_by_time.get(target_timestamp)
        next_bar = bars_by_time.get(origin.future_timestamps[0])
        if target_bar is None or next_bar is None:
            return EvaluationObservation(
                **common,
                unavailable=UnavailableDetail(
                    code="ACTUAL_UNAVAILABLE",
                    message="A required next-bar entry or horizon close is absent from the historical data.",
                ),
            )
        actual_return = target_bar.close / origin_bar.close - 1
        execution_return = target_bar.close / next_bar.open - 1
        actual_path = [bars_by_time.get(timestamp) for timestamp in origin.future_timestamps[:horizon]]
        complete_path = [bar for bar in actual_path if bar is not None]
        actual_first = (
            first_passage_outcome(complete_path, origin.target_stop) if len(complete_path) == horizon else None
        )
        if result.status == "unavailable":
            # Keep the technical-only baseline evaluable when the public model
            # is unavailable. The prediction record remains unavailable and is
            # never admitted to the AI-filtered strategy.
            return EvaluationObservation(
                **common,
                unavailable=result.unavailable,
                actual_return=actual_return,
                execution_return=execution_return,
                actual_first_passage=actual_first,
            )
        forecast_horizon = next(item for item in result.horizons if item.horizon_minutes == horizon)
        return EvaluationObservation(
            **common,
            unavailable=None,
            predicted_median_return=median_return(forecast_horizon),
            actual_return=actual_return,
            up_probability=forecast_horizon.up_probability,
            predicted_quantiles=quantile_returns(forecast_horizon),
            execution_return=execution_return,
            predicted_first_passage=_predicted_first_passage(forecast_horizon.target_stop),
            actual_first_passage=actual_first,
        )

    def _handle_evaluate(self, request: EvaluateRequest) -> AIResponse:
        points, rejected = self._evaluation_points(request)
        predicted = self._run_forecasts(tuple(point.forecast for point in points), request.seed)
        by_key = {item.instrument_key: item for item in predicted}
        all_series = tuple([*predicted, *(item.result for item in rejected)])
        observations = [
            self._observation(point, by_key[point.forecast.instrument_key], horizon)
            for point in points
            for horizon in FIXED_HORIZONS
        ]
        for rejected_point in rejected:
            local_hour = rejected_point.origin.origin.astimezone(ZoneInfo(rejected_point.source.timezone)).strftime(
                "%H"
            )
            observations.extend(
                EvaluationObservation(
                    instrument_key=rejected_point.source.instrument_key,
                    origin=rejected_point.origin.origin,
                    local_hour=local_hour,
                    horizon_minutes=horizon,
                    target_timestamp=rejected_point.origin.future_timestamps[horizon - 1],
                    technical_signal=rejected_point.origin.technical_signal,
                    regime=rejected_point.origin.regime,
                    unavailable=rejected_point.result.unavailable,
                )
                for horizon in FIXED_HORIZONS
            )
        evaluation = build_evaluation_result(observations, request.cost_assumptions)
        available_records = sum(item.status == "available" for item in evaluation.records)
        status = "unavailable"
        if available_records == len(evaluation.records) and evaluation.records:
            status = "available"
        elif available_records:
            status = "partial"
        return AIResponse(
            schema_version=SCHEMA_VERSION,
            request_id=request.request_id,
            mode="evaluate",
            status=status,
            model=self.adapter.provenance,
            generated_at=datetime.now(timezone.utc),
            series=all_series,
            evaluation=evaluation,
        )
