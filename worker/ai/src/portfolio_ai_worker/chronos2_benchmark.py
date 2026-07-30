from __future__ import annotations

from dataclasses import dataclass
import statistics
from pathlib import Path
import time
import traceback
from typing import Any

import numpy as np
import torch

from .adapters import load_production_model_suite
from .chronos2 import CHRONOS2_NATIVE_QUANTILES, Chronos2Adapter
from .chronos2_artifacts import (
    chronos2_task_batch_size,
    load_chronos2_input,
    open_chronos2_arrays,
)
from .chronos2_raw_inference import (
    CHRONOS2_RAW_BACKENDS,
    Chronos2RawBackend,
    Chronos2RawInference,
    Chronos2RawInferenceError,
    chronos2_raw_output_digest,
)
from .gpu_telemetry import GpuTelemetrySampler
from .raw_artifacts import atomic_write, canonical_json_bytes
from .settings import AISettings

CHRONOS2_BENCHMARK_SCHEMA = "chronos2-p40-raw-benchmark/v1"
CHRONOS2_BENCHMARK_BATCHES = (1, 2, 4, 8, 12, 16, 24, 32, 48, 50)
CHRONOS2_MINIMUM_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class Chronos2BenchmarkProtocol:
    rounds: int = 3
    warmups: int = 10
    iterations: int = 30

    def validate(self) -> Chronos2BenchmarkProtocol:
        if self.rounds < 1 or self.rounds > 10:
            raise Chronos2RawInferenceError("benchmark rounds must be in 1..10")
        if self.warmups < 0 or self.warmups > 100:
            raise Chronos2RawInferenceError("benchmark warmups must be in 0..100")
        if self.iterations < 1 or self.iterations > 1000:
            raise Chronos2RawInferenceError("benchmark iterations must be in 1..1000")
        return self


def _summary(values: list[float]) -> dict[str, float]:
    if not values:
        raise Chronos2RawInferenceError("cannot summarize empty timing samples")
    array = np.asarray(values, dtype=np.float64)
    return {
        "minimum": min(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "p50": float(np.percentile(array, 50)),
        "p95": float(np.percentile(array, 95)),
        "p99": float(np.percentile(array, 99)),
        "maximum": max(values),
    }


def _accuracy_gate(reference: np.ndarray, candidate: np.ndarray, contexts: np.ndarray) -> dict[str, Any]:
    if reference.shape != candidate.shape or reference.shape[1:] != (4, 22):
        raise Chronos2RawInferenceError("Chronos-2 accuracy gate received misaligned outputs")
    finite = bool(np.isfinite(candidate).all())
    monotonic = bool(np.all(np.diff(candidate[:, :, 1:], axis=-1) >= 0))
    median_column = 1 + CHRONOS2_NATIVE_QUANTILES.index(0.5)
    q25_column = 1 + CHRONOS2_NATIVE_QUANTILES.index(0.25)
    q75_column = 1 + CHRONOS2_NATIVE_QUANTILES.index(0.75)
    reference_q50 = reference[:, :, median_column]
    candidate_q50 = candidate[:, :, median_column]
    last_close = contexts[:, 0, -1][:, None]
    direction_match = float(np.mean(np.sign(reference_q50 - last_close) == np.sign(candidate_q50 - last_close)))
    iqr = np.maximum(
        reference[:, :, q75_column] - reference[:, :, q25_column],
        np.maximum(np.abs(last_close) * np.float32(1e-7), np.float32(1e-12)),
    )
    error = np.abs(candidate_q50 - reference_q50) / iqr
    error_median = float(np.median(error))
    error_p95 = float(np.percentile(error, 95))
    exact = bool(np.array_equal(reference, candidate))
    return {
        "passed": (finite and monotonic and direction_match >= 0.99 and error_median <= 0.05 and error_p95 <= 0.15),
        "finite": finite,
        "quantile_monotonicity": monotonic,
        "direction_match_rate": direction_match,
        "q50_error_over_iqr": {
            "median": error_median,
            "p95": error_p95,
        },
        "exact": exact,
        "reference_digest": chronos2_raw_output_digest(reference),
        "candidate_digest": chronos2_raw_output_digest(candidate),
        "thresholds": {
            "direction_match_rate_minimum": 0.99,
            "q50_error_over_iqr_median_maximum": 0.05,
            "q50_error_over_iqr_p95_maximum": 0.15,
        },
    }


def _stage_predecessor(backend: Chronos2RawBackend) -> Chronos2RawBackend | None:
    return {
        "pipeline_eager": None,
        "worker_local": "pipeline_eager",
        "no_padding": "worker_local",
        "gpu_gather": "no_padding",
        "cuda_graph": "gpu_gather",
    }[backend]


def _predict(
    inference: Chronos2RawInference,
    arrays: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray],
    variate_batch_size: int,
) -> tuple[np.ndarray, float, float | None, float | None, bool]:
    started = time.perf_counter()
    observation = inference.predict(
        *arrays,
        variate_batch_size=variate_batch_size,
    )
    wall_ms = (time.perf_counter() - started) * 1_000
    return (
        observation.output,
        wall_ms,
        observation.compute_cuda_ms,
        observation.graph_capture_ms,
        observation.tail_eager,
    )


def benchmark_chronos2_candidate(
    *,
    settings: AISettings,
    manifest_path: Path,
    backend: Chronos2RawBackend,
    variate_batch_size: int,
    protocol: Chronos2BenchmarkProtocol,
) -> dict[str, Any]:
    protocol = protocol.validate()
    if backend not in CHRONOS2_RAW_BACKENDS:
        raise Chronos2RawInferenceError("unsupported Chronos-2 benchmark backend")
    if variate_batch_size not in CHRONOS2_BENCHMARK_BATCHES:
        raise Chronos2RawInferenceError("Chronos-2 benchmark batch must be 1/2/4/8/12/16/24/32/48/50")
    artifact = load_chronos2_input(manifest_path)
    variate_count = len(artifact.manifest.variate_names)
    task_batch_size = chronos2_task_batch_size(
        variate_batch_size,
        variate_count,
    )
    if artifact.manifest.row_count < task_batch_size:
        raise Chronos2RawInferenceError("Chronos-2 benchmark artifact has fewer tasks than the effective batch")
    mapped = open_chronos2_arrays(artifact)
    try:
        arrays = tuple(np.ascontiguousarray(value[:task_batch_size]) for value in mapped)
    finally:
        del mapped
    load_started = time.perf_counter()
    suite = load_production_model_suite(settings)
    model_load_ms = (time.perf_counter() - load_started) * 1_000
    if not isinstance(suite.primary, Chronos2Adapter):
        raise Chronos2RawInferenceError("the pinned Chronos-2 adapter is unavailable")
    adapter = suite.primary
    outputs: dict[Chronos2RawBackend, np.ndarray] = {}
    reference = Chronos2RawInference(
        adapter,
        backend="pipeline_eager",
        variate_names=artifact.manifest.variate_names,
    )
    outputs["pipeline_eager"] = reference.predict(
        *arrays,
        variate_batch_size=variate_batch_size,
    ).output
    predecessor = _stage_predecessor(backend)
    if predecessor is not None and predecessor != "pipeline_eager":
        prior = Chronos2RawInference(
            adapter,
            backend=predecessor,
            variate_names=artifact.manifest.variate_names,
        )
        if backend == "cuda_graph":
            prior._enable_graph_compatible_execution()
        outputs[predecessor] = prior.predict(
            *arrays,
            variate_batch_size=variate_batch_size,
        ).output
    candidate = Chronos2RawInference(
        adapter,
        backend=backend,
        variate_names=artifact.manifest.variate_names,
        graph_task_batch_size=(task_batch_size if backend == "cuda_graph" else None),
    )
    wall_samples: list[float] = []
    cuda_samples: list[float] = []
    digests: list[str] = []
    graph_capture_ms: float | None = None
    tail_eager = False
    rounds: list[dict[str, Any]] = []
    peak_allocated = 0
    peak_reserved = 0
    last_output: np.ndarray | None = None
    for round_index in range(protocol.rounds):
        for _ in range(protocol.warmups):
            output, _wall, _cuda, capture, tail = _predict(
                candidate,
                arrays,  # type: ignore[arg-type]
                variate_batch_size,
            )
            del output
            graph_capture_ms = capture if capture is not None else graph_capture_ms
            tail_eager = tail_eager or tail
        if adapter._runtime.name == "cuda":
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
        round_wall: list[float] = []
        round_cuda: list[float] = []
        sampler = GpuTelemetrySampler(0)
        with sampler:
            for _ in range(protocol.iterations):
                output, wall, cuda, capture, tail = _predict(
                    candidate,
                    arrays,  # type: ignore[arg-type]
                    variate_batch_size,
                )
                graph_capture_ms = capture if capture is not None else graph_capture_ms
                tail_eager = tail_eager or tail
                round_wall.append(wall)
                if cuda is not None:
                    round_cuda.append(cuda)
                digests.append(chronos2_raw_output_digest(output))
                last_output = output
        if adapter._runtime.name == "cuda":
            allocated = int(torch.cuda.max_memory_allocated())
            reserved = int(torch.cuda.max_memory_reserved())
        else:
            allocated = reserved = 0
        peak_allocated = max(peak_allocated, allocated)
        peak_reserved = max(peak_reserved, reserved)
        wall_samples.extend(round_wall)
        cuda_samples.extend(round_cuda)
        rounds.append(
            {
                "round": round_index + 1,
                "wall_ms": _summary(round_wall),
                "cuda_compute_ms": _summary(round_cuda) if round_cuda else None,
                "tasks_per_second": _summary([task_batch_size / (value / 1_000) for value in round_wall]),
                "variates_per_second": _summary(
                    [task_batch_size * variate_count / (value / 1_000) for value in round_wall]
                ),
                "torch_peak_allocated_bytes": allocated,
                "torch_peak_reserved_bytes": reserved,
                "gpu_telemetry": sampler.summary(),
            }
        )
    if last_output is None:
        raise Chronos2RawInferenceError("Chronos-2 benchmark produced no output")
    accuracy = _accuracy_gate(
        outputs["pipeline_eager"],
        last_output,
        arrays[0],
    )
    previous_output = outputs["pipeline_eager"] if predecessor in {None, "pipeline_eager"} else outputs[predecessor]
    stage_exact = bool(np.array_equal(previous_output, last_output))
    repeat_stable = len(set(digests)) == 1
    telemetry = [item["gpu_telemetry"] for item in rounds if item["gpu_telemetry"].get("status") == "available"]
    minimum_free = min(
        (int(item["min_memory_free_bytes"]) for item in telemetry),
        default=0,
    )
    headroom = minimum_free >= CHRONOS2_MINIMUM_HEADROOM_BYTES
    # Only representation-preserving stages require byte-exact output. The
    # 64-step patch-aligned path is a numerical optimization and therefore
    # uses the common FP32 gate, while worker-local transport removal, GPU
    # gather, and CUDA Graph replay must preserve their direct predecessor.
    exact_required = backend in {"worker_local", "gpu_gather", "cuda_graph"}
    passed = (
        accuracy["passed"] and repeat_stable and headroom and (stage_exact or not exact_required) and not tail_eager
    )
    rejections: list[str] = []
    if not accuracy["passed"]:
        rejections.append("numerical_accuracy_gate")
    if not repeat_stable:
        rejections.append("repeat_digest_instability")
    if not headroom:
        rejections.append("vram_headroom_below_2gib")
    if exact_required and not stage_exact:
        rejections.append("stage_predecessor_not_exact")
    if tail_eager:
        rejections.append("unexpected_tail_in_fixed_batch_benchmark")
    return {
        "schema_version": CHRONOS2_BENCHMARK_SCHEMA,
        "status": "passed" if passed else "rejected",
        "rejection_reasons": rejections,
        "backend": backend,
        "profile": artifact.manifest.profile,
        "variate_batch_size": variate_batch_size,
        "variate_count": variate_count,
        "task_batch_size": task_batch_size,
        "effective_variate_batch_size": task_batch_size * variate_count,
        "protocol": {
            "rounds": protocol.rounds,
            "warmups_per_round": protocol.warmups,
            "timed_iterations_per_round": protocol.iterations,
            "independent_model_process": True,
            "cross_learning": False,
        },
        "model_load_ms": model_load_ms,
        "graph_capture_ms": graph_capture_ms,
        "timing": {
            "wall_ms": _summary(wall_samples),
            "cuda_compute_ms": _summary(cuda_samples) if cuda_samples else None,
            "tasks_per_second": _summary([task_batch_size / (value / 1_000) for value in wall_samples]),
            "variates_per_second": _summary(
                [task_batch_size * variate_count / (value / 1_000) for value in wall_samples]
            ),
        },
        "rounds": rounds,
        "memory": {
            "torch_peak_allocated_bytes": peak_allocated,
            "torch_peak_reserved_bytes": peak_reserved,
            "minimum_nvml_free_bytes": minimum_free,
            "required_headroom_bytes": CHRONOS2_MINIMUM_HEADROOM_BYTES,
            "headroom_passed": headroom,
        },
        "accuracy_gate": accuracy,
        "stage_exact_gate": {
            "required": exact_required,
            "predecessor": predecessor,
            "passed": stage_exact,
            "predecessor_digest": chronos2_raw_output_digest(previous_output),
            "candidate_digest": chronos2_raw_output_digest(last_output),
        },
        "repeat_output_digest": {
            "stable": repeat_stable,
            "digest": digests[0] if repeat_stable else None,
            "observations": len(digests),
        },
        "structure": {
            "context_bars": artifact.manifest.context_bars,
            "context_patch_remainder": 0,
            "future_steps": 64 if backend in {"no_padding", "gpu_gather", "cuda_graph"} else 60,
            "future_patch_remainder": (0 if backend in {"no_padding", "gpu_gather", "cuda_graph"} else 12),
            "left_padding_created": False,
            "cross_learning": False,
            "moe_packed_experts": {
                "status": "not_applicable",
                "reason": "Chronos-2 has dense MLP blocks and no MoE experts.",
            },
            "tensorrt": {
                "status": "unavailable",
                "reason": "Operator-removed TensorRT artifacts were not rebuilt.",
            },
        },
        "provenance": candidate.provenance,
        "input": {
            "manifest_sha256": artifact.manifest_sha256,
            "artifact_digest": artifact.artifact_digest,
            "row_start": 0,
            "row_end": task_batch_size,
        },
    }


def run_chronos2_benchmark_to_file(
    *,
    manifest_path: Path,
    output_path: Path,
    backend: Chronos2RawBackend,
    variate_batch_size: int,
    protocol: Chronos2BenchmarkProtocol,
) -> dict[str, Any]:
    if not output_path.is_absolute() or output_path.resolve(strict=False) != output_path or output_path.exists():
        raise Chronos2RawInferenceError("Chronos-2 benchmark output must be a new absolute normalized path")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    settings = AISettings.from_env()
    try:
        result = benchmark_chronos2_candidate(
            settings=settings,
            manifest_path=manifest_path,
            backend=backend,
            variate_batch_size=variate_batch_size,
            protocol=protocol,
        )
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        result = {
            "schema_version": CHRONOS2_BENCHMARK_SCHEMA,
            "status": "rejected",
            "rejection_reasons": ["cuda_out_of_memory"],
            "backend": backend,
            "variate_batch_size": variate_batch_size,
        }
    except (Chronos2RawInferenceError, RuntimeError, ValueError) as error:
        result = {
            "schema_version": CHRONOS2_BENCHMARK_SCHEMA,
            "status": "unavailable",
            "rejection_reasons": ["runtime_unavailable"],
            "backend": backend,
            "variate_batch_size": variate_batch_size,
            "error": f"{type(error).__name__}: {error}"[:2_000],
            "traceback": traceback.format_exc(limit=40)[-16_000:],
        }
    atomic_write(output_path, canonical_json_bytes(result))
    return result


def select_chronos2_batch(results: list[dict[str, Any]]) -> dict[str, Any] | None:
    eligible = [
        value
        for value in results
        if value.get("status") == "passed" and value.get("memory", {}).get("headroom_passed") is True
    ]
    if not eligible:
        return None
    fastest = max(float(value["timing"]["tasks_per_second"]["median"]) for value in eligible)
    near = [value for value in eligible if float(value["timing"]["tasks_per_second"]["median"]) >= fastest * 0.97]
    return min(
        near,
        key=lambda value: (
            float(value["timing"]["wall_ms"]["p95"]),
            int(value["variate_batch_size"]),
        ),
    )
