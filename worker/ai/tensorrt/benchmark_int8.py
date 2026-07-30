#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import time
from typing import Any

from cuda import cudart
import numpy as np
import tensorrt as trt

from build_int8 import (
    BATCH_SIZE,
    CONTEXT_LENGTH,
    CONTEXT_ROWS,
    _calibration_split,
    _cuda_check,
    _routing_uniforms,
)

ROUNDS = 3
WARMUPS = 10
ITERATIONS = 30


def _path(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.resolve(strict=True) != path
        or path.is_symlink()
    ):
        raise argparse.ArgumentTypeError("path must be absolute, normalized, and regular")
    return path


def _output_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=False) != path:
        raise argparse.ArgumentTypeError("output must be absolute and normalized")
    if path.exists() or path.is_symlink():
        raise argparse.ArgumentTypeError("output already exists or is a symlink")
    return path


def _summary(values: list[float]) -> dict[str, float]:
    array = np.asarray(values, dtype=np.float64)
    return {
        "minimum": float(array.min()),
        "mean": float(array.mean()),
        "median": float(np.median(array)),
        "p50": float(np.percentile(array, 50)),
        "p95": float(np.percentile(array, 95)),
        "p99": float(np.percentile(array, 99)),
        "maximum": float(array.max()),
    }


def _load_reference(folder: Path) -> np.ndarray:
    pieces: list[np.ndarray] = []
    for path in sorted((folder / "chunks").glob("chunk-*.f32")):
        values = np.fromfile(path, dtype="<f4")
        if values.size % 40 != 0:
            raise RuntimeError(f"reference chunk has an invalid shape: {path.name}")
        pieces.append(values.reshape(-1, 4, 10))
    if not pieces:
        raise RuntimeError("reference raw output has no chunks")
    output = np.ascontiguousarray(np.concatenate(pieces, axis=0), dtype=np.float32)
    if output.shape != (CONTEXT_ROWS, 4, 10):
        raise RuntimeError(f"reference raw output shape is invalid: {output.shape}")
    return output


def _numerical_gate(
    reference: np.ndarray,
    candidate: np.ndarray,
    contexts: np.ndarray,
) -> dict[str, Any]:
    finite = bool(np.isfinite(candidate).all())
    monotonic = bool(np.all(np.diff(candidate[..., 1:], axis=-1) >= 0))
    reference_native = np.sort(reference[..., 1:], axis=-1).astype(np.float64)
    candidate_native = np.sort(candidate[..., 1:], axis=-1).astype(np.float64)
    reference_projected = np.stack(
        (
            reference_native[..., 0],
            reference_native[..., 0],
            (reference_native[..., 1] + reference_native[..., 2]) / 2.0,
            reference_native[..., 4],
            (reference_native[..., 6] + reference_native[..., 7]) / 2.0,
            reference_native[..., 8],
            reference_native[..., 8],
        ),
        axis=-1,
    ).astype(np.float32)
    candidate_projected = np.stack(
        (
            candidate_native[..., 0],
            candidate_native[..., 0],
            (candidate_native[..., 1] + candidate_native[..., 2]) / 2.0,
            candidate_native[..., 4],
            (candidate_native[..., 6] + candidate_native[..., 7]) / 2.0,
            candidate_native[..., 8],
            candidate_native[..., 8],
        ),
        axis=-1,
    ).astype(np.float32)
    reference_q25 = reference_projected[..., 2]
    reference_q50 = reference_projected[..., 3]
    reference_q75 = reference_projected[..., 4]
    candidate_q50 = candidate_projected[..., 3]
    last_close = contexts[:, -1, None]
    direction_match_rate = float(
        np.mean(
            np.sign(reference_q50 - last_close)
            == np.sign(candidate_q50 - last_close)
        )
    )
    iqr = np.maximum(
        reference_q75 - reference_q25,
        np.maximum(np.abs(last_close) * np.float32(1e-7), np.float32(1e-12)),
    )
    errors = np.abs(candidate_q50 - reference_q50) / iqr
    median = float(np.median(errors))
    p95 = float(np.percentile(errors, 95))
    passed = (
        finite
        and monotonic
        and direction_match_rate >= 0.99
        and median <= 0.05
        and p95 <= 0.15
    )
    return {
        "passed": passed,
        "finite": finite,
        "quantile_monotonicity": monotonic,
        "direction_match_rate": direction_match_rate,
        "q50_error_over_iqr": {"median": median, "p95": p95},
        "thresholds": {
            "direction_match_rate_minimum": 0.99,
            "q50_error_over_iqr_median_maximum": 0.05,
            "q50_error_over_iqr_p95_maximum": 0.15,
        },
    }


class EngineRunner:
    def __init__(self, engine_path: Path, plugin_path: Path) -> None:
        ctypes.CDLL(str(plugin_path), mode=ctypes.RTLD_GLOBAL)
        self.logger = trt.Logger(trt.Logger.WARNING)
        trt.init_libnvinfer_plugins(self.logger, "")
        self.runtime = trt.Runtime(self.logger)
        self.engine = self.runtime.deserialize_cuda_engine(engine_path.read_bytes())
        if self.engine is None:
            raise RuntimeError("TensorRT engine deserialization failed")
        self.context = self.engine.create_execution_context()
        if self.context is None:
            raise RuntimeError("TensorRT execution context creation failed")
        self.stream = int(_cuda_check(cudart.cudaStreamCreate(), "cudaStreamCreate")[1])
        self.bindings: list[int] = [0] * self.engine.num_bindings
        self.devices: dict[str, int] = {}
        self.host_outputs: dict[str, np.ndarray] = {}
        for index in range(self.engine.num_bindings):
            name = self.engine.get_binding_name(index)
            shape = tuple(self.engine.get_binding_shape(index))
            dtype = np.dtype(trt.nptype(self.engine.get_binding_dtype(index)))
            size = int(np.prod(shape, dtype=np.int64)) * dtype.itemsize
            pointer = int(_cuda_check(cudart.cudaMalloc(size), f"cudaMalloc {name}")[1])
            self.bindings[index] = pointer
            self.devices[name] = pointer
            if not self.engine.binding_is_input(index):
                self.host_outputs[name] = np.empty(shape, dtype=dtype)
        if set(self.devices) != {
            "contexts",
            "routing_uniforms",
            "native_predictions",
        }:
            raise RuntimeError(f"unexpected TensorRT bindings: {sorted(self.devices)}")

    def run(
        self,
        contexts: np.ndarray,
        routing: np.ndarray,
    ) -> tuple[np.ndarray, float, float]:
        contexts = np.ascontiguousarray(contexts, dtype=np.float32)
        routing = np.ascontiguousarray(routing, dtype=np.float32)
        output = self.host_outputs["native_predictions"]
        started = time.perf_counter()
        _cuda_check(
            cudart.cudaMemcpyAsync(
                self.devices["contexts"],
                contexts.ctypes.data,
                contexts.nbytes,
                cudart.cudaMemcpyKind.cudaMemcpyHostToDevice,
                self.stream,
            ),
            "cudaMemcpyAsync contexts",
        )
        _cuda_check(
            cudart.cudaMemcpyAsync(
                self.devices["routing_uniforms"],
                routing.ctypes.data,
                routing.nbytes,
                cudart.cudaMemcpyKind.cudaMemcpyHostToDevice,
                self.stream,
            ),
            "cudaMemcpyAsync routing",
        )
        start_event = int(_cuda_check(cudart.cudaEventCreate(), "cudaEventCreate start")[1])
        end_event = int(_cuda_check(cudart.cudaEventCreate(), "cudaEventCreate end")[1])
        try:
            _cuda_check(cudart.cudaEventRecord(start_event, self.stream), "cudaEventRecord start")
            if not self.context.execute_async_v2(self.bindings, self.stream):
                raise RuntimeError("TensorRT execute_async_v2 failed")
            _cuda_check(cudart.cudaEventRecord(end_event, self.stream), "cudaEventRecord end")
            _cuda_check(
                cudart.cudaMemcpyAsync(
                    output.ctypes.data,
                    self.devices["native_predictions"],
                    output.nbytes,
                    cudart.cudaMemcpyKind.cudaMemcpyDeviceToHost,
                    self.stream,
                ),
                "cudaMemcpyAsync output",
            )
            _cuda_check(cudart.cudaStreamSynchronize(self.stream), "cudaStreamSynchronize")
            compute_ms = float(
                _cuda_check(
                    cudart.cudaEventElapsedTime(start_event, end_event),
                    "cudaEventElapsedTime",
                )[1]
            )
        finally:
            _cuda_check(cudart.cudaEventDestroy(start_event), "cudaEventDestroy start")
            _cuda_check(cudart.cudaEventDestroy(end_event), "cudaEventDestroy end")
        wall_ms = (time.perf_counter() - started) * 1_000
        return output.copy(), wall_ms, compute_ms

    def close(self) -> None:
        for pointer in self.bindings:
            if pointer:
                _cuda_check(cudart.cudaFree(pointer), "cudaFree binding")
        self.bindings = []
        if self.stream:
            _cuda_check(cudart.cudaStreamDestroy(self.stream), "cudaStreamDestroy")
            self.stream = 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--backend",
        choices=("tensorrt_fp32", "tensorrt_int8"),
        default="tensorrt_int8",
    )
    parser.add_argument("--engine", required=True, type=_path)
    parser.add_argument("--plugin", required=True, type=_path)
    parser.add_argument("--contexts", required=True, type=_path)
    parser.add_argument("--reference", required=True, type=_path)
    parser.add_argument("--output", required=True, type=_output_path)
    arguments = parser.parse_args()

    contexts_map = np.memmap(
        arguments.contexts,
        dtype="<f4",
        mode="r",
        shape=(CONTEXT_ROWS, CONTEXT_LENGTH),
    )
    contexts = np.ascontiguousarray(contexts_map, dtype=np.float32)
    calibration_indices, holdout_indices, split_digest = _calibration_split(contexts)
    benchmark_rows = np.arange(BATCH_SIZE, dtype=np.int64)
    benchmark_contexts = contexts[benchmark_rows]
    benchmark_routing = _routing_uniforms(benchmark_rows)
    validation_rows = np.concatenate((holdout_indices, calibration_indices[:16]))
    validation_contexts = contexts[validation_rows]
    validation_routing = _routing_uniforms(validation_rows)
    reference = _load_reference(arguments.reference)

    runner = EngineRunner(arguments.engine, arguments.plugin)
    wall_samples: list[float] = []
    compute_samples: list[float] = []
    digests: list[str] = []
    round_results: list[dict[str, Any]] = []
    try:
        validation_output, _, _ = runner.run(
            validation_contexts,
            validation_routing,
        )
        for round_index in range(ROUNDS):
            for _ in range(WARMUPS):
                runner.run(benchmark_contexts, benchmark_routing)
            round_wall: list[float] = []
            round_compute: list[float] = []
            for _ in range(ITERATIONS):
                output, wall_ms, compute_ms = runner.run(
                    benchmark_contexts,
                    benchmark_routing,
                )
                digests.append(hashlib.sha256(output.tobytes(order="C")).hexdigest())
                wall_samples.append(wall_ms)
                compute_samples.append(compute_ms)
                round_wall.append(wall_ms)
                round_compute.append(compute_ms)
            round_results.append(
                {
                    "round": round_index + 1,
                    "wall_ms": _summary(round_wall),
                    "cuda_compute_ms": _summary(round_compute),
                    "series_per_second": _summary(
                        [BATCH_SIZE / (value / 1_000) for value in round_wall]
                    ),
                }
            )
    finally:
        runner.close()

    holdout_output = validation_output[: len(holdout_indices)]
    accuracy = _numerical_gate(
        reference[holdout_indices],
        holdout_output,
        contexts[holdout_indices],
    )
    digest_stable = len(set(digests)) == 1
    wall_summary = _summary(wall_samples)
    compute_summary = _summary(compute_samples)
    result = {
        "schema_version": (
            "fincast-tensorrt-fp32-benchmark/v1"
            if arguments.backend == "tensorrt_fp32"
            else "fincast-tensorrt-int8-benchmark/v1"
        ),
        "status": "passed" if accuracy["passed"] and digest_stable else "rejected",
        "rejection_reasons": [
            reason
            for reason, failed in (
                ("numerical_accuracy_gate", not accuracy["passed"]),
                ("repeat_digest_instability", not digest_stable),
            )
            if failed
        ],
        "backend": arguments.backend,
        "cadence_seconds": 60,
        "batch_size": BATCH_SIZE,
        "protocol": {
            "rounds": ROUNDS,
            "warmups_per_round": WARMUPS,
            "timed_iterations_per_round": ITERATIONS,
        },
        "timing": {
            "wall_ms": wall_summary,
            "cuda_compute_ms": compute_summary,
            "series_per_second": _summary(
                [BATCH_SIZE / (value / 1_000) for value in wall_samples]
            ),
        },
        "rounds": round_results,
        "accuracy_gate": accuracy,
        "repeat_output_digest": {
            "stable": digest_stable,
            "digest": digests[0] if digest_stable else None,
            "observations": len(digests),
        },
        "holdout": {
            "rows": len(holdout_indices),
            "indices": holdout_indices.tolist(),
            "split_digest": split_digest,
            "static_batch_fill_rows": 16,
            "scored_rows": len(holdout_indices),
        },
    }
    arguments.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = arguments.output.with_suffix(arguments.output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, arguments.output)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
