from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Sequence

from portfolio_ai_worker.adapters import InferenceSeries, PredictedBar, RawPrediction
from portfolio_ai_worker.contracts import (
    ModelProvenance,
    PriceBar,
    QuantileRearrangementObservations,
)
from portfolio_ai_worker.settings import AISettings


def bars(count: int, *, start: datetime | None = None, drift: float = 0.001) -> tuple[PriceBar, ...]:
    start = start or datetime(2025, 1, 2, 0, 0, tzinfo=timezone.utc)
    output: list[PriceBar] = []
    close = 100.0
    for index in range(count):
        opening = close
        close = opening * (1 + drift)
        output.append(
            PriceBar(
                timestamp=start + timedelta(minutes=index),
                open=opening,
                high=max(opening, close) * 1.001,
                low=min(opening, close) * 0.999,
                close=close,
                volume=1_000.0 + index,
                amount=(1_000.0 + index) * close,
                complete=True,
            )
        )
    return tuple(output)


def future(last: datetime, count: int = 60) -> tuple[datetime, ...]:
    return tuple(last + timedelta(minutes=index) for index in range(1, count + 1))


def provenance(*, loaded: bool = True) -> ModelProvenance:
    return ModelProvenance(
        model_id="amazon/chronos-2",
        model_revision="test-only",
        source_revision="test-only",
        loader_version="dependency-injected-test-adapter",
        license="Apache-2.0",
        device="cpu" if loaded else "unavailable",
        dtype="float32",
        attention_backend="math" if loaded else "unavailable",
        loaded=loaded,
        precision_validation="not_required" if loaded else "unavailable",
        memory_status="ok" if loaded else "unavailable",
        quantile_monotonicity_policy=(
            "chronos2_fp32_monotone_rearrangement_v1" if loaded else "unavailable"
        ),
        quantile_tail_policy="native" if loaded else "unavailable",
        precision_failure_reasons=(),
    )


def fincast_provenance() -> ModelProvenance:
    observations = QuantileRearrangementObservations(
        row_count=54_600,
        non_finite_value_count=0,
        crossing_row_count=1,
        crossing_adjacent_pair_count=1,
        adjusted_row_count=1,
        q50_adjustment_iqr_ratio_median=0.01,
        q50_adjustment_iqr_ratio_p95=0.02,
        q50_adjustment_iqr_ratio_max=0.03,
        postprocessed_monotonic=True,
    )
    return ModelProvenance(
        model_id="Vincent05R/FinCast",
        model_revision="test-only",
        source_revision="test-only",
        loader_version="dependency-injected-test-adapter",
        license="Apache-2.0",
        device="cuda",
        device_name="Tesla P40",
        cuda_capability="6.1",
        dtype="float32",
        attention_backend="math",
        loaded=True,
        precision_validation="fallback_fp32",
        peak_vram_bytes=1,
        peak_vram_measurement="cuda_allocated_or_reserved",
        memory_status="ok",
        quantile_monotonicity_policy="fp32_monotone_rearrangement_v1",
        quantile_tail_policy="tail_clamped_q10_q90",
        fp32_quantile_observations=observations,
        mixed_quantile_observations=observations,
        precision_failure_reasons=("peak_vram_reduction_below_25pct",),
    )


class DeterministicAdapter:
    def __init__(self, model_provenance: ModelProvenance | None = None) -> None:
        self.calls: list[tuple[InferenceSeries, ...]] = []
        self._provenance = model_provenance or provenance()

    @property
    def provenance(self) -> ModelProvenance:
        return self._provenance

    def predict_batch(self, series: Sequence[InferenceSeries], *, seed: int) -> list[RawPrediction]:
        del seed
        self.calls.append(tuple(series))
        output: list[RawPrediction] = []
        for item in series:
            base = item.bars[-1].close
            paths: list[tuple[PredictedBar, ...]] = []
            for drift in (-0.0006, -0.0002, 0.0003, 0.0008):
                close = base
                path: list[PredictedBar] = []
                for _timestamp in item.future_timestamps:
                    opening = close
                    close = opening * (1 + drift)
                    path.append(
                        PredictedBar(
                            open=opening,
                            high=max(opening, close) * 1.0005,
                            low=min(opening, close) * 0.9995,
                            close=close,
                        )
                    )
                paths.append(tuple(path))
            output.append(RawPrediction(instrument_key=item.instrument_key, paths=tuple(paths)))
        return output


def settings(tmp_path: Path, **updates: object) -> AISettings:
    value = AISettings(
        model_cache_dir=tmp_path / "models",
        manifest_path=tmp_path / "manifest.json",
        device="cpu",
        allow_cpu_fallback=True,
        expected_cuda_capability="6.1",
        expected_cuda_device_name="Tesla P40",
        microbatch_size=2,
        max_series=50,
        max_evaluation_origins=1_000,
        min_context_bars=64,
        max_context_bars=512,
        max_request_bytes=4 * 1024 * 1024,
        max_response_bytes=8 * 1024 * 1024,
        model_lane="chronos_2",
        chronos2_context_bars=512,
    )
    return replace(value, **updates).validate()
