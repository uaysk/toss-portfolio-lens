from __future__ import annotations

from bisect import bisect_right
import hashlib
import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import count
from time import perf_counter
from typing import Sequence
from zoneinfo import ZoneInfo

from pydantic import ValidationError

from .adapters import InferenceSeries, ModelAdapter, ProductionModelBinding, RawPrediction
from .contracts import (
    AIRequest,
    AIResponse,
    EvaluateRequest,
    EvaluationOrigin,
    EvaluationSeries,
    FINCAST_MODEL_ID,
    FIXED_HORIZONS,
    ForecastRequest,
    ForecastSeries,
    ModelRun,
    ModelRunInputOrigin,
    PriceBar,
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


def _effective_context_bars(bars: Sequence[PriceBar], maximum: int) -> tuple[PriceBar, ...]:
    return tuple(bars[-maximum:])


def _inference_series(item: ForecastSeries) -> InferenceSeries:
    return InferenceSeries(
        instrument_key=item.instrument_key,
        timezone=item.timezone,
        bars=item.bars,
        future_timestamps=item.future_timestamps,
        input_cadence=item.input_cadence,
    )


def _fincast_microbatch_key(item: ForecastSeries) -> tuple[int, str, int, str]:
    """Group valid FinCast inputs by cadence and isolate malformed series.

    FinCast rejects a whole batch when even one series has a different or
    invalid cadence. Reusing its canonical validator here keeps that failure
    local to the offending instrument instead of making another cadence
    unavailable.
    """

    from .fincast import fincast_interval_seconds

    try:
        interval_seconds = fincast_interval_seconds(_inference_series(item))
    except (TypeError, ValueError):
        return (len(item.bars), "invalid", 0, item.instrument_key)
    return (len(item.bars), "valid", interval_seconds, "")


def _canonical_input_digest(bars: Sequence[PriceBar]) -> str:
    """Hash the exact confirmed-bar values passed to a model.

    IEEE-754 hexadecimal strings avoid locale and JSON number-rendering
    differences while retaining every input float bit. Timestamps are pinned
    to UTC microsecond RFC3339 and nullable liquidity fields remain explicit.
    """

    def number(value: float | None) -> str | None:
        return None if value is None else float(value).hex()

    payload = [
        {
            "amount": number(bar.amount),
            "benchmark_return": number(bar.benchmark_return),
            "btc_realized_volatility": number(bar.btc_realized_volatility),
            "btc_short_return": number(bar.btc_short_return),
            "close": number(bar.close),
            "complete": bar.complete,
            "eth_realized_volatility": number(bar.eth_realized_volatility),
            "eth_short_return": number(bar.eth_short_return),
            "funding_rate": number(bar.funding_rate),
            "high": number(bar.high),
            "index_price": number(bar.index_price),
            "low": number(bar.low),
            "mark_price": number(bar.mark_price),
            "open": number(bar.open),
            "premium_index": number(bar.premium_index),
            "relative_strength": number(bar.relative_strength),
            "taker_buy_amount": number(bar.taker_buy_amount),
            "taker_buy_volume": number(bar.taker_buy_volume),
            "timestamp": bar.timestamp.astimezone(timezone.utc)
            .isoformat(timespec="microseconds")
            .replace("+00:00", "Z"),
            "trade_count": bar.trade_count,
            "volume": number(bar.volume),
        }
        for bar in bars
    ]
    canonical = json.dumps(
        payload,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _model_run_input_origins(
    series: Sequence[ForecastSeries],
    maximum_context_bars: int,
) -> tuple[ModelRunInputOrigin, ...]:
    origins: list[ModelRunInputOrigin] = []
    for item in series:
        context = _effective_context_bars(item.bars, maximum_context_bars)
        origins.append(
            ModelRunInputOrigin(
                instrument_key=item.instrument_key,
                context_start_at=context[0].timestamp,
                input_end_at=item.input_end_at,
                bar_count=len(context),
                input_digest=_canonical_input_digest(context),
            )
        )
    return tuple(origins)


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
    bars_by_time: dict[datetime, PriceBar]


@dataclass(frozen=True, slots=True)
class _RejectedEvaluationPoint:
    source: EvaluationSeries
    origin: EvaluationOrigin
    result: SeriesForecastResult


class AIService:
    def __init__(
        self,
        settings: AISettings,
        adapter: ModelAdapter,
        model_run_adapters: Sequence[ProductionModelBinding] = (),
    ) -> None:
        self.settings = settings
        self.adapter = adapter
        self.model_run_adapters = tuple(model_run_adapters)
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

    def cross_request_batch_key(self, request: AIRequest) -> tuple[object, ...] | None:
        """Return a conservative compatibility key for transport microbatching.

        A key is available only when at least two whole requests fit in the
        model's configured microbatch. Request IDs and instrument identities
        are intentionally excluded: they are caller metadata, not model input
        shape, and are restored after the shared inference call.
        """

        if not isinstance(request, ForecastRequest):
            return None
        if len(request.series) > self.settings.max_series:
            return None
        if self.settings.microbatch_size // len(request.series) < 2:
            return None

        bindings = self.model_run_adapters
        model_identity = tuple(
            (
                binding.role,
                binding.expected_model_id,
                binding.adapter.provenance.model_id,
                binding.adapter.provenance.model_revision,
                binding.adapter.provenance.source_revision,
                binding.adapter.provenance.dtype,
            )
            for binding in bindings
        ) or (
            (
                "primary",
                self.adapter.provenance.model_id,
                self.adapter.provenance.model_id,
                self.adapter.provenance.model_revision,
                self.adapter.provenance.source_revision,
                self.adapter.provenance.dtype,
            ),
        )
        shape_items: list[tuple[object, ...]] = []
        for item in request.series:
            if self.settings.model_lane == "fincast":
                # Keep admission work constant-time on the event loop. Legacy
                # undeclared cadence is still supported by isolated service
                # calls, while cross-request batching requires an explicit
                # cadence declaration.
                if item.input_cadence is None:
                    return None
                cadence_shape: object = (
                    item.input_cadence.candle_seconds,
                    item.input_cadence.gap_policy,
                )
            else:
                cadence_shape = (
                    (
                        item.input_cadence.candle_seconds,
                        item.input_cadence.gap_policy,
                    )
                    if item.input_cadence is not None
                    else None
                )
            shape_items.append((len(item.bars), len(item.future_timestamps), cadence_shape))
        shape = tuple(shape_items)
        lane_profile = (
            self.settings.chronos2_input_profile
            if self.settings.model_lane == "chronos_2"
            else self.settings.model_lane
        )
        return (
            model_identity,
            self.settings.model_lane,
            lane_profile,
            request.forecast_profile,
            shape,
            request.horizons_minutes,
            request.quantiles,
            request.seed,
        )

    def cross_request_batch_capacity(self, request: AIRequest) -> int:
        if self.cross_request_batch_key(request) is None:
            return 1
        return max(1, self.settings.microbatch_size // len(request.series))

    def _run_cross_request_forecasts(
        self,
        requests: Sequence[ForecastRequest],
        adapter: ModelAdapter,
    ) -> tuple[tuple[tuple[SeriesForecastResult, ...], ...], float, datetime]:
        synthetic: list[ForecastSeries] = []
        original_keys: list[tuple[str, ...]] = []
        for request_ordinal, request in enumerate(requests):
            request_keys: list[str] = []
            for series_ordinal, item in enumerate(request.series):
                request_keys.append(item.instrument_key)
                synthetic.append(
                    item.model_copy(
                        update={
                            "instrument_key": f"cross-request-{request_ordinal}-{series_ordinal}",
                        }
                    )
                )
            original_keys.append(tuple(request_keys))

        started = perf_counter()
        combined = self._run_forecasts(synthetic, requests[0].seed, adapter)
        latency_ms = (perf_counter() - started) * 1_000
        generated_at = datetime.now(timezone.utc)

        split: list[tuple[SeriesForecastResult, ...]] = []
        offset = 0
        for request, request_keys in zip(requests, original_keys, strict=True):
            end = offset + len(request.series)
            restored = tuple(
                result.model_copy(update={"instrument_key": instrument_key})
                for result, instrument_key in zip(combined[offset:end], request_keys, strict=True)
            )
            split.append(restored)
            offset = end
        return tuple(split), latency_ms, generated_at

    def handle_batch(self, requests: Sequence[AIRequest]) -> tuple[AIResponse, ...]:
        """Handle one compatible cross-request microbatch.

        This is deliberately defensive because the service can be called
        independently of the WebSocket scheduler. Any mismatch falls back to
        isolated handling, preserving the existing request contract.
        """

        if len(requests) < 2:
            return tuple(self.handle(request) for request in requests)
        key = self.cross_request_batch_key(requests[0])
        if key is None or any(self.cross_request_batch_key(request) != key for request in requests[1:]):
            return tuple(self.handle(request) for request in requests)
        if sum(len(request.series) for request in requests) > self.settings.microbatch_size:
            return tuple(self.handle(request) for request in requests)

        forecast_requests = tuple(request for request in requests if isinstance(request, ForecastRequest))
        if len(forecast_requests) != len(requests):
            return tuple(self.handle(request) for request in requests)

        if self.model_run_adapters:
            batched_runs = [
                (
                    binding,
                    *self._run_cross_request_forecasts(forecast_requests, binding.adapter),
                )
                for binding in self.model_run_adapters
            ]
            responses: list[AIResponse] = []
            for request_ordinal, request in enumerate(forecast_requests):
                input_origins = _model_run_input_origins(request.series, self.settings.max_context_bars)
                model_runs = tuple(
                    ModelRun(
                        role=binding.role,
                        expected_model_id=binding.expected_model_id,
                        status=_response_status(results_by_request[request_ordinal]),
                        model=binding.adapter.provenance,
                        generated_at=generated_at,
                        latency_ms=latency_ms,
                        degraded=False,
                        fallback_used=False,
                        fallback_reason=None,
                        input_origins=input_origins,
                        input_end_aligned=True,
                        raw_series=results_by_request[request_ordinal],
                    )
                    for binding, results_by_request, latency_ms, generated_at in batched_runs
                )
                primary = model_runs[0]
                responses.append(
                    AIResponse(
                        schema_version=SCHEMA_VERSION,
                        request_id=request.request_id,
                        mode="forecast",
                        status=primary.status,
                        model=primary.model,
                        generated_at=datetime.now(timezone.utc),
                        series=primary.raw_series,
                        model_runs=model_runs,
                    )
                )
            return tuple(responses)

        results_by_request, _latency_ms, _generated_at = self._run_cross_request_forecasts(
            forecast_requests,
            self.adapter,
        )
        return tuple(
            AIResponse(
                schema_version=SCHEMA_VERSION,
                request_id=request.request_id,
                mode="forecast",
                status=_response_status(results),
                model=self.adapter.provenance,
                generated_at=datetime.now(timezone.utc),
                series=results,
            )
            for request, results in zip(forecast_requests, results_by_request, strict=True)
        )

    def _run_forecasts(
        self,
        series: Sequence[ForecastSeries],
        seed: int,
        adapter: ModelAdapter | None = None,
    ) -> tuple[SeriesForecastResult, ...]:
        selected_adapter = adapter or self.adapter
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
                    item.input_cadence,
                )
                continue
            eligible.append(
                item.model_copy(update={"bars": _effective_context_bars(item.bars, self.settings.max_context_bars)})
            )

        is_fincast = (
            self.settings.model_lane == "fincast"
            or selected_adapter.provenance.model_id == FINCAST_MODEL_ID
        )
        groups: dict[tuple[int, str, int, str], list[ForecastSeries]] = {}
        for item in eligible:
            key = (
                _fincast_microbatch_key(item)
                if is_fincast
                else (len(item.bars), "shared", 0, "")
            )
            groups.setdefault(key, []).append(item)

        batch_ordinal = count()
        for _group_key, group in sorted(groups.items()):
            for offset in range(0, len(group), self.settings.microbatch_size):
                chunk = group[offset : offset + self.settings.microbatch_size]
                inputs = [_inference_series(item) for item in chunk]
                ordinal = next(batch_ordinal)
                try:
                    with self._model_lock:
                        raw = selected_adapter.predict_batch(inputs, seed=seed + ordinal)
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

    def _model_run(
        self,
        request: ForecastRequest,
        binding: ProductionModelBinding,
        input_origins: tuple[ModelRunInputOrigin, ...],
    ) -> ModelRun:
        started = perf_counter()
        results = self._run_forecasts(request.series, request.seed, binding.adapter)
        latency_ms = (perf_counter() - started) * 1_000
        generated_at = datetime.now(timezone.utc)
        provenance = binding.adapter.provenance
        return ModelRun(
            role=binding.role,
            expected_model_id=binding.expected_model_id,
            status=_response_status(results),
            model=provenance,
            generated_at=generated_at,
            latency_ms=latency_ms,
            degraded=False,
            fallback_used=False,
            fallback_reason=None,
            input_origins=input_origins,
            input_end_aligned=True,
            raw_series=results,
        )

    def _handle_forecast(self, request: ForecastRequest) -> AIResponse:
        if self.model_run_adapters:
            input_origins = _model_run_input_origins(request.series, self.settings.max_context_bars)
            model_runs = tuple(self._model_run(request, binding, input_origins) for binding in self.model_run_adapters)
            primary = model_runs[0]
            return AIResponse(
                schema_version=SCHEMA_VERSION,
                request_id=request.request_id,
                mode="forecast",
                status=primary.status,
                model=primary.model,
                generated_at=datetime.now(timezone.utc),
                series=primary.raw_series,
                model_runs=model_runs,
            )
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
                context_end = bisect_right(
                    source.bars,
                    origin.origin,
                    key=lambda bar: bar.timestamp,
                )
                context = source.bars[:context_end]
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
                        input_cadence=source.input_cadence,
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
                                source.input_cadence,
                            ),
                        )
                    )
                    continue
                points.append(
                    _EvaluationPoint(
                        source=source,
                        origin=origin,
                        forecast=forecast,
                        bars_by_time=bars_by_time,
                    )
                )
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
        bars_by_time = point.bars_by_time
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
