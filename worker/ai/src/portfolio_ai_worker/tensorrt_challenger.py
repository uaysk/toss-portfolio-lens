from __future__ import annotations

from dataclasses import dataclass
import ctypes.util
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from typing import Any

import numpy as np

from .raw_artifacts import (
    atomic_write,
    canonical_json_bytes,
    load_raw_input,
    open_contexts,
)
from .raw_inference import RawInferenceError

TENSORRT_CHALLENGER_SCHEMA = "fincast-tensorrt-int8-challenger/v1"
TENSORRT_VERSION = "8.6.1.6"
TENSORRT_PYTHON = (3, 11)
TENSORRT_CUDA_TOOLKIT = "12.2"
TENSORRT_CUDNN = "8.9.7"
TENSORRT_COMPUTE_CAPABILITY = "6.1"
CALIBRATION_ROWS = 96
HOLDOUT_ROWS = 32
FROZEN_CONTEXT_ROWS = CALIBRATION_ROWS + HOLDOUT_ROWS

INT8_TARGETS = (
    "attention_linear",
    "attention_matmul",
    "expert_gate_linear",
    "expert_down_linear",
    "output_linear",
)
FP32_ALLOWLIST = (
    "normalization",
    "softmax",
    "top2_routing_dispatch_combine",
    "final_quantile_restore",
)


def top2_route_reference(
    probabilities: np.ndarray,
    uniforms: np.ndarray,
    *,
    threshold: float = 0.2,
) -> tuple[np.ndarray, np.ndarray]:
    """CPU oracle for the fixed-shape TensorRT routing plugin."""

    gates = np.asarray(probabilities, dtype=np.float32)
    draws = np.asarray(uniforms, dtype=np.float32)
    if (
        gates.ndim != 3
        or gates.shape[1:] != (16, 4)
        or draws.shape != (2, gates.shape[0], 16)
        or threshold <= 0
        or not np.isfinite(gates).all()
        or not np.isfinite(draws).all()
    ):
        raise RawInferenceError("TensorRT routing oracle received an invalid fixed-shape input")
    batch = gates.shape[0]
    dispatch = np.zeros((batch, 16, 4, 8), dtype=np.float32)
    combine = np.zeros_like(dispatch)
    for batch_index in range(batch):
        top_indices = np.argsort(-gates[batch_index], axis=-1, kind="stable")[:, :2]
        top_values = np.take_along_axis(
            gates[batch_index],
            top_indices,
            axis=-1,
        )
        top_values /= np.maximum(
            top_values.sum(axis=-1, keepdims=True),
            np.float32(1e-9),
        )
        used = [0, 0, 0, 0]
        for route in range(2):
            for token in range(16):
                if route == 1 and not (
                    draws[route, batch_index, token]
                    < top_values[token, route] / np.float32(threshold)
                ):
                    continue
                expert = int(top_indices[token, route])
                position = used[expert]
                used[expert] += 1
                if position >= 8:
                    continue
                dispatch[batch_index, token, expert, position] = 1
                combine[batch_index, token, expert, position] = top_values[
                    token,
                    route,
                ]
    return dispatch, combine


@dataclass(frozen=True, slots=True)
class CalibrationSplit:
    calibration_indices: tuple[int, ...]
    holdout_indices: tuple[int, ...]
    row_digests: tuple[str, ...]
    split_digest: str

    def json(self) -> dict[str, Any]:
        return {
            "policy": "sha256-row-order/v1",
            "calibration_rows": len(self.calibration_indices),
            "holdout_rows": len(self.holdout_indices),
            "calibration_indices": list(self.calibration_indices),
            "holdout_indices": list(self.holdout_indices),
            "row_digests": list(self.row_digests),
            "split_digest": self.split_digest,
        }


def calibration_split(contexts: np.ndarray) -> CalibrationSplit:
    values = np.ascontiguousarray(contexts, dtype="<f4")
    if values.shape != (FROZEN_CONTEXT_ROWS, 512):
        raise RawInferenceError("TensorRT calibration requires the exact frozen [128,512] contexts")
    if not np.isfinite(values).all() or not (values > 0).all():
        raise RawInferenceError("TensorRT calibration contexts must be finite positive closes")
    row_digests = tuple(
        hashlib.sha256(values[index].tobytes(order="C")).hexdigest()
        for index in range(FROZEN_CONTEXT_ROWS)
    )
    ordered = tuple(sorted(range(FROZEN_CONTEXT_ROWS), key=lambda index: (row_digests[index], index)))
    calibration = tuple(sorted(ordered[:CALIBRATION_ROWS]))
    holdout = tuple(sorted(ordered[CALIBRATION_ROWS:]))
    if set(calibration) & set(holdout) or sorted((*calibration, *holdout)) != list(
        range(FROZEN_CONTEXT_ROWS)
    ):
        raise AssertionError("TensorRT calibration and holdout sets must be disjoint and complete")
    split_digest = hashlib.sha256(
        json.dumps(
            {
                "policy": "sha256-row-order/v1",
                "row_digests": row_digests,
                "calibration_indices": calibration,
                "holdout_indices": holdout,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
    ).hexdigest()
    return CalibrationSplit(
        calibration_indices=calibration,
        holdout_indices=holdout,
        row_digests=row_digests,
        split_digest=split_digest,
    )


def _package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _cuda_toolkit_version(nvcc: str | None) -> str | None:
    if nvcc is None:
        return None
    try:
        result = subprocess.run(
            [nvcc, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in (*result.stdout.splitlines(), *result.stderr.splitlines()):
        marker = "release "
        if marker not in line:
            continue
        version = line.split(marker, 1)[1].split(",", 1)[0].strip()
        if version:
            return version
    return None


def _find_nvcc() -> str | None:
    discovered = shutil.which("nvcc")
    if discovered is not None:
        return discovered
    cuda_home = Path(os.getenv("CUDA_HOME", "/usr/local/cuda"))
    candidate = cuda_home / "bin" / "nvcc"
    if candidate.is_file() and not candidate.is_symlink():
        return str(candidate)
    return None


def _cudnn_version() -> str | None:
    cuda_home = Path(os.getenv("CUDA_HOME", "/usr/local/cuda"))
    header = cuda_home / "include" / "cudnn_version.h"
    if not header.is_file() or header.is_symlink():
        return None
    values: dict[str, str] = {}
    try:
        for line in header.read_text(encoding="utf-8").splitlines():
            fields = line.split()
            if len(fields) == 3 and fields[:2] == ["#define", "CUDNN_MAJOR"]:
                values["major"] = fields[2]
            elif len(fields) == 3 and fields[:2] == ["#define", "CUDNN_MINOR"]:
                values["minor"] = fields[2]
            elif len(fields) == 3 and fields[:2] == ["#define", "CUDNN_PATCHLEVEL"]:
                values["patch"] = fields[2]
    except OSError:
        return None
    if set(values) != {"major", "minor", "patch"}:
        return None
    return f"{values['major']}.{values['minor']}.{values['patch']}"


def _nvinfer_library() -> str | None:
    discovered = ctypes.util.find_library("nvinfer")
    if discovered is not None:
        return discovered
    root_value = os.getenv("TENSORRT_ROOT")
    if not root_value:
        return None
    root = Path(root_value)
    for folder in ("lib", "lib64"):
        candidate = root / folder / "libnvinfer.so.8"
        if candidate.is_file() and not candidate.is_symlink():
            return str(candidate)
    return None


def probe_tensorrt_environment(
    *,
    plugin_source: Path,
    plugin_library: Path | None = None,
) -> dict[str, Any]:
    python_version = platform.python_version()
    tensorrt_version = _package_version("tensorrt")
    onnx_version = _package_version("onnx")
    nvinfer = _nvinfer_library()
    cudnn = _cudnn_version()
    reasons: list[str] = []
    if sys.version_info[:2] != TENSORRT_PYTHON:
        reasons.append("python_3_11_unavailable")
    if tensorrt_version not in {"8.6.1", TENSORRT_VERSION}:
        reasons.append("tensorrt_8_6_1_6_unavailable")
    if onnx_version is None:
        reasons.append("onnx_unavailable")
    if nvinfer is None:
        reasons.append("libnvinfer_unavailable")
    nvcc = _find_nvcc()
    cuda_toolkit = _cuda_toolkit_version(nvcc)
    if nvcc is None:
        reasons.append("cuda_compiler_unavailable")
    elif cuda_toolkit != TENSORRT_CUDA_TOOLKIT:
        reasons.append("cuda_toolkit_12_2_unavailable")
    if cudnn != TENSORRT_CUDNN:
        reasons.append("cudnn_8_9_7_unavailable")
    if not plugin_source.is_file() or plugin_source.is_symlink():
        reasons.append("routing_plugin_source_unavailable")
    if plugin_library is not None and (
        not plugin_library.is_file() or plugin_library.is_symlink()
    ):
        reasons.append("routing_plugin_library_unavailable")
    return {
        "status": "available" if not reasons else "unavailable",
        "reasons": reasons,
        "required": {
            "tensorrt": TENSORRT_VERSION,
            "python": "3.11",
            "cuda_toolkit_build": TENSORRT_CUDA_TOOLKIT,
            "cudnn": TENSORRT_CUDNN,
            "compute_capability": TENSORRT_COMPUTE_CAPABILITY,
        },
        "observed": {
            "python": python_version,
            "tensorrt": tensorrt_version,
            "onnx": onnx_version,
            "libnvinfer": nvinfer,
            "nvcc": nvcc,
            "cuda_toolkit": cuda_toolkit,
            "cudnn": cudnn,
            "plugin_source": str(plugin_source),
            "plugin_source_sha256": (
                hashlib.sha256(plugin_source.read_bytes()).hexdigest()
                if plugin_source.is_file() and not plugin_source.is_symlink()
                else None
            ),
            "plugin_library": str(plugin_library) if plugin_library is not None else None,
        },
    }


def write_unavailable_challenger_artifact(
    output_path: Path,
    *,
    environment: dict[str, Any],
    split: CalibrationSplit,
    model_provenance: dict[str, Any],
) -> dict[str, Any]:
    if environment.get("status") != "unavailable":
        raise RawInferenceError("unavailable challenger artifact requires an unavailable environment probe")
    if not output_path.is_absolute() or output_path.resolve(strict=False) != output_path:
        raise RawInferenceError("TensorRT challenger output must be an absolute normalized path")
    if output_path.exists() or output_path.is_symlink():
        raise RawInferenceError("TensorRT challenger output already exists or is a symlink")
    output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    artifact = {
        "schema_version": TENSORRT_CHALLENGER_SCHEMA,
        "status": "unavailable",
        "promotion": "challenger_only_no_automatic_promotion",
        "environment": environment,
        "calibration": split.json(),
        "precision_policy": {
            "int8_targets": list(INT8_TARGETS),
            "fp32_allowlist": list(FP32_ALLOWLIST),
            "engine_inspector_required": True,
            "calibration_cache_required": True,
        },
        "model_provenance": model_provenance,
        "engine": None,
        "accuracy_gate": None,
        "latency": None,
    }
    atomic_write(output_path, canonical_json_bytes(artifact))
    return artifact


def run_tensorrt_challenger_probe(
    *,
    manifest_path: Path,
    output_path: Path,
    plugin_source: Path,
    model_provenance: dict[str, Any],
) -> dict[str, Any]:
    """Attempt the isolated challenger prerequisites and persist an honest result.

    Building or promoting an engine is deliberately outside this probe. When the
    pinned TensorRT environment is absent, this records the exact blocker plus
    the deterministic 96/32 calibration split without inventing engine metrics.
    """

    artifact = load_raw_input(manifest_path)
    if artifact.manifest.row_count != FROZEN_CONTEXT_ROWS:
        raise RawInferenceError(
            "TensorRT challenger requires the exact frozen 128-context artifact"
        )
    contexts = open_contexts(artifact)
    try:
        split = calibration_split(np.asarray(contexts))
    finally:
        del contexts
    environment = probe_tensorrt_environment(plugin_source=plugin_source)
    if environment["status"] != "unavailable":
        raise RawInferenceError(
            "TensorRT prerequisites are available; a reviewed static ONNX/engine build "
            "must run instead of emitting an unavailable artifact"
        )
    return write_unavailable_challenger_artifact(
        output_path,
        environment=environment,
        split=split,
        model_provenance={
            **model_provenance,
            "input_manifest_sha256": artifact.manifest_sha256,
            "input_artifact_digest": artifact.artifact_digest,
        },
    )
