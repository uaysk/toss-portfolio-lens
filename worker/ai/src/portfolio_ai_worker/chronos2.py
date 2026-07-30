from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timedelta
import importlib
import importlib.metadata
import math
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

import numpy as np

from .adapters import (
    AdapterLoadError,
    InferenceSeries,
    RawPrediction,
    RuntimeDevice,
    _provenance,
    _snapshot,
    math_sdpa,
)
from .contracts import CHRONOS_2_MODEL_ID, ModelProvenance, PriceBar
from .precision_validation import sha256_file
from .settings import AISettings

CHRONOS2_PACKAGE_VERSION = "2.3.1"
CHRONOS2_SOURCE_REVISION = "v2.3.1"
CHRONOS2_MODEL_REVISION = "254b5357164a84326913b0695216f690752ac55d"
CHRONOS2_CHECKPOINT_SHA256 = "ddcda3c7508bf2528087723e98a20707cc04b7f370ae275a9fd88078ddba4f42"
CHRONOS2_LOADER_VERSION = f"chronos-forecasting-{CHRONOS2_PACKAGE_VERSION}"
CHRONOS2_CONTEXT_BARS = 1024
CHRONOS2_CONTEXT_WINDOWS = (512, 1024, 2048, 4096, 8192)
CHRONOS2_OUTPUT_PATCH_SIZE = 16
CHRONOS2_MAX_OUTPUT_PATCHES = 64
CHRONOS2_MAX_DIRECT_PREDICTION_STEPS = CHRONOS2_OUTPUT_PATCH_SIZE * CHRONOS2_MAX_OUTPUT_PATCHES
CHRONOS2_PREDICTION_STEPS = 60
CHRONOS2_PADDED_PREDICTION_STEPS = 64
CHRONOS2_NATIVE_QUANTILES = (
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
Chronos2InputProfile = Literal[
    "close_only",
    "ohlcv_calendar",
    "microstructure_calendar",
    "derivatives_calendar",
    "compact_causal_v1",
]
CHRONOS2_INPUT_PROFILES: tuple[Chronos2InputProfile, ...] = (
    "close_only",
    "ohlcv_calendar",
    "microstructure_calendar",
    "derivatives_calendar",
    "compact_causal_v1",
)

_CALENDAR_FEATURES = (
    "minute_of_day_sin",
    "minute_of_day_cos",
    "minute_of_week_sin",
    "minute_of_week_cos",
    "is_weekend",
)
_OHLCV_FEATURES = (
    "open_close_log_ratio",
    "high_close_log_ratio",
    "low_close_log_ratio",
    "log1p_volume",
    "log1p_amount",
)
_MICROSTRUCTURE_FEATURES = (
    "log1p_trade_count",
    "taker_buy_volume_share",
    "taker_buy_amount_share",
)
_DERIVATIVES_FEATURES = (
    "mark_close_basis",
    "index_close_basis",
    "premium_index",
    "funding_rate",
)
_COMPACT_CAUSAL_FEATURES = (
    "open_close_log_ratio",
    "high_close_log_ratio",
    "low_close_log_ratio",
    "log1p_amount",
    "log1p_trade_count",
    "taker_buy_amount_share",
    "mark_close_basis",
    "index_close_basis",
    "premium_index",
    "funding_rate",
    "btc_short_return",
    "btc_realized_volatility",
    "eth_short_return",
    "eth_realized_volatility",
    "benchmark_return",
    "relative_strength",
)


def chronos2_feature_names(profile: Chronos2InputProfile) -> tuple[str, ...]:
    if profile == "close_only":
        return ()
    names = (
        (*_COMPACT_CAUSAL_FEATURES, *_CALENDAR_FEATURES)
        if profile == "compact_causal_v1"
        else (*_OHLCV_FEATURES, *_CALENDAR_FEATURES)
    )
    if profile in {"microstructure_calendar", "derivatives_calendar"}:
        names = (*names, *_MICROSTRUCTURE_FEATURES)
    if profile == "derivatives_calendar":
        names = (*names, *_DERIVATIVES_FEATURES)
    # chronos-forecasting 2.3.1 sorts raw covariate keys, then places
    # past-only rows before known-future rows. Keep the worker-local fixed
    # tensor contract byte-for-byte aligned with that official preprocessing.
    known_future = set(_CALENDAR_FEATURES)
    return (
        *sorted(name for name in names if name not in known_future),
        *sorted(name for name in names if name in known_future),
    )


def chronos2_known_future_names(profile: Chronos2InputProfile) -> tuple[str, ...]:
    return () if profile == "close_only" else tuple(sorted(_CALENDAR_FEATURES))


def _calendar_features(timestamp: datetime, timezone_name: str) -> dict[str, float]:
    local = timestamp.astimezone(ZoneInfo(timezone_name))
    minute_of_day = local.hour * 60 + local.minute + local.second / 60
    minute_of_week = local.weekday() * 1_440 + minute_of_day
    day_angle = 2 * math.pi * minute_of_day / 1_440
    week_angle = 2 * math.pi * minute_of_week / 10_080
    return {
        "minute_of_day_sin": math.sin(day_angle),
        "minute_of_day_cos": math.cos(day_angle),
        "minute_of_week_sin": math.sin(week_angle),
        "minute_of_week_cos": math.cos(week_angle),
        "is_weekend": 1.0 if local.weekday() >= 5 else 0.0,
    }


def _optional_log1p(value: float | int | None) -> float:
    return math.log1p(value) if value is not None else math.nan


def _optional_share(numerator: float | None, denominator: float | None) -> float:
    if numerator is None or denominator is None:
        return math.nan
    if denominator == 0:
        return 0.0
    return min(1.0, max(0.0, numerator / denominator))


def _optional_basis(reference: float | None, close: float) -> float:
    return reference / close - 1 if reference is not None else math.nan


def _bar_features(
    bar: PriceBar,
    *,
    timezone_name: str,
    profile: Chronos2InputProfile,
) -> dict[str, float]:
    if profile == "close_only":
        return {}
    values = {
        "open_close_log_ratio": math.log(bar.open / bar.close),
        "high_close_log_ratio": math.log(bar.high / bar.close),
        "low_close_log_ratio": math.log(bar.low / bar.close),
        "log1p_volume": _optional_log1p(bar.volume),
        "log1p_amount": _optional_log1p(bar.amount),
        **_calendar_features(bar.timestamp, timezone_name),
    }
    if profile == "compact_causal_v1":
        return {
            "open_close_log_ratio": values["open_close_log_ratio"],
            "high_close_log_ratio": values["high_close_log_ratio"],
            "low_close_log_ratio": values["low_close_log_ratio"],
            "log1p_amount": values["log1p_amount"],
            "log1p_trade_count": _optional_log1p(bar.trade_count),
            "taker_buy_amount_share": _optional_share(
                bar.taker_buy_amount,
                bar.amount,
            ),
            "mark_close_basis": _optional_basis(bar.mark_price, bar.close),
            "index_close_basis": _optional_basis(bar.index_price, bar.close),
            "premium_index": (bar.premium_index if bar.premium_index is not None else math.nan),
            "funding_rate": (bar.funding_rate if bar.funding_rate is not None else math.nan),
            "btc_short_return": (bar.btc_short_return if bar.btc_short_return is not None else math.nan),
            "btc_realized_volatility": (
                bar.btc_realized_volatility if bar.btc_realized_volatility is not None else math.nan
            ),
            "eth_short_return": (bar.eth_short_return if bar.eth_short_return is not None else math.nan),
            "eth_realized_volatility": (
                bar.eth_realized_volatility if bar.eth_realized_volatility is not None else math.nan
            ),
            "benchmark_return": (bar.benchmark_return if bar.benchmark_return is not None else math.nan),
            "relative_strength": (bar.relative_strength if bar.relative_strength is not None else math.nan),
            **_calendar_features(bar.timestamp, timezone_name),
        }
    if profile in {"microstructure_calendar", "derivatives_calendar"}:
        values.update(
            {
                "log1p_trade_count": _optional_log1p(bar.trade_count),
                "taker_buy_volume_share": _optional_share(
                    bar.taker_buy_volume,
                    bar.volume,
                ),
                "taker_buy_amount_share": _optional_share(
                    bar.taker_buy_amount,
                    bar.amount,
                ),
            }
        )
    if profile == "derivatives_calendar":
        values.update(
            {
                "mark_close_basis": _optional_basis(bar.mark_price, bar.close),
                "index_close_basis": _optional_basis(bar.index_price, bar.close),
                "premium_index": (bar.premium_index if bar.premium_index is not None else math.nan),
                "funding_rate": (bar.funding_rate if bar.funding_rate is not None else math.nan),
            }
        )
    return values


def _float32_column(values: Iterable[float]) -> np.ndarray:
    return np.fromiter(values, dtype=np.float32)


def _calendar_columns(
    timestamps: Sequence[datetime],
    timezone_name: str,
) -> dict[str, np.ndarray]:
    # Build each timestamp exactly once. The former row-dict path calculated
    # calendar trigonometry twice for compact_causal_v1 and then transposed a
    # large list of dictionaries into NumPy columns.
    rows = tuple(_calendar_features(timestamp, timezone_name) for timestamp in timestamps)
    return {
        name: _float32_column(row[name] for row in rows)
        for name in _CALENDAR_FEATURES
    }


def _feature_columns(
    item: InferenceSeries,
    profile: Chronos2InputProfile,
) -> dict[str, np.ndarray]:
    """Columnar, allocation-bounded equivalent of `_bar_features`."""

    if profile == "close_only":
        return {}
    bars = item.bars
    columns: dict[str, np.ndarray] = {
        "open_close_log_ratio": _float32_column(
            math.log(bar.open / bar.close) for bar in bars
        ),
        "high_close_log_ratio": _float32_column(
            math.log(bar.high / bar.close) for bar in bars
        ),
        "low_close_log_ratio": _float32_column(
            math.log(bar.low / bar.close) for bar in bars
        ),
        "log1p_volume": _float32_column(
            _optional_log1p(bar.volume) for bar in bars
        ),
        "log1p_amount": _float32_column(
            _optional_log1p(bar.amount) for bar in bars
        ),
        **_calendar_columns(tuple(bar.timestamp for bar in bars), item.timezone),
    }
    if profile == "compact_causal_v1":
        columns.update(
            {
                "log1p_trade_count": _float32_column(
                    _optional_log1p(bar.trade_count) for bar in bars
                ),
                "taker_buy_amount_share": _float32_column(
                    _optional_share(bar.taker_buy_amount, bar.amount)
                    for bar in bars
                ),
                "mark_close_basis": _float32_column(
                    _optional_basis(bar.mark_price, bar.close) for bar in bars
                ),
                "index_close_basis": _float32_column(
                    _optional_basis(bar.index_price, bar.close) for bar in bars
                ),
                "premium_index": _float32_column(
                    bar.premium_index
                    if bar.premium_index is not None
                    else math.nan
                    for bar in bars
                ),
                "funding_rate": _float32_column(
                    bar.funding_rate if bar.funding_rate is not None else math.nan
                    for bar in bars
                ),
                "btc_short_return": _float32_column(
                    bar.btc_short_return
                    if bar.btc_short_return is not None
                    else math.nan
                    for bar in bars
                ),
                "btc_realized_volatility": _float32_column(
                    bar.btc_realized_volatility
                    if bar.btc_realized_volatility is not None
                    else math.nan
                    for bar in bars
                ),
                "eth_short_return": _float32_column(
                    bar.eth_short_return
                    if bar.eth_short_return is not None
                    else math.nan
                    for bar in bars
                ),
                "eth_realized_volatility": _float32_column(
                    bar.eth_realized_volatility
                    if bar.eth_realized_volatility is not None
                    else math.nan
                    for bar in bars
                ),
                "benchmark_return": _float32_column(
                    bar.benchmark_return
                    if bar.benchmark_return is not None
                    else math.nan
                    for bar in bars
                ),
                "relative_strength": _float32_column(
                    bar.relative_strength
                    if bar.relative_strength is not None
                    else math.nan
                    for bar in bars
                ),
            }
        )
        return columns
    if profile in {"microstructure_calendar", "derivatives_calendar"}:
        columns.update(
            {
                "log1p_trade_count": _float32_column(
                    _optional_log1p(bar.trade_count) for bar in bars
                ),
                "taker_buy_volume_share": _float32_column(
                    _optional_share(bar.taker_buy_volume, bar.volume)
                    for bar in bars
                ),
                "taker_buy_amount_share": _float32_column(
                    _optional_share(bar.taker_buy_amount, bar.amount)
                    for bar in bars
                ),
            }
        )
    if profile == "derivatives_calendar":
        columns.update(
            {
                "mark_close_basis": _float32_column(
                    _optional_basis(bar.mark_price, bar.close) for bar in bars
                ),
                "index_close_basis": _float32_column(
                    _optional_basis(bar.index_price, bar.close) for bar in bars
                ),
                "premium_index": _float32_column(
                    bar.premium_index
                    if bar.premium_index is not None
                    else math.nan
                    for bar in bars
                ),
                "funding_rate": _float32_column(
                    bar.funding_rate if bar.funding_rate is not None else math.nan
                    for bar in bars
                ),
            }
        )
    return columns


def _timestamp_deltas(timestamps: Sequence[datetime], label: str) -> tuple[int, ...]:
    deltas: list[int] = []
    for left, right in zip(timestamps, timestamps[1:], strict=False):
        seconds = (right - left).total_seconds()
        if not float(seconds).is_integer() or seconds <= 0:
            raise ValueError(f"Chronos-2 {label} timestamps must increase on whole-second boundaries")
        deltas.append(int(seconds))
    return tuple(deltas)


def chronos2_interval_seconds(item: InferenceSeries) -> int:
    """Validate and return the native input cadence for one forecast task."""

    if len(item.bars) not in CHRONOS2_CONTEXT_WINDOWS:
        raise ValueError("Chronos-2 requires exactly 512/1024/2048/4096/8192 complete context bars")
    context_timestamps = tuple(bar.timestamp for bar in item.bars)
    cadence = item.input_cadence
    if cadence is None:
        deltas = _timestamp_deltas(context_timestamps, "context")
        if len(deltas) != len(item.bars) - 1 or len(set(deltas)) != 1 or deltas[0] not in (5, 15, 30, 60):
            raise ValueError("Chronos-2 undeclared context bars must be continuous at 5s, 15s, 30s, or 60s")
        candle_seconds = deltas[0]
    else:
        if cadence.gap_policy != "continuous":
            raise ValueError("Chronos-2 cadence/context benchmarks require continuous inputs")
        candle_seconds = cadence.candle_seconds
        deltas = _timestamp_deltas(context_timestamps, "context")
        if any(delta != candle_seconds for delta in deltas):
            raise ValueError("Chronos-2 context must be continuous at the declared candle cadence")
    if len(item.future_timestamps) not in {15, 60}:
        raise ValueError("Chronos-2 result timestamps must select the 15- or 60-minute profile")
    result_deltas = _timestamp_deltas(
        (context_timestamps[-1], *item.future_timestamps),
        "result",
    )
    if any(delta != 60 for delta in result_deltas):
        raise ValueError("Chronos-2 result timestamps must remain aligned to one-minute horizons")
    return candle_seconds


def chronos2_native_prediction_steps(item: InferenceSeries) -> int:
    candle_seconds = chronos2_interval_seconds(item)
    steps = len(item.future_timestamps) * 60 // candle_seconds
    if steps * candle_seconds != len(item.future_timestamps) * 60:
        raise ValueError("Chronos-2 horizon is not divisible by the input cadence")
    if steps > CHRONOS2_MAX_DIRECT_PREDICTION_STEPS:
        raise ValueError("Chronos-2 requested horizon exceeds the direct output-patch capacity")
    return steps


def _native_future_timestamps(item: InferenceSeries) -> tuple[datetime, ...]:
    candle_seconds = chronos2_interval_seconds(item)
    steps = chronos2_native_prediction_steps(item)
    origin = item.bars[-1].timestamp
    timestamps = tuple(origin + timedelta(seconds=candle_seconds * (index + 1)) for index in range(steps))
    if timestamps[-1] != item.future_timestamps[-1]:
        raise ValueError("Chronos-2 native prediction grid does not end at the requested horizon")
    return timestamps


def _validated_native_future_timestamps(
    item: InferenceSeries,
    candle_seconds: int,
    prediction_steps: int,
) -> tuple[datetime, ...]:
    expected_steps = len(item.future_timestamps) * 60 // candle_seconds
    if (
        expected_steps != prediction_steps
        or expected_steps * candle_seconds
        != len(item.future_timestamps) * 60
    ):
        raise ValueError(
            "Chronos-2 prepared prediction length differs from the native cadence"
        )
    origin = item.bars[-1].timestamp
    timestamps = tuple(
        origin + timedelta(seconds=candle_seconds * (index + 1))
        for index in range(prediction_steps)
    )
    if timestamps[-1] != item.future_timestamps[-1]:
        raise ValueError(
            "Chronos-2 native prediction grid does not end at the requested horizon"
        )
    return timestamps


def chronos2_raw_input(
    item: InferenceSeries,
    profile: Chronos2InputProfile,
    *,
    context_bars: int = CHRONOS2_CONTEXT_BARS,
) -> dict[str, Any]:
    if context_bars not in CHRONOS2_CONTEXT_WINDOWS:
        raise ValueError("Chronos-2 context bars must be one of 512/1024/2048/4096/8192")
    if len(item.bars) != context_bars:
        raise ValueError(f"Chronos-2 requires exactly {context_bars} complete context bars")
    chronos2_interval_seconds(item)
    target = np.asarray([bar.close for bar in item.bars], dtype=np.float32)
    if not np.isfinite(target).all() or np.any(target <= 0):
        raise ValueError("Chronos-2 target close context must be finite and positive")
    feature_names = chronos2_feature_names(profile)
    known_future_names = set(chronos2_known_future_names(profile))
    past_rows = [
        _bar_features(
            bar,
            timezone_name=item.timezone,
            profile=profile,
        )
        for bar in item.bars
    ]
    past_covariates = {name: np.asarray([row[name] for row in past_rows], dtype=np.float32) for name in feature_names}
    future_rows = [_calendar_features(timestamp, item.timezone) for timestamp in _native_future_timestamps(item)]
    future_covariates = {
        name: np.asarray([row[name] for row in future_rows], dtype=np.float32)
        for name in feature_names
        if name in known_future_names
    }
    return {
        "target": target,
        **({"past_covariates": past_covariates} if past_covariates else {}),
        **({"future_covariates": future_covariates} if future_covariates else {}),
    }


def chronos2_prepared_tensors(
    items: Sequence[InferenceSeries],
    profile: Chronos2InputProfile,
    *,
    prediction_steps: int = CHRONOS2_PREDICTION_STEPS,
    context_bars: int = CHRONOS2_CONTEXT_BARS,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, tuple[str, ...]]:
    """Build the exact fixed-shape tensors consumed by the direct model path.

    Rows are flattened by task: target first, followed by past covariates in
    `chronos2_feature_names()` order. Unknown future entries are represented by
    a zero value plus an explicit zero mask, avoiding NaNs in mmap artifacts.
    """

    if prediction_steps < 1 or prediction_steps > CHRONOS2_MAX_DIRECT_PREDICTION_STEPS:
        raise ValueError("Chronos-2 prediction steps must fit the direct output-patch capacity")
    if context_bars not in CHRONOS2_CONTEXT_WINDOWS:
        raise ValueError("Chronos-2 context bars must be one of 512/1024/2048/4096/8192")
    padded_prediction_steps = math.ceil(prediction_steps / CHRONOS2_OUTPUT_PATCH_SIZE) * CHRONOS2_OUTPUT_PATCH_SIZE
    feature_names = chronos2_feature_names(profile)
    known_future = set(chronos2_known_future_names(profile))
    variate_names = ("target_close", *feature_names)
    contexts = np.empty(
        (len(items), len(variate_names), context_bars),
        dtype=np.float32,
    )
    future = np.zeros(
        (len(items), len(variate_names), padded_prediction_steps),
        dtype=np.float32,
    )
    future_mask = np.zeros_like(future, dtype=np.uint8)
    for task_index, item in enumerate(items):
        candle_seconds = chronos2_interval_seconds(item)
        contexts[task_index, 0] = _float32_column(
            bar.close for bar in item.bars
        )
        past = _feature_columns(item, profile)
        future_timestamps = _validated_native_future_timestamps(
            item,
            candle_seconds,
            prediction_steps,
        )
        future_values = _calendar_columns(
            future_timestamps,
            item.timezone,
        )
        for feature_index, name in enumerate(feature_names, start=1):
            contexts[task_index, feature_index] = past[name]
            if name in known_future:
                known = future_values[name]
                if len(known) != prediction_steps:
                    raise ValueError("Chronos-2 known future covariate length differs from the native prediction grid")
                future[task_index, feature_index, :prediction_steps] = known
                future_mask[task_index, feature_index, :prediction_steps] = 1
    context_mask = np.isfinite(contexts).astype(np.uint8)
    np.nan_to_num(contexts, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    if np.any(context_mask[:, 0] == 0):
        raise ValueError("Chronos-2 target context cannot contain missing values")
    return contexts, context_mask, future, future_mask, variate_names


def _validate_manifest(
    manifest_model: Mapping[str, Any],
    source: Mapping[str, Any],
) -> None:
    if (
        manifest_model.get("model_id") != CHRONOS_2_MODEL_ID
        or manifest_model.get("revision") != CHRONOS2_MODEL_REVISION
        or manifest_model.get("checkpoint_file") != "model.safetensors"
        or manifest_model.get("checkpoint_sha256") != CHRONOS2_CHECKPOINT_SHA256
        or manifest_model.get("loader_version") != CHRONOS2_LOADER_VERSION
        or tuple(manifest_model.get("native_quantiles", ())) != CHRONOS2_NATIVE_QUANTILES
        or manifest_model.get("context_length") != 8192
        or manifest_model.get("input_patch_size") != 16
        or manifest_model.get("output_patch_size") != 16
        or manifest_model.get("max_output_patches") != 64
        or source.get("package") != "chronos-forecasting"
        or source.get("version") != CHRONOS2_PACKAGE_VERSION
        or source.get("revision") != CHRONOS2_SOURCE_REVISION
    ):
        raise AdapterLoadError("Chronos-2 manifest identity, shape, or revision is invalid")


def _validate_checkpoint(
    model_path: Path,
    manifest_model: Mapping[str, Any],
) -> None:
    checkpoint_name = manifest_model.get("checkpoint_file")
    expected_sha256 = manifest_model.get("checkpoint_sha256")
    if (
        not isinstance(checkpoint_name, str)
        or checkpoint_name != "model.safetensors"
        or not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
    ):
        raise AdapterLoadError("Chronos-2 checkpoint manifest is invalid")
    checkpoint = model_path / checkpoint_name
    if not checkpoint.is_file() or sha256_file(checkpoint) != expected_sha256:
        raise AdapterLoadError("Chronos-2 checkpoint SHA-256 does not match the pinned manifest")


class Chronos2Adapter:
    def __init__(
        self,
        settings: AISettings,
        manifest_model: dict[str, Any],
        source: dict[str, Any],
        runtime: RuntimeDevice,
    ) -> None:
        _validate_manifest(manifest_model, source)
        try:
            installed_version = importlib.metadata.version("chronos-forecasting")
        except importlib.metadata.PackageNotFoundError as error:
            raise AdapterLoadError("chronos-forecasting is not installed") from error
        if installed_version != CHRONOS2_PACKAGE_VERSION:
            raise AdapterLoadError("installed chronos-forecasting version does not match the pinned manifest")
        model_path = _snapshot(
            settings.model_cache_dir,
            "chronos-2",
            str(manifest_model["revision"]),
        )
        _validate_checkpoint(model_path, manifest_model)
        try:
            chronos = importlib.import_module("chronos")
            pipeline = chronos.BaseChronosPipeline.from_pretrained(
                str(model_path),
                device_map=runtime.name,
                local_files_only=True,
                torch_dtype=runtime.torch.float32,
            )
            if type(pipeline).__name__ != "Chronos2Pipeline":
                raise AdapterLoadError("pinned snapshot did not resolve to Chronos2Pipeline")
            pipeline.model.eval()
            if tuple(float(value) for value in pipeline.quantiles) != CHRONOS2_NATIVE_QUANTILES:
                raise AdapterLoadError("loaded Chronos-2 native quantiles differ from the manifest")
        except AdapterLoadError:
            raise
        except Exception as error:
            raise AdapterLoadError(f"failed to load pinned Chronos-2 snapshot: {type(error).__name__}") from error
        self._settings = settings
        self._runtime = runtime
        self._pipeline = pipeline
        self._profile: Chronos2InputProfile = settings.chronos2_input_profile  # type: ignore[assignment]
        self._batch_size = settings.chronos2_batch_size
        self._inference_backend = settings.chronos2_inference_backend
        self._cuda_graph_key: tuple[int, int, int, int] | None = None
        self._cuda_graph_inference: Any | None = None
        self._provenance = _provenance(
            {
                **manifest_model,
                "loader_version": (f"{manifest_model['loader_version']}-{self._profile}-{self._inference_backend}"),
            },
            source_revision=str(source["revision"]),
            device=runtime.name,
            device_name=runtime.device_name,
            cuda_capability=runtime.cuda_capability,
            loaded=True,
            quantile_monotonicity_policy=("chronos2_fp32_monotone_rearrangement_v1"),
        )

    @property
    def provenance(self) -> ModelProvenance:
        return self._provenance

    @property
    def input_profile(self) -> Chronos2InputProfile:
        return self._profile

    @property
    def pipeline(self) -> Any:
        return self._pipeline

    def _predict_cuda_graph(
        self,
        series: Sequence[InferenceSeries],
        *,
        context_bars: int,
        interval_seconds: int,
        prediction_length: int,
    ) -> list[RawPrediction]:
        # Imported lazily to keep the public adapter module free of a circular
        # import. The graph backend is fail-closed: capture or replay errors are
        # surfaced to the service instead of silently falling back to eager.
        from .chronos2_raw_inference import Chronos2RawInference

        tensors = chronos2_prepared_tensors(
            series,
            self._profile,
            prediction_steps=prediction_length,
            context_bars=context_bars,
        )
        contexts, context_mask, future, future_mask, variate_names = tensors
        horizon_minutes = (5, 15) if len(series[0].future_timestamps) == 15 else (5, 15, 30, 60)
        horizon_steps = tuple(minute * 60 // interval_seconds for minute in horizon_minutes)
        key = (
            len(series),
            len(variate_names),
            context_bars,
            prediction_length,
        )
        if self._cuda_graph_key != key:
            # Retaining one graph for every context/cadence matrix entry would
            # accumulate private graph pools and exhaust a 24 GiB P40. The
            # benchmark evaluates one combination at a time, so keep only the
            # active fixed-shape graph.
            self._cuda_graph_inference = None
            self._cuda_graph_key = None
            if self._runtime.name == "cuda":
                self._runtime.torch.cuda.empty_cache()
            self._cuda_graph_inference = Chronos2RawInference(
                self,
                backend="cuda_graph",
                variate_names=variate_names,
                graph_task_batch_size=len(series),
                prediction_steps=prediction_length,
                horizon_steps=horizon_steps,
            )
            self._cuda_graph_key = key
        inference = self._cuda_graph_inference
        if not isinstance(inference, Chronos2RawInference):
            raise RuntimeError("Chronos-2 CUDA Graph runtime was not initialized")
        observation = inference.predict(
            contexts,
            context_mask,
            future,
            future_mask,
            variate_batch_size=self._batch_size,
        )
        expected_shape = (
            len(series),
            len(horizon_minutes),
            1 + len(CHRONOS2_NATIVE_QUANTILES),
        )
        if observation.output.shape != expected_shape:
            raise RuntimeError("Chronos-2 CUDA Graph returned an unexpected projected shape")
        output: list[RawPrediction] = []
        for task_index, item in enumerate(series):
            close_quantiles = {
                horizon: {
                    quantile: float(
                        observation.output[
                            task_index,
                            horizon_index,
                            quantile_index + 1,
                        ]
                    )
                    for quantile_index, quantile in enumerate(CHRONOS2_NATIVE_QUANTILES)
                }
                for horizon_index, horizon in enumerate(horizon_minutes)
            }
            output.append(
                RawPrediction(
                    instrument_key=item.instrument_key,
                    close_quantiles=close_quantiles,
                )
            )
        return output

    def predict_batch(
        self,
        series: Sequence[InferenceSeries],
        *,
        seed: int,
    ) -> list[RawPrediction]:
        del seed
        if not series:
            return []
        result_steps = len(series[0].future_timestamps)
        if result_steps not in {15, 60} or any(len(item.future_timestamps) != result_steps for item in series):
            raise ValueError("Chronos-2 batch prediction horizon must be uniformly 15 or 60")
        context_bars = len(series[0].bars)
        if context_bars not in CHRONOS2_CONTEXT_WINDOWS or any(len(item.bars) != context_bars for item in series):
            raise ValueError("Chronos-2 batch context must use one supported uniform window")
        intervals = tuple(chronos2_interval_seconds(item) for item in series)
        if len(set(intervals)) != 1:
            raise ValueError("Chronos-2 batch series must use one native cadence")
        interval_seconds = intervals[0]
        prediction_length = result_steps * 60 // interval_seconds
        if (
            prediction_length * interval_seconds != result_steps * 60
            or prediction_length > CHRONOS2_MAX_DIRECT_PREDICTION_STEPS
        ):
            raise ValueError("Chronos-2 requested horizon exceeds the direct output-patch capacity")
        if getattr(self, "_inference_backend", "pipeline_eager") == "cuda_graph":
            return self._predict_cuda_graph(
                series,
                context_bars=context_bars,
                interval_seconds=interval_seconds,
                prediction_length=prediction_length,
            )
        inputs = [
            chronos2_raw_input(
                item,
                self._profile,
                context_bars=context_bars,
            )
            for item in series
        ]
        torch = self._runtime.torch
        with math_sdpa(torch), torch.inference_mode():
            predictions = self._pipeline.predict(
                inputs,
                prediction_length=prediction_length,
                batch_size=self._batch_size,
                context_length=context_bars,
                cross_learning=False,
                limit_prediction_length=False,
                max_output_patches=CHRONOS2_MAX_OUTPUT_PATCHES,
            )
        if len(predictions) != len(series):
            raise RuntimeError("Chronos-2 pipeline returned a misaligned task count")
        output: list[RawPrediction] = []
        horizons = (5, 15) if result_steps == 15 else (5, 15, 30, 60)
        for item, prediction in zip(series, predictions, strict=True):
            values = prediction.detach().to(dtype=torch.float32, device="cpu").numpy()
            if values.shape != (1, len(CHRONOS2_NATIVE_QUANTILES), prediction_length):
                raise RuntimeError("Chronos-2 pipeline returned an unexpected tensor shape")
            native = np.sort(values[0], axis=0)
            close_quantiles = {
                horizon: {
                    quantile: float(native[index, horizon * 60 // interval_seconds - 1])
                    for index, quantile in enumerate(CHRONOS2_NATIVE_QUANTILES)
                }
                for horizon in horizons
            }
            output.append(
                RawPrediction(
                    instrument_key=item.instrument_key,
                    close_quantiles=close_quantiles,
                )
            )
        return output


def chronos2_weights_path(model_cache_dir: Path) -> Path:
    return model_cache_dir / "chronos-2" / "model.safetensors"
