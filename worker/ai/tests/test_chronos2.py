from __future__ import annotations

from contextlib import nullcontext
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from portfolio_ai_worker.adapters import AdapterLoadError, InferenceSeries, RuntimeDevice
from portfolio_ai_worker.chronos2 import (
    CHRONOS2_CONTEXT_BARS,
    CHRONOS2_CONTEXT_WINDOWS,
    CHRONOS2_MAX_OUTPUT_PATCHES,
    CHRONOS2_NATIVE_QUANTILES,
    Chronos2Adapter,
    _validate_checkpoint,
    chronos2_feature_names,
    chronos2_known_future_names,
    chronos2_native_prediction_steps,
    chronos2_prepared_tensors,
    chronos2_raw_input,
)
from portfolio_ai_worker.chronos2_generator import (
    CHRONOS2_DEFAULT_BACKEND,
    CHRONOS2_DEFAULT_VARIATE_BATCH,
    selected_backend,
    selected_variate_batch_size,
)
from portfolio_ai_worker.contracts import PriceBar, SeriesCadence


def _series(
    *,
    future_offset_minutes: int = 0,
    omit_derivatives_every: int | None = None,
    context_bars: int = CHRONOS2_CONTEXT_BARS,
    candle_seconds: int = 60,
) -> InferenceSeries:
    start = datetime(2026, 6, 1, tzinfo=timezone.utc)
    bars: list[PriceBar] = []
    close = 100.0
    for index in range(context_bars):
        opening = close
        close = opening * (1 + ((index % 9) - 4) * 0.00001)
        missing = omit_derivatives_every is not None and index % omit_derivatives_every == 0
        volume = 1_000.0 + index
        amount = volume * close
        bars.append(
            PriceBar(
                timestamp=start + timedelta(seconds=candle_seconds * index),
                open=opening,
                high=max(opening, close) * 1.0002,
                low=min(opening, close) * 0.9998,
                close=close,
                volume=volume,
                amount=amount,
                trade_count=100 + index,
                taker_buy_volume=volume * 0.45,
                taker_buy_amount=amount * 0.46,
                mark_price=None if missing else close * 1.0001,
                index_price=None if missing else close * 0.9999,
                premium_index=None if missing else 0.0002,
                funding_rate=None if missing else 0.0001,
                complete=True,
            )
        )
    final = bars[-1].timestamp
    future = tuple(final + timedelta(minutes=index + future_offset_minutes) for index in range(1, 61))
    return InferenceSeries(
        instrument_key="BINANCE_USDM:BTCUSDT",
        timezone="UTC",
        bars=tuple(bars),
        future_timestamps=future,
        input_cadence=SeriesCadence(
            candle_seconds=candle_seconds,  # type: ignore[arg-type]
            gap_policy="continuous",
        ),
    )


def test_chronos2_defaults_match_five_week_p40_qualification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AI_CHRONOS2_RAW_BACKEND", raising=False)
    monkeypatch.delenv("AI_CHRONOS2_RAW_BATCH", raising=False)

    assert CHRONOS2_DEFAULT_BACKEND == "gpu_gather"
    assert CHRONOS2_DEFAULT_VARIATE_BATCH == 32
    assert selected_backend() == "gpu_gather"
    assert selected_variate_batch_size() == 32


def test_chronos2_checkpoint_cache_is_verified_before_load(tmp_path) -> None:
    checkpoint = tmp_path / "model.safetensors"
    checkpoint.write_bytes(b"pinned-offline-checkpoint")
    manifest = {
        "checkpoint_file": checkpoint.name,
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
    }

    _validate_checkpoint(tmp_path, manifest)
    checkpoint.write_bytes(b"tampered")
    with pytest.raises(AdapterLoadError, match="SHA-256"):
        _validate_checkpoint(tmp_path, manifest)


@pytest.mark.parametrize(
    ("profile", "expected_feature_count"),
    [
        ("close_only", 0),
        ("ohlcv_calendar", 10),
        ("microstructure_calendar", 13),
        ("derivatives_calendar", 17),
    ],
)
def test_chronos2_profiles_match_official_preprocessing_order(
    profile: str,
    expected_feature_count: int,
) -> None:
    from chronos.chronos2 import preprocess

    series = _series(omit_derivatives_every=17)
    raw = chronos2_raw_input(series, profile)  # type: ignore[arg-type]
    official = preprocess.from_list_of_dicts([raw], prediction_length=60)[0]
    contexts, context_mask, future, future_mask, names = chronos2_prepared_tensors(
        [series],
        profile,  # type: ignore[arg-type]
    )

    assert names == ("target_close", *chronos2_feature_names(profile))  # type: ignore[arg-type]
    assert len(names) == expected_feature_count + 1
    assert contexts.shape == (
        1,
        expected_feature_count + 1,
        CHRONOS2_CONTEXT_BARS,
    )
    assert future.shape == (1, expected_feature_count + 1, 64)
    official_context = official["context"].numpy()
    np.testing.assert_array_equal(context_mask[0], np.isfinite(official_context))
    np.testing.assert_allclose(
        contexts[0],
        np.nan_to_num(official_context, nan=0.0),
        rtol=0,
        atol=0,
    )
    official_future = official["future_covariates"].numpy()
    np.testing.assert_array_equal(future_mask[0, :, :60], np.isfinite(official_future))
    np.testing.assert_allclose(
        future[0, :, :60],
        np.nan_to_num(official_future, nan=0.0),
        rtol=0,
        atol=0,
    )
    assert not future_mask[:, :, 60:].any()
    assert not future[:, :, 60:].any()


def test_chronos2_future_calendar_is_causal_and_rejects_shifted_grid() -> None:
    original = _series()
    shifted = _series(future_offset_minutes=1)
    first = chronos2_prepared_tensors([original], "ohlcv_calendar")

    assert first[2].shape[-1] == 64
    with pytest.raises(ValueError, match="one-minute horizons"):
        chronos2_prepared_tensors([shifted], "ohlcv_calendar")
    assert set(chronos2_known_future_names("ohlcv_calendar")) == {
        "minute_of_day_sin",
        "minute_of_day_cos",
        "minute_of_week_sin",
        "minute_of_week_cos",
        "is_weekend",
    }


def test_chronos2_rejects_incomplete_or_misdeclared_context_shape() -> None:
    series = _series()
    with pytest.raises(ValueError, match=f"exactly {CHRONOS2_CONTEXT_BARS}"):
        chronos2_raw_input(
            InferenceSeries(
                instrument_key=series.instrument_key,
                timezone=series.timezone,
                bars=series.bars[:-1],
                future_timestamps=series.future_timestamps,
                input_cadence=series.input_cadence,
            ),
            "close_only",
        )
    with pytest.raises(ValueError, match="declared candle cadence"):
        chronos2_raw_input(
            InferenceSeries(
                instrument_key=series.instrument_key,
                timezone=series.timezone,
                bars=series.bars,
                future_timestamps=series.future_timestamps,
                input_cadence=SeriesCadence(candle_seconds=30, gap_policy="continuous"),
            ),
            "close_only",
        )


@pytest.mark.parametrize(
    ("candle_seconds", "expected_steps"),
    [(60, 60), (30, 120), (15, 240), (5, 720)],
)
def test_chronos2_native_horizon_steps_are_exact_and_direct(
    candle_seconds: int,
    expected_steps: int,
) -> None:
    series = _series(candle_seconds=candle_seconds)

    assert chronos2_native_prediction_steps(series) == expected_steps
    raw = chronos2_raw_input(series, "compact_causal_v1")
    for values in raw["future_covariates"].values():
        assert values.shape == (expected_steps,)
    contexts, context_mask, future, future_mask, names = chronos2_prepared_tensors(
        [series],
        "compact_causal_v1",
        prediction_steps=expected_steps,
    )
    expected_padded = ((expected_steps + 15) // 16) * 16
    assert contexts.shape[-1] == CHRONOS2_CONTEXT_BARS
    assert context_mask.shape == contexts.shape
    assert future.shape == (1, len(names), expected_padded)
    assert future_mask.shape == future.shape
    assert future_mask[:, 0].sum() == 0
    assert future_mask[:, -5:, :expected_steps].all()
    assert not future_mask[:, :, expected_steps:].any()


@pytest.mark.parametrize("context_bars", CHRONOS2_CONTEXT_WINDOWS)
def test_chronos2_close_only_supports_qualified_full_history_windows(
    context_bars: int,
) -> None:
    series = _series(context_bars=context_bars)
    raw = chronos2_raw_input(
        series,
        "close_only",
        context_bars=context_bars,
    )
    contexts, context_mask, future, future_mask, names = chronos2_prepared_tensors(
        [series],
        "close_only",
        context_bars=context_bars,
    )

    assert raw["target"].shape == (context_bars,)
    assert contexts.shape == (1, 1, context_bars)
    assert context_mask.shape == contexts.shape
    assert context_mask.all()
    assert future.shape == (1, 1, 64)
    assert not future.any()
    assert not future_mask.any()
    assert names == ("target_close",)


class _Pipeline:
    def predict(self, inputs: object, **kwargs: object) -> list[torch.Tensor]:
        assert isinstance(inputs, list)
        assert kwargs["cross_learning"] is False
        prediction_length = int(kwargs["prediction_length"])
        assert kwargs["limit_prediction_length"] is False
        assert kwargs["max_output_patches"] == CHRONOS2_MAX_OUTPUT_PATCHES
        base = torch.arange(len(CHRONOS2_NATIVE_QUANTILES), dtype=torch.float32)
        # Reverse the native quantile axis to prove the explicit FP32 monotone
        # rearrangement is applied before project quantiles are selected.
        values = base.flip(0)[:, None].expand(-1, prediction_length)
        return [values.unsqueeze(0).clone() for _item in inputs]


def test_chronos2_adapter_disables_cross_learning_and_returns_fixed_monotone_quantiles() -> None:
    adapter = object.__new__(Chronos2Adapter)
    adapter._runtime = RuntimeDevice(
        "cpu",
        SimpleNamespace(
            float32=torch.float32,
            inference_mode=lambda: nullcontext(),
        ),
    )
    adapter._pipeline = _Pipeline()
    adapter._profile = "close_only"
    adapter._batch_size = 48
    adapter._settings = SimpleNamespace(
        chronos2_context_bars=CHRONOS2_CONTEXT_BARS,
    )

    prediction = adapter.predict_batch([_series()], seed=123)[0]

    assert prediction.close_quantiles is not None
    assert tuple(prediction.close_quantiles) == (5, 15, 30, 60)
    for quantiles in prediction.close_quantiles.values():
        assert tuple(quantiles) == CHRONOS2_NATIVE_QUANTILES
        assert list(quantiles.values()) == sorted(quantiles.values())


def test_chronos2_adapter_preserves_720_step_output_without_truncation() -> None:
    adapter = object.__new__(Chronos2Adapter)
    adapter._runtime = RuntimeDevice(
        "cpu",
        SimpleNamespace(
            float32=torch.float32,
            inference_mode=lambda: nullcontext(),
        ),
    )
    adapter._pipeline = _Pipeline()
    adapter._profile = "close_only"
    adapter._batch_size = 1
    adapter._settings = SimpleNamespace()

    prediction = adapter.predict_batch(
        [_series(candle_seconds=5, context_bars=8192)],
        seed=123,
    )[0]

    assert prediction.close_quantiles is not None
    assert tuple(prediction.close_quantiles) == (5, 15, 30, 60)


def test_chronos2_adapter_materializes_only_fixed_horizons_on_cpu() -> None:
    selected_horizon_indices: list[tuple[int, ...]] = []

    class TrackingPrediction:
        shape = (1, len(CHRONOS2_NATIVE_QUANTILES), 240)

        def __getitem__(self, key: object) -> torch.Tensor:
            task_slice, quantile_slice, horizon_indices = key  # type: ignore[misc]
            assert task_slice == slice(None)
            assert quantile_slice == slice(None)
            selected_horizon_indices.append(tuple(horizon_indices))
            values = torch.arange(
                len(CHRONOS2_NATIVE_QUANTILES),
                dtype=torch.float32,
            )
            return values[None, :, None].expand(1, -1, len(horizon_indices)).clone()

    class TrackingPipeline:
        def predict(self, _inputs: object, **kwargs: object) -> list[TrackingPrediction]:
            assert kwargs["prediction_length"] == 240
            return [TrackingPrediction()]

    adapter = object.__new__(Chronos2Adapter)
    adapter._runtime = RuntimeDevice(
        "cpu",
        SimpleNamespace(
            float32=torch.float32,
            inference_mode=lambda: nullcontext(),
        ),
    )
    adapter._pipeline = TrackingPipeline()
    adapter._profile = "close_only"
    adapter._batch_size = 1
    adapter._settings = SimpleNamespace()

    prediction = adapter.predict_batch([_series(candle_seconds=15)], seed=123)[0]

    assert selected_horizon_indices == [(19, 59, 119, 239)]
    assert prediction.close_quantiles is not None
    assert tuple(prediction.close_quantiles) == (5, 15, 30, 60)


def test_chronos2_adapter_reuses_only_the_active_cuda_graph_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import portfolio_ai_worker.chronos2_raw_inference as raw_inference

    instances: list[object] = []

    class FakeGraphInference:
        def __init__(self, _adapter: object, **kwargs: object) -> None:
            self.kwargs = kwargs
            instances.append(self)

        def predict(self, contexts: np.ndarray, *_args: object, **_kwargs: object) -> object:
            tasks = contexts.shape[0]
            horizons = len(self.kwargs["horizon_steps"])  # type: ignore[arg-type]
            values = np.zeros(
                (tasks, horizons, 1 + len(CHRONOS2_NATIVE_QUANTILES)),
                dtype=np.float32,
            )
            values[:, :, 1:] = np.arange(
                len(CHRONOS2_NATIVE_QUANTILES),
                dtype=np.float32,
            )
            return SimpleNamespace(output=values)

    monkeypatch.setattr(
        raw_inference,
        "Chronos2RawInference",
        FakeGraphInference,
    )
    adapter = object.__new__(Chronos2Adapter)
    adapter._runtime = RuntimeDevice("cpu", torch)
    adapter._profile = "close_only"
    adapter._batch_size = 1
    adapter._inference_backend = "cuda_graph"
    adapter._cuda_graph_key = None
    adapter._cuda_graph_inference = None

    first = adapter.predict_batch([_series()], seed=17)
    second = adapter.predict_batch([_series()], seed=17)
    third = adapter.predict_batch(
        [_series(candle_seconds=30, context_bars=2048)],
        seed=17,
    )
    short = _series()
    fourth = adapter.predict_batch(
        [replace(short, future_timestamps=short.future_timestamps[:15])],
        seed=17,
    )

    assert len(instances) == 3
    assert len(first) == len(second) == len(third) == len(fourth) == 1
    assert instances[0].kwargs["prediction_steps"] == 60  # type: ignore[attr-defined]
    assert instances[0].kwargs["horizon_steps"] == (5, 15, 30, 60)  # type: ignore[attr-defined]
    assert instances[1].kwargs["prediction_steps"] == 120  # type: ignore[attr-defined]
    assert instances[1].kwargs["horizon_steps"] == (10, 30, 60, 120)  # type: ignore[attr-defined]
    assert instances[2].kwargs["prediction_steps"] == 15  # type: ignore[attr-defined]
    assert instances[2].kwargs["horizon_steps"] == (5, 15)  # type: ignore[attr-defined]
    assert tuple(fourth[0].close_quantiles or {}) == (5, 15)
