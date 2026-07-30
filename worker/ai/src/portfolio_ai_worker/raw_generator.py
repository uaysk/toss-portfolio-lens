from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import time

import numpy as np
import torch

from .fincast import FinCastAdapter
from .gpu_telemetry import GpuTelemetrySampler
from .raw_artifacts import (
    RAW_CHUNK_DIRECTORY,
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
from .raw_inference import (
    FP32_BACKENDS,
    FinCastRawInference,
    RawBackendName,
    RawInferenceError,
    numpy_output_digest,
)
from .tensorrt_process import TensorRTRawProcess

RAW_DEFAULT_BACKEND_BY_CADENCE: dict[int, RawBackendName] = {
    15: "cuda_graph",
    30: "cuda_graph",
    60: "cuda_graph",
}
RAW_DEFAULT_BATCH_BY_CADENCE = {
    15: 48,
    30: 48,
    60: 48,
}


@dataclass(frozen=True, slots=True)
class RawGenerationResult:
    output_manifest: Path
    backend: RawBackendName
    batch_size: int
    completed_rows: int
    output_digest: str
    resumed_from_row: int
    fallback_reason: str | None = None


def selected_raw_backend(cadence_seconds: int) -> RawBackendName:
    configured = os.getenv(
        "AI_FINCAST_RAW_BACKEND",
        RAW_DEFAULT_BACKEND_BY_CADENCE[cadence_seconds],
    ).strip()
    if configured not in FP32_BACKENDS:
        raise RawInferenceError(
            "AI_FINCAST_RAW_BACKEND must be eager, no_padding, batched_experts, "
            "cuda_graph, or tensorrt_fp32"
        )
    return configured  # type: ignore[return-value]


def selected_raw_batch_size(cadence_seconds: int) -> int:
    name = f"AI_FINCAST_RAW_BATCH_{cadence_seconds}"
    raw = os.getenv(name, str(RAW_DEFAULT_BATCH_BY_CADENCE[cadence_seconds]))
    try:
        value = int(raw)
    except ValueError as error:
        raise RawInferenceError(f"{name} must be an integer") from error
    if value < 1 or value > 256:
        raise RawInferenceError(f"{name} must be between 1 and 256")
    return value


class _PinnedTransfer:
    def __init__(
        self,
        *,
        batch_size: int,
        decode_passes: int,
        layers: int,
        device: str,
    ) -> None:
        self.host_contexts = torch.empty(
            (batch_size, 512),
            dtype=torch.float32,
            pin_memory=True,
        )
        self.host_uniforms = torch.empty(
            (decode_passes, layers, 2, batch_size, 16),
            dtype=torch.float32,
            pin_memory=True,
        )
        self.device_contexts = torch.empty(
            (batch_size, 512),
            dtype=torch.float32,
            device=device,
        )
        self.device_uniforms = torch.empty(
            (decode_passes, layers, 2, batch_size, 16),
            dtype=torch.float32,
            device=device,
        )

    def copy(
        self,
        contexts: np.ndarray,
        uniforms: np.ndarray,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        rows = int(contexts.shape[0])
        if rows <= 0 or rows > self.host_contexts.shape[0]:
            raise RawInferenceError("pinned transfer received an invalid batch")
        np.copyto(
            self.host_contexts[:rows].numpy(),
            np.asarray(contexts, dtype=np.float32),
            casting="no",
        )
        np.copyto(
            self.host_uniforms[:, :, :, :rows, :].numpy(),
            np.asarray(uniforms, dtype=np.float32),
            casting="no",
        )
        device_contexts = self.device_contexts[:rows]
        device_uniforms = self.device_uniforms[:, :, :, :rows, :]
        device_contexts.copy_(self.host_contexts[:rows], non_blocking=True)
        device_uniforms.copy_(
            self.host_uniforms[:, :, :, :rows, :],
            non_blocking=True,
        )
        return device_contexts, device_uniforms


def _empty_output_required(output_dir: Path) -> None:
    if not output_dir.exists():
        return
    if output_dir.is_symlink() or not output_dir.is_dir():
        raise RawInferenceError("raw output must be a non-symlink directory")
    entries = tuple(output_dir.iterdir())
    if entries:
        raise RawInferenceError("raw output is not empty; pass --resume to validate and continue it")


def _metadata_name(start_row: int, end_row: int) -> str:
    return f"{RAW_CHUNK_DIRECTORY}/chunk-{start_row:010d}-{end_row:010d}.json"


def generate_raw_predictions(
    adapter: FinCastAdapter,
    *,
    manifest_path: Path,
    output_dir: Path,
    resume: bool,
    backend: RawBackendName | None = None,
    batch_size: int | None = None,
) -> RawGenerationResult:
    artifact = load_raw_input(manifest_path)
    cadence_seconds = artifact.manifest.cadence_seconds
    selected_backend = backend or selected_raw_backend(cadence_seconds)
    selected_batch = batch_size or selected_raw_batch_size(cadence_seconds)
    if selected_backend not in FP32_BACKENDS:
        raise RawInferenceError("raw-generate does not permit this backend")
    if selected_batch < 1 or selected_batch > 256:
        raise RawInferenceError("raw generation batch size must be between 1 and 256")
    if not resume:
        _empty_output_required(output_dir)
    output_dir = secure_output_directory(output_dir)

    fallback_reason: str | None = None
    tensorrt: TensorRTRawProcess | None = None
    if selected_backend == "tensorrt_fp32":
        if cadence_seconds != 60 or selected_batch != 48:
            raise RawInferenceError("TensorRT FP32 raw generation is qualified only for c60/B48")
        try:
            tensorrt = TensorRTRawProcess(batch_size=selected_batch)
        except RawInferenceError as error:
            if os.getenv("AI_FINCAST_TENSORRT_LOAD_FALLBACK", "").strip() != "cuda_graph":
                raise
            fallback_reason = str(error)
            selected_backend = "cuda_graph"
            inference = FinCastRawInference(
                adapter,
                backend="cuda_graph",
                graph_batch_size=selected_batch,
            )
        else:
            inference = FinCastRawInference(
                adapter,
                backend="batched_experts",
            )
    else:
        inference = FinCastRawInference(
            adapter,
            backend=selected_backend,
            graph_batch_size=selected_batch if selected_backend == "cuda_graph" else None,
        )
    provenance = inference.provenance
    if tensorrt is not None:
        provenance = {
            **provenance,
            "backend": "tensorrt_fp32",
            "packed_expert_layers": len(inference.packed_experts),
            **tensorrt.provenance,
        }
    if provenance["weights_sha256"] == "unavailable":
        raise RawInferenceError("raw generation could not record the fixed weight SHA-256")
    if resume:
        state = load_resume_state(
            output_dir,
            artifact=artifact,
            backend=selected_backend,
            batch_size=selected_batch,
            provenance=provenance,
        )
    else:
        state = ResumeState(next_row=0, chunks=(), chunk_metadata_names=())
    resumed_from = state.next_row
    write_output_manifest(
        output_dir,
        artifact=artifact,
        backend=selected_backend,
        batch_size=selected_batch,
        provenance=provenance,
        state=state,
    )

    horizon_steps = 60 * 60 // cadence_seconds
    decode_passes = (horizon_steps + 127) // 128
    transfer = _PinnedTransfer(
        batch_size=selected_batch,
        decode_passes=decode_passes,
        layers=inference.layers,
        device=inference.runtime.name,
    )
    contexts = open_contexts(artifact)
    output_hasher = hashlib.sha256()
    try:
        for completed_chunk in state.chunks:
            binary_path = output_dir / completed_chunk.output.name
            with binary_path.open("rb") as handle:
                while block := handle.read(1 << 20):
                    output_hasher.update(block)

        while state.next_row < artifact.manifest.row_count:
            start_row = state.next_row
            end_row = min(start_row + selected_batch, artifact.manifest.row_count)
            host_contexts = np.asarray(contexts[start_row:end_row])
            row_ids = np.arange(start_row, end_row, dtype=np.int64)
            host_uniforms = routing_uniforms(
                row_ids,
                model_seed=artifact.manifest.model_seed,
                decode_passes=decode_passes,
                layers=inference.layers,
            )
            input_digest = chunk_input_digest(
                artifact,
                start_row,
                host_contexts,
            )
            torch.cuda.reset_peak_memory_stats()
            telemetry = GpuTelemetrySampler(
                adapter._settings.fincast_nvml_device_index
            )
            wall_started = time.perf_counter()
            if tensorrt is not None and len(host_contexts) == selected_batch:
                with telemetry:
                    tensorrt_observation = tensorrt.predict(
                        host_contexts,
                        host_uniforms,
                        cadence_seconds=cadence_seconds,
                    )
                values = np.ascontiguousarray(tensorrt_observation.output, dtype="<f4")
                compute_cuda_ms = tensorrt_observation.compute_cuda_ms
                graph_capture_ms = None
                graph_replay = False
                tail_eager = False
                execution_backend = "tensorrt_fp32"
            else:
                compute_started = torch.cuda.Event(enable_timing=True)
                compute_finished = torch.cuda.Event(enable_timing=True)
                with telemetry:
                    device_contexts, device_uniforms = transfer.copy(
                        host_contexts,
                        host_uniforms,
                    )
                    compute_started.record()
                    observation = inference.predict_tensor(
                        device_contexts,
                        device_uniforms,
                        cadence_seconds=cadence_seconds,
                    )
                    compute_finished.record()
                    output_cpu = observation.output.detach().cpu()
                    torch.cuda.synchronize()
                values = np.ascontiguousarray(output_cpu.numpy(), dtype="<f4")
                compute_cuda_ms = float(compute_started.elapsed_time(compute_finished))
                graph_capture_ms = observation.graph_capture_ms
                graph_replay = observation.graph_replay
                tail_eager = bool(observation.tail_eager or tensorrt is not None)
                execution_backend = (
                    "batched_experts" if tensorrt is not None else selected_backend
                )
            inference_wall_ms = (time.perf_counter() - wall_started) * 1_000
            chunk_output_digest = numpy_output_digest(values)
            chunk = write_prediction_chunk(
                output_dir,
                values,
                start_row=start_row,
                input_digest=input_digest,
                backend=selected_backend,
                batch_size=selected_batch,
                model_seed=artifact.manifest.model_seed,
                provenance=provenance,
                latency={
                    "inference_wall_ms": inference_wall_ms,
                    "compute_cuda_ms": compute_cuda_ms,
                    "series_per_second": len(values) / (inference_wall_ms / 1_000),
                    "graph_capture_ms": graph_capture_ms,
                    "graph_replay": graph_replay,
                    "tail_eager": tail_eager,
                    "execution_backend": execution_backend,
                    "torch_peak_allocated_bytes": int(torch.cuda.max_memory_allocated()),
                    "torch_peak_reserved_bytes": int(torch.cuda.max_memory_reserved()),
                    "output_digest": chunk_output_digest,
                },
                gpu_telemetry=telemetry.summary(),
            )
            output_hasher.update(values.tobytes(order="C"))
            state = ResumeState(
                next_row=end_row,
                chunks=(*state.chunks, chunk),
                chunk_metadata_names=(
                    *state.chunk_metadata_names,
                    _metadata_name(start_row, end_row),
                ),
            )
            manifest = write_output_manifest(
                output_dir,
                artifact=artifact,
                backend=selected_backend,
                batch_size=selected_batch,
                provenance=provenance,
                state=state,
            )
            if manifest.completed_rows != end_row:
                raise RawInferenceError("raw output checkpoint did not advance atomically")
    except BaseException:
        write_output_manifest(
            output_dir,
            artifact=artifact,
            backend=selected_backend,
            batch_size=selected_batch,
            provenance=provenance,
            state=state,
        )
        torch.cuda.empty_cache()
        raise
    finally:
        if tensorrt is not None:
            tensorrt.close()
        del contexts

    return RawGenerationResult(
        output_manifest=output_dir / "manifest.json",
        backend=selected_backend,
        batch_size=selected_batch,
        completed_rows=state.next_row,
        output_digest=output_hasher.hexdigest(),
        resumed_from_row=resumed_from,
        fallback_reason=fallback_reason,
    )
