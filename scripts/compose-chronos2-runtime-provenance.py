#!/usr/bin/env python3
"""Compose host, framework, image, and model provenance for Chronos-2 runs."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
from typing import Any


MAX_INPUT_BYTES = 1 << 20


def absolute_file(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_file()
        or path.stat().st_size > MAX_INPUT_BYTES
    ):
        raise argparse.ArgumentTypeError(
            "input must be a bounded absolute normalized regular file"
        )
    return path


def absolute_output(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.resolve(strict=False) != path
        or path.parent.is_symlink()
        or not path.parent.is_dir()
    ):
        raise argparse.ArgumentTypeError(
            "output must be in an existing absolute normalized directory"
        )
    return path


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", type=absolute_file, required=True)
    parser.add_argument("--model", type=absolute_file, required=True)
    parser.add_argument("--framework", type=absolute_file, required=True)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--output", type=absolute_output, required=True)
    return parser.parse_args()


def read_object(path: Path, schema: str) -> dict[str, Any]:
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict) or value.get("schema_version") != schema:
        raise ValueError(f"{path} must use {schema}")
    return value


def atomic_json(path: Path, value: object) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    args = arguments()
    preflight = read_object(args.preflight, "chronos2-p40-preflight/v1")
    model = read_object(args.model, "chronos2-model-cache/v1")
    framework = read_object(args.framework, "chronos2-framework-runtime/v1")
    image_id = args.image_id.strip()
    if not image_id.startswith("sha256:") or len(image_id) != 71:
        raise ValueError("image ID must be a sha256 Docker image identifier")

    requested = {"cuda": "12.2", "cudnn": "8.9.7"}
    actual = {
        "cuda": framework.get("cuda_runtime"),
        "cudnn": framework.get("cudnn_runtime"),
    }
    result = {
        "schema_version": "chronos2-runtime-provenance/v2",
        "image_id": image_id,
        "host": {
            "gpu": preflight.get("gpu"),
            "driver": preflight.get("driver"),
            "power_limit_w": preflight.get("power_limit_w"),
            "cuda_toolkit_nvcc": preflight.get("cuda_nvcc"),
            "cudnn_header": preflight.get("cudnn_header"),
        },
        "framework": framework,
        "model": model,
        "requested_runtime": requested,
        "exact_requested_runtime": actual == requested,
        "runtime_interpretation": (
            "PyTorch uses the CUDA and cuDNN libraries bundled by its locked wheel; "
            "the host nvcc and cuDNN header are recorded separately and do not "
            "identify the libraries used by inference."
        ),
    }
    atomic_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
