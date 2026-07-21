from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Sequence

from portfolio_ai_worker.adapters import InferenceSeries, PredictedBar, RawPrediction
from portfolio_ai_worker.contracts import ModelProvenance, PriceBar
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
        model_id="test/deterministic",
        model_revision="test-only",
        source_revision="test-only",
        loader_version="dependency-injected-test-adapter",
        license="test-only",
        device="cpu" if loaded else "unavailable",
        dtype="float32",
        attention_backend="math" if loaded else "unavailable",
        loaded=loaded,
    )


class DeterministicAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple[InferenceSeries, ...]] = []
        self._provenance = provenance()

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
        socket_path=tmp_path / "ai.sock",
        model_cache_dir=tmp_path / "models",
        manifest_path=tmp_path / "manifest.json",
        primary_model="kronos-small",
        fallback_model="chronos-bolt-small",
        device="cpu",
        allow_cpu_fallback=True,
        expected_cuda_capability="6.1",
        microbatch_size=2,
        max_series=50,
        max_evaluation_origins=1_000,
        min_context_bars=64,
        max_context_bars=128,
        sample_count=4,
        max_request_bytes=4 * 1024 * 1024,
        max_response_bytes=8 * 1024 * 1024,
    )
    return replace(value, **updates).validate()
