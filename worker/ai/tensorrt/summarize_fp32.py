#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
from typing import Any


def _existing_file(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.resolve(strict=True) != path
        or path.is_symlink()
        or not path.is_file()
    ):
        raise argparse.ArgumentTypeError("input must be an absolute regular file")
    return path


def _output_file(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=False) != path or path.is_symlink():
        raise argparse.ArgumentTypeError("output must be an absolute normalized path")
    return path


def _json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"expected a JSON object: {path}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _touches(layer: dict[str, Any], marker: str) -> bool:
    return any(
        marker in tensor.get("Format/Datatype", "")
        for collection in ("Inputs", "Outputs")
        for tensor in layer.get(collection, [])
    )


def _telemetry(path: Path) -> dict[str, Any]:
    with path.open(newline="", encoding="utf-8") as source:
        rows = list(csv.DictReader(source))
    fields = {
        "gpu_utilization_percent": "utilization_gpu_pct",
        "memory_used_mib": "memory_used_mib",
        "memory_free_mib": "memory_free_mib",
        "power_watts": "power_w",
        "temperature_celsius": "temperature_c",
    }
    result: dict[str, Any] = {"samples": len(rows)}
    for label, field in fields.items():
        values = [float(row[field]) for row in rows if row.get(field, "").strip()]
        result[label] = (
            {
                "minimum": min(values),
                "mean": sum(values) / len(values),
                "maximum": max(values),
            }
            if values
            else None
        )
    return result


def _comparison(candidate: float, reference: float) -> dict[str, float]:
    ratio = candidate / reference
    return {
        "throughput_ratio": ratio,
        "throughput_improvement_percent": (ratio - 1.0) * 100.0,
        "batch_wall_time_reduction_percent": (1.0 - reference / candidate) * 100.0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--benchmark", required=True, type=_existing_file)
    parser.add_argument("--build-result", required=True, type=_existing_file)
    parser.add_argument("--inspector", required=True, type=_existing_file)
    parser.add_argument("--telemetry", required=True, type=_existing_file)
    parser.add_argument("--engine", required=True, type=_existing_file)
    parser.add_argument("--pytorch-fp32-throughput", required=True, type=float)
    parser.add_argument("--tensorrt-int8-throughput", required=True, type=float)
    parser.add_argument("--output", required=True, type=_output_file)
    arguments = parser.parse_args()

    benchmark = _json(arguments.benchmark)
    build = _json(arguments.build_result)
    inspector = _json(arguments.inspector)
    layers = inspector["Layers"]
    fp32_throughput = benchmark["timing"]["series_per_second"]["median"]
    int8_layers = sum(_touches(layer, "Int8") for layer in layers)
    fp16_layers = sum(_touches(layer, "Half") for layer in layers)
    if int8_layers or fp16_layers:
        raise RuntimeError(
            f"strict FP32 inspector found lower precision: "
            f"int8={int8_layers}, fp16={fp16_layers}"
        )
    if benchmark["status"] != "passed":
        raise RuntimeError("TensorRT FP32 benchmark did not pass")

    result = {
        "schema_version": "fincast-tensorrt-fp32-challenger/v1",
        "status": "passed",
        "backend": "tensorrt_fp32",
        "cadence_seconds": benchmark["cadence_seconds"],
        "batch_size": benchmark["batch_size"],
        "promotion": "measured_comparator_not_selected_as_offline_default",
        "environment": build["environment"],
        "precision": {
            "constraints": build["network"]["precision_constraints"],
            "tf32": False,
            "fp16": False,
            "int8": False,
            "fp32_constrained_layer_count": build["network"][
                "fp32_constrained_layer_count"
            ],
            "engine_layer_count": len(layers),
            "inspector_int8_layer_count": int8_layers,
            "inspector_fp16_layer_count": fp16_layers,
            "shape_tensors": "int32",
        },
        "build": build["build"],
        "engine": {
            "bytes": arguments.engine.stat().st_size,
            "sha256": _sha256(arguments.engine),
        },
        "accuracy_gate": benchmark["accuracy_gate"],
        "repeat_output_digest": benchmark["repeat_output_digest"],
        "holdout": benchmark["holdout"],
        "latency": benchmark["timing"],
        "rounds": benchmark["rounds"],
        "gpu_telemetry": _telemetry(arguments.telemetry),
        "speed_comparison": {
            "pytorch_cuda_graph_fp32": {
                "reference_series_per_second": arguments.pytorch_fp32_throughput,
                "candidate_series_per_second": fp32_throughput,
                **_comparison(fp32_throughput, arguments.pytorch_fp32_throughput),
            },
            "tensorrt_int8_vs_tensorrt_fp32": {
                "reference_series_per_second": fp32_throughput,
                "candidate_series_per_second": arguments.tensorrt_int8_throughput,
                **_comparison(arguments.tensorrt_int8_throughput, fp32_throughput),
            },
        },
        "diagnosis": (
            "The strict TensorRT FP32 engine passes the holdout gate, so the ONNX "
            "lowering and routing plugin are compatible with the PyTorch reference. "
            "The rejected TensorRT INT8 result is attributable to quantization, not "
            "the transport-free TensorRT execution path itself."
        ),
    }

    arguments.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = arguments.output.with_suffix(arguments.output.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(result, output, indent=2, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, arguments.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
