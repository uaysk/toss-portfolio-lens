from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import statistics
import time
from typing import Any

import numpy as np
import torch

from .adapters import load_production_model_suite
from .fincast import FinCastAdapter
from .gpu_telemetry import GpuTelemetrySampler
from .raw_artifacts import (
    RAW_HORIZONS_MINUTES,
    atomic_write,
    canonical_json_bytes,
    load_raw_input,
    open_contexts,
    routing_uniforms,
)
from .raw_generator import _PinnedTransfer
from .raw_inference import (
    FP32_BACKENDS,
    FinCastRawInference,
    RawBackendName,
    RawInferenceError,
    native_to_projected_compatibility,
    numpy_output_digest,
)
from .settings import AISettings

BENCHMARK_SCHEMA = "fincast-p40-raw-benchmark/v1"
BENCHMARK_BATCHES = (16, 24, 32, 48, 50)
MINIMUM_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class BenchmarkProtocol:
    rounds: int = 3
    warmups: int = 10
    iterations: int = 30

    def validate(self) -> BenchmarkProtocol:
        if self.rounds < 1 or self.rounds > 10:
            raise RawInferenceError("benchmark rounds must be between 1 and 10")
        if self.warmups < 0 or self.warmups > 100:
            raise RawInferenceError("benchmark warmups must be between 0 and 100")
        if self.iterations < 1 or self.iterations > 1_000:
            raise RawInferenceError("benchmark iterations must be between 1 and 1000")
        return self


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        raise RawInferenceError("cannot summarize an empty benchmark sample")
    return float(np.percentile(np.asarray(values, dtype=np.float64), percentile))


def _timing_summary(values: list[float]) -> dict[str, float]:
    return {
        "minimum": min(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "p50": _percentile(values, 50),
        "p95": _percentile(values, 95),
        "p99": _percentile(values, 99),
        "maximum": max(values),
    }


def select_batch_candidate(
    results: list[dict[str, Any]],
) -> dict[str, Any] | None:
    eligible = [
        item
        for item in results
        if (
            item.get("status") == "passed"
            and item.get("memory", {}).get("headroom_passed") is True
            and isinstance(
                item.get("timing", {}).get("series_per_second", {}).get("median"),
                (int, float),
            )
            and isinstance(
                item.get("timing", {}).get("wall_ms", {}).get("p95"),
                (int, float),
            )
        )
    ]
    if not eligible:
        return None
    fastest = max(
        float(item["timing"]["series_per_second"]["median"])
        for item in eligible
    )
    near_fastest = [
        item
        for item in eligible
        if float(item["timing"]["series_per_second"]["median"]) >= fastest * 0.97
    ]
    return min(
        near_fastest,
        key=lambda item: (
            float(item["timing"]["wall_ms"]["p95"]),
            int(item["batch_size"]),
        ),
    )


def _decode_passes(cadence_seconds: int) -> int:
    horizon_steps = max(RAW_HORIZONS_MINUTES) * 60 // cadence_seconds
    return (horizon_steps + 127) // 128


def _reference_predictions(
    inference: FinCastRawInference,
    contexts: np.ndarray,
    *,
    cadence_seconds: int,
    model_seed: int,
    reference_batch_size: int = 16,
) -> np.ndarray:
    outputs: list[np.ndarray] = []
    transfer = _PinnedTransfer(
        batch_size=min(reference_batch_size, len(contexts)),
        decode_passes=_decode_passes(cadence_seconds),
        layers=inference.layers,
        device=inference.runtime.name,
    )
    for start in range(0, len(contexts), reference_batch_size):
        end = min(start + reference_batch_size, len(contexts))
        row_ids = np.arange(start, end, dtype=np.int64)
        uniforms = routing_uniforms(
            row_ids,
            model_seed=model_seed,
            decode_passes=_decode_passes(cadence_seconds),
            layers=inference.layers,
        )
        device_contexts, device_uniforms = transfer.copy(
            contexts[start:end],
            uniforms,
        )
        observation = inference.predict_tensor(
            device_contexts,
            device_uniforms,
            cadence_seconds=cadence_seconds,
        )
        outputs.append(observation.output.detach().cpu().numpy())
    torch.cuda.synchronize()
    return np.ascontiguousarray(np.concatenate(outputs, axis=0), dtype="<f4")


def numerical_gate(
    reference: np.ndarray,
    candidate: np.ndarray,
    contexts: np.ndarray,
) -> dict[str, Any]:
    reference = np.asarray(reference, dtype=np.float32)
    candidate = np.asarray(candidate, dtype=np.float32)
    if reference.shape != candidate.shape or reference.shape[1:] != (4, 10):
        raise RawInferenceError("accuracy gate received misaligned raw predictions")
    finite = bool(np.isfinite(candidate).all())
    monotonic = bool(np.all(np.diff(candidate[..., 1:], axis=-1) >= 0))
    reference_projected = native_to_projected_compatibility(reference)
    candidate_projected = native_to_projected_compatibility(candidate)
    reference_q25 = reference_projected[..., 2]
    reference_q50 = reference_projected[..., 3]
    reference_q75 = reference_projected[..., 4]
    candidate_q50 = candidate_projected[..., 3]
    last_close = np.asarray(contexts[:, -1], dtype=np.float32)[:, None]
    reference_direction = np.sign(reference_q50 - last_close)
    candidate_direction = np.sign(candidate_q50 - last_close)
    direction_match_rate = float(np.mean(reference_direction == candidate_direction))
    iqr = np.maximum(
        reference_q75 - reference_q25,
        np.maximum(np.abs(last_close) * np.float32(1e-7), np.float32(1e-12)),
    )
    normalized_q50_error = np.abs(candidate_q50 - reference_q50) / iqr
    error_median = float(np.median(normalized_q50_error))
    error_p95 = float(np.percentile(normalized_q50_error, 95))
    passed = (
        finite
        and monotonic
        and direction_match_rate >= 0.99
        and error_median <= 0.05
        and error_p95 <= 0.15
    )
    return {
        "passed": passed,
        "finite": finite,
        "quantile_monotonicity": monotonic,
        "direction_match_rate": direction_match_rate,
        "q50_error_over_iqr": {
            "median": error_median,
            "p95": error_p95,
        },
        "thresholds": {
            "direction_match_rate_minimum": 0.99,
            "q50_error_over_iqr_median_maximum": 0.05,
            "q50_error_over_iqr_p95_maximum": 0.15,
        },
        "reference_digest": numpy_output_digest(reference),
        "candidate_digest": numpy_output_digest(candidate),
        "reference_projected_digest": numpy_output_digest(reference_projected),
        "candidate_projected_digest": numpy_output_digest(candidate_projected),
    }


def _candidate_once(
    inference: FinCastRawInference,
    transfer: _PinnedTransfer,
    contexts: np.ndarray,
    uniforms: np.ndarray,
    *,
    cadence_seconds: int,
    timed: bool,
) -> tuple[np.ndarray, float, float, float | None, bool]:
    wall_started = time.perf_counter()
    device_contexts, device_uniforms = transfer.copy(contexts, uniforms)
    compute_started = torch.cuda.Event(enable_timing=True)
    compute_finished = torch.cuda.Event(enable_timing=True)
    compute_started.record()
    observation = inference.predict_tensor(
        device_contexts,
        device_uniforms,
        cadence_seconds=cadence_seconds,
    )
    compute_finished.record()
    output = observation.output.detach().cpu().numpy()
    torch.cuda.synchronize()
    wall_ms = (time.perf_counter() - wall_started) * 1_000
    cuda_ms = float(compute_started.elapsed_time(compute_finished))
    if not timed:
        return (
            np.ascontiguousarray(output, dtype="<f4"),
            wall_ms,
            cuda_ms,
            observation.graph_capture_ms,
            observation.tail_eager,
        )
    return (
        np.ascontiguousarray(output, dtype="<f4"),
        wall_ms,
        cuda_ms,
        observation.graph_capture_ms,
        observation.tail_eager,
    )


def _profile_packed_expert_gemms(
    inference: FinCastRawInference,
    transfer: _PinnedTransfer,
    contexts: np.ndarray,
    uniforms: np.ndarray,
    *,
    cadence_seconds: int,
) -> dict[str, Any]:
    expected_per_projection = inference.layers * _decode_passes(cadence_seconds)
    try:
        for packed in inference.packed_experts:
            packed.annotate_profiler = True
        with torch.profiler.profile(
            activities=[
                torch.profiler.ProfilerActivity.CPU,
                torch.profiler.ProfilerActivity.CUDA,
            ],
            record_shapes=True,
        ) as profile:
            output, _wall, _cuda, _capture, _tail = _candidate_once(
                inference,
                transfer,
                contexts,
                uniforms,
                cadence_seconds=cadence_seconds,
                timed=False,
            )
            del output
        counts = {
            event.key: int(event.count)
            for event in profile.key_averages()
            if event.key.startswith("fincast_raw::packed_expert_")
        }
        gate_count = counts.get("fincast_raw::packed_expert_gate_bmm", 0)
        down_count = counts.get("fincast_raw::packed_expert_down_bmm", 0)
        passed = (
            gate_count == expected_per_projection
            and down_count == expected_per_projection
        )
        return {
            "status": "passed" if passed else "rejected",
            "passed": passed,
            "profiler": "torch.profiler",
            "decode_passes": _decode_passes(cadence_seconds),
            "transformer_layers": inference.layers,
            "original_expert_linear_modules_per_layer": 8,
            "packed_batched_gemms_per_layer": 2,
            "expected_calls_per_projection": expected_per_projection,
            "observed_gate_bmm_calls": gate_count,
            "observed_down_bmm_calls": down_count,
            "recorded_events": counts,
        }
    except (RuntimeError, torch.cuda.OutOfMemoryError) as error:
        torch.cuda.empty_cache()
        return {
            "status": "unavailable",
            "passed": False,
            "profiler": "torch.profiler",
            "reason": f"{type(error).__name__}: {error}"[:300],
            "original_expert_linear_modules_per_layer": 8,
            "packed_batched_gemms_per_layer": 2,
        }
    finally:
        for packed in inference.packed_experts:
            packed.annotate_profiler = False


def _observe_no_padding_structure(
    inference: FinCastRawInference,
    transfer: _PinnedTransfer,
    contexts: np.ndarray,
    uniforms: np.ndarray,
    *,
    cadence_seconds: int,
) -> dict[str, Any]:
    sentinel = object()
    observed_paddings: list[object] = []
    handles = []

    def observe(
        _module: torch.nn.Module,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
    ) -> None:
        padding = kwargs.get(
            "paddings",
            args[1] if len(args) > 1 else sentinel,
        )
        observed_paddings.append(padding)

    try:
        for layer in inference.model.stacked_transformer.layers:
            handles.append(
                layer.moe.register_forward_pre_hook(
                    observe,
                    with_kwargs=True,
                )
            )
        output, _wall, _cuda, _capture, tail = _candidate_once(
            inference,
            transfer,
            contexts,
            uniforms,
            cadence_seconds=cadence_seconds,
            timed=False,
        )
        del output
    finally:
        for handle in handles:
            handle.remove()

    expected_calls = inference.layers * _decode_passes(cadence_seconds)
    projection = inference.model.input_ff_layer
    hidden_input_features = int(projection.hidden_layer[0].in_features)
    residual_input_features = int(projection.residual_layer.in_features)
    complete_decode_observations = (
        len(observed_paddings) >= expected_calls
        and len(observed_paddings) % expected_calls == 0
    )
    passed = (
        complete_decode_observations
        and all(value is None for value in observed_paddings)
        and hidden_input_features == 64
        and residual_input_features == 64
        and len(inference._paddings) == 0
        and not tail
    )
    return {
        "status": "passed" if passed else "rejected",
        "passed": passed,
        "moe_calls": len(observed_paddings),
        "minimum_expected_moe_calls": expected_calls,
        "complete_decode_observations": complete_decode_observations,
        "observed_decode_executions": (
            len(observed_paddings) // expected_calls
            if expected_calls > 0 and complete_decode_observations
            else 0
        ),
        "all_moe_paddings_none": all(value is None for value in observed_paddings),
        "upstream_projection_input_features": hidden_input_features,
        "active_projection_weight_features": 32,
        "removed_zero_padding_weight_features": hidden_input_features - 32,
        "padding_tensor_cache_entries": len(inference._paddings),
        "attention_mask": "causal_only_[1,1,16,16]",
        "tail_padding": False,
    }


def benchmark_raw_candidate(
    *,
    settings: AISettings,
    manifest_path: Path,
    backend: RawBackendName,
    batch_size: int,
    protocol: BenchmarkProtocol,
) -> dict[str, Any]:
    protocol = protocol.validate()
    if backend not in FP32_BACKENDS:
        raise RawInferenceError("the FP32 benchmark does not execute TensorRT")
    if batch_size not in BENCHMARK_BATCHES:
        raise RawInferenceError("benchmark batch must be one of 16, 24, 32, 48, or 50")
    artifact = load_raw_input(manifest_path)
    if artifact.manifest.row_count < batch_size:
        raise RawInferenceError("benchmark artifact has fewer rows than the requested batch")
    cadence_seconds = artifact.manifest.cadence_seconds

    load_started = time.perf_counter()
    suite = load_production_model_suite(settings)
    model_load_ms = (time.perf_counter() - load_started) * 1_000
    if not isinstance(suite.primary, FinCastAdapter):
        raise RawInferenceError("the pinned FinCast adapter is unavailable")
    adapter = suite.primary
    contexts_map = open_contexts(artifact)
    try:
        contexts = np.ascontiguousarray(contexts_map[:batch_size], dtype="<f4")
    finally:
        del contexts_map

    reference_inference = FinCastRawInference(adapter, backend="eager")
    reference = _reference_predictions(
        reference_inference,
        contexts,
        cadence_seconds=cadence_seconds,
        model_seed=artifact.manifest.model_seed,
    )
    candidate = FinCastRawInference(
        adapter,
        backend=backend,
        graph_batch_size=batch_size if backend == "cuda_graph" else None,
    )
    row_ids = np.arange(batch_size, dtype=np.int64)
    uniforms = routing_uniforms(
        row_ids,
        model_seed=artifact.manifest.model_seed,
        decode_passes=_decode_passes(cadence_seconds),
        layers=candidate.layers,
    )
    transfer = _PinnedTransfer(
        batch_size=batch_size,
        decode_passes=_decode_passes(cadence_seconds),
        layers=candidate.layers,
        device=candidate.runtime.name,
    )
    no_padding_structure = (
        _observe_no_padding_structure(
            candidate,
            transfer,
            contexts,
            uniforms,
            cadence_seconds=cadence_seconds,
        )
        if backend != "eager"
        else {"status": "not_required", "passed": None}
    )

    packed_eager: np.ndarray | None = None
    if backend == "cuda_graph":
        device_contexts, device_uniforms = transfer.copy(contexts, uniforms)
        with torch.inference_mode():
            packed_eager = (
                candidate
                ._predict_no_padding_core(
                    device_contexts,
                    device_uniforms,
                    cadence_seconds,
                )
                .detach()
                .cpu()
                .numpy()
            )
        torch.cuda.synchronize()
        packed_eager = np.ascontiguousarray(packed_eager, dtype="<f4")

    wall_samples: list[float] = []
    cuda_samples: list[float] = []
    output_digests: list[str] = []
    round_results: list[dict[str, Any]] = []
    graph_capture_ms: float | None = None
    last_output: np.ndarray | None = None
    peak_allocated = 0
    peak_reserved = 0
    tail_eager_seen = False
    for round_index in range(protocol.rounds):
        for _ in range(protocol.warmups):
            warmup_output, _wall, _cuda, capture_ms, tail_eager = _candidate_once(
                candidate,
                transfer,
                contexts,
                uniforms,
                cadence_seconds=cadence_seconds,
                timed=False,
            )
            del warmup_output
            graph_capture_ms = capture_ms if capture_ms is not None else graph_capture_ms
            tail_eager_seen = tail_eager_seen or tail_eager
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        round_wall: list[float] = []
        round_cuda: list[float] = []
        sampler = GpuTelemetrySampler(settings.fincast_nvml_device_index)
        with sampler:
            for _ in range(protocol.iterations):
                output, wall_ms, cuda_ms, capture_ms, tail_eager = _candidate_once(
                    candidate,
                    transfer,
                    contexts,
                    uniforms,
                    cadence_seconds=cadence_seconds,
                    timed=True,
                )
                graph_capture_ms = capture_ms if capture_ms is not None else graph_capture_ms
                tail_eager_seen = tail_eager_seen or tail_eager
                digest = numpy_output_digest(output)
                output_digests.append(digest)
                round_wall.append(wall_ms)
                round_cuda.append(cuda_ms)
                last_output = output
        current_allocated = int(torch.cuda.max_memory_allocated())
        current_reserved = int(torch.cuda.max_memory_reserved())
        peak_allocated = max(peak_allocated, current_allocated)
        peak_reserved = max(peak_reserved, current_reserved)
        wall_samples.extend(round_wall)
        cuda_samples.extend(round_cuda)
        round_results.append(
            {
                "round": round_index + 1,
                "wall_ms": _timing_summary(round_wall),
                "cuda_compute_ms": _timing_summary(round_cuda),
                "series_per_second": _timing_summary(
                    [batch_size / (value / 1_000) for value in round_wall]
                ),
                "torch_peak_allocated_bytes": current_allocated,
                "torch_peak_reserved_bytes": current_reserved,
                "gpu_telemetry": sampler.summary(),
            }
        )
    if last_output is None:
        raise RawInferenceError("benchmark produced no timed output")

    accuracy = numerical_gate(reference, last_output, contexts)
    digest_stable = len(set(output_digests)) == 1
    telemetry_available = [
        result["gpu_telemetry"]
        for result in round_results
        if result["gpu_telemetry"].get("status") == "available"
    ]
    minimum_free = min(
        (
            int(item["min_memory_free_bytes"])
            for item in telemetry_available
        ),
        default=0,
    )
    headroom_passed = minimum_free >= MINIMUM_HEADROOM_BYTES
    cuda_graph_exact = (
        None
        if packed_eager is None
        else bool(np.array_equal(packed_eager, last_output))
    )
    expert_gemm_profile = (
        _profile_packed_expert_gemms(
            candidate,
            transfer,
            contexts,
            uniforms,
            cadence_seconds=cadence_seconds,
        )
        if backend == "batched_experts"
        else {
            "status": "not_required",
            "passed": None,
            "original_expert_linear_modules_per_layer": 8,
            "packed_batched_gemms_per_layer": (
                2 if backend == "cuda_graph" else None
            ),
        }
    )
    passed = (
        accuracy["passed"]
        and digest_stable
        and headroom_passed
        and (cuda_graph_exact is not False)
        and not tail_eager_seen
        and (expert_gemm_profile["passed"] is not False)
        and (no_padding_structure["passed"] is not False)
    )
    status = "passed" if passed else "rejected"
    rejection_reasons: list[str] = []
    if not accuracy["passed"]:
        rejection_reasons.append("numerical_accuracy_gate")
    if not digest_stable:
        rejection_reasons.append("repeat_digest_instability")
    if not headroom_passed:
        rejection_reasons.append("vram_headroom_below_2gib")
    if cuda_graph_exact is False:
        rejection_reasons.append("cuda_graph_not_exact")
    if tail_eager_seen:
        rejection_reasons.append("unexpected_tail_eager_during_fixed_batch_benchmark")
    if expert_gemm_profile["passed"] is False:
        rejection_reasons.append("packed_expert_profiler_gate")
    if no_padding_structure["passed"] is False:
        rejection_reasons.append("no_padding_structure_gate")

    wall_summary = _timing_summary(wall_samples)
    cuda_summary = _timing_summary(cuda_samples)
    throughput_samples = [
        batch_size / (value / 1_000)
        for value in wall_samples
    ]
    result = {
        "schema_version": BENCHMARK_SCHEMA,
        "status": status,
        "rejection_reasons": rejection_reasons,
        "cadence_seconds": cadence_seconds,
        "backend": backend,
        "batch_size": batch_size,
        "protocol": {
            "rounds": protocol.rounds,
            "warmups_per_round": protocol.warmups,
            "timed_iterations_per_round": protocol.iterations,
            "independent_model_process": True,
        },
        "model_load_ms": model_load_ms,
        "graph_capture_ms": graph_capture_ms,
        "timing": {
            "wall_ms": wall_summary,
            "cuda_compute_ms": cuda_summary,
            "series_per_second": _timing_summary(throughput_samples),
        },
        "rounds": round_results,
        "memory": {
            "torch_peak_allocated_bytes": peak_allocated,
            "torch_peak_reserved_bytes": peak_reserved,
            "minimum_nvml_free_bytes": minimum_free,
            "required_headroom_bytes": MINIMUM_HEADROOM_BYTES,
            "headroom_passed": headroom_passed,
        },
        "accuracy_gate": accuracy,
        "repeat_output_digest": {
            "stable": digest_stable,
            "digest": output_digests[0] if digest_stable else None,
            "observations": len(output_digests),
        },
        "cuda_graph_exact_backend_eager": cuda_graph_exact,
        "transport_compatibility": {
            "projected_reference_digest": hashlib.sha256(
                native_to_projected_compatibility(reference).tobytes(order="C")
            ).hexdigest(),
            "view": "native_q10_q90_to_existing_seven_quantiles",
        },
        "no_padding_structure": no_padding_structure,
        "expert_gemm": {
            "packed_layers": len(candidate.packed_experts),
            **expert_gemm_profile,
        },
        "provenance": candidate.provenance,
        "input": {
            "manifest_sha256": artifact.manifest_sha256,
            "artifact_digest": artifact.artifact_digest,
            "row_start": 0,
            "row_end": batch_size,
            "model_seed": artifact.manifest.model_seed,
        },
    }
    return result


def run_benchmark_to_file(
    *,
    manifest_path: Path,
    output_path: Path,
    backend: RawBackendName,
    batch_size: int,
    protocol: BenchmarkProtocol,
) -> dict[str, Any]:
    if not output_path.is_absolute() or output_path.resolve(strict=False) != output_path:
        raise RawInferenceError("benchmark output must be an absolute normalized path")
    if output_path.exists():
        raise RawInferenceError("benchmark output already exists")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.parent.is_symlink():
        raise RawInferenceError("benchmark output parent must not be a symlink")
    settings = AISettings.from_env()
    try:
        result = benchmark_raw_candidate(
            settings=settings,
            manifest_path=manifest_path,
            backend=backend,
            batch_size=batch_size,
            protocol=protocol,
        )
    except torch.cuda.OutOfMemoryError as error:
        torch.cuda.empty_cache()
        result = {
            "schema_version": BENCHMARK_SCHEMA,
            "status": "rejected",
            "rejection_reasons": ["cuda_out_of_memory"],
            "cadence_seconds": load_raw_input(manifest_path).manifest.cadence_seconds,
            "backend": backend,
            "batch_size": batch_size,
            "error": f"{type(error).__name__}: CUDA out of memory"[:300],
        }
    except (RawInferenceError, RuntimeError) as error:
        result = {
            "schema_version": BENCHMARK_SCHEMA,
            "status": "unavailable",
            "rejection_reasons": ["runtime_unavailable"],
            "cadence_seconds": load_raw_input(manifest_path).manifest.cadence_seconds,
            "backend": backend,
            "batch_size": batch_size,
            "error": f"{type(error).__name__}: {error}"[:300],
        }
    atomic_write(output_path, canonical_json_bytes(result))
    return result
