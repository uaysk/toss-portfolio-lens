from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from portfolio_ai_worker import raw_generator
from portfolio_ai_worker.raw_artifacts import load_raw_input, load_resume_state
from portfolio_ai_worker.raw_generator import (
    generate_raw_predictions,
    selected_raw_backend,
    selected_raw_batch_size,
)
from portfolio_ai_worker.raw_inference import RawInferenceError, RawInferenceObservation


@pytest.mark.parametrize("cadence_seconds", [15, 30, 60])
def test_qualified_offline_defaults_use_cuda_graph_batch_48(
    monkeypatch: pytest.MonkeyPatch,
    cadence_seconds: int,
) -> None:
    monkeypatch.delenv("AI_FINCAST_RAW_BACKEND", raising=False)
    monkeypatch.delenv(f"AI_FINCAST_RAW_BATCH_{cadence_seconds}", raising=False)

    assert selected_raw_backend(cadence_seconds) == "cuda_graph"
    assert selected_raw_batch_size(cadence_seconds) == 48


def test_tensorrt_challenger_cannot_be_selected_as_raw_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_FINCAST_RAW_BACKEND", "tensorrt_int8")

    with pytest.raises(RawInferenceError, match="eager, no_padding"):
        selected_raw_backend(60)


def test_qualified_tensorrt_fp32_can_be_selected_explicitly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_FINCAST_RAW_BACKEND", "tensorrt_fp32")

    assert selected_raw_backend(60) == "tensorrt_fp32"


def _raw_input(tmp_path: Path, *, rows: int = 3) -> Path:
    root = tmp_path / "input"
    root.mkdir()
    contexts = np.full((rows, 512), 100, dtype="<f4")
    context_payload = contexts.tobytes(order="C")
    (root / "contexts.f32").write_bytes(context_payload)
    started_at = datetime(2026, 7, 1, tzinfo=timezone.utc)
    origins = []
    for row_id in range(rows):
        origin = started_at + timedelta(minutes=row_id)
        origins.append(
            json.dumps(
                {
                    "row_id": row_id,
                    "instrument_key": f"BTCUSDT:{row_id}",
                    "origin": origin.isoformat(),
                    "future_timestamps": [
                        (origin + timedelta(minutes=index + 1)).isoformat()
                        for index in range(60)
                    ],
                    "metadata": {"symbol": "BTCUSDT"},
                },
                separators=(",", ":"),
            )
        )
    origin_payload = ("\n".join(origins) + "\n").encode()
    (root / "origins.jsonl").write_bytes(origin_payload)
    manifest = {
        "schema_version": "fincast-raw-input/v1",
        "cadence_seconds": 60,
        "horizon_minutes": [5, 15, 30, 60],
        "row_count": rows,
        "row_order": "row_id_ascending",
        "context_bars": 512,
        "model_seed": 3,
        "files": {
            "contexts": {
                "name": "contexts.f32",
                "size_bytes": len(context_payload),
                "sha256": hashlib.sha256(context_payload).hexdigest(),
            },
            "origins": {
                "name": "origins.jsonl",
                "size_bytes": len(origin_payload),
                "sha256": hashlib.sha256(origin_payload).hexdigest(),
            },
        },
    }
    path = root / "manifest.json"
    path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
    return path.resolve()


class _FakeTransfer:
    def __init__(self, **_kwargs: object) -> None:
        pass

    def copy(
        self,
        contexts: np.ndarray,
        uniforms: np.ndarray,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        return torch.from_numpy(contexts.copy()), torch.from_numpy(uniforms.copy())


class _FakeTelemetry:
    def __init__(self, _index: int) -> None:
        pass

    def __enter__(self) -> _FakeTelemetry:
        return self

    def __exit__(self, *_args: object) -> None:
        pass

    def summary(self) -> dict[str, object]:
        return {"status": "unavailable"}


class _FakeEvent:
    def __init__(self, **_kwargs: object) -> None:
        pass

    def record(self) -> None:
        pass

    def elapsed_time(self, _other: _FakeEvent) -> float:
        return 1.0


class _FakeInference:
    def __init__(self, *, failure: BaseException | None) -> None:
        self.layers = 1
        self.packed_experts = ()
        self.runtime = SimpleNamespace(name="cpu")
        self.provenance = {
            "model_id": "Vincent05R/FinCast",
            "weights_sha256": "a" * 64,
        }
        self.failure = failure
        self.calls = 0

    def predict_tensor(
        self,
        contexts: torch.Tensor,
        _uniforms: torch.Tensor,
        *,
        cadence_seconds: int,
    ) -> RawInferenceObservation:
        assert cadence_seconds == 60
        if self.calls == 1 and self.failure is not None:
            raise self.failure
        self.calls += 1
        values = torch.empty((len(contexts), 4, 10), dtype=torch.float32)
        values[..., 0] = 100
        values[..., 1:] = torch.arange(91, 100, dtype=torch.float32)
        return RawInferenceObservation(output=values)


class _FakeTensorRTObservation:
    def __init__(self, rows: int) -> None:
        self.output = np.empty((rows, 4, 10), dtype=np.float32)
        self.output[..., 0] = 100
        self.output[..., 1:] = np.arange(91, 100, dtype=np.float32)
        self.wall_ms = 4.0
        self.compute_cuda_ms = 3.0


class _FakeTensorRT:
    instances: list[_FakeTensorRT] = []

    def __init__(self, *, batch_size: int) -> None:
        assert batch_size == 48
        self.layers = 1
        self.provenance = {
            "tensorrt_engine_sha256": "b" * 64,
            "tensorrt_plugin_sha256": "c" * 64,
        }
        self.calls = 0
        self.closed = False
        self.instances.append(self)

    def predict(
        self,
        contexts: np.ndarray,
        _uniforms: np.ndarray,
        *,
        cadence_seconds: int,
    ) -> _FakeTensorRTObservation:
        assert cadence_seconds == 60
        assert contexts.shape == (48, 512)
        self.calls += 1
        return _FakeTensorRTObservation(len(contexts))

    def close(self) -> None:
        self.closed = True


@pytest.mark.parametrize(
    "failure",
    [
        torch.cuda.OutOfMemoryError("synthetic OOM"),
        KeyboardInterrupt("synthetic cancellation"),
    ],
    ids=["oom", "cancellation"],
)
def test_raw_generation_checkpoints_and_resumes_after_oom_or_cancellation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: BaseException,
) -> None:
    manifest = _raw_input(tmp_path)
    output = (tmp_path / "output").resolve()
    adapter = SimpleNamespace(
        _settings=SimpleNamespace(fincast_nvml_device_index=0),
    )
    monkeypatch.setattr(raw_generator, "_PinnedTransfer", _FakeTransfer)
    monkeypatch.setattr(raw_generator, "GpuTelemetrySampler", _FakeTelemetry)
    monkeypatch.setattr(torch.cuda, "Event", _FakeEvent)
    monkeypatch.setattr(torch.cuda, "reset_peak_memory_stats", lambda: None)
    monkeypatch.setattr(torch.cuda, "synchronize", lambda: None)
    monkeypatch.setattr(torch.cuda, "max_memory_allocated", lambda: 0)
    monkeypatch.setattr(torch.cuda, "max_memory_reserved", lambda: 0)
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: None)
    monkeypatch.setattr(
        raw_generator,
        "FinCastRawInference",
        lambda *_args, **_kwargs: _FakeInference(failure=failure),
    )

    with pytest.raises(type(failure), match="synthetic"):
        generate_raw_predictions(
            adapter,  # type: ignore[arg-type]
            manifest_path=manifest,
            output_dir=output,
            resume=False,
            backend="eager",
            batch_size=2,
        )

    artifact = load_raw_input(manifest)
    checkpoint = load_resume_state(
        output,
        artifact=artifact,
        backend="eager",
        batch_size=2,
        provenance={
            "model_id": "Vincent05R/FinCast",
            "weights_sha256": "a" * 64,
        },
    )
    assert checkpoint.next_row == 2
    assert [(chunk.start_row, chunk.end_row) for chunk in checkpoint.chunks] == [(0, 2)]

    monkeypatch.setattr(
        raw_generator,
        "FinCastRawInference",
        lambda *_args, **_kwargs: _FakeInference(failure=None),
    )
    completed = generate_raw_predictions(
        adapter,  # type: ignore[arg-type]
        manifest_path=manifest,
        output_dir=output,
        resume=True,
        backend="eager",
        batch_size=2,
    )
    assert completed.resumed_from_row == 2
    assert completed.completed_rows == 3
    resumed = load_resume_state(
        output,
        artifact=artifact,
        backend="eager",
        batch_size=2,
        provenance={
            "model_id": "Vincent05R/FinCast",
            "weights_sha256": "a" * 64,
        },
    )
    assert [(chunk.start_row, chunk.end_row) for chunk in resumed.chunks] == [
        (0, 2),
        (2, 3),
    ]


def test_tensorrt_fp32_uses_full_static_chunks_and_packed_eager_tail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = _raw_input(tmp_path, rows=50)
    output = (tmp_path / "output").resolve()
    adapter = SimpleNamespace(
        _settings=SimpleNamespace(fincast_nvml_device_index=0),
    )
    _FakeTensorRT.instances.clear()
    monkeypatch.setattr(raw_generator, "_PinnedTransfer", _FakeTransfer)
    monkeypatch.setattr(raw_generator, "GpuTelemetrySampler", _FakeTelemetry)
    monkeypatch.setattr(torch.cuda, "Event", _FakeEvent)
    monkeypatch.setattr(torch.cuda, "reset_peak_memory_stats", lambda: None)
    monkeypatch.setattr(torch.cuda, "synchronize", lambda: None)
    monkeypatch.setattr(torch.cuda, "max_memory_allocated", lambda: 0)
    monkeypatch.setattr(torch.cuda, "max_memory_reserved", lambda: 0)
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: None)
    monkeypatch.setattr(
        raw_generator,
        "FinCastRawInference",
        lambda *_args, **_kwargs: _FakeInference(failure=None),
    )
    monkeypatch.setattr(raw_generator, "TensorRTRawProcess", _FakeTensorRT)

    result = generate_raw_predictions(
        adapter,  # type: ignore[arg-type]
        manifest_path=manifest,
        output_dir=output,
        resume=False,
        backend="tensorrt_fp32",
        batch_size=48,
    )

    assert result.backend == "tensorrt_fp32"
    assert result.completed_rows == 50
    assert result.fallback_reason is None
    assert len(_FakeTensorRT.instances) == 1
    assert _FakeTensorRT.instances[0].calls == 1
    assert _FakeTensorRT.instances[0].closed
    chunks = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((output / "chunks").glob("chunk-*.json"))
    ]
    assert [(chunk["start_row"], chunk["end_row"]) for chunk in chunks] == [
        (0, 48),
        (48, 50),
    ]
    assert chunks[0]["latency"]["execution_backend"] == "tensorrt_fp32"
    assert chunks[0]["latency"]["tail_eager"] is False
    assert chunks[1]["latency"]["execution_backend"] == "batched_experts"
    assert chunks[1]["latency"]["tail_eager"] is True

    resumed = generate_raw_predictions(
        adapter,  # type: ignore[arg-type]
        manifest_path=manifest,
        output_dir=output,
        resume=True,
        backend="tensorrt_fp32",
        batch_size=48,
    )
    assert resumed.resumed_from_row == 50
    assert resumed.output_digest == result.output_digest


def test_tensorrt_load_fallback_is_explicit_and_records_actual_backend(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = _raw_input(tmp_path)
    output = (tmp_path / "output").resolve()
    adapter = SimpleNamespace(
        _settings=SimpleNamespace(fincast_nvml_device_index=0),
    )
    monkeypatch.setenv("AI_FINCAST_TENSORRT_LOAD_FALLBACK", "cuda_graph")
    monkeypatch.setattr(raw_generator, "_PinnedTransfer", _FakeTransfer)
    monkeypatch.setattr(raw_generator, "GpuTelemetrySampler", _FakeTelemetry)
    monkeypatch.setattr(torch.cuda, "Event", _FakeEvent)
    monkeypatch.setattr(torch.cuda, "reset_peak_memory_stats", lambda: None)
    monkeypatch.setattr(torch.cuda, "synchronize", lambda: None)
    monkeypatch.setattr(torch.cuda, "max_memory_allocated", lambda: 0)
    monkeypatch.setattr(torch.cuda, "max_memory_reserved", lambda: 0)
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: None)
    monkeypatch.setattr(
        raw_generator,
        "FinCastRawInference",
        lambda *_args, **_kwargs: _FakeInference(failure=None),
    )

    class _RejectedTensorRT:
        def __init__(self, *, batch_size: int) -> None:
            raise RawInferenceError(f"synthetic TensorRT load failure B{batch_size}")

    monkeypatch.setattr(raw_generator, "TensorRTRawProcess", _RejectedTensorRT)

    result = generate_raw_predictions(
        adapter,  # type: ignore[arg-type]
        manifest_path=manifest,
        output_dir=output,
        resume=False,
        backend="tensorrt_fp32",
        batch_size=48,
    )
    assert result.backend == "cuda_graph"
    assert result.fallback_reason == "synthetic TensorRT load failure B48"
    written = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert written["backend"] == "cuda_graph"
