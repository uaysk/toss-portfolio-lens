from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import struct
import subprocess
import tempfile
from typing import BinaryIO

import numpy as np

from .raw_inference import RawInferenceError


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_REQUEST = struct.Struct("<4sII")
_RESPONSE = struct.Struct("<4sIdd")
_BATCH_SIZE = 48
_LAYERS = 50


@dataclass(frozen=True, slots=True)
class TensorRTProcessObservation:
    output: np.ndarray
    wall_ms: float
    compute_cuda_ms: float


def _regular_path(value: str | None, label: str, *, executable: bool = False) -> Path:
    if not value:
        raise RawInferenceError(f"{label} is required for the TensorRT FP32 backend")
    path = Path(value)
    if (
        not path.is_absolute()
        or path.resolve(strict=True) != path
        or path.is_symlink()
        or not path.is_file()
        or (executable and not os.access(path, os.X_OK))
    ):
        raise RawInferenceError(f"{label} must be an absolute normalized regular file")
    return path


def _directory_path(value: str | None, label: str) -> Path:
    if not value:
        raise RawInferenceError(f"{label} is required for the TensorRT FP32 backend")
    path = Path(value)
    if (
        not path.is_absolute()
        or path.resolve(strict=True) != path
        or path.is_symlink()
        or not path.is_dir()
    ):
        raise RawInferenceError(f"{label} must be an absolute normalized directory")
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _expected_digest(name: str, path: Path) -> str:
    expected = os.getenv(name, "").strip()
    if not _SHA256.fullmatch(expected):
        raise RawInferenceError(f"{name} must contain one lowercase SHA-256 digest")
    observed = _sha256(path)
    if observed != expected:
        raise RawInferenceError(f"{name} does not match {path.name}")
    return observed


class TensorRTRawProcess:
    def __init__(self, *, batch_size: int) -> None:
        if batch_size != _BATCH_SIZE:
            raise RawInferenceError("TensorRT FP32 raw generation requires static batch 48")
        python = _regular_path(
            os.getenv("AI_FINCAST_TENSORRT_PYTHON"),
            "AI_FINCAST_TENSORRT_PYTHON",
            executable=True,
        )
        engine = _regular_path(
            os.getenv("AI_FINCAST_TENSORRT_FP32_ENGINE"),
            "AI_FINCAST_TENSORRT_FP32_ENGINE",
        )
        plugin = _regular_path(
            os.getenv("AI_FINCAST_TENSORRT_PLUGIN"),
            "AI_FINCAST_TENSORRT_PLUGIN",
        )
        site_packages = _directory_path(
            os.getenv("AI_FINCAST_TENSORRT_SITE_PACKAGES"),
            "AI_FINCAST_TENSORRT_SITE_PACKAGES",
        )
        runtime_worker = Path(__file__).with_name("_tensorrt_runtime_worker.py").resolve()
        if runtime_worker.is_symlink() or not runtime_worker.is_file():
            raise RawInferenceError("TensorRT runtime worker source is unavailable")
        engine_sha256 = _expected_digest(
            "AI_FINCAST_TENSORRT_FP32_ENGINE_SHA256",
            engine,
        )
        plugin_sha256 = _expected_digest(
            "AI_FINCAST_TENSORRT_PLUGIN_SHA256",
            plugin,
        )
        self._stderr = tempfile.TemporaryFile(mode="w+b")
        child_environment = os.environ.copy()
        child_environment["PYTHONPATH"] = str(site_packages)
        try:
            self._process = subprocess.Popen(
                [
                    str(python),
                    str(runtime_worker),
                    "--engine",
                    str(engine),
                    "--plugin",
                    str(plugin),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=self._stderr,
                env=child_environment,
            )
        except BaseException:
            self._stderr.close()
            raise
        if self._process.stdin is None or self._process.stdout is None:
            self.close()
            raise RawInferenceError("TensorRT runtime pipes were not created")
        self._stdin: BinaryIO = self._process.stdin
        self._stdout: BinaryIO = self._process.stdout
        try:
            ready = json.loads(self._readline(timeout_seconds=180).decode("utf-8"))
            if (
                ready.get("status") != "ready"
                or ready.get("batch_size") != _BATCH_SIZE
                or ready.get("layers") != _LAYERS
            ):
                raise RawInferenceError(f"TensorRT runtime returned an invalid preflight: {ready}")
        except BaseException:
            detail = self._stderr_text()
            self.close()
            raise RawInferenceError(
                f"TensorRT FP32 runtime failed to initialize: {detail or 'no diagnostic'}"
            ) from None
        self.layers = _LAYERS
        self.batch_size = _BATCH_SIZE
        self.provenance = {
            "tensorrt_version": str(ready.get("tensorrt", "unavailable")),
            "tensorrt_engine_file": engine.name,
            "tensorrt_engine_sha256": engine_sha256,
            "tensorrt_engine_bytes": engine.stat().st_size,
            "tensorrt_plugin_file": plugin.name,
            "tensorrt_plugin_sha256": plugin_sha256,
            "tensorrt_plugin_bytes": plugin.stat().st_size,
            "tensorrt_static_batch": _BATCH_SIZE,
            "tensorrt_tail_backend": "batched_experts",
        }

    def _wait_readable(self, timeout_seconds: float) -> None:
        with selectors.DefaultSelector() as selector:
            selector.register(self._stdout, selectors.EVENT_READ)
            if not selector.select(timeout_seconds):
                raise RawInferenceError("TensorRT runtime response timed out")

    def _readline(self, *, timeout_seconds: float) -> bytes:
        self._wait_readable(timeout_seconds)
        line = self._stdout.readline(1 << 20)
        if not line:
            raise RawInferenceError("TensorRT runtime closed before its response")
        return line

    def _read_exact(self, size: int, *, timeout_seconds: float) -> bytes:
        output = bytearray()
        while len(output) < size:
            self._wait_readable(timeout_seconds)
            block = os.read(self._stdout.fileno(), size - len(output))
            if not block:
                raise RawInferenceError("TensorRT runtime closed during its response")
            output.extend(block)
        return bytes(output)

    def _stderr_text(self) -> str:
        self._stderr.flush()
        self._stderr.seek(0)
        return self._stderr.read(65536).decode("utf-8", errors="replace").strip()

    def predict(
        self,
        contexts: np.ndarray,
        uniforms: np.ndarray,
        *,
        cadence_seconds: int,
    ) -> TensorRTProcessObservation:
        contexts = np.ascontiguousarray(contexts, dtype="<f4")
        uniforms = np.ascontiguousarray(uniforms, dtype="<f4")
        if (
            contexts.shape != (_BATCH_SIZE, 512)
            or uniforms.shape != (1, _LAYERS, 2, _BATCH_SIZE, 16)
            or cadence_seconds != 60
            or not np.isfinite(contexts).all()
            or np.any(contexts <= 0)
            or not np.isfinite(uniforms).all()
            or np.any(uniforms <= 0)
            or np.any(uniforms >= 1)
        ):
            raise RawInferenceError("TensorRT FP32 request differs from the fixed c60/B48 contract")
        if self._process.poll() is not None:
            raise RawInferenceError(
                f"TensorRT runtime exited before inference: {self._stderr_text() or self._process.returncode}"
            )
        self._stdin.write(_REQUEST.pack(b"FCR1", _BATCH_SIZE, cadence_seconds))
        self._stdin.write(contexts.tobytes(order="C"))
        self._stdin.write(uniforms.tobytes(order="C"))
        self._stdin.flush()
        header = self._read_exact(_RESPONSE.size, timeout_seconds=120)
        magic, size, wall_ms, compute_ms = _RESPONSE.unpack(header)
        payload = self._read_exact(size, timeout_seconds=120)
        if magic != b"FCO1":
            raise RawInferenceError(
                f"TensorRT FP32 execution failed: {payload.decode('utf-8', errors='replace')}"
            )
        expected = _BATCH_SIZE * 4 * 10 * 4
        if size != expected:
            raise RawInferenceError("TensorRT FP32 output size differs from [48,4,10] FP32")
        output = np.frombuffer(payload, dtype="<f4").reshape(_BATCH_SIZE, 4, 10).copy()
        if not np.isfinite(output).all() or np.any(np.diff(output[..., 1:], axis=-1) < 0):
            raise RawInferenceError("TensorRT FP32 output failed finite or monotonicity validation")
        return TensorRTProcessObservation(
            output=output,
            wall_ms=float(wall_ms),
            compute_cuda_ms=float(compute_ms),
        )

    def close(self) -> None:
        process = getattr(self, "_process", None)
        if process is not None and process.poll() is None:
            try:
                stdin = getattr(self, "_stdin", None)
                if stdin is not None:
                    stdin.write(_REQUEST.pack(b"FCQ1", 0, 0))
                    stdin.flush()
                process.wait(timeout=10)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=10)
        for stream_name in ("_stdin", "_stdout"):
            stream = getattr(self, stream_name, None)
            if stream is not None:
                stream.close()
        stderr = getattr(self, "_stderr", None)
        if stderr is not None:
            stderr.close()

    def __enter__(self) -> TensorRTRawProcess:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
