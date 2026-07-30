from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .adapters import InferenceSeries
from .contracts import PriceBar
from .fincast import FinCastAdapter
from .raw_artifacts import (
    RawOrigin,
    atomic_write,
    canonical_json_bytes,
    load_raw_input,
    open_contexts,
    routing_uniforms,
)
from .raw_generator import _PinnedTransfer
from .raw_inference import (
    FinCastRawInference,
    RawInferenceError,
    native_to_projected_compatibility,
    numpy_output_digest,
    routing_scope,
)

COMPATIBILITY_SCHEMA = "fincast-raw-transport-compatibility/v1"
COMPATIBILITY_BATCH_SIZE = 16


def _origins(path: Path, count: int) -> tuple[RawOrigin, ...]:
    values: list[RawOrigin] = []
    with path.open("rb") as handle:
        for line in handle:
            if len(values) >= count:
                break
            values.append(RawOrigin.model_validate_json(line))
    if len(values) != count:
        raise RawInferenceError("raw compatibility input does not contain the requested origins")
    return tuple(values)


def _series(
    contexts: np.ndarray,
    origins: tuple[RawOrigin, ...],
    *,
    cadence_seconds: int,
) -> tuple[InferenceSeries, ...]:
    output: list[InferenceSeries] = []
    for row_id, (context, origin) in enumerate(zip(contexts, origins, strict=True)):
        end = origin.origin
        bars = tuple(
            PriceBar(
                timestamp=end - timedelta(seconds=(511 - index) * cadence_seconds),
                open=float(close),
                high=float(close),
                low=float(close),
                close=float(close),
                volume=1.0,
                amount=float(close),
                complete=True,
            )
            for index, close in enumerate(context)
        )
        future = tuple(origin.future_timestamps[:60])
        output.append(
            InferenceSeries(
                instrument_key=f"{origin.instrument_key}:compat:{row_id}",
                timezone="UTC",
                bars=bars,
                future_timestamps=future,
            )
        )
    return tuple(output)


def _adapter_view(predictions: list[Any]) -> np.ndarray:
    values = np.empty((len(predictions), 4, 7), dtype="<f4")
    for row, prediction in enumerate(predictions):
        if prediction.close_quantiles is None:
            raise RawInferenceError("FinCastAdapter compatibility prediction is unavailable")
        for horizon_index, horizon in enumerate((5, 15, 30, 60)):
            quantiles = prediction.close_quantiles.get(horizon)
            if quantiles is None or tuple(quantiles) != (
                0.05,
                0.1,
                0.25,
                0.5,
                0.75,
                0.9,
                0.95,
            ):
                raise RawInferenceError("FinCastAdapter compatibility quantiles are misaligned")
            values[row, horizon_index] = np.asarray(
                tuple(quantiles.values()),
                dtype="<f4",
            )
    return values


def verify_raw_transport_compatibility(
    adapter: FinCastAdapter,
    *,
    manifest_path: Path,
) -> dict[str, Any]:
    artifact = load_raw_input(manifest_path)
    if artifact.manifest.row_count < COMPATIBILITY_BATCH_SIZE:
        raise RawInferenceError("raw compatibility requires at least 16 rows")
    contexts_map = open_contexts(artifact)
    try:
        contexts = np.ascontiguousarray(
            contexts_map[:COMPATIBILITY_BATCH_SIZE],
            dtype="<f4",
        )
    finally:
        del contexts_map
    origins = _origins(artifact.origins_path, COMPATIBILITY_BATCH_SIZE)
    series = _series(
        contexts,
        origins,
        cadence_seconds=artifact.manifest.cadence_seconds,
    )
    inference = FinCastRawInference(adapter, backend="eager")
    horizon_steps = 60 * 60 // artifact.manifest.cadence_seconds
    decode_passes = (horizon_steps + 127) // 128
    uniforms = routing_uniforms(
        np.arange(COMPATIBILITY_BATCH_SIZE, dtype=np.int64),
        model_seed=artifact.manifest.model_seed,
        decode_passes=decode_passes,
        layers=inference.layers,
    )
    transfer = _PinnedTransfer(
        batch_size=COMPATIBILITY_BATCH_SIZE,
        decode_passes=decode_passes,
        layers=inference.layers,
        device=inference.runtime.name,
    )
    _device_contexts, adapter_uniforms = transfer.copy(contexts, uniforms)
    with routing_scope(inference.gates, adapter_uniforms):
        adapter_predictions = adapter.predict_batch(
            series,
            seed=artifact.manifest.model_seed,
        )
    adapter_projected = _adapter_view(adapter_predictions)

    raw_contexts, raw_uniforms = transfer.copy(contexts, uniforms)
    raw = inference.predict_tensor(
        raw_contexts,
        raw_uniforms,
        cadence_seconds=artifact.manifest.cadence_seconds,
    )
    raw_native = np.ascontiguousarray(
        raw.output.detach().cpu().numpy(),
        dtype="<f4",
    )
    torch.cuda.synchronize()
    raw_projected = native_to_projected_compatibility(raw_native)
    exact = bool(np.array_equal(adapter_projected, raw_projected))
    return {
        "schema_version": COMPATIBILITY_SCHEMA,
        "status": "passed" if exact else "rejected",
        "exact_digest": exact,
        "batch_size": COMPATIBILITY_BATCH_SIZE,
        "cadence_seconds": artifact.manifest.cadence_seconds,
        "row_start": 0,
        "row_end": COMPATIBILITY_BATCH_SIZE,
        "row_order": "row_id_ascending",
        "routing_seed_policy": "fincast-row-routing-uniform/v1",
        "model_seed": artifact.manifest.model_seed,
        "adapter_projected_digest": numpy_output_digest(adapter_projected),
        "worker_local_projected_digest": numpy_output_digest(raw_projected),
        "worker_local_native_digest": numpy_output_digest(raw_native),
        "input_manifest_sha256": artifact.manifest_sha256,
        "input_artifact_digest": artifact.artifact_digest,
        "provenance": inference.provenance,
        "evidence": {
            "live_value_path": "FinCastAdapter.predict_batch",
            "transport_contract": "unchanged_websocket_contract",
            "raw_value_path": "FinCastRawInference.eager",
            "projected_shape": list(raw_projected.shape),
        },
    }


def write_raw_transport_compatibility(
    adapter: FinCastAdapter,
    *,
    manifest_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    if not output_path.is_absolute() or output_path.resolve(strict=False) != output_path:
        raise RawInferenceError("raw compatibility output must be an absolute normalized path")
    if output_path.exists() or output_path.is_symlink():
        raise RawInferenceError("raw compatibility output already exists or is a symlink")
    output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    result = verify_raw_transport_compatibility(
        adapter,
        manifest_path=manifest_path,
    )
    atomic_write(output_path, canonical_json_bytes(result))
    return result
