from __future__ import annotations

import argparse
import ctypes
import json
from pathlib import Path
import struct
import sys
import time

from cuda import cudart
import numpy as np
import tensorrt as trt


BATCH_SIZE = 48
CONTEXT_LENGTH = 512
LAYERS = 50
ROUTES = 2
TOKENS = 16
OUTPUT_SHAPE = (BATCH_SIZE, 4, 10)
REQUEST = struct.Struct("<4sII")
RESPONSE = struct.Struct("<4sIdd")


def _path(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.resolve(strict=True) != path
        or path.is_symlink()
        or not path.is_file()
    ):
        raise argparse.ArgumentTypeError("runtime inputs must be absolute regular files")
    return path


def _cuda(result: tuple[object, ...], operation: str) -> tuple[object, ...]:
    if result[0] != cudart.cudaError_t.cudaSuccess:
        raise RuntimeError(f"{operation} failed: {result[0]}")
    return result


def _read_exact(size: int) -> bytes:
    output = bytearray()
    while len(output) < size:
        block = sys.stdin.buffer.read(size - len(output))
        if not block:
            raise EOFError("TensorRT parent closed the request stream")
        output.extend(block)
    return bytes(output)


class Engine:
    def __init__(self, engine_path: Path, plugin_path: Path) -> None:
        ctypes.CDLL(str(plugin_path), mode=ctypes.RTLD_GLOBAL)
        self.logger = trt.Logger(trt.Logger.WARNING)
        trt.init_libnvinfer_plugins(self.logger, "")
        self.runtime = trt.Runtime(self.logger)
        serialized = engine_path.read_bytes()
        try:
            self.engine = self.runtime.deserialize_cuda_engine(serialized)
        finally:
            del serialized
        if self.engine is None:
            raise RuntimeError("TensorRT FP32 engine deserialization failed")
        self.context = self.engine.create_execution_context()
        if self.context is None:
            raise RuntimeError("TensorRT FP32 execution context creation failed")
        self.stream = int(_cuda(cudart.cudaStreamCreate(), "cudaStreamCreate")[1])
        self.start_event = int(_cuda(cudart.cudaEventCreate(), "cudaEventCreate start")[1])
        self.end_event = int(_cuda(cudart.cudaEventCreate(), "cudaEventCreate end")[1])
        self.bindings: list[int] = [0] * self.engine.num_bindings
        self.devices: dict[str, int] = {}
        self.output = np.empty(OUTPUT_SHAPE, dtype=np.float32)
        expected = {
            "contexts": (BATCH_SIZE, CONTEXT_LENGTH),
            "routing_uniforms": (1, LAYERS, ROUTES, BATCH_SIZE, TOKENS),
            "native_predictions": OUTPUT_SHAPE,
        }
        for index in range(self.engine.num_bindings):
            name = self.engine.get_binding_name(index)
            shape = tuple(self.engine.get_binding_shape(index))
            dtype = np.dtype(trt.nptype(self.engine.get_binding_dtype(index)))
            if name not in expected or shape != expected[name] or dtype != np.dtype(np.float32):
                raise RuntimeError(
                    f"unexpected TensorRT binding {name}: shape={shape}, dtype={dtype}"
                )
            size = int(np.prod(shape, dtype=np.int64)) * dtype.itemsize
            pointer = int(_cuda(cudart.cudaMalloc(size), f"cudaMalloc {name}")[1])
            self.bindings[index] = pointer
            self.devices[name] = pointer
        if set(self.devices) != set(expected):
            raise RuntimeError(f"missing TensorRT bindings: {sorted(set(expected) - set(self.devices))}")

    def run(self, contexts: np.ndarray, uniforms: np.ndarray) -> tuple[np.ndarray, float, float]:
        started = time.perf_counter()
        _cuda(
            cudart.cudaMemcpyAsync(
                self.devices["contexts"],
                contexts.ctypes.data,
                contexts.nbytes,
                cudart.cudaMemcpyKind.cudaMemcpyHostToDevice,
                self.stream,
            ),
            "cudaMemcpyAsync contexts",
        )
        _cuda(
            cudart.cudaMemcpyAsync(
                self.devices["routing_uniforms"],
                uniforms.ctypes.data,
                uniforms.nbytes,
                cudart.cudaMemcpyKind.cudaMemcpyHostToDevice,
                self.stream,
            ),
            "cudaMemcpyAsync routing_uniforms",
        )
        _cuda(cudart.cudaEventRecord(self.start_event, self.stream), "cudaEventRecord start")
        if not self.context.execute_async_v2(self.bindings, self.stream):
            raise RuntimeError("TensorRT execute_async_v2 failed")
        _cuda(cudart.cudaEventRecord(self.end_event, self.stream), "cudaEventRecord end")
        _cuda(
            cudart.cudaMemcpyAsync(
                self.output.ctypes.data,
                self.devices["native_predictions"],
                self.output.nbytes,
                cudart.cudaMemcpyKind.cudaMemcpyDeviceToHost,
                self.stream,
            ),
            "cudaMemcpyAsync native_predictions",
        )
        _cuda(cudart.cudaStreamSynchronize(self.stream), "cudaStreamSynchronize")
        compute_ms = float(
            _cuda(
                cudart.cudaEventElapsedTime(self.start_event, self.end_event),
                "cudaEventElapsedTime",
            )[1]
        )
        return self.output.copy(), (time.perf_counter() - started) * 1_000, compute_ms

    def close(self) -> None:
        for pointer in self.bindings:
            if pointer:
                _cuda(cudart.cudaFree(pointer), "cudaFree binding")
        self.bindings = []
        if self.start_event:
            _cuda(cudart.cudaEventDestroy(self.start_event), "cudaEventDestroy start")
            self.start_event = 0
        if self.end_event:
            _cuda(cudart.cudaEventDestroy(self.end_event), "cudaEventDestroy end")
            self.end_event = 0
        if self.stream:
            _cuda(cudart.cudaStreamDestroy(self.stream), "cudaStreamDestroy")
            self.stream = 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", required=True, type=_path)
    parser.add_argument("--plugin", required=True, type=_path)
    arguments = parser.parse_args()
    engine = Engine(arguments.engine, arguments.plugin)
    sys.stdout.write(
        json.dumps(
            {
                "status": "ready",
                "batch_size": BATCH_SIZE,
                "layers": LAYERS,
                "tensorrt": trt.__version__,
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    sys.stdout.flush()
    try:
        while True:
            magic, rows, cadence = REQUEST.unpack(_read_exact(REQUEST.size))
            if magic == b"FCQ1":
                return 0
            try:
                if magic != b"FCR1" or rows != BATCH_SIZE or cadence != 60:
                    raise RuntimeError("TensorRT request is not the fixed c60/B48 contract")
                contexts = np.frombuffer(
                    _read_exact(BATCH_SIZE * CONTEXT_LENGTH * 4),
                    dtype="<f4",
                ).reshape(BATCH_SIZE, CONTEXT_LENGTH)
                uniforms = np.frombuffer(
                    _read_exact(BATCH_SIZE * LAYERS * ROUTES * TOKENS * 4),
                    dtype="<f4",
                ).reshape(1, LAYERS, ROUTES, BATCH_SIZE, TOKENS)
                output, wall_ms, compute_ms = engine.run(contexts, uniforms)
                sys.stdout.buffer.write(RESPONSE.pack(b"FCO1", output.nbytes, wall_ms, compute_ms))
                sys.stdout.buffer.write(output.tobytes(order="C"))
            except Exception as error:
                payload = str(error).encode("utf-8", errors="replace")[:65536]
                sys.stdout.buffer.write(RESPONSE.pack(b"FCE1", len(payload), 0.0, 0.0))
                sys.stdout.buffer.write(payload)
            sys.stdout.buffer.flush()
    finally:
        engine.close()


if __name__ == "__main__":
    raise SystemExit(main())
