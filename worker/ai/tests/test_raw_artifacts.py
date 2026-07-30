from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from portfolio_ai_worker.raw_artifacts import (
    RAW_CONTEXT_BARS,
    RAW_ROUTING_POLICY,
    LoadedRawInput,
    RawArtifactError,
    ResumeState,
    chunk_input_digest,
    load_raw_input,
    load_resume_state,
    open_contexts,
    routing_uniforms,
    secure_output_directory,
    write_output_manifest,
    write_prediction_chunk,
)


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _raw_input(tmp_path: Path, *, rows: int = 3, cadence_seconds: int = 60) -> Path:
    root = tmp_path / "input"
    root.mkdir(parents=True)
    contexts = (
        np.arange(rows * RAW_CONTEXT_BARS, dtype=np.float32).reshape(rows, RAW_CONTEXT_BARS)
        + np.float32(1.0)
    ).astype("<f4")
    context_payload = contexts.tobytes(order="C")
    (root / "contexts.f32").write_bytes(context_payload)
    origin = datetime(2026, 7, 1, tzinfo=timezone.utc)
    origin_lines = []
    for row_id in range(rows):
        row_origin = origin + timedelta(minutes=row_id)
        origin_lines.append(
            json.dumps(
                {
                    "row_id": row_id,
                    "instrument_key": f"BINANCE_USDM:BTCUSDT:{row_id}",
                    "origin": row_origin.isoformat(),
                    "future_timestamps": [
                        (row_origin + timedelta(minutes=index + 1)).isoformat()
                        for index in range(60)
                    ],
                    "metadata": {"symbol": "BTCUSDT"},
                },
                separators=(",", ":"),
            )
        )
    origin_payload = ("\n".join(origin_lines) + "\n").encode()
    (root / "origins.jsonl").write_bytes(origin_payload)
    manifest = {
        "schema_version": "fincast-raw-input/v1",
        "cadence_seconds": cadence_seconds,
        "horizon_minutes": [5, 15, 30, 60],
        "row_count": rows,
        "row_order": "row_id_ascending",
        "context_bars": 512,
        "model_seed": 17,
        "files": {
            "contexts": {
                "name": "contexts.f32",
                "size_bytes": len(context_payload),
                "sha256": _digest(context_payload),
            },
            "origins": {
                "name": "origins.jsonl",
                "size_bytes": len(origin_payload),
                "sha256": _digest(origin_payload),
            },
        },
        "metadata": {"source": "unit-test"},
    }
    manifest_path = root / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def _predictions(rows: int, *, offset: float = 0.0) -> np.ndarray:
    values = np.empty((rows, 4, 10), dtype=np.float32)
    values[:, :, 0] = np.float32(100 + offset)
    values[:, :, 1:] = (
        np.arange(1, 10, dtype=np.float32)[None, None, :]
        + np.float32(offset)
    )
    return values


def _provenance() -> dict[str, object]:
    return {
        "model_id": "Vincent05R/FinCast",
        "model_revision": "2d7d90b159db8961d27c2cf165d51195902ef92b",
        "source_revision": "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
        "weights_sha256": "a" * 64,
    }


def _append_chunk(
    artifact: LoadedRawInput,
    output: Path,
    *,
    start_row: int,
    rows: int,
) -> None:
    contexts = open_contexts(artifact)
    try:
        digest = chunk_input_digest(
            artifact,
            start_row,
            np.asarray(contexts[start_row : start_row + rows]),
        )
    finally:
        del contexts
    write_prediction_chunk(
        output,
        _predictions(rows, offset=float(start_row)),
        start_row=start_row,
        input_digest=digest,
        backend="eager",
        batch_size=2,
        model_seed=17,
        provenance=_provenance(),
        latency={"wall_ms": 1.0, "cuda_event_ms": None},
        gpu_telemetry={"status": "unavailable"},
    )


def test_raw_input_validates_binary_jsonl_bounds_and_opens_little_endian_memmap(
    tmp_path: Path,
) -> None:
    artifact = load_raw_input(_raw_input(tmp_path).resolve())
    contexts = open_contexts(artifact)
    try:
        assert contexts.dtype == np.dtype("<f4")
        assert contexts.shape == (3, 512)
        assert contexts[2, 511] == np.float32(1536)
    finally:
        del contexts
    assert artifact.manifest.row_count == 3
    assert artifact.manifest.horizon_minutes == (5, 15, 30, 60)
    assert len(artifact.artifact_digest) == 64


def test_raw_input_rejects_relative_symlink_tampering_and_non_finite_values(
    tmp_path: Path,
) -> None:
    manifest = _raw_input(tmp_path)
    with pytest.raises(RawArtifactError, match="must be absolute"):
        load_raw_input(manifest.relative_to(tmp_path))

    context_path = manifest.parent / "contexts.f32"
    context_path.write_bytes(context_path.read_bytes()[:-4])
    with pytest.raises(RawArtifactError, match="size differs"):
        load_raw_input(manifest.resolve())

    other = tmp_path / "other"
    other.mkdir()
    linked = other / "manifest.json"
    linked.symlink_to(manifest)
    with pytest.raises(RawArtifactError, match="must not be a symlink"):
        load_raw_input(linked)

    clean = _raw_input(tmp_path / "fresh", rows=1)
    payload = bytearray((clean.parent / "contexts.f32").read_bytes())
    payload[0:4] = np.asarray([np.nan], dtype="<f4").tobytes()
    context_file = clean.parent / "contexts.f32"
    context_file.write_bytes(payload)
    decoded = json.loads(clean.read_text(encoding="utf-8"))
    decoded["files"]["contexts"]["sha256"] = _digest(bytes(payload))
    clean.write_text(json.dumps(decoded), encoding="utf-8")
    with pytest.raises(RawArtifactError, match="finite positive"):
        load_raw_input(clean.resolve())


def test_row_routing_uniform_is_batch_resume_and_decode_shape_invariant() -> None:
    full = routing_uniforms(
        np.asarray([7, 8, 9], dtype=np.int64),
        model_seed=41,
        decode_passes=2,
        layers=3,
    )
    resumed = routing_uniforms(
        np.asarray([9], dtype=np.int64),
        model_seed=41,
        decode_passes=2,
        layers=3,
    )
    other_batch = routing_uniforms(
        np.asarray([100, 9, 101], dtype=np.int64),
        model_seed=41,
        decode_passes=2,
        layers=3,
    )

    assert full.shape == (2, 3, 2, 3, 16)
    np.testing.assert_array_equal(full[:, :, :, 2:3, :], resumed)
    np.testing.assert_array_equal(other_batch[:, :, :, 1:2, :], resumed)
    assert np.all(full > 0)
    assert np.all(full < 1)
    assert not np.array_equal(
        full,
        routing_uniforms(
            np.asarray([7, 8, 9], dtype=np.int64),
            model_seed=42,
            decode_passes=2,
            layers=3,
        ),
    )


def test_row_routing_uniform_clamps_fp32_upper_endpoint_without_batch_drift() -> None:
    # row 5255 / layer 31 / top-0 / token 3 used to round to exactly 1.0
    # when a five-week replay first reached this row.
    isolated = routing_uniforms(
        np.asarray([5255], dtype=np.int64),
        model_seed=0,
        decode_passes=1,
        layers=50,
    )
    batched = routing_uniforms(
        np.arange(5232, 5280, dtype=np.int64),
        model_seed=0,
        decode_passes=1,
        layers=50,
    )

    assert np.all(isolated > 0)
    assert np.all(isolated < 1)
    assert isolated[0, 31, 0, 0, 3] == np.nextafter(
        np.float32(1.0),
        np.float32(0.0),
    )
    np.testing.assert_array_equal(isolated, batched[:, :, :, 23:24, :])


def test_chunk_checkpoint_resume_is_atomic_contiguous_and_digest_verified(
    tmp_path: Path,
) -> None:
    artifact = load_raw_input(_raw_input(tmp_path, rows=3).resolve())
    output = secure_output_directory((tmp_path / "output").resolve())
    empty = ResumeState(next_row=0, chunks=(), chunk_metadata_names=())
    write_output_manifest(
        output,
        artifact=artifact,
        backend="eager",
        batch_size=2,
        provenance=_provenance(),
        state=empty,
    )

    _append_chunk(artifact, output, start_row=0, rows=2)
    first = load_resume_state(
        output,
        artifact=artifact,
        backend="eager",
        batch_size=2,
        provenance=_provenance(),
    )
    assert first.next_row == 2
    assert len(first.chunks) == 1
    write_output_manifest(
        output,
        artifact=artifact,
        backend="eager",
        batch_size=2,
        provenance=_provenance(),
        state=first,
    )

    # A data file without its atomically-published metadata is never treated as complete.
    orphan = output / "chunks" / "chunk-0000000002-0000000003.f32"
    orphan.write_bytes(b"interrupted")
    still_first = load_resume_state(
        output,
        artifact=artifact,
        backend="eager",
        batch_size=2,
        provenance=_provenance(),
    )
    assert still_first.next_row == 2
    orphan.unlink()

    _append_chunk(artifact, output, start_row=2, rows=1)
    complete = load_resume_state(
        output,
        artifact=artifact,
        backend="eager",
        batch_size=2,
        provenance=_provenance(),
    )
    manifest = write_output_manifest(
        output,
        artifact=artifact,
        backend="eager",
        batch_size=2,
        provenance=_provenance(),
        state=complete,
    )
    assert complete.next_row == 3
    assert manifest.complete is True
    assert manifest.routing_seed_policy == RAW_ROUTING_POLICY

    binary = output / complete.chunks[0].output.name
    binary.write_bytes(binary.read_bytes()[:-4] + b"\0\0\0\0")
    with pytest.raises(RawArtifactError, match="SHA-256"):
        load_resume_state(
            output,
            artifact=artifact,
            backend="eager",
            batch_size=2,
            provenance=_provenance(),
        )


def test_resume_rejects_gaps_contract_drift_and_nonmonotonic_predictions(
    tmp_path: Path,
) -> None:
    artifact = load_raw_input(_raw_input(tmp_path, rows=4).resolve())
    output = secure_output_directory((tmp_path / "output").resolve())
    _append_chunk(artifact, output, start_row=1, rows=1)
    with pytest.raises(RawArtifactError, match="contiguous"):
        load_resume_state(
            output,
            artifact=artifact,
            backend="eager",
            batch_size=2,
            provenance=_provenance(),
        )

    clean_output = secure_output_directory((tmp_path / "clean-output").resolve())
    write_output_manifest(
        clean_output,
        artifact=artifact,
        backend="eager",
        batch_size=2,
        provenance=_provenance(),
        state=ResumeState(next_row=0, chunks=(), chunk_metadata_names=()),
    )
    with pytest.raises(RawArtifactError, match="does not match"):
        load_resume_state(
            clean_output,
            artifact=artifact,
            backend="no_padding",
            batch_size=2,
            provenance=_provenance(),
        )

    invalid = _predictions(1)
    invalid[0, 0, 4] = invalid[0, 0, 3] - 1
    with pytest.raises(RawArtifactError, match="monotonic"):
        write_prediction_chunk(
            clean_output,
            invalid,
            start_row=0,
            input_digest="b" * 64,
            backend="eager",
            batch_size=2,
            model_seed=17,
            provenance=_provenance(),
            latency={},
            gpu_telemetry={},
        )
