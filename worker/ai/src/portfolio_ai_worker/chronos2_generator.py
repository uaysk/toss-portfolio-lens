from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import time

import numpy as np
import torch

from .chronos2 import Chronos2Adapter
from .chronos2_artifacts import (
    Chronos2ResumeState,
    chunk_input_digest,
    chronos2_task_batch_size,
    empty_output_required,
    load_chronos2_input,
    load_chronos2_resume_state,
    open_chronos2_arrays,
    write_chronos2_chunk,
    write_chronos2_output_manifest,
)
from .chronos2_raw_inference import (
    CHRONOS2_RAW_BACKENDS,
    Chronos2RawBackend,
    Chronos2RawInference,
    Chronos2RawInferenceError,
)
from .gpu_telemetry import GpuTelemetrySampler
from .raw_artifacts import secure_output_directory

CHRONOS2_DEFAULT_BACKEND: Chronos2RawBackend = "gpu_gather"
CHRONOS2_DEFAULT_VARIATE_BATCH = 32


@dataclass(frozen=True, slots=True)
class Chronos2GenerationResult:
    output_manifest: Path
    backend: Chronos2RawBackend
    variate_batch_size: int
    task_batch_size: int
    completed_rows: int
    output_digest: str
    resumed_from_row: int
    graph_capture_ms: float


def selected_backend() -> Chronos2RawBackend:
    value = os.getenv(
        "AI_CHRONOS2_RAW_BACKEND",
        CHRONOS2_DEFAULT_BACKEND,
    ).strip()
    if value not in CHRONOS2_RAW_BACKENDS:
        raise Chronos2RawInferenceError(
            "AI_CHRONOS2_RAW_BACKEND must be pipeline_eager, worker_local, "
            "no_padding, gpu_gather, or cuda_graph"
        )
    return value  # type: ignore[return-value]


def selected_variate_batch_size() -> int:
    raw = os.getenv(
        "AI_CHRONOS2_RAW_BATCH",
        str(CHRONOS2_DEFAULT_VARIATE_BATCH),
    )
    try:
        value = int(raw)
    except ValueError as error:
        raise Chronos2RawInferenceError(
            "AI_CHRONOS2_RAW_BATCH must be an integer"
        ) from error
    if value < 1 or value > 4096:
        raise Chronos2RawInferenceError(
            "AI_CHRONOS2_RAW_BATCH must be between 1 and 4096"
        )
    return value


def generate_chronos2_predictions(
    adapter: Chronos2Adapter,
    *,
    manifest_path: Path,
    output_dir: Path,
    resume: bool,
    backend: Chronos2RawBackend | None = None,
    variate_batch_size: int | None = None,
) -> Chronos2GenerationResult:
    artifact = load_chronos2_input(manifest_path)
    if artifact.manifest.profile != adapter.input_profile:
        raise Chronos2RawInferenceError(
            "Chronos-2 input artifact profile differs from the loaded adapter"
        )
    active_backend = backend or selected_backend()
    if active_backend not in CHRONOS2_RAW_BACKENDS:
        raise Chronos2RawInferenceError("unsupported Chronos-2 raw backend")
    active_variate_batch = variate_batch_size or selected_variate_batch_size()
    task_batch = chronos2_task_batch_size(
        active_variate_batch,
        len(artifact.manifest.variate_names),
    )
    if resume:
        output_dir = secure_output_directory(output_dir)
    else:
        output_dir = empty_output_required(output_dir)
    inference = Chronos2RawInference(
        adapter,
        backend=active_backend,
        variate_names=artifact.manifest.variate_names,
        graph_task_batch_size=(
            task_batch if active_backend == "cuda_graph" else None
        ),
    )
    provenance = inference.provenance
    if provenance["weights_sha256"] == "unavailable":
        raise Chronos2RawInferenceError(
            "Chronos-2 raw generation could not record the fixed weight SHA-256"
        )
    if resume:
        state = load_chronos2_resume_state(
            output_dir,
            artifact=artifact,
            backend=active_backend,
            variate_batch_size=active_variate_batch,
            task_batch_size=task_batch,
            provenance=provenance,  # type: ignore[arg-type]
        )
    else:
        state = Chronos2ResumeState(next_row=0, chunks=(), chunk_names=())
    resumed_from = state.next_row
    write_chronos2_output_manifest(
        output_dir,
        artifact=artifact,
        backend=active_backend,
        variate_batch_size=active_variate_batch,
        task_batch_size=task_batch,
        provenance=provenance,  # type: ignore[arg-type]
        state=state,
    )
    arrays = open_chronos2_arrays(artifact)
    output_hasher = hashlib.sha256()
    graph_capture_ms = 0.0
    try:
        for chunk in state.chunks:
            with (output_dir / chunk.output.name).open("rb") as handle:
                while block := handle.read(1 << 20):
                    output_hasher.update(block)
        while state.next_row < artifact.manifest.row_count:
            start_row = state.next_row
            end_row = min(start_row + task_batch, artifact.manifest.row_count)
            values = tuple(
                np.asarray(array[start_row:end_row])
                for array in arrays
            )
            input_digest = chunk_input_digest(
                artifact,
                start_row,
                values,  # type: ignore[arg-type]
            )
            if inference.device.type == "cuda":
                torch.cuda.reset_peak_memory_stats(inference.device)
            telemetry = GpuTelemetrySampler(0)
            started = time.perf_counter()
            with telemetry:
                observation = inference.predict(
                    *values,
                    variate_batch_size=active_variate_batch,
                )
            wall_ms = (time.perf_counter() - started) * 1_000
            graph_capture_ms += observation.graph_capture_ms or 0.0
            output = np.ascontiguousarray(observation.output, dtype="<f4")
            output_hasher.update(output.tobytes(order="C"))
            peak_vram = (
                max(
                    int(torch.cuda.max_memory_allocated(inference.device)),
                    int(torch.cuda.max_memory_reserved(inference.device)),
                )
                if inference.device.type == "cuda"
                else 0
            )
            chunk = write_chronos2_chunk(
                output_dir,
                output,
                start_row=start_row,
                input_digest=input_digest,
                backend=active_backend,
                variate_batch_size=active_variate_batch,
                task_batch_size=task_batch,
                provenance=provenance,  # type: ignore[arg-type]
                latency={
                    "wall_ms": wall_ms,
                    "compute_cuda_ms": observation.compute_cuda_ms,
                    "series_per_second": (
                        len(output) / (wall_ms / 1_000)
                        if wall_ms > 0
                        else None
                    ),
                    "graph_capture_ms": observation.graph_capture_ms,
                    "graph_replay": observation.graph_replay,
                    "tail_eager": observation.tail_eager,
                },
                gpu_telemetry={
                    **telemetry.summary(),
                    "peak_vram_bytes": peak_vram,
                },
            )
            state = Chronos2ResumeState(
                next_row=end_row,
                chunks=(*state.chunks, chunk),
                chunk_names=(
                    *state.chunk_names,
                    f"chunks/chunk-{start_row:010d}-{end_row:010d}.json",
                ),
            )
            write_chronos2_output_manifest(
                output_dir,
                artifact=artifact,
                backend=active_backend,
                variate_batch_size=active_variate_batch,
                task_batch_size=task_batch,
                provenance=provenance,  # type: ignore[arg-type]
                state=state,
            )
    finally:
        del arrays
    return Chronos2GenerationResult(
        output_manifest=output_dir / "manifest.json",
        backend=active_backend,
        variate_batch_size=active_variate_batch,
        task_batch_size=task_batch,
        completed_rows=state.next_row,
        output_digest=output_hasher.hexdigest(),
        resumed_from_row=resumed_from,
        graph_capture_ms=graph_capture_ms,
    )
