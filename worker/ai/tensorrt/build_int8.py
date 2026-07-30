#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import resource
import sys
import time
from typing import Any

from cuda import cudart
import numpy as np
import tensorrt as trt

BATCH_SIZE = 48
CONTEXT_ROWS = 128
CALIBRATION_ROWS = 96
CONTEXT_LENGTH = 512
LAYERS = 50
TOP_N = 2
TOKENS = 16
MODEL_SEED = 17


def _absolute_existing(path: str) -> Path:
    value = Path(path)
    if (
        not value.is_absolute()
        or value.resolve(strict=True) != value
        or value.is_symlink()
    ):
        raise argparse.ArgumentTypeError("input must be an absolute normalized regular path")
    return value


def _absolute_output(path: str) -> Path:
    value = Path(path)
    if not value.is_absolute() or value.resolve(strict=False) != value:
        raise argparse.ArgumentTypeError("output must be an absolute normalized path")
    if value.exists() or value.is_symlink():
        raise argparse.ArgumentTypeError("output already exists or is a symlink")
    return value


def _routing_uniforms(row_ids: np.ndarray) -> np.ndarray:
    bounded_rows = np.asarray(row_ids, dtype=np.uint64)
    passes = np.arange(1, dtype=np.uint64)[:, None, None, None, None]
    layer_ids = np.arange(LAYERS, dtype=np.uint64)[None, :, None, None, None]
    top_ids = np.arange(TOP_N, dtype=np.uint64)[None, None, :, None, None]
    rows = bounded_rows[None, None, None, :, None]
    token_ids = np.arange(TOKENS, dtype=np.uint64)[None, None, None, None, :]
    with np.errstate(over="ignore"):
        state = (
            np.uint64(MODEL_SEED)
            ^ (rows * np.uint64(0xD6E8FEB86659FD93))
            ^ (passes * np.uint64(0xA0761D6478BD642F))
            ^ (layer_ids * np.uint64(0xE7037ED1A0B428DB))
            ^ (top_ids * np.uint64(0x8EBC6AF09C88C6E3))
            ^ (token_ids * np.uint64(0x589965CC75374CC3))
        )
        state += np.uint64(0x9E3779B97F4A7C15)
        state = (state ^ (state >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        state = (state ^ (state >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        state ^= state >> np.uint64(31)
    mantissa = (state >> np.uint64(40)).astype(np.uint32)
    return np.ascontiguousarray(
        (mantissa.astype(np.float32) + np.float32(0.5)) / np.float32(1 << 24),
        dtype=np.float32,
    )


def _calibration_split(contexts: np.ndarray) -> tuple[np.ndarray, np.ndarray, str]:
    row_digests = tuple(
        hashlib.sha256(contexts[index].tobytes(order="C")).hexdigest()
        for index in range(CONTEXT_ROWS)
    )
    ordered = tuple(sorted(range(CONTEXT_ROWS), key=lambda index: (row_digests[index], index)))
    calibration = np.asarray(sorted(ordered[:CALIBRATION_ROWS]), dtype=np.int64)
    holdout = np.asarray(sorted(ordered[CALIBRATION_ROWS:]), dtype=np.int64)
    payload = json.dumps(
        {
            "policy": "sha256-row-order/v1",
            "row_digests": row_digests,
            "calibration_indices": calibration.tolist(),
            "holdout_indices": holdout.tolist(),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    return calibration, holdout, hashlib.sha256(payload).hexdigest()


def _cuda_check(result: tuple[Any, ...], operation: str) -> tuple[Any, ...]:
    if result[0] != cudart.cudaError_t.cudaSuccess:
        raise RuntimeError(f"{operation} failed with CUDA error {int(result[0])}")
    return result


class FinCastCalibrator(trt.IInt8EntropyCalibrator2):
    def __init__(
        self,
        contexts: np.ndarray,
        calibration_indices: np.ndarray,
        cache_path: Path,
    ) -> None:
        super().__init__()
        self.contexts = contexts
        self.indices = calibration_indices
        self.cache_path = cache_path
        self.offset = 0
        self.batch_count = 0
        self.cache_read = False
        self.cache_written = False
        context_bytes = BATCH_SIZE * CONTEXT_LENGTH * np.dtype(np.float32).itemsize
        routing_bytes = (
            LAYERS * TOP_N * BATCH_SIZE * TOKENS * np.dtype(np.float32).itemsize
        )
        self.context_device = int(_cuda_check(cudart.cudaMalloc(context_bytes), "cudaMalloc contexts")[1])
        self.routing_device = int(_cuda_check(cudart.cudaMalloc(routing_bytes), "cudaMalloc routing")[1])

    def get_batch_size(self) -> int:
        return BATCH_SIZE

    def get_batch(self, names: list[str]) -> list[int] | None:
        if self.offset >= len(self.indices):
            return None
        selected = self.indices[self.offset : self.offset + BATCH_SIZE]
        if len(selected) != BATCH_SIZE:
            raise RuntimeError("calibration split did not form complete static batches")
        contexts = np.ascontiguousarray(self.contexts[selected], dtype=np.float32)
        routing = _routing_uniforms(selected)
        _cuda_check(
            cudart.cudaMemcpy(
                self.context_device,
                contexts.ctypes.data,
                contexts.nbytes,
                cudart.cudaMemcpyKind.cudaMemcpyHostToDevice,
            ),
            "cudaMemcpy contexts",
        )
        _cuda_check(
            cudart.cudaMemcpy(
                self.routing_device,
                routing.ctypes.data,
                routing.nbytes,
                cudart.cudaMemcpyKind.cudaMemcpyHostToDevice,
            ),
            "cudaMemcpy routing",
        )
        pointers = {
            "contexts": self.context_device,
            "routing_uniforms": self.routing_device,
        }
        if set(names) != set(pointers):
            raise RuntimeError(f"unexpected calibration inputs: {names}")
        self.offset += BATCH_SIZE
        self.batch_count += 1
        return [pointers[name] for name in names]

    def read_calibration_cache(self) -> bytes | None:
        if not self.cache_path.is_file():
            return None
        self.cache_read = True
        return self.cache_path.read_bytes()

    def write_calibration_cache(self, cache: bytes) -> None:
        temporary = self.cache_path.with_suffix(self.cache_path.suffix + ".tmp")
        temporary.write_bytes(cache)
        os.replace(temporary, self.cache_path)
        self.cache_written = True

    def close(self) -> None:
        if self.context_device:
            _cuda_check(cudart.cudaFree(self.context_device), "cudaFree contexts")
            self.context_device = 0
        if self.routing_device:
            _cuda_check(cudart.cudaFree(self.routing_device), "cudaFree routing")
            self.routing_device = 0


def _set_fp32_allowlist(network: trt.INetworkDefinition) -> list[str]:
    allowed: list[str] = []
    precision_capable = {
        trt.LayerType.ACTIVATION,
        trt.LayerType.EINSUM,
        trt.LayerType.ELEMENTWISE,
        trt.LayerType.MATRIX_MULTIPLY,
        trt.LayerType.NORMALIZATION,
        trt.LayerType.PLUGIN_V2,
        trt.LayerType.REDUCE,
        trt.LayerType.SOFTMAX,
        trt.LayerType.TOPK,
        trt.LayerType.UNARY,
    }
    for index in range(network.num_layers):
        layer = network.get_layer(index)
        name = layer.name
        final_restore = index >= network.num_layers - 25
        normalization = (
            layer.type == trt.LayerType.NORMALIZATION
            or "input_layernorm" in name
            or index < 25
        )
        routing = "/moe/moe/gate" in name
        if (
            layer.type
            in {
                trt.LayerType.SOFTMAX,
                trt.LayerType.PLUGIN_V2,
                trt.LayerType.TOPK,
            }
            or normalization
            or routing
            or final_restore
        ) and layer.type in precision_capable:
            try:
                layer.precision = trt.float32
                for output_index in range(layer.num_outputs):
                    output = layer.get_output(output_index)
                    if output is not None and output.dtype == trt.float32:
                        layer.set_output_type(output_index, trt.float32)
            except (AttributeError, RuntimeError):
                continue
            allowed.append(name)
    return allowed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--onnx", required=True, type=_absolute_existing)
    parser.add_argument("--plugin", required=True, type=_absolute_existing)
    parser.add_argument("--contexts", required=True, type=_absolute_existing)
    parser.add_argument("--engine", required=True, type=_absolute_output)
    parser.add_argument("--calibration-cache", required=True, type=Path)
    parser.add_argument("--timing-cache", required=True, type=Path)
    parser.add_argument("--inspector", required=True, type=_absolute_output)
    parser.add_argument("--result", required=True, type=_absolute_output)
    arguments = parser.parse_args()
    for path in (
        arguments.engine,
        arguments.calibration_cache,
        arguments.timing_cache,
        arguments.inspector,
        arguments.result,
    ):
        if not path.is_absolute() or path.resolve(strict=False) != path or path.is_symlink():
            raise RuntimeError(f"unsafe output path: {path}")
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    contexts = np.memmap(
        arguments.contexts,
        dtype="<f4",
        mode="r",
        shape=(CONTEXT_ROWS, CONTEXT_LENGTH),
    )
    calibration_indices, holdout_indices, split_digest = _calibration_split(contexts)
    ctypes.CDLL(str(arguments.plugin), mode=ctypes.RTLD_GLOBAL)
    logger = trt.Logger(trt.Logger.INFO)
    trt.init_libnvinfer_plugins(logger, "")
    builder = trt.Builder(logger)
    network = builder.create_network(
        1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
    )
    onnx_parser = trt.OnnxParser(network, logger)
    parse_started = time.perf_counter()
    if not onnx_parser.parse_from_file(str(arguments.onnx)):
        errors = [
            onnx_parser.get_error(index).desc()
            for index in range(onnx_parser.num_errors)
        ]
        raise RuntimeError(f"TensorRT ONNX parse failed: {errors}")
    parse_seconds = time.perf_counter() - parse_started

    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 8 * 1024**3)
    config.clear_flag(trt.BuilderFlag.TF32)
    config.set_flag(trt.BuilderFlag.INT8)
    config.set_flag(trt.BuilderFlag.PREFER_PRECISION_CONSTRAINTS)
    config.profiling_verbosity = trt.ProfilingVerbosity.DETAILED
    fp32_allowlist = _set_fp32_allowlist(network)
    calibrator = FinCastCalibrator(
        contexts,
        calibration_indices,
        arguments.calibration_cache,
    )
    config.int8_calibrator = calibrator
    timing_cache = config.create_timing_cache(
        arguments.timing_cache.read_bytes()
        if arguments.timing_cache.is_file()
        else b""
    )
    config.set_timing_cache(timing_cache, ignore_mismatch=False)

    build_started = time.perf_counter()
    try:
        serialized = builder.build_serialized_network(network, config)
    finally:
        calibrator.close()
    build_seconds = time.perf_counter() - build_started
    if serialized is None:
        raise RuntimeError("TensorRT INT8 engine build returned no serialized network")

    engine_temporary = arguments.engine.with_suffix(arguments.engine.suffix + ".tmp")
    with engine_temporary.open("wb") as output:
        output.write(memoryview(serialized))
        output.flush()
        os.fsync(output.fileno())
    os.replace(engine_temporary, arguments.engine)
    timing_serialized = config.get_timing_cache().serialize()
    timing_temporary = arguments.timing_cache.with_suffix(
        arguments.timing_cache.suffix + ".tmp"
    )
    timing_temporary.write_bytes(memoryview(timing_serialized))
    os.replace(timing_temporary, arguments.timing_cache)

    runtime = trt.Runtime(logger)
    engine = runtime.deserialize_cuda_engine(serialized)
    if engine is None:
        raise RuntimeError("TensorRT INT8 engine failed immediate deserialization")
    inspector = engine.create_engine_inspector()
    inspector_text = inspector.get_engine_information(
        trt.LayerInformationFormat.JSON
    )
    inspector_temporary = arguments.inspector.with_suffix(
        arguments.inspector.suffix + ".tmp"
    )
    inspector_temporary.write_text(inspector_text, encoding="utf-8")
    os.replace(inspector_temporary, arguments.inspector)

    result = {
        "schema_version": "fincast-tensorrt-int8-build/v1",
        "status": "built",
        "environment": {
            "tensorrt": trt.__version__,
            "python": sys.version.split()[0],
            "cuda_runtime": int(_cuda_check(cudart.cudaRuntimeGetVersion(), "cudaRuntimeGetVersion")[1]),
            "compute_capability": "6.1",
            "cudnn": "8.9.7",
            "tf32": False,
            "fp16": False,
            "bf16": False,
        },
        "network": {
            "inputs": network.num_inputs,
            "outputs": network.num_outputs,
            "layers": network.num_layers,
            "static_batch": BATCH_SIZE,
            "parse_seconds": parse_seconds,
            "fp32_allowlist_layer_count": len(fp32_allowlist),
            "fp32_allowlist_layers": fp32_allowlist,
        },
        "calibration": {
            "policy": "sha256-row-order/v1",
            "rows": CALIBRATION_ROWS,
            "batches": calibrator.batch_count,
            "cache_read": calibrator.cache_read,
            "cache_written": calibrator.cache_written,
            "indices": calibration_indices.tolist(),
            "holdout_indices": holdout_indices.tolist(),
            "split_digest": split_digest,
        },
        "build": {
            "seconds": build_seconds,
            "workspace_bytes": 8 * 1024**3,
            "engine_bytes": arguments.engine.stat().st_size,
            "calibration_cache_bytes": arguments.calibration_cache.stat().st_size,
            "timing_cache_bytes": arguments.timing_cache.stat().st_size,
            "maximum_resident_set_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            * 1024,
            "immediate_deserialization": True,
        },
    }
    result_temporary = arguments.result.with_suffix(arguments.result.suffix + ".tmp")
    result_temporary.write_text(
        json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.replace(result_temporary, arguments.result)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
