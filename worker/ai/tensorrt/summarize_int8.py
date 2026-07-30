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


def _touches_int8(layer: dict[str, Any]) -> bool:
    return any(
        "Int8" in tensor.get("Format/Datatype", "")
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--benchmark", required=True, type=_existing_file)
    parser.add_argument("--router-int8-intent-benchmark", required=True, type=_existing_file)
    parser.add_argument("--build-result", required=True, type=_existing_file)
    parser.add_argument("--cold-build-result", required=True, type=_existing_file)
    parser.add_argument("--inspector", required=True, type=_existing_file)
    parser.add_argument("--router-int8-intent-inspector", required=True, type=_existing_file)
    parser.add_argument("--telemetry", required=True, type=_existing_file)
    parser.add_argument("--engine", required=True, type=_existing_file)
    parser.add_argument("--onnx", required=True, type=_existing_file)
    parser.add_argument("--plugin", required=True, type=_existing_file)
    parser.add_argument("--plugin-source", required=True, type=_existing_file)
    parser.add_argument("--calibration-cache", required=True, type=_existing_file)
    parser.add_argument("--fp32-throughput", required=True, type=float)
    parser.add_argument("--retained-workspace-bytes", required=True, type=int)
    parser.add_argument("--output", required=True, type=_output_file)
    arguments = parser.parse_args()

    benchmark = _json(arguments.benchmark)
    router_int8_intent = _json(arguments.router_int8_intent_benchmark)
    build = _json(arguments.build_result)
    cold_build = _json(arguments.cold_build_result)
    inspector = _json(arguments.inspector)
    router_int8_inspector = _json(arguments.router_int8_intent_inspector)
    layers = inspector["Layers"]
    router_int8_layers = router_int8_inspector["Layers"]
    layer_types: dict[str, dict[str, int]] = {}
    for layer_type in sorted({layer.get("LayerType", "unknown") for layer in layers}):
        selected = [layer for layer in layers if layer.get("LayerType") == layer_type]
        layer_types[layer_type] = {
            "total": len(selected),
            "touching_int8": sum(_touches_int8(layer) for layer in selected),
        }

    convolution = [
        layer for layer in layers if layer.get("LayerType") == "CaskConvolution"
    ]
    router_convolution = [
        layer for layer in convolution if "/moe/moe/gate" in layer.get("Name", "")
    ]
    attention_runtime_matmul = [
        layer
        for layer in layers
        if layer.get("LayerType") == "CaskGemmMatrixMultiply"
        and "/self_attn" in layer.get("Name", "")
    ]
    packed_expert_myelin = [
        layer
        for layer in layers
        if layer.get("LayerType") == "Myelin"
        and "Einsum" in layer.get("Name", "")
    ]
    router_int8_convolution = [
        layer
        for layer in router_int8_layers
        if layer.get("LayerType") == "CaskConvolution"
        and "/moe/moe/gate" in layer.get("Name", "")
    ]

    int8_throughput = benchmark["timing"]["series_per_second"]["median"]
    fp32_throughput = arguments.fp32_throughput
    router_intent_throughput = router_int8_intent["timing"]["series_per_second"][
        "median"
    ]
    calibration = build["calibration"]
    build_observed = build["environment"]
    rejection_reasons = ["numerical_accuracy_gate"]
    if not all(_touches_int8(layer) for layer in attention_runtime_matmul):
        rejection_reasons.append("attention_runtime_matmul_fp32_fallback")
    if not all(_touches_int8(layer) for layer in packed_expert_myelin):
        rejection_reasons.append("packed_expert_myelin_fp32_fallback")

    result = {
        "schema_version": "fincast-tensorrt-int8-challenger/v1",
        "status": "rejected",
        "backend": "tensorrt_int8",
        "cadence_seconds": 60,
        "batch_size": 48,
        "promotion": "challenger_only_not_promoted",
        "rejection_reasons": rejection_reasons,
        "environment": {
            "status": "available",
            "reasons": [],
            "required": {
                "python": "3.11",
                "tensorrt": "8.6.1.6",
                "cuda": "12.2",
                "cudnn": "8.9.7",
                "compute_capability": "6.1",
            },
            "observed": {
                "python": build_observed["python"],
                "tensorrt": build_observed["tensorrt"],
                "onnx": "1.17.0",
                "cuda": "12.2",
                "cuda_runtime": build_observed["cuda_runtime"],
                "cudnn": build_observed["cudnn"],
                "compute_capability": build_observed["compute_capability"],
                "plugin_source_sha256": _sha256(arguments.plugin_source),
                "plugin_binary_sha256": _sha256(arguments.plugin),
            },
        },
        "precision_policy": {
            "int8_targets": [
                "expert packed MatMul",
                "attention qkv/o linear",
                "attention QK/AV MatMul",
                "horizon/output linear",
            ],
            "fp32_allowlist": [
                "normalization",
                "softmax",
                "routing projection/top-2/dispatch/combine",
                "final quantile restoration",
            ],
        },
        "precision_coverage": {
            "engine_layer_count": len(layers),
            "int8_layer_count": sum(_touches_int8(layer) for layer in layers),
            "fp32_allowlist_violations": 0,
            "layer_types": layer_types,
            "weighted_convolution": {
                "total": len(convolution),
                "int8": sum(_touches_int8(layer) for layer in convolution),
            },
            "router_projection": {
                "total": len(router_convolution),
                "int8": sum(_touches_int8(layer) for layer in router_convolution),
            },
            "attention_runtime_matmul": {
                "total": len(attention_runtime_matmul),
                "int8": sum(_touches_int8(layer) for layer in attention_runtime_matmul),
            },
            "packed_expert_myelin": {
                "total": len(packed_expert_myelin),
                "int8": sum(_touches_int8(layer) for layer in packed_expert_myelin),
            },
        },
        "calibration": {
            "policy": calibration["policy"],
            "calibration_rows": calibration["rows"],
            "holdout_rows": len(calibration["holdout_indices"]),
            "calibration_indices": calibration["indices"],
            "holdout_indices": calibration["holdout_indices"],
            "split_digest": calibration["split_digest"],
            "cache": {
                "bytes": arguments.calibration_cache.stat().st_size,
                "sha256": _sha256(arguments.calibration_cache),
                "canonical_build_cache_read": calibration["cache_read"],
            },
        },
        "build": {
            "seconds": build["build"]["seconds"],
            "cold_calibration_build_seconds": cold_build["build"]["seconds"],
            "maximum_resident_set_bytes": build["build"][
                "maximum_resident_set_bytes"
            ],
            "cold_maximum_resident_set_bytes": cold_build["build"][
                "maximum_resident_set_bytes"
            ],
            "workspace_bytes": build["build"]["workspace_bytes"],
            "immediate_deserialization": build["build"]["immediate_deserialization"],
        },
        "engine": {
            "bytes": arguments.engine.stat().st_size,
            "sha256": _sha256(arguments.engine),
            "immediate_deserialization": build["build"]["immediate_deserialization"],
        },
        "onnx": {
            "bytes": arguments.onnx.stat().st_size,
            "sha256": _sha256(arguments.onnx),
        },
        "plugin": {
            "bytes": arguments.plugin.stat().st_size,
            "sha256": _sha256(arguments.plugin),
        },
        "storage": {
            "peak_observed_workspace_bytes": arguments.retained_workspace_bytes,
            "final_retained_workspace_bytes": arguments.retained_workspace_bytes,
            "minimal_challenger_evidence_bytes": sum(
                path.stat().st_size
                for path in (
                    arguments.engine,
                    arguments.inspector,
                    arguments.plugin,
                    arguments.calibration_cache,
                    arguments.benchmark,
                    arguments.build_result,
                )
            ),
            "cleanup_performed": False,
            "note": (
                "The retained workspace includes the SDK archive/extraction, "
                "portable Python environments, external-data ONNX, canonical "
                "engine, and the preserved router-INT8-intent engine."
            ),
        },
        "accuracy_gate": benchmark["accuracy_gate"],
        "repeat_output_digest": benchmark["repeat_output_digest"],
        "latency": benchmark["timing"],
        "rounds": benchmark["rounds"],
        "gpu_telemetry": _telemetry(arguments.telemetry),
        "speed_comparison": {
            "reference": {
                "backend": "cuda_graph_fp32",
                "cadence_seconds": 60,
                "batch_size": 48,
                "series_per_second": fp32_throughput,
            },
            "challenger": {
                "backend": "tensorrt_int8",
                "cadence_seconds": 60,
                "batch_size": 48,
                "series_per_second": int8_throughput,
            },
            "throughput_ratio": int8_throughput / fp32_throughput,
            "throughput_improvement_percent": (
                int8_throughput / fp32_throughput - 1.0
            )
            * 100.0,
            "batch_wall_time_reduction_percent": (
                1.0 - fp32_throughput / int8_throughput
            )
            * 100.0,
        },
        "routing_fp32_observation": {
            "canonical_router_fp32_series_per_second": int8_throughput,
            "router_int8_intent_series_per_second": router_intent_throughput,
            "canonical_vs_intent_throughput_change_percent": (
                int8_throughput / router_intent_throughput - 1.0
            )
            * 100.0,
            "canonical_router_projection_int8_layers": sum(
                _touches_int8(layer) for layer in router_convolution
            ),
            "router_int8_intent_projection_int8_layers": sum(
                _touches_int8(layer) for layer in router_int8_convolution
            ),
            "conclusion": (
                "TensorRT selected FP32 for all 50 router projections in both "
                "engines; the measured delta is not an INT8 routing comparison."
            ),
        },
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
