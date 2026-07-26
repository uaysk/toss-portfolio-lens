from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path
import hashlib
import importlib.util
import json
import math
import sys
from types import ModuleType, SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

import portfolio_ai_worker.fincast as fincast_module
from portfolio_ai_worker.adapters import AdapterLoadError
from portfolio_ai_worker.fincast import (
    FinCastAdapter,
    MemoryPressureError,
    _attention_softmax_structure_matches,
    _cast_normalized_input_to_model_dtype,
    _promote_horizon_output,
    _remember_input_dtype,
    _restore_output_dtype,
    _restore_router_outputs,
    fincast_interval_seconds,
    import_decoder_from_source,
    is_fincast_fp32_island_key,
    observe_fincast_decode_output_dtypes,
    project_native_quantiles,
    rearrange_native_quantiles,
    validate_fincast_mixed_inference_observations,
    validate_fincast_mixed_model_dtypes,
    verify_pinned_attention_softmax_structure,
)
from portfolio_ai_worker.adapters import InferenceSeries
from portfolio_ai_worker.contracts import (
    FINCAST_QUALIFICATION_CASE_COUNT,
    FINCAST_QUALIFICATION_NATIVE_HORIZON_STEPS,
    FINCAST_QUALIFICATION_ROW_COUNT,
    PriceBar,
    SeriesCadence,
)
from portfolio_ai_worker.precision_validation import (
    FinCastPrecisionValidation,
    MixedPrecisionMetrics,
    PrecisionArtifact,
    QualificationEnvironment,
    QuantileRearrangementObservations,
    cost_exceeding_direction,
    load_precision_validation,
    precision_failure_reasons,
    qualification_environment_from_torch,
    serialize_precision_validation,
    validate_qualification_runtime,
)


def _artifact(file: str, peak: int, *, complete: bool = True) -> PrecisionArtifact:
    return PrecisionArtifact(
        file=file,
        sha256="a" * 64,
        peak_vram_bytes=peak,
        peak_vram_measurement="cuda_allocated_or_reserved",
        peak_vram_measurement_complete=complete,
    )


def _quantile_observations(
    *,
    non_finite_value_count: int = 0,
    postprocessed_monotonic: bool = True,
) -> QuantileRearrangementObservations:
    return QuantileRearrangementObservations(
        row_count=FINCAST_QUALIFICATION_ROW_COUNT,
        non_finite_value_count=non_finite_value_count,
        crossing_row_count=0,
        crossing_adjacent_pair_count=0,
        adjusted_row_count=0,
        q50_adjustment_iqr_ratio_median=0,
        q50_adjustment_iqr_ratio_p95=0,
        q50_adjustment_iqr_ratio_max=0,
        postprocessed_monotonic=postprocessed_monotonic,
    )


def _qualification_forecasts(
    row: list[float] | None = None,
) -> list[list[list[float]]]:
    native = row or [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]
    return [
        [list(native) for _ in range(horizon_steps)]
        for _ in range(130)
        for horizon_steps in FINCAST_QUALIFICATION_NATIVE_HORIZON_STEPS
    ]


def _qualification_contexts() -> list[dict[str, object]]:
    return [
        {
            "instrument_key": f"context-{index}",
            "closes": [5.0] * 512,
            "round_trip_cost_bps": 8.0,
        }
        for index in range(128)
    ]


def _completed_validation(metrics: MixedPrecisionMetrics) -> FinCastPrecisionValidation:
    reasons = precision_failure_reasons(metrics)
    observations = _quantile_observations()
    return FinCastPrecisionValidation(
        schema_version="fincast-precision-validation/v4",
        model_id="Vincent05R/FinCast",
        model_revision="2d7d90b159db8961d27c2cf165d51195902ef92b",
        source_revision="488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
        mixed_runtime_policy_version="fincast-mixed-runtime-policy/v2",
        qualification_environment=QualificationEnvironment(
            torch_version="2.6.0",
            cuda_runtime_version="12.4",
            gpu_name="Tesla P40",
            cuda_capability="6.1",
        ),
        context_fixture_sha256="b" * 64,
        context_count=128,
        qualification_case_count=390,
        qualification_row_count=54_600,
        context_fixture_candle_seconds=60,
        decoder_horizon_shape_candle_seconds=(15, 30, 60),
        validated_native_horizon_steps=(240, 120, 60),
        cadence_validation_scope=(
            "one-minute-close-contexts-with-native-15s-30s-60s-horizon-shapes/v1"
        ),
        scale_stress_policy=(
            "rescale-context-0-last-close-to-131072-and-0.00001/v1"
        ),
        quantile_tail_policy="tail_clamped_q10_q90",
        quantile_monotonicity_policy="fp32_monotone_rearrangement_v1",
        fp32_quantile_observations=observations,
        mixed_quantile_observations=observations,
        fp32=_artifact("model.fp32.safetensors", 10_000),
        mixed_fp16=_artifact("model.mixed-fp16.safetensors", 6_000),
        mixed_run_status="completed",
        mixed_runtime_failure=None,
        mixed_metrics=metrics,
        mixed_failure_reasons=reasons,
        selected_precision="mixed_float16" if not reasons else "float32",
    )


def _validation_script() -> object:
    script = Path(__file__).resolve().parents[3] / "scripts" / "validate-fincast-precision.py"
    module_name = "validate_fincast_precision_test"
    specification = importlib.util.spec_from_file_location(module_name, script)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[module_name] = module
    specification.loader.exec_module(module)
    return module


def _prepare_script() -> object:
    script = Path(__file__).resolve().parents[3] / "scripts" / "prepare-fincast-model-cache.py"
    module_name = "prepare_fincast_model_cache_test"
    specification = importlib.util.spec_from_file_location(module_name, script)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[module_name] = module
    specification.loader.exec_module(module)
    return module


def _qualification_torch(cuda: object | None = None) -> object:
    bounded_cuda = cuda or SimpleNamespace(
        get_device_name=lambda: "Tesla P40",
        get_device_capability=lambda: (6, 1),
    )
    return SimpleNamespace(
        __version__="2.6.0+cu124",
        version=SimpleNamespace(cuda="12.4"),
        cuda=bounded_cuda,
    )


def test_native_quantiles_use_deterministic_rearrangement_and_documented_tail_clamp() -> None:
    projected = project_native_quantiles((10, 20, 30, 40, 50, 60, 70, 80, 90))

    assert tuple(projected) == (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)
    assert projected == {
        0.05: 10,
        0.1: 10,
        0.25: 25,
        0.5: 50,
        0.75: 75,
        0.9: 90,
        0.95: 90,
    }
    crossing = (90, 20, 70, 40, 50, 60, 30, 80, 10)
    assert rearrange_native_quantiles(crossing) == (10, 20, 30, 40, 50, 60, 70, 80, 90)
    assert rearrange_native_quantiles(crossing) == rearrange_native_quantiles(crossing)
    assert project_native_quantiles(crossing) == projected


@pytest.mark.parametrize("seconds", (15, 30, 60))
def test_fincast_interval_seconds_accepts_supported_continuous_contexts(seconds: int) -> None:
    start = datetime(2026, 7, 26, tzinfo=timezone.utc)
    bars = tuple(
        PriceBar(
            timestamp=start + timedelta(seconds=index * seconds),
            open=100,
            high=101,
            low=99,
            close=100,
            volume=1,
            amount=100,
            complete=True,
        )
        for index in range(512)
    )
    series = InferenceSeries(
        instrument_key="BTCUSDT",
        timezone="UTC",
        bars=bars,
        future_timestamps=tuple(
            bars[-1].timestamp + timedelta(minutes=index + 1)
            for index in range(60)
        ),
    )

    assert fincast_interval_seconds(series) == seconds


def test_fincast_interval_seconds_rejects_non_continuous_context() -> None:
    start = datetime(2026, 7, 26, tzinfo=timezone.utc)
    timestamps = [
        start + timedelta(seconds=index * 15)
        for index in range(512)
    ]
    timestamps[-1] += timedelta(seconds=15)
    series = InferenceSeries(
        instrument_key="BTCUSDT",
        timezone="UTC",
        bars=tuple(
            PriceBar(
                timestamp=timestamp,
                open=100,
                high=101,
                low=99,
                close=100,
                volume=1,
                amount=100,
                complete=True,
            )
            for timestamp in timestamps
        ),
        future_timestamps=tuple(
            timestamps[-1] + timedelta(minutes=index + 1)
            for index in range(60)
        ),
    )

    with pytest.raises(ValueError, match="continuous"):
        fincast_interval_seconds(series)


def test_fincast_interval_seconds_rejects_gap_before_the_last_sixteen_bars() -> None:
    start = datetime(2026, 7, 26, tzinfo=timezone.utc)
    timestamps = tuple(
        start + timedelta(seconds=index * 15 + (15 if index >= 32 else 0))
        for index in range(512)
    )
    series = InferenceSeries(
        instrument_key="BTCUSDT",
        timezone="UTC",
        bars=tuple(
            PriceBar(
                timestamp=timestamp,
                open=100,
                high=101,
                low=99,
                close=100,
                volume=1,
                amount=100,
                complete=True,
            )
            for timestamp in timestamps
        ),
        future_timestamps=tuple(
            timestamps[-1] + timedelta(minutes=index + 1)
            for index in range(60)
        ),
    )

    with pytest.raises(ValueError, match="continuous"):
        fincast_interval_seconds(series)


def _stock_session_series(
    instrument_key: str,
    timezone_name: str,
    *,
    input_cadence: SeriesCadence | None,
    next_session_offset_seconds: int = 0,
) -> InferenceSeries:
    local_timezone = ZoneInfo(timezone_name)
    first_session = datetime(2026, 7, 20, 9, 1, tzinfo=local_timezone)
    second_session = datetime(
        2026,
        7,
        21,
        9,
        1,
        tzinfo=local_timezone,
    ) + timedelta(seconds=next_session_offset_seconds)
    timestamps = tuple(
        first_session + timedelta(minutes=index)
        for index in range(300)
    ) + tuple(
        second_session + timedelta(minutes=index)
        for index in range(212)
    )
    bars = tuple(
        PriceBar(
            timestamp=timestamp.astimezone(timezone.utc),
            open=100 + index * 0.01,
            high=101 + index * 0.01,
            low=99 + index * 0.01,
            close=100.5 + index * 0.01,
            volume=1_000 + index,
            amount=(1_000 + index) * (100.5 + index * 0.01),
            complete=True,
        )
        for index, timestamp in enumerate(timestamps)
    )
    return InferenceSeries(
        instrument_key=instrument_key,
        timezone=timezone_name,
        bars=bars,
        future_timestamps=tuple(
            bars[-1].timestamp + timedelta(minutes=index + 1)
            for index in range(60)
        ),
        input_cadence=input_cadence,
    )


@pytest.mark.parametrize(
    ("instrument_key", "timezone_name"),
    (
        ("005930", "Asia/Seoul"),
        ("AAPL", "America/New_York"),
    ),
)
def test_fincast_accepts_prevalidated_kr_us_trading_minute_session_gaps(
    instrument_key: str,
    timezone_name: str,
) -> None:
    series = _stock_session_series(
        instrument_key,
        timezone_name,
        input_cadence=SeriesCadence(
            candle_seconds=60,
            gap_policy="market_session_prevalidated",
        ),
    )

    assert len(series.bars) == 512
    assert fincast_interval_seconds(series) == 60


def test_fincast_stock_session_gaps_require_explicit_prevalidated_policy() -> None:
    series = _stock_session_series(
        "AAPL",
        "America/New_York",
        input_cadence=None,
    )

    with pytest.raises(ValueError, match="undeclared context bars must be continuous"):
        fincast_interval_seconds(series)


def test_fincast_stock_session_gaps_remain_minute_aligned_and_timezone_bounded() -> None:
    cadence = SeriesCadence(
        candle_seconds=60,
        gap_policy="market_session_prevalidated",
    )
    unaligned = _stock_session_series(
        "005930",
        "Asia/Seoul",
        input_cadence=cadence,
        next_session_offset_seconds=30,
    )
    unsupported_timezone = _stock_session_series(
        "LSE:VOD",
        "Europe/London",
        input_cadence=cadence,
    )

    with pytest.raises(ValueError, match="minute-aligned"):
        fincast_interval_seconds(unaligned)
    with pytest.raises(ValueError, match="only KR or US"):
        fincast_interval_seconds(unsupported_timezone)


def test_fincast_rejects_more_than_512_context_bars_instead_of_slicing() -> None:
    start = datetime(2026, 7, 26, tzinfo=timezone.utc)
    bars = tuple(
        PriceBar(
            timestamp=start + timedelta(minutes=index),
            open=100,
            high=101,
            low=99,
            close=100,
            complete=True,
        )
        for index in range(513)
    )
    series = InferenceSeries(
        instrument_key="BINANCE_USDM:BTCUSDT",
        timezone="UTC",
        bars=bars,
        future_timestamps=tuple(
            bars[-1].timestamp + timedelta(minutes=index + 1)
            for index in range(60)
        ),
    )

    with pytest.raises(ValueError, match="exactly 512"):
        fincast_interval_seconds(series)


def test_qualification_cases_bind_native_cadences_and_price_scale_stress() -> None:
    module = _validation_script()

    cases = module._qualification_cases(_qualification_contexts())

    assert len(cases) == FINCAST_QUALIFICATION_CASE_COUNT
    assert [
        (case.candle_seconds, case.horizon_steps)
        for case in cases[:3]
    ] == [(15, 240), (30, 120), (60, 60)]
    assert {
        (seconds, steps): sum(
            case.candle_seconds == seconds and case.horizon_steps == steps
            for case in cases
        )
        for seconds, steps in ((15, 240), (30, 120), (60, 60))
    } == {(15, 240): 130, (30, 120): 130, (60, 60): 130}
    assert [case.closes[-1] for case in cases[-6:-3]] == [131_072.0] * 3
    assert [case.closes[-1] for case in cases[-3:]] == [0.000_01] * 3
    assert all(
        value > 65_504
        for case in cases[-6:-3]
        for value in case.closes
    )
    assert all(value > 0 for case in cases[-3:] for value in case.closes)
    assert max(value for case in cases[-3:] for value in case.closes) == pytest.approx(
        0.000_01
    )


def test_qualification_forecast_decodes_every_case_at_its_native_horizon(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _validation_script()
    decode_calls: list[dict[str, object]] = []
    tensor_last_closes: list[float] = []
    zero_calls: list[tuple[object, object]] = []

    class FakeOutput:
        def __init__(self, horizon_steps: int) -> None:
            self.rows = [
                [float(index) for index in range(1, 10)]
                for _ in range(horizon_steps)
            ]

        def __getitem__(self, _key: object) -> "FakeOutput":
            return self

        def float(self) -> "FakeOutput":
            return self

        def cpu(self) -> "FakeOutput":
            return self

        def tolist(self) -> list[list[float]]:
            return self.rows

    class FakeModel:
        def decode(self, **kwargs: object) -> tuple[None, FakeOutput]:
            decode_calls.append(kwargs)
            return None, FakeOutput(int(kwargs["horizon_len"]))  # type: ignore[arg-type]

    class FakeTorch:
        float32 = "torch.float32"
        float16 = "torch.float16"
        long = "torch.int64"

        def __init__(self) -> None:
            self.cuda = SimpleNamespace(manual_seed_all=lambda _seed: None)

        def manual_seed(self, _seed: int) -> None:
            return None

        def tensor(self, values: object, *, dtype: object, device: str) -> object:
            del dtype, device
            tensor_last_closes.append(float(values[0][-1]))  # type: ignore[index]
            return values

        def zeros(self, shape: object, *, dtype: object, device: str) -> object:
            del device
            zero_calls.append((shape, dtype))
            return shape

        def inference_mode(self) -> object:
            return nullcontext()

    original_postprocess = module._postprocess_qualification_forecasts

    def checked_postprocess(
        forecasts: list[list[list[float]]],
    ) -> tuple[list[list[list[float]]], QuantileRearrangementObservations]:
        module._require_qualification_forecast_shape(forecasts)
        return forecasts, _quantile_observations()

    monkeypatch.setattr(
        module,
        "_postprocess_qualification_forecasts",
        checked_postprocess,
    )
    forecasts, observations = module._forecast(
        FakeModel(),
        _qualification_contexts(),
        FakeTorch(),
        "float32",
    )
    monkeypatch.setattr(
        module,
        "_postprocess_qualification_forecasts",
        original_postprocess,
    )

    assert len(forecasts) == FINCAST_QUALIFICATION_CASE_COUNT
    assert observations.row_count == FINCAST_QUALIFICATION_ROW_COUNT
    assert [call["horizon_len"] for call in decode_calls] == list(
        FINCAST_QUALIFICATION_NATIVE_HORIZON_STEPS
    ) * 130
    assert [
        call["paddings"]
        for call in decode_calls[-3:]
    ] == [(1, 752), (1, 632), (1, 572)]
    assert tensor_last_closes[-6:-3] == [131_072.0] * 3
    assert tensor_last_closes[-3:] == [0.000_01] * 3
    assert zero_calls[-6:] == [
        ((1, 752), "torch.float32"),
        ((1, 1), "torch.int64"),
        ((1, 632), "torch.float32"),
        ((1, 1), "torch.int64"),
        ((1, 572), "torch.float32"),
        ((1, 1), "torch.int64"),
    ]


@pytest.mark.parametrize(
    ("seconds", "expected_horizon_steps"),
    ((15, 240), (30, 120), (60, 60)),
)
def test_fincast_mixed_runtime_keeps_high_raw_prices_fp32_until_model_normalization(
    seconds: int,
    expected_horizon_steps: int,
) -> None:
    tensor_calls: list[dict[str, object]] = []
    zero_calls: list[dict[str, object]] = []

    class FakeTensor:
        def __init__(self, values: object) -> None:
            self.values = values

        def float(self) -> "FakeTensor":
            return self

        def cpu(self) -> "FakeTensor":
            return self

        def tolist(self) -> object:
            return self.values

    class FakeTorch:
        float16 = "torch.float16"
        float32 = "torch.float32"
        long = "torch.int64"

        def __init__(self) -> None:
            self.cuda = SimpleNamespace(manual_seed_all=lambda _seed: None)

        def manual_seed(self, _seed: int) -> None:
            return None

        def tensor(self, values: object, *, dtype: object, device: str) -> FakeTensor:
            tensor_calls.append({"values": values, "dtype": dtype, "device": device})
            return FakeTensor(values)

        def zeros(self, shape: object, *, dtype: object, device: str) -> FakeTensor:
            zero_calls.append({"shape": shape, "dtype": dtype, "device": device})
            rows, columns = shape  # type: ignore[misc]
            return FakeTensor([[0 for _ in range(columns)] for _ in range(rows)])

        def inference_mode(self) -> object:
            return nullcontext()

    class FakeModel:
        def __init__(self) -> None:
            self.call: dict[str, object] | None = None

        def decode(self, **kwargs: object) -> tuple[None, FakeTensor]:
            self.call = kwargs
            rows = [
                [
                    100_000.0,
                    99_000.0,
                    99_200.0,
                    99_400.0,
                    99_600.0,
                    100_000.0,
                    100_400.0,
                    100_600.0,
                    100_800.0,
                    101_000.0,
                ]
                for _ in range(expected_horizon_steps)
            ]
            return None, FakeTensor([rows])

    start = datetime(2026, 7, 26, tzinfo=timezone.utc)
    bars = tuple(
        PriceBar(
            timestamp=start + timedelta(seconds=index * seconds),
            open=100_000.0 + index * 0.01,
            high=100_001.0 + index * 0.01,
            low=99_999.0 + index * 0.01,
            close=100_000.5 + index * 0.01,
            volume=2,
            amount=200_001.0 + index * 0.02,
            complete=True,
        )
        for index in range(512)
    )
    item = InferenceSeries(
        instrument_key="BTCUSDT",
        timezone="UTC",
        bars=bars,
        future_timestamps=tuple(
            bars[-1].timestamp + timedelta(minutes=index + 1)
            for index in range(60)
        ),
    )
    torch = FakeTorch()
    model = FakeModel()
    adapter = object.__new__(FinCastAdapter)
    adapter._runtime = SimpleNamespace(torch=torch, name="cuda")
    adapter._context_bars = 512
    adapter._model = model
    adapter._precision = "mixed_float16"

    result = adapter.predict_batch((item,), seed=7)

    assert tensor_calls[0]["dtype"] == "torch.float32"
    captured_context = tensor_calls[0]["values"]
    assert isinstance(captured_context, list)
    assert len(captured_context) == 1
    assert len(captured_context[0]) == 512
    assert captured_context[0] == [bar.close for bar in bars]
    assert captured_context[0] != [bar.open for bar in bars]
    assert captured_context[0] != [bar.high for bar in bars]
    assert captured_context[0] != [bar.low for bar in bars]
    assert captured_context[0] != [bar.volume for bar in bars]
    assert captured_context[0] != [bar.amount for bar in bars]
    assert not any(isinstance(value, datetime) for value in captured_context[0])
    assert all(math.isfinite(value) and value > 65_504 for value in captured_context[0])
    assert zero_calls[0] == {
        "shape": (1, 512 + expected_horizon_steps),
        "dtype": "torch.float16",
        "device": "cuda",
    }
    assert zero_calls[1] == {
        "shape": (1, 1),
        "dtype": "torch.int64",
        "device": "cuda",
    }
    assert model.call is not None
    assert set(model.call) == {
        "input_ts",
        "paddings",
        "freq",
        "horizon_len",
        "output_patch_len",
        "max_len",
        "return_forecast_on_context",
    }
    assert model.call["input_ts"].values == captured_context  # type: ignore[union-attr]
    padding_values = model.call["paddings"].values  # type: ignore[union-attr]
    assert len(padding_values) == 1
    assert len(padding_values[0]) == 512 + expected_horizon_steps
    assert set(padding_values[0]) == {0}
    assert model.call["freq"].values == [[0]]  # type: ignore[union-attr]
    assert model.call["horizon_len"] == expected_horizon_steps
    assert model.call["max_len"] == 512
    assert result[0].close_quantiles is not None


def test_native_quantile_rearrangement_leaves_monotonic_values_unchanged() -> None:
    native = (10.0, 20.0, 20.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0)

    assert rearrange_native_quantiles(native) == native


@pytest.mark.parametrize("invalid", (float("nan"), float("inf"), float("-inf")))
def test_native_quantile_rearrangement_rejects_non_finite_values(invalid: float) -> None:
    native = (10.0, 20.0, 30.0, 40.0, invalid, 60.0, 70.0, 80.0, 90.0)

    with pytest.raises(ValueError, match="non-finite"):
        rearrange_native_quantiles(native)
    with pytest.raises(ValueError, match="non-finite"):
        project_native_quantiles(native)


def test_qualification_rearrangement_matches_runtime_projection() -> None:
    module = _validation_script()
    reference = [9.0, 2.0, 7.0, 4.0, 5.0, 6.0, 3.0, 8.0, 1.0]
    candidate = [9.1, 2.1, 7.1, 4.1, 5.1, 6.1, 3.1, 8.1, 1.1]
    reference_forecasts = _qualification_forecasts(reference)
    candidate_forecasts = _qualification_forecasts(candidate)
    contexts = _qualification_contexts()
    cases = module._qualification_cases(contexts)

    normalized_reference, reference_observations = (
        module._postprocess_qualification_forecasts(reference_forecasts)
    )
    normalized_candidate, candidate_observations = (
        module._postprocess_qualification_forecasts(candidate_forecasts)
    )
    runtime_reference = project_native_quantiles(reference)
    runtime_candidate = project_native_quantiles(candidate)
    metrics = module.qualification_metrics(
        normalized_reference,
        normalized_candidate,
        cases,
        10_000,
        6_000,
    )

    assert normalized_reference[0][0] == list(rearrange_native_quantiles(reference))
    assert normalized_candidate[0][0] == list(rearrange_native_quantiles(candidate))
    assert reference_observations.row_count == FINCAST_QUALIFICATION_ROW_COUNT
    assert (
        reference_observations.crossing_row_count
        == FINCAST_QUALIFICATION_ROW_COUNT
    )
    assert (
        reference_observations.adjusted_row_count
        == FINCAST_QUALIFICATION_ROW_COUNT
    )
    assert reference_observations.postprocessed_monotonic is True
    assert candidate_observations.postprocessed_monotonic is True
    assert metrics.quantile_monotonic is True
    expected_scale = runtime_reference[0.75] - runtime_reference[0.25]
    assert metrics.q50_median_iqr_ratio == pytest.approx(
        abs(runtime_candidate[0.5] - runtime_reference[0.5]) / expected_scale
    )


def test_qualification_rejects_wrong_native_cadence_shape_even_when_total_matches() -> None:
    module = _validation_script()
    row = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]
    malformed = _qualification_forecasts(row)
    malformed[0] = [row] * 239
    malformed[1] = [row] * 121

    with pytest.raises(ValueError, match="390 ordered native-cadence cases"):
        module._postprocess_qualification_forecasts(malformed)

    with pytest.raises(ValueError, match="390 ordered native-cadence cases"):
        module._postprocess_qualification_forecasts(malformed[:-1])


def test_rearrangement_adjustment_ratios_use_only_adjusted_rows_and_postprocessed_iqr() -> None:
    module = _validation_script()
    forecasts = _qualification_forecasts()
    forecasts[0][0] = [9.0, 2.0, 7.0, 4.0, 1.0, 6.0, 3.0, 8.0, 5.0]

    _normalized, observations = module._postprocess_qualification_forecasts(forecasts)

    assert observations.adjusted_row_count == 1
    assert observations.q50_adjustment_iqr_ratio_median == pytest.approx(0.8)
    assert observations.q50_adjustment_iqr_ratio_p95 == pytest.approx(0.8)
    assert observations.q50_adjustment_iqr_ratio_max == pytest.approx(0.8)

    _unchanged, unchanged_observations = module._postprocess_qualification_forecasts(
        _qualification_forecasts()
    )
    assert unchanged_observations.adjusted_row_count == 0
    assert (
        unchanged_observations.q50_adjustment_iqr_ratio_median,
        unchanged_observations.q50_adjustment_iqr_ratio_p95,
        unchanged_observations.q50_adjustment_iqr_ratio_max,
    ) == (0, 0, 0)
    invalid_summary = unchanged_observations.model_dump(mode="python")
    invalid_summary["q50_adjustment_iqr_ratio_max"] = 0.1
    with pytest.raises(ValidationError, match="unadjusted quantile output"):
        QuantileRearrangementObservations.model_validate(invalid_summary)


def test_precision_gate_requires_every_fixed_threshold() -> None:
    passing = MixedPrecisionMetrics(
        finite=True,
        quantile_monotonic=True,
        signal_direction_agreement=0.99,
        q50_median_iqr_ratio=0.05,
        q50_p95_iqr_ratio=0.15,
        peak_vram_reduction=0.25,
    )
    assert precision_failure_reasons(passing) == ()
    failing = passing.model_copy(
        update={
            "finite": False,
            "quantile_monotonic": False,
            "signal_direction_agreement": 0.989,
            "q50_median_iqr_ratio": 0.051,
            "q50_p95_iqr_ratio": 0.151,
            "peak_vram_reduction": 0.249,
        }
    )
    assert precision_failure_reasons(failing) == (
        "non_finite_output",
        "signal_direction_agreement_below_99pct",
        "q50_median_error_above_5pct_fp32_iqr",
        "q50_p95_error_above_15pct_fp32_iqr",
        "peak_vram_reduction_below_25pct",
    )
    postprocessing_failure = passing.model_copy(update={"quantile_monotonic": False})
    assert precision_failure_reasons(postprocessing_failure) == (
        "quantile_postprocessing_failed",
    )


def test_cost_exceeding_direction_matches_node_cdf_threshold_and_tie_policy() -> None:
    assert cost_exceeding_direction([(0.1, -0.02), (0.5, 0.01), (0.9, 0.04)], 0.001) == 1
    assert cost_exceeding_direction([(0.1, -0.04), (0.5, -0.01), (0.9, 0.02)], 0.001) == -1
    assert cost_exceeding_direction([(0.1, -0.001), (0.5, 0), (0.9, 0.001)], 0.01) == 0


def test_failed_mixed_validation_selects_lossless_fp32_artifact() -> None:
    metrics = MixedPrecisionMetrics(
        finite=True,
        quantile_monotonic=True,
        signal_direction_agreement=0.98,
        q50_median_iqr_ratio=0.01,
        q50_p95_iqr_ratio=0.02,
        peak_vram_reduction=0.4,
    )
    validation = _completed_validation(metrics)
    assert validation.selected_precision == "float32"
    with pytest.raises(ValidationError, match="selected precision"):
        validation.model_copy(update={"selected_precision": "mixed_float16"}).model_validate(
            validation.model_copy(update={"selected_precision": "mixed_float16"}).model_dump()
        )


def test_passing_mixed_qualification_selects_fp16(tmp_path: Path) -> None:
    module = _validation_script()
    output = _qualification_forecasts()
    runs = iter(
        (
            module.PrecisionRunResult(
                output,
                10_000,
                True,
                None,
                _quantile_observations(),
            ),
            module.PrecisionRunResult(
                output,
                6_000,
                True,
                None,
                _quantile_observations(),
            ),
        )
    )
    module.run_precision = lambda *_args: next(runs)
    fp32_path = tmp_path / "model.fp32.safetensors"
    mixed_path = tmp_path / "model.mixed-fp16.safetensors"
    fp32_path.write_bytes(b"fp32")
    mixed_path.write_bytes(b"mixed")
    validation = module.qualify_precision(
        Path("/unused/source"),
        fp32_path,
        mixed_path,
        _qualification_contexts(),
        "b" * 64,
        _qualification_torch(),
    )

    assert validation.mixed_run_status == "completed"
    assert validation.mixed_runtime_failure is None
    assert validation.mixed_metrics is not None
    assert validation.mixed_metrics.peak_vram_reduction == pytest.approx(0.4)
    assert validation.fp32_quantile_observations.crossing_row_count == 0
    assert validation.fp32_quantile_observations.postprocessed_monotonic is True
    assert validation.mixed_quantile_observations is not None
    assert validation.mixed_quantile_observations.crossing_row_count == 0
    assert validation.mixed_quantile_observations.postprocessed_monotonic is True
    assert validation.mixed_failure_reasons == ()
    assert validation.selected_precision == "mixed_float16"


def test_precision_validation_serializes_as_standard_finite_json() -> None:
    validation = _completed_validation(
        MixedPrecisionMetrics(
            finite=True,
            quantile_monotonic=True,
            signal_direction_agreement=1.0,
            q50_median_iqr_ratio=0.01,
            q50_p95_iqr_ratio=0.02,
            peak_vram_reduction=0.4,
        )
    )

    payload = serialize_precision_validation(validation)
    decoded = json.loads(
        payload,
        parse_constant=lambda value: pytest.fail(f"non-standard JSON number was serialized: {value}"),
    )
    assert decoded["selected_precision"] == "mixed_float16"
    assert "NaN" not in payload
    assert "Infinity" not in payload

    invalid_metrics = MixedPrecisionMetrics.model_construct(
        finite=True,
        quantile_monotonic=True,
        signal_direction_agreement=1.0,
        q50_median_iqr_ratio=float("nan"),
        q50_p95_iqr_ratio=0.02,
        peak_vram_reduction=0.4,
    )
    invalid_validation = validation.model_copy(update={"mixed_metrics": invalid_metrics})
    with pytest.raises(ValidationError):
        serialize_precision_validation(invalid_validation)


def test_precision_validation_round_trips_nonempty_failure_reasons_from_json(
    tmp_path: Path,
) -> None:
    validation = _completed_validation(
        MixedPrecisionMetrics(
            finite=True,
            quantile_monotonic=True,
            signal_direction_agreement=0.98,
            q50_median_iqr_ratio=0.01,
            q50_p95_iqr_ratio=0.02,
            peak_vram_reduction=0.4,
        )
    )
    path = tmp_path / "precision-validation.json"
    path.write_text(serialize_precision_validation(validation), encoding="utf-8")

    loaded = load_precision_validation(path)

    assert loaded == validation
    assert loaded.mixed_failure_reasons == (
        "signal_direction_agreement_below_99pct",
    )


def test_precision_validation_v4_binds_cadences_scale_policy_and_environment() -> None:
    validation = _completed_validation(
        MixedPrecisionMetrics(
            finite=True,
            quantile_monotonic=True,
            signal_direction_agreement=1.0,
            q50_median_iqr_ratio=0.01,
            q50_p95_iqr_ratio=0.02,
            peak_vram_reduction=0.4,
        )
    )
    observed = qualification_environment_from_torch(_qualification_torch())
    assert observed == validation.qualification_environment
    validate_qualification_runtime(validation, _qualification_torch())
    assert validation.qualification_case_count == 390
    assert validation.qualification_row_count == 54_600
    assert validation.context_fixture_candle_seconds == 60
    assert validation.decoder_horizon_shape_candle_seconds == (15, 30, 60)
    assert validation.validated_native_horizon_steps == (240, 120, 60)
    assert (
        validation.cadence_validation_scope
        == "one-minute-close-contexts-with-native-15s-30s-60s-horizon-shapes/v1"
    )
    assert (
        validation.scale_stress_policy
        == "rescale-context-0-last-close-to-131072-and-0.00001/v1"
    )

    missing_policy = validation.model_dump(mode="python")
    missing_policy.pop("mixed_runtime_policy_version")
    with pytest.raises(ValidationError, match="mixed_runtime_policy_version"):
        FinCastPrecisionValidation.model_validate(missing_policy)

    stale_policy = validation.model_dump(mode="python")
    stale_policy["mixed_runtime_policy_version"] = "fincast-mixed-runtime-policy/v1"
    with pytest.raises(ValidationError, match="fincast-mixed-runtime-policy/v2"):
        FinCastPrecisionValidation.model_validate(stale_policy)

    missing_environment = validation.model_dump(mode="python")
    missing_environment.pop("qualification_environment")
    with pytest.raises(ValidationError, match="qualification_environment"):
        FinCastPrecisionValidation.model_validate(missing_environment)

    missing_monotonicity_policy = validation.model_dump(mode="python")
    missing_monotonicity_policy.pop("quantile_monotonicity_policy")
    with pytest.raises(ValidationError, match="quantile_monotonicity_policy"):
        FinCastPrecisionValidation.model_validate(missing_monotonicity_policy)

    stale_schema = validation.model_dump(mode="python")
    stale_schema["schema_version"] = "fincast-precision-validation/v3"
    with pytest.raises(ValidationError, match="fincast-precision-validation/v4"):
        FinCastPrecisionValidation.model_validate(stale_schema)

    incomplete_fp32 = validation.model_dump(mode="python")
    incomplete_fp32["fp32_quantile_observations"]["row_count"] = 54_599
    with pytest.raises(ValidationError, match="54,600"):
        FinCastPrecisionValidation.model_validate(incomplete_fp32)

    incomplete_mixed = validation.model_dump(mode="python")
    incomplete_mixed["mixed_quantile_observations"]["row_count"] = 54_599
    with pytest.raises(ValidationError, match="54,600"):
        FinCastPrecisionValidation.model_validate(incomplete_mixed)

    stale_cadences = validation.model_dump(mode="python")
    stale_cadences["decoder_horizon_shape_candle_seconds"] = (60, 30, 15)
    with pytest.raises(ValidationError, match="decoder_horizon_shape_candle_seconds"):
        FinCastPrecisionValidation.model_validate(stale_cadences)

    overstated_contexts = validation.model_dump(mode="python")
    overstated_contexts["context_fixture_candle_seconds"] = 15
    with pytest.raises(ValidationError, match="context_fixture_candle_seconds"):
        FinCastPrecisionValidation.model_validate(overstated_contexts)

    missing_scope = validation.model_dump(mode="python")
    missing_scope.pop("cadence_validation_scope")
    with pytest.raises(ValidationError, match="cadence_validation_scope"):
        FinCastPrecisionValidation.model_validate(missing_scope)

    missing_scale_policy = validation.model_dump(mode="python")
    missing_scale_policy.pop("scale_stress_policy")
    with pytest.raises(ValidationError, match="scale_stress_policy"):
        FinCastPrecisionValidation.model_validate(missing_scale_policy)


@pytest.mark.parametrize(
    ("torch_version", "cuda_version", "gpu_name", "capability"),
    (
        ("2.6.1", "12.4", "Tesla P40", (6, 1)),
        ("2.6.0", "12.5", "Tesla P40", (6, 1)),
        ("2.6.0", "12.4", "Tesla P100", (6, 1)),
        ("2.6.0", "12.4", "Tesla P40", (6, 0)),
    ),
)
def test_qualification_environment_rejects_any_runtime_drift(
    torch_version: str,
    cuda_version: str,
    gpu_name: str,
    capability: tuple[int, int],
) -> None:
    torch = SimpleNamespace(
        __version__=torch_version,
        version=SimpleNamespace(cuda=cuda_version),
        cuda=SimpleNamespace(
            get_device_name=lambda: gpu_name,
            get_device_capability=lambda: capability,
        ),
    )
    with pytest.raises(ValueError, match="pinned qualification environment"):
        qualification_environment_from_torch(torch)


def _write_qualification_cache(root: Path) -> tuple[Path, dict[str, str]]:
    model = root / "fincast"
    model.mkdir(parents=True)
    (model / ".revision").write_text(
        "2d7d90b159db8961d27c2cf165d51195902ef92b\n",
        encoding="utf-8",
    )
    artifacts = {
        "model.fp32.safetensors": b"lossless-fp32",
        "model.mixed-fp16.safetensors": b"mixed-fp16",
    }
    hashes: dict[str, str] = {}
    for name, contents in artifacts.items():
        path = model / name
        path.write_bytes(contents)
        hashes[name] = hashlib.sha256(contents).hexdigest()
    (model / ".artifact-sha256.json").write_text(
        json.dumps(hashes, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return root, hashes


def test_validator_verifies_regular_artifacts_against_cache_hash_manifest(
    tmp_path: Path,
) -> None:
    module = _validation_script()
    cache, expected_hashes = _write_qualification_cache(tmp_path / "cache")

    resolved_cache, fp32, mixed, hashes = module.verify_qualification_cache(cache)

    assert resolved_cache == cache.resolve()
    assert fp32 == (cache / "fincast" / "model.fp32.safetensors").resolve()
    assert mixed == (cache / "fincast" / "model.mixed-fp16.safetensors").resolve()
    assert hashes == expected_hashes


@pytest.mark.parametrize(
    "symlink_target",
    ("cache", "model", "revision", "hash_manifest", "fp32", "mixed_fp16"),
)
def test_validator_rejects_cache_model_and_artifact_symlinks_before_gpu(
    tmp_path: Path,
    symlink_target: str,
) -> None:
    module = _validation_script()
    cache, _hashes = _write_qualification_cache(tmp_path / "cache")
    model = cache / "fincast"
    candidate = cache
    if symlink_target == "cache":
        link = tmp_path / "cache-link"
        link.symlink_to(cache, target_is_directory=True)
        candidate = link
    elif symlink_target == "model":
        real_model = cache / "fincast-real"
        model.rename(real_model)
        model.symlink_to(real_model, target_is_directory=True)
    else:
        name = {
            "revision": ".revision",
            "hash_manifest": ".artifact-sha256.json",
            "fp32": "model.fp32.safetensors",
            "mixed_fp16": "model.mixed-fp16.safetensors",
        }[symlink_target]
        original = model / name
        target = tmp_path / f"real-{name}"
        original.rename(target)
        original.symlink_to(target)

    with pytest.raises(RuntimeError, match="symlink"):
        module.verify_qualification_cache(candidate)


def test_validator_rejects_hash_manifest_mismatch_before_gpu(tmp_path: Path) -> None:
    module = _validation_script()
    cache, _hashes = _write_qualification_cache(tmp_path / "cache")
    (cache / "fincast" / "model.fp32.safetensors").write_bytes(b"tampered")

    with pytest.raises(RuntimeError, match="SHA-256"):
        module.verify_qualification_cache(cache)


def test_mixed_runtime_exception_atomically_writes_sanitized_fp32_fallback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _validation_script()
    fp32_path = tmp_path / "model.fp32.safetensors"
    mixed_path = tmp_path / "model.mixed-fp16.safetensors"
    fp32_path.write_bytes(b"lossless-fp32")
    mixed_path.write_bytes(b"mixed-fp16")
    reference = _qualification_forecasts()

    class FakeCuda:
        def __init__(self) -> None:
            self.empty_cache_calls = 0
            self.peak = 0

        def empty_cache(self) -> None:
            self.empty_cache_calls += 1

        def reset_peak_memory_stats(self) -> None:
            self.peak = 0

        def get_device_name(self) -> str:
            return "Tesla P40"

        def get_device_capability(self) -> tuple[int, int]:
            return (6, 1)

        def max_memory_allocated(self) -> int:
            return self.peak

        def max_memory_reserved(self) -> int:
            return max(0, self.peak - 1_000)

    cuda = FakeCuda()
    fake_torch = _qualification_torch(cuda)

    def fake_load_model(
        _source: Path,
        artifact: Path,
        _precision: str,
        _runtime: object,
    ) -> object:
        if artifact == fp32_path:
            cuda.peak = 10_000
            return object()
        cuda.peak = 6_000
        raise RuntimeError(
            "CUDA out of memory while loading /sensitive/cache/model.safetensors at 0x7f001234"
        )

    monkeypatch.setattr(module, "_load_model", fake_load_model)
    monkeypatch.setattr(
        module,
        "_forecast",
        lambda *_args: (reference, _quantile_observations()),
    )
    gc_calls: list[bool] = []
    monkeypatch.setattr(module.gc, "collect", lambda: gc_calls.append(True))

    validation = module.qualify_precision(
        Path("/unused/source"),
        fp32_path,
        mixed_path,
        _qualification_contexts(),
        "b" * 64,
        fake_torch,
    )

    assert validation.selected_precision == "float32"
    assert validation.mixed_run_status == "runtime_failed"
    assert validation.mixed_metrics is None
    assert validation.mixed_quantile_observations is None
    assert validation.mixed_runtime_failure is not None
    assert validation.mixed_runtime_failure.code == "mixed_cuda_out_of_memory"
    assert validation.mixed_runtime_failure.stage == "load"
    assert validation.mixed_runtime_failure.exception_class == "RuntimeError"
    assert validation.mixed_failure_reasons == ("mixed_cuda_out_of_memory",)
    assert validation.mixed_fp16.peak_vram_bytes == 6_000
    assert validation.mixed_fp16.peak_vram_measurement_complete is False
    assert cuda.empty_cache_calls == 4
    assert len(gc_calls) == 2

    output = tmp_path / "precision-validation.json"
    payload = module.write_validation_atomic(output, validation)
    persisted = json.loads(output.read_text(encoding="utf-8"))
    assert persisted["selected_precision"] == "float32"
    assert persisted["mixed_run_status"] == "runtime_failed"
    assert persisted["mixed_quantile_observations"] is None
    assert persisted["mixed_runtime_failure"] == {
        "code": "mixed_cuda_out_of_memory",
        "exception_class": "RuntimeError",
        "stage": "load",
    }
    assert payload + "\n" == output.read_text(encoding="utf-8")
    assert "/sensitive/" not in payload
    assert "0x7f001234" not in payload
    assert not tuple(tmp_path.glob(".precision-validation-*.tmp"))

    tampered = validation.model_copy(update={"selected_precision": "mixed_float16"})
    with pytest.raises(ValidationError, match="selected precision"):
        serialize_precision_validation(tampered)
    tampered_observations = validation.model_copy(
        update={"mixed_quantile_observations": _quantile_observations()}
    )
    with pytest.raises(ValidationError, match="failed mixed runtime"):
        serialize_precision_validation(tampered_observations)


def test_unsupported_mixed_operation_uses_only_bounded_failure_fields() -> None:
    module = _validation_script()
    observation = module._sanitized_failure(
        RuntimeError("operator is not implemented for Half at /secret/source.py:99"),
        "inference",
    )
    failure = module._runtime_failure(observation)

    assert failure.model_dump() == {
        "code": "mixed_unsupported_operation",
        "stage": "inference",
        "exception_class": "RuntimeError",
    }


def test_mixed_observation_mismatch_falls_back_without_applying_invariant_to_fp32(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _validation_script()
    fp32_path = tmp_path / "model.fp32.safetensors"
    mixed_path = tmp_path / "model.mixed-fp16.safetensors"
    fp32_path.write_bytes(b"lossless-fp32")
    mixed_path.write_bytes(b"mixed-fp16")
    reference = _qualification_forecasts()

    class FakeCuda:
        def __init__(self) -> None:
            self.peak = 0

        def empty_cache(self) -> None:
            pass

        def reset_peak_memory_stats(self) -> None:
            self.peak = 0

        def get_device_name(self) -> str:
            return "Tesla P40"

        def get_device_capability(self) -> tuple[int, int]:
            return (6, 1)

        def max_memory_allocated(self) -> int:
            return self.peak

        def max_memory_reserved(self) -> int:
            return self.peak

    cuda = FakeCuda()
    fake_torch = _qualification_torch(cuda)
    model_without_observations = SimpleNamespace(modules=lambda: ())

    def fake_load_model(
        _source: Path,
        artifact: Path,
        _precision: str,
        _runtime: object,
    ) -> object:
        cuda.peak = 10_000 if artifact == fp32_path else 6_000
        return model_without_observations

    monkeypatch.setattr(module, "_load_model", fake_load_model)
    monkeypatch.setattr(
        module,
        "_forecast",
        lambda *_args: (reference, _quantile_observations()),
    )
    validation = module.qualify_precision(
        Path("/unused/source"),
        fp32_path,
        mixed_path,
        _qualification_contexts(),
        "b" * 64,
        fake_torch,
    )

    assert validation.selected_precision == "float32"
    assert validation.mixed_run_status == "runtime_failed"
    assert validation.mixed_quantile_observations is None
    assert validation.mixed_runtime_failure is not None
    assert validation.mixed_runtime_failure.code == "mixed_evaluation_failure"
    assert validation.mixed_runtime_failure.stage == "evaluation"
    assert validation.mixed_runtime_failure.exception_class == "OtherException"
    assert validation.mixed_fp16.peak_vram_bytes == 6_000
    assert validation.mixed_fp16.peak_vram_measurement_complete is True


def test_fp32_runtime_failure_remains_fail_closed() -> None:
    module = _validation_script()
    failure = module.PrecisionRunFailureObservation(
        stage="load",
        category="stage_failure",
        exception_class="RuntimeError",
    )
    module.run_precision = lambda *_args: module.PrecisionRunResult(None, 4_000, False, failure)

    with pytest.raises(RuntimeError, match="FP32 FinCast baseline runtime failed"):
        module.qualify_precision(
            Path("/unused/source"),
            Path("/unused/model.fp32.safetensors"),
            Path("/unused/model.mixed-fp16.safetensors"),
            [{"closes": [5.0] * 512, "round_trip_cost_bps": 8.0}],
            "b" * 64,
            _qualification_torch(),
        )


class _FakeTensor:
    def __init__(self, dtype: str) -> None:
        self.dtype = dtype

    def float(self) -> "_FakeTensor":
        return _FakeTensor("torch.float32")

    def to(self, *, dtype: str) -> "_FakeTensor":
        return _FakeTensor(dtype)


class RMSNorm:
    def __init__(self, parameters: dict[str, _FakeTensor]) -> None:
        self._parameters = parameters

    def named_parameters(self, *, recurse: bool = True) -> tuple[tuple[str, _FakeTensor], ...]:
        del recurse
        return tuple(self._parameters.items())

    def named_buffers(self, *, recurse: bool = True) -> tuple[tuple[str, _FakeTensor], ...]:
        del recurse
        return ()


class TopNGating:
    def __init__(
        self,
        parameters: dict[str, _FakeTensor],
        buffers: dict[str, _FakeTensor],
    ) -> None:
        self._parameters = parameters
        self._buffers = buffers

    def named_parameters(self, *, recurse: bool = True) -> tuple[tuple[str, _FakeTensor], ...]:
        del recurse
        return tuple(self._parameters.items())

    def named_buffers(self, *, recurse: bool = True) -> tuple[tuple[str, _FakeTensor], ...]:
        del recurse
        return tuple(self._buffers.items())


class _HorizonLayer:
    pass


class _InputLayer:
    def __init__(self, weight: _FakeTensor) -> None:
        self.weight = weight


class _MixedBoundaryModel:
    def __init__(
        self,
        *,
        ordinary_dtype: str = "torch.float16",
        island_dtype: str = "torch.float32",
    ) -> None:
        prefix = "stacked_transformer.layers.0"
        input_norm_weight = _FakeTensor(island_dtype)
        moe_norm_gamma = _FakeTensor(island_dtype)
        router_weight = _FakeTensor(island_dtype)
        threshold_train = _FakeTensor(island_dtype)
        threshold_eval = _FakeTensor(island_dtype)
        router_zero = _FakeTensor(island_dtype)
        input_weight = _FakeTensor(ordinary_dtype)
        self.input_ff_layer = _InputLayer(input_weight)
        self.input_norm = RMSNorm({"weight": input_norm_weight})
        self.moe_norm = RMSNorm({"gamma": moe_norm_gamma})
        self.router = TopNGating(
            {"to_gates.weight": router_weight},
            {
                "threshold_train": threshold_train,
                "threshold_eval": threshold_eval,
                "zero": router_zero,
            },
        )
        self.horizon_ff_layer = _HorizonLayer()
        self._parameters = {
            "input_ff_layer.hidden_layer.0.weight": input_weight,
            f"{prefix}.self_attn.scaling": _FakeTensor(ordinary_dtype),
            f"{prefix}.input_layernorm.weight": input_norm_weight,
            f"{prefix}.moe.moe_prenorm.gamma": moe_norm_gamma,
            f"{prefix}.moe.moe.gate.to_gates.weight": router_weight,
            "horizon_ff_layer.output_layer.weight": _FakeTensor(ordinary_dtype),
        }
        self._buffers = {
            f"{prefix}.moe.moe.gate.threshold_train": threshold_train,
            f"{prefix}.moe.moe.gate.threshold_eval": threshold_eval,
            f"{prefix}.moe.moe.gate.zero": router_zero,
            f"{prefix}.moe.moe.experts.dummy": _FakeTensor(ordinary_dtype),
        }
        self._modules = (
            ("", self),
            (f"{prefix}.input_layernorm", self.input_norm),
            (f"{prefix}.moe.moe_prenorm", self.moe_norm),
            (f"{prefix}.moe.moe.gate", self.router),
            ("horizon_ff_layer", self.horizon_ff_layer),
        )

    def named_parameters(self) -> tuple[tuple[str, _FakeTensor], ...]:
        return tuple(self._parameters.items())

    def named_buffers(self) -> tuple[tuple[str, _FakeTensor], ...]:
        return tuple(self._buffers.items())

    def named_modules(self) -> tuple[tuple[str, object], ...]:
        return self._modules

    def modules(self) -> tuple[object, ...]:
        return tuple(module for _name, module in self._modules)


def test_fp32_island_predicate_and_loaded_model_dtype_boundary_are_exhaustive() -> None:
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.input_layernorm.weight"
    )
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.moe.moe_prenorm.gamma"
    )
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.moe.moe.gate.to_gates.weight"
    )
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.moe.moe.gate.threshold_eval"
    )
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.moe.moe.gate.zero"
    )
    assert not is_fincast_fp32_island_key("horizon_ff_layer.output_layer.weight")

    validate_fincast_mixed_model_dtypes(_MixedBoundaryModel())
    with pytest.raises(AdapterLoadError, match="mixed dtype boundary"):
        validate_fincast_mixed_model_dtypes(
            _MixedBoundaryModel(ordinary_dtype="torch.float32")
        )
    with pytest.raises(AdapterLoadError, match="mixed dtype boundary"):
        validate_fincast_mixed_model_dtypes(
            _MixedBoundaryModel(island_dtype="torch.float16")
        )


def test_provisioning_uses_the_shared_fp32_island_predicate() -> None:
    module = _prepare_script()

    class ProvisionTensor:
        def __init__(self, *, floating: bool) -> None:
            self.dtype = SimpleNamespace(is_floating_point=floating)

        def to(self, *, dtype: str) -> tuple[str, str]:
            return ("converted", dtype)

    island = ProvisionTensor(floating=True)
    ordinary = ProvisionTensor(floating=True)
    integer = ProvisionTensor(floating=False)
    converted = module.mixed_state_dict(
        {
            "stacked_transformer.layers.0.input_layernorm.weight": island,
            "horizon_ff_layer.output_layer.weight": ordinary,
            "integer_buffer": integer,
        },
        SimpleNamespace(float16="fp16"),
    )

    assert converted["stacked_transformer.layers.0.input_layernorm.weight"] is island
    assert converted["horizon_ff_layer.output_layer.weight"] == ("converted", "fp16")
    assert converted["integer_buffer"] is integer


def test_provisioning_publishes_staged_directories_before_locking_their_roots(
    tmp_path: Path,
) -> None:
    module = _prepare_script()
    cache = tmp_path / "cache"
    source_stage = cache / ".stage" / "fincast-source"
    model_stage = cache / ".stage" / "fincast"
    (source_stage / "src").mkdir(parents=True)
    model_stage.mkdir()
    (source_stage / "src" / "module.py").write_text("reviewed = True\n", encoding="utf-8")
    (model_stage / "model.safetensors").write_bytes(b"weights")

    module.publish_read_only_cache(cache, source_stage, model_stage)

    final_source = cache / "fincast-source"
    final_model = cache / "fincast"
    assert not source_stage.exists()
    assert not model_stage.exists()
    assert final_source.stat().st_mode & 0o777 == 0o555
    assert final_model.stat().st_mode & 0o777 == 0o555
    assert (final_source / "src").stat().st_mode & 0o777 == 0o555
    assert (final_source / "src" / "module.py").stat().st_mode & 0o777 == 0o444
    assert (final_model / "model.safetensors").stat().st_mode & 0o777 == 0o444

    module.remove_read_only_tree(final_source)
    module.remove_read_only_tree(final_model)
    module.remove_read_only_tree(cache / ".stage")


def test_provisioning_rolls_back_a_partial_atomic_publish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _prepare_script()
    cache = tmp_path / "cache"
    source_stage = cache / ".stage" / "fincast-source"
    model_stage = cache / ".stage" / "fincast"
    source_stage.mkdir(parents=True)
    model_stage.mkdir()
    (source_stage / "source.py").write_text("reviewed = True\n", encoding="utf-8")
    (model_stage / "model.safetensors").write_bytes(b"weights")
    real_replace = module.os.replace
    replace_calls = 0

    def fail_second_replace(source: Path, destination: Path) -> None:
        nonlocal replace_calls
        replace_calls += 1
        if replace_calls == 2:
            raise PermissionError("synthetic second publish failure")
        real_replace(source, destination)

    monkeypatch.setattr(module.os, "replace", fail_second_replace)

    with pytest.raises(PermissionError, match="second publish failure"):
        module.publish_read_only_cache(cache, source_stage, model_stage)

    assert replace_calls == 2
    assert not (cache / "fincast-source").exists()
    assert not (cache / "fincast").exists()
    assert model_stage.exists()
    module.remove_read_only_tree(cache / ".stage")


def test_precision_hooks_observe_compute_restore_horizon_and_decode_dtypes() -> None:
    model = _MixedBoundaryModel()
    model.input_ff_layer._fincast_model_input_dtype = "torch.float16"
    normalized_args = _cast_normalized_input_to_model_dtype(
        model.input_ff_layer,
        (_FakeTensor("torch.float32"),),
    )
    assert normalized_args[0].dtype == "torch.float16"
    for module in (model.input_norm, model.moe_norm):
        compute_args = _remember_input_dtype(module, (_FakeTensor("torch.float16"),))
        assert compute_args[0].dtype == "torch.float32"
        restored = _restore_output_dtype(module, (), _FakeTensor("torch.float32"))
        assert restored.dtype == "torch.float16"

    router_args = _remember_input_dtype(model.router, (_FakeTensor("torch.float16"),))
    assert router_args[0].dtype == "torch.float32"
    router = _restore_router_outputs(
        model.router,
        (),
        (
            _FakeTensor("torch.float32"),
            _FakeTensor("torch.float32"),
            _FakeTensor("torch.float32"),
            _FakeTensor("torch.float32"),
        ),
    )
    assert router[0].dtype == "torch.float16"
    assert router[1].dtype == "torch.float16"
    assert router[2].dtype == "torch.float32"
    assert router[3].dtype == "torch.float32"

    promoted = _promote_horizon_output(
        model.horizon_ff_layer,
        (),
        _FakeTensor("torch.float16"),
    )
    assert promoted.dtype == "torch.float32"
    observe_fincast_decode_output_dtypes(
        model,
        _FakeTensor("torch.float32"),
        _FakeTensor("torch.float32"),
    )
    validate_fincast_mixed_inference_observations(model)

    _restore_output_dtype(model.input_norm, (), _FakeTensor("torch.float16"))
    with pytest.raises(AdapterLoadError, match="RMSNorm dtype observation"):
        validate_fincast_mixed_inference_observations(model)


def test_attention_softmax_structural_invariant_is_exact_and_hash_gated(
    tmp_path: Path,
) -> None:
    reviewed_expression = """
class TimesFMAttention:
    def forward(self, scores, q):
        scores = F.softmax(scores.float(), dim=-1).type_as(q)
        return scores
"""
    assert _attention_softmax_structure_matches(reviewed_expression)
    assert not _attention_softmax_structure_matches(
        reviewed_expression.replace("scores.float()", "scores")
    )
    assert not _attention_softmax_structure_matches(
        reviewed_expression.replace(".type_as(q)", "")
    )
    assert not _attention_softmax_structure_matches(
        reviewed_expression.replace("F.softmax", "torch.softmax")
    )

    source = tmp_path / "fincast-source"
    decoder = source / "src" / "ffm" / "pytorch_patched_decoder_MOE.py"
    decoder.parent.mkdir(parents=True)
    decoder.write_text(reviewed_expression, encoding="utf-8")
    with pytest.raises(AdapterLoadError, match="pinned SHA-256"):
        verify_pinned_attention_softmax_structure(source)


def test_fincast_adapter_rechecks_nvml_headroom_after_model_load(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = SimpleNamespace(
        model_cache_dir=tmp_path,
        fincast_nvml_device_index=0,
        fincast_min_vram_headroom_bytes=1_000,
        fincast_context_bars=512,
    )
    cuda = SimpleNamespace(
        empty_cache_calls=0,
        get_device_name=lambda: "Tesla P40",
        get_device_capability=lambda: (6, 1),
    )

    def empty_cache() -> None:
        cuda.empty_cache_calls += 1

    cuda.empty_cache = empty_cache
    runtime = SimpleNamespace(torch=_qualification_torch(cuda))
    nvml_values = iter((1_600, 999))
    nvml_calls: list[int] = []

    def fake_nvml(device_index: int) -> int:
        nvml_calls.append(device_index)
        return next(nvml_values)

    loads: list[bool] = []
    monkeypatch.setattr(fincast_module, "_source_snapshot", lambda *_args: tmp_path)
    monkeypatch.setattr(
        fincast_module,
        "_artifact_selection",
        lambda *_args: (
            _completed_validation(
                MixedPrecisionMetrics(
                    finite=True,
                    quantile_monotonic=True,
                    signal_direction_agreement=1.0,
                    q50_median_iqr_ratio=0.01,
                    q50_p95_iqr_ratio=0.02,
                    peak_vram_reduction=0.4,
                )
            ),
            tmp_path / "model.mixed-fp16.safetensors",
            "mixed_float16",
            500,
        ),
    )
    monkeypatch.setattr(fincast_module, "nvml_free_bytes", fake_nvml)
    monkeypatch.setattr(
        fincast_module,
        "_load_model",
        lambda *_args: loads.append(True) or object(),
    )

    with pytest.raises(
        MemoryPressureError,
        match="^memory_pressure: FinCast post-load VRAM headroom is below the configured minimum$",
    ):
        FinCastAdapter(settings, {}, {}, runtime)

    assert nvml_calls == [0, 0]
    assert loads == [True]
    assert cuda.empty_cache_calls == 1


def test_loaded_fincast_provenance_carries_full_validation_observations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = SimpleNamespace(
        model_cache_dir=tmp_path,
        fincast_nvml_device_index=0,
        fincast_min_vram_headroom_bytes=1_000,
        fincast_context_bars=512,
    )
    runtime = SimpleNamespace(
        torch=_qualification_torch(),
        name="cuda",
        device_name="Tesla P40",
        cuda_capability="6.1",
    )
    validation = _completed_validation(
        MixedPrecisionMetrics(
            finite=True,
            quantile_monotonic=True,
            signal_direction_agreement=1.0,
            q50_median_iqr_ratio=0.01,
            q50_p95_iqr_ratio=0.02,
            peak_vram_reduction=0.4,
        )
    )
    monkeypatch.setattr(fincast_module, "_source_snapshot", lambda *_args: tmp_path)
    monkeypatch.setattr(
        fincast_module,
        "_artifact_selection",
        lambda *_args: (
            validation,
            tmp_path / "model.mixed-fp16.safetensors",
            "mixed_float16",
            500,
        ),
    )
    monkeypatch.setattr(fincast_module, "nvml_free_bytes", lambda _index: 1_600)
    monkeypatch.setattr(fincast_module, "_load_model", lambda *_args: object())
    model_manifest = {
        "model_id": "Vincent05R/FinCast",
        "revision": "2d7d90b159db8961d27c2cf165d51195902ef92b",
        "loader_version": "fincast-source-488b19d",
        "license": "Apache-2.0",
    }

    adapter = FinCastAdapter(settings, model_manifest, {}, runtime)

    assert (
        adapter.provenance.fp32_quantile_observations
        == validation.fp32_quantile_observations
    )
    assert (
        adapter.provenance.mixed_quantile_observations
        == validation.mixed_quantile_observations
    )


def _write_minimal_decoder_source(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "fincast-source"
    package = source / "src" / "ffm"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("raise RuntimeError('must not execute')\n", encoding="utf-8")
    decoder_path = package / "pytorch_patched_decoder_MOE.py"
    decoder_path.write_text(
        "from st_moe_pytorch import MoE\nSENTINEL = 'minimal-reviewed-decoder'\n",
        encoding="utf-8",
    )
    dependency = source / "src" / "st_moe_pytorch"
    dependency.mkdir()
    (dependency / "__init__.py").write_text(
        "from .st_moe_pytorch import MoE\n",
        encoding="utf-8",
    )
    (dependency / "st_moe_pytorch.py").write_text(
        "from . import distributed\nclass MoE: pass\n",
        encoding="utf-8",
    )
    (dependency / "distributed.py").write_text("SENTINEL = 'pinned'\n", encoding="utf-8")
    return source, decoder_path


def test_decoder_import_bypasses_initializer_and_pins_dependency_closure(
    tmp_path: Path,
) -> None:
    source, decoder_path = _write_minimal_decoder_source(tmp_path)
    module_names = (
        "ffm",
        "ffm.pytorch_patched_decoder_MOE",
        "st_moe_pytorch",
        "st_moe_pytorch.st_moe_pytorch",
        "st_moe_pytorch.distributed",
    )
    previous = {name: sys.modules.pop(name, None) for name in module_names}
    source_path = str(source / "src")
    sys.path.insert(0, source_path)
    try:
        decoder = import_decoder_from_source(source)
        assert decoder.SENTINEL == "minimal-reviewed-decoder"
        assert Path(decoder.__file__).resolve() == decoder_path.resolve()
        assert Path(sys.modules["st_moe_pytorch"].__file__).resolve() == (
            source / "src" / "st_moe_pytorch" / "__init__.py"
        ).resolve()
        assert Path(sys.modules["st_moe_pytorch.st_moe_pytorch"].__file__).resolve() == (
            source / "src" / "st_moe_pytorch" / "st_moe_pytorch.py"
        ).resolve()
        assert Path(sys.modules["st_moe_pytorch.distributed"].__file__).resolve() == (
            source / "src" / "st_moe_pytorch" / "distributed.py"
        ).resolve()
    finally:
        sys.path.remove(source_path)
        for name in reversed(module_names):
            sys.modules.pop(name, None)
            if previous[name] is not None:
                sys.modules[name] = previous[name]


@pytest.mark.parametrize(
    "module_name",
    (
        "st_moe_pytorch",
        "st_moe_pytorch.st_moe_pytorch",
        "st_moe_pytorch.distributed",
    ),
)
def test_decoder_import_rejects_preloaded_external_dependencies(
    tmp_path: Path,
    module_name: str,
) -> None:
    source, _decoder_path = _write_minimal_decoder_source(tmp_path)
    module_names = (
        "ffm",
        "ffm.pytorch_patched_decoder_MOE",
        "st_moe_pytorch",
        "st_moe_pytorch.st_moe_pytorch",
        "st_moe_pytorch.distributed",
    )
    previous = {name: sys.modules.pop(name, None) for name in module_names}
    external = ModuleType(module_name)
    external.__file__ = "/external/site-packages/st_moe_pytorch.py"
    if module_name == "st_moe_pytorch":
        external.__path__ = ["/external/site-packages/st_moe_pytorch"]
    sys.modules[module_name] = external
    source_path = str(source / "src")
    sys.path.insert(0, source_path)
    try:
        with pytest.raises(AdapterLoadError, match="different source"):
            import_decoder_from_source(source)
    finally:
        sys.path.remove(source_path)
        for name in reversed(module_names):
            sys.modules.pop(name, None)
            if previous[name] is not None:
                sys.modules[name] = previous[name]


def test_fixed_validation_fixture_is_actual_finalized_binance_data() -> None:
    fixture = Path(__file__).parent / "fixtures" / "fincast-crypto-contexts.json"
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == (
        "3ee014f25181c595949580acec1ad83908819e3f283b378f449ab679bef75f6f"
    )
    payload = json.loads(fixture.read_text(encoding="utf-8"))
    assert payload["source"] == {
        "complete_only": True,
        "contract_type": "PERPETUAL",
        "endpoint": "/fapi/v1/klines",
        "fixed_end_at": "2026-07-01T00:00:00Z",
        "interval": "1m",
        "quote_asset": "USDT",
        "round_trip_cost_bps": 8.0,
        "venue": "BINANCE_USDM",
    }
    assert len(payload["contexts"]) == 128
    assert len({item["symbol"] for item in payload["contexts"]}) == 16
    assert {item["bar_count"] for item in payload["contexts"]} == {512}
    assert {len(item["closes"]) for item in payload["contexts"]} == {512}


def test_non_finite_mixed_output_records_failure_instead_of_blocking_fp32_fallback(
    tmp_path: Path,
) -> None:
    module = _validation_script()
    reference = _qualification_forecasts()
    candidate = _qualification_forecasts()
    candidate[0][0][4] = float("nan")
    runs = iter(
        (
            module.PrecisionRunResult(
                reference,
                10_000,
                True,
                None,
                _quantile_observations(),
            ),
            module.PrecisionRunResult(
                candidate,
                6_000,
                True,
                None,
                _quantile_observations(
                    non_finite_value_count=1,
                    postprocessed_monotonic=False,
                ),
            ),
        )
    )
    module.run_precision = lambda *_args: next(runs)
    contexts = _qualification_contexts()
    fp32_path = tmp_path / "model.fp32.safetensors"
    mixed_path = tmp_path / "model.mixed-fp16.safetensors"
    fp32_path.write_bytes(b"fp32")
    mixed_path.write_bytes(b"mixed")
    validation = module.qualify_precision(
        Path("/unused/source"),
        fp32_path,
        mixed_path,
        contexts,
        "b" * 64,
        _qualification_torch(),
    )

    assert validation.mixed_run_status == "completed"
    assert validation.mixed_runtime_failure is None
    assert validation.mixed_metrics is not None
    assert validation.mixed_metrics.finite is False
    assert validation.mixed_metrics.quantile_monotonic is False
    assert validation.mixed_quantile_observations is not None
    assert validation.mixed_quantile_observations.non_finite_value_count == 1
    assert validation.mixed_quantile_observations.postprocessed_monotonic is False
    assert "non_finite_output" in validation.mixed_failure_reasons
    assert validation.selected_precision == "float32"
