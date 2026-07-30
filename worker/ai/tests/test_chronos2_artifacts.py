from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path

import numpy as np
import pytest

from portfolio_ai_worker.chronos2 import CHRONOS2_NATIVE_QUANTILES
from portfolio_ai_worker.chronos2_artifacts import (
    CHRONOS2_DETERMINISM_POLICY,
    CHRONOS2_RAW_CHUNK_SCHEMA,
    CHRONOS2_RAW_INPUT_SCHEMA,
    CHRONOS2_RAW_INPUT_SCHEMA_V2,
    Chronos2InputFiles,
    Chronos2InputManifest,
    Chronos2ResumeState,
    chunk_input_digest,
    chronos2_task_batch_size,
    load_chronos2_input,
    load_chronos2_resume_state,
    open_chronos2_arrays,
    write_chronos2_chunk,
    write_chronos2_output_manifest,
)
from portfolio_ai_worker.raw_artifacts import (
    RawArtifactError,
    RawFileSpec,
    RawOrigin,
    atomic_write,
    canonical_json_bytes,
)


def _file(name: str, payload: bytes) -> RawFileSpec:
    return RawFileSpec(
        name=name,
        size_bytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
    )


def _artifact(
    root: Path,
    rows: int = 3,
    *,
    context_bars: int = 512,
    schema_version: str = CHRONOS2_RAW_INPUT_SCHEMA,
) -> Path:
    root.mkdir()
    contexts = np.ones((rows, 2, context_bars), dtype="<f4")
    contexts[:, 0] *= np.arange(rows, dtype=np.float32)[:, None] + 100
    contexts[:, 1] *= 0.25
    context_mask = np.ones_like(contexts, dtype=np.uint8)
    future = np.zeros((rows, 2, 64), dtype="<f4")
    future[:, 1] = 0.5
    future_mask = np.zeros_like(future, dtype=np.uint8)
    future_mask[:, 1, :60] = 1
    start = datetime(2026, 6, 1, tzinfo=timezone.utc)
    origins = b"".join(
        canonical_json_bytes(
            RawOrigin(
                row_id=row,
                instrument_key=f"TEST:{row}",
                origin=start + timedelta(minutes=row * 15),
                future_timestamps=tuple(
                    start + timedelta(minutes=row * 15 + index + 1)
                    for index in range(60)
                ),
                metadata={"symbol": "TEST"},
            )
        )
        for row in range(rows)
    )
    payloads = {
        "contexts.f32": contexts.tobytes(order="C"),
        "context-mask.u8": context_mask.tobytes(order="C"),
        "future-covariates.f32": future.tobytes(order="C"),
        "future-covariates-mask.u8": future_mask.tobytes(order="C"),
        "origins.jsonl": origins,
    }
    for name, payload in payloads.items():
        atomic_write(root / name, payload)
    manifest = Chronos2InputManifest(
        schema_version=schema_version,
        profile="ohlcv_calendar",
        cadence_seconds=60,
        horizon_minutes=(5, 15, 30, 60),
        prediction_steps=60,
        padded_prediction_steps=64,
        row_count=rows,
        row_order="row_id_ascending",
        context_bars=context_bars,
        variate_names=("target_close", "minute_of_day_sin"),
        target_variate_index=0,
        native_quantiles=CHRONOS2_NATIVE_QUANTILES,
        files=Chronos2InputFiles(
            contexts=_file("contexts.f32", payloads["contexts.f32"]),
            context_mask=_file("context-mask.u8", payloads["context-mask.u8"]),
            future_covariates=_file(
                "future-covariates.f32",
                payloads["future-covariates.f32"],
            ),
            future_covariates_mask=_file(
                "future-covariates-mask.u8",
                payloads["future-covariates-mask.u8"],
            ),
            origins=_file("origins.jsonl", origins),
        ),
        metadata={"test": True},
    )
    atomic_write(root / "manifest.json", canonical_json_bytes(manifest))
    return root / "manifest.json"


def test_chronos2_input_round_trip_validates_all_binary_shapes_and_digests(tmp_path: Path) -> None:
    loaded = load_chronos2_input(_artifact(tmp_path / "input"))
    arrays = open_chronos2_arrays(loaded)
    try:
        assert arrays[0].shape == (3, 2, 512)
        assert arrays[2].shape == (3, 2, 64)
        assert chunk_input_digest(
            loaded,
            0,
            tuple(np.asarray(value[:2]) for value in arrays),  # type: ignore[arg-type]
        )
    finally:
        del arrays


@pytest.mark.parametrize("context_bars", [512, 1024, 2048, 4096, 8192])
def test_chronos2_v2_input_round_trip_preserves_context_shape(
    tmp_path: Path,
    context_bars: int,
) -> None:
    loaded = load_chronos2_input(
        _artifact(
            tmp_path / f"input-{context_bars}",
            context_bars=context_bars,
            schema_version=CHRONOS2_RAW_INPUT_SCHEMA_V2,
        )
    )
    arrays = open_chronos2_arrays(loaded)
    try:
        assert arrays[0].shape == (3, 2, context_bars)
        assert arrays[1].all()
        assert loaded.manifest.context_bars == context_bars
    finally:
        del arrays


def test_chronos2_v1_rejects_non_512_context(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="v1 remains fixed"):
        _artifact(tmp_path / "invalid", context_bars=1024)


def test_chronos2_input_rejects_tampered_binary(tmp_path: Path) -> None:
    manifest = _artifact(tmp_path / "input")
    path = manifest.parent / "contexts.f32"
    values = bytearray(path.read_bytes())
    values[0] ^= 1
    path.write_bytes(values)
    with pytest.raises(RawArtifactError, match="SHA-256"):
        load_chronos2_input(manifest)


def test_chronos2_task_batch_respects_flattened_variate_limit() -> None:
    assert chronos2_task_batch_size(48, 11) == 4
    assert chronos2_task_batch_size(48, 14) == 3
    assert chronos2_task_batch_size(48, 18) == 2
    assert chronos2_task_batch_size(16, 18) == 1


def test_chronos2_chunks_resume_only_one_verified_contiguous_range(tmp_path: Path) -> None:
    loaded = load_chronos2_input(_artifact(tmp_path / "input"))
    output = tmp_path / "output"
    (output / "chunks").mkdir(parents=True)
    arrays = open_chronos2_arrays(loaded)
    try:
        sliced = tuple(np.asarray(value[:2]) for value in arrays)
        digest = chunk_input_digest(
            loaded,
            0,
            sliced,  # type: ignore[arg-type]
        )
    finally:
        del arrays
    predictions = np.zeros((2, 4, 22), dtype=np.float32)
    predictions[:, :, 1:] = np.arange(21, dtype=np.float32)
    predictions[:, :, 0] = 10
    provenance = {
        "model_id": "amazon/chronos-2",
        "weights_sha256": "a" * 64,
    }
    chunk = write_chronos2_chunk(
        output,
        predictions,
        start_row=0,
        input_digest=digest,
        backend="gpu_gather",
        variate_batch_size=16,
        task_batch_size=2,
        provenance=provenance,
        latency={"wall_ms": 1.0},
        gpu_telemetry={"status": "unavailable"},
    )
    assert chunk.schema_version == CHRONOS2_RAW_CHUNK_SCHEMA
    assert chunk.determinism_policy == CHRONOS2_DETERMINISM_POLICY
    state = load_chronos2_resume_state(
        output,
        artifact=loaded,
        backend="gpu_gather",
        variate_batch_size=16,
        task_batch_size=2,
        provenance=provenance,
    )
    assert state.next_row == 2
    manifest = write_chronos2_output_manifest(
        output,
        artifact=loaded,
        backend="gpu_gather",
        variate_batch_size=16,
        task_batch_size=2,
        provenance=provenance,
        state=Chronos2ResumeState(
            next_row=2,
            chunks=state.chunks,
            chunk_names=state.chunk_names,
        ),
    )
    assert manifest.output_shape == (3, 4, 22)
    assert manifest.completed_rows == 2
    assert manifest.complete is False
