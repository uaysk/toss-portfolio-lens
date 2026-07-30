#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import resource
import sys
import time

from cuda import cudart
import tensorrt as trt

from build_int8 import BATCH_SIZE, _absolute_existing, _absolute_output, _cuda_check

WORKSPACE_BYTES = 8 * 1024**3


def _constrain_fp32(network: trt.INetworkDefinition) -> list[str]:
    constrained: list[str] = []
    for index in range(network.num_layers):
        layer = network.get_layer(index)
        floating_outputs = [
            output_index
            for output_index in range(layer.num_outputs)
            if (
                (output := layer.get_output(output_index)) is not None
                and output.dtype == trt.float32
            )
        ]
        # TensorRT shape tensors and the constants that feed them must remain
        # INT32. A precision constraint is only meaningful for layers that
        # produce floating-point execution tensors.
        if not floating_outputs:
            continue
        try:
            layer.precision = trt.float32
            for output_index in floating_outputs:
                layer.set_output_type(output_index, trt.float32)
        except (AttributeError, RuntimeError):
            continue
        constrained.append(layer.name)
    return constrained


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--onnx", required=True, type=_absolute_existing)
    parser.add_argument("--plugin", required=True, type=_absolute_existing)
    parser.add_argument("--engine", required=True, type=_absolute_output)
    parser.add_argument("--timing-cache", required=True, type=Path)
    parser.add_argument("--inspector", required=True, type=_absolute_output)
    parser.add_argument("--result", required=True, type=_absolute_output)
    arguments = parser.parse_args()
    for path in (
        arguments.engine,
        arguments.timing_cache,
        arguments.inspector,
        arguments.result,
    ):
        if not path.is_absolute() or path.resolve(strict=False) != path or path.is_symlink():
            raise RuntimeError(f"unsafe output path: {path}")
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

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
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, WORKSPACE_BYTES)
    config.clear_flag(trt.BuilderFlag.TF32)
    config.clear_flag(trt.BuilderFlag.FP16)
    config.clear_flag(trt.BuilderFlag.INT8)
    config.set_flag(trt.BuilderFlag.OBEY_PRECISION_CONSTRAINTS)
    config.profiling_verbosity = trt.ProfilingVerbosity.DETAILED
    constrained_layers = _constrain_fp32(network)
    timing_cache = config.create_timing_cache(
        arguments.timing_cache.read_bytes()
        if arguments.timing_cache.is_file()
        else b""
    )
    config.set_timing_cache(timing_cache, ignore_mismatch=False)

    build_started = time.perf_counter()
    serialized = builder.build_serialized_network(network, config)
    build_seconds = time.perf_counter() - build_started
    if serialized is None:
        raise RuntimeError("TensorRT FP32 engine build returned no serialized network")

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
        raise RuntimeError("TensorRT FP32 engine failed immediate deserialization")
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
        "schema_version": "fincast-tensorrt-fp32-build/v1",
        "status": "built",
        "environment": {
            "tensorrt": trt.__version__,
            "python": sys.version.split()[0],
            "cuda_runtime": int(
                _cuda_check(
                    cudart.cudaRuntimeGetVersion(),
                    "cudaRuntimeGetVersion",
                )[1]
            ),
            "compute_capability": "6.1",
            "cudnn": "8.9.7",
            "tf32": False,
            "fp16": False,
            "bf16": False,
            "int8": False,
        },
        "network": {
            "inputs": network.num_inputs,
            "outputs": network.num_outputs,
            "layers": network.num_layers,
            "static_batch": BATCH_SIZE,
            "parse_seconds": parse_seconds,
            "fp32_constrained_layer_count": len(constrained_layers),
            "fp32_constrained_layers": constrained_layers,
            "precision_constraints": "obey",
        },
        "build": {
            "seconds": build_seconds,
            "workspace_bytes": WORKSPACE_BYTES,
            "engine_bytes": arguments.engine.stat().st_size,
            "timing_cache_bytes": arguments.timing_cache.stat().st_size,
            "maximum_resident_set_bytes": (
                resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
            ),
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
