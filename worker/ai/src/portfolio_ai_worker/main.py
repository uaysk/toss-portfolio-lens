from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import socket
import ssl
import sys

from pydantic import ValidationError

from .adapters import load_production_model_suite
from .contracts import AI_REQUEST_ADAPTER, AI_RESPONSE_ADAPTER
from .fincast import FinCastAdapter
from .server import _envelope, serve
from .service import AIService
from .settings import AISettings


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Toss Portfolio Lens offline AI forecasting worker")
    parser.add_argument(
        "command",
        choices=(
            "serve",
            "forecast-json",
            "preflight-json",
            "healthcheck",
            "raw-generate",
            "raw-benchmark",
            "raw-compatibility",
            "raw-tensorrt-challenger",
            "raw-tensorrt-export",
        ),
        nargs="?",
        default="serve",
    )
    parser.add_argument("--job", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument(
        "--backend",
        choices=(
            "eager",
            "no_padding",
            "batched_experts",
            "cuda_graph",
            "tensorrt_fp32",
            "pipeline_eager",
            "worker_local",
            "gpu_gather",
        ),
    )
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--warmups", type=int, default=10)
    parser.add_argument("--iterations", type=int, default=30)
    parser.add_argument("--plugin-source", type=Path)
    parser.add_argument("--provenance", type=Path)
    return parser


def _runtime() -> tuple[AISettings, AIService]:
    settings = AISettings.from_env()
    suite = load_production_model_suite(settings)
    return settings, AIService(settings, suite.primary, suite.runs)


def _healthcheck(settings: AISettings) -> int:
    host = settings.websocket_host
    if host in {"0.0.0.0", "::", ""}:
        host = "::1" if host == "::" else "127.0.0.1"
    try:
        connection = socket.create_connection((host, settings.websocket_port), timeout=2)
        if settings.websocket_tls_cert_file is not None:
            # This is a loopback-only liveness probe. Remote clients still enforce
            # the configured certificate trust and identity checks.
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            connection = context.wrap_socket(connection, server_hostname=host)
        with connection:
            request = (
                f"GET /health/live HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
            )
            connection.sendall(request.encode("ascii"))
            response = connection.recv(256)
        return 0 if response.startswith(b"HTTP/1.1 200") else 2
    except (OSError, ssl.SSLError):
        return 2


def _preflight(service: AIService) -> int:
    provenance = service.adapter.provenance
    model_bindings = service.model_run_adapters
    models = [
        {
            "role": binding.role,
            "expected_model_id": binding.expected_model_id,
            "degraded": (
                binding.adapter.provenance.loaded and binding.adapter.provenance.model_id != binding.expected_model_id
            ),
            "model": binding.adapter.provenance.model_dump(mode="json"),
        }
        for binding in model_bindings
    ]
    all_loaded = bool(models) and all(binding.adapter.provenance.loaded for binding in model_bindings)
    any_degraded = any(item["degraded"] for item in models)
    status = (
        "available"
        if all_loaded and not any_degraded
        else "degraded"
        if any(binding.adapter.provenance.loaded for binding in model_bindings)
        else "unavailable"
    )
    output = {
        "schema_version": "scalping-ai-preflight/v1",
        "status": status,
        "model": provenance.model_dump(mode="json"),
        "models": models,
        "features": {
            "cross_request_microbatch": service.settings.cross_request_microbatch,
        },
        "limits": {
            "microbatch_size": service.settings.microbatch_size,
            "max_series": service.settings.max_series,
            "max_evaluation_origins": service.settings.max_evaluation_origins,
            "min_context_bars": service.settings.min_context_bars,
            "max_context_bars": service.settings.max_context_bars,
            "max_request_bytes": service.settings.max_request_bytes,
            "max_response_bytes": service.settings.max_response_bytes,
        },
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0 if status == "available" else 2


def _json_request(service: AIService) -> int:
    payload = sys.stdin.buffer.read(service.settings.max_request_bytes + 1)
    if len(payload) > service.settings.max_request_bytes:
        response = service.protocol_error(
            code="REQUEST_LIMIT_EXCEEDED", message="stdin request exceeds the configured limit"
        )
    else:
        request_id, mode = _envelope(payload)
        try:
            request = AI_REQUEST_ADAPTER.validate_json(payload)
        except ValidationError as error:
            first = error.errors(include_url=False, include_input=False)[0]
            response = service.protocol_error(
                request_id=request_id,
                mode=mode,
                message=f"Request validation failed: {first['msg']}",
            )
        else:
            response = service.handle(request)
    sys.stdout.buffer.write(AI_RESPONSE_ADAPTER.dump_json(response) + b"\n")
    return 0 if response.error is None else 2


def _raw_generate(arguments: argparse.Namespace) -> int:
    if arguments.job is None or arguments.output is None:
        raise ValueError("raw-generate requires --job and --output")
    settings = AISettings.from_env()
    suite = load_production_model_suite(settings)
    if settings.model_lane == "chronos_2":
        from .chronos2 import Chronos2Adapter
        from .chronos2_generator import generate_chronos2_predictions

        if not isinstance(suite.primary, Chronos2Adapter):
            detail = suite.primary.provenance.memory_status or "unavailable"
            raise RuntimeError(f"the pinned Chronos-2 adapter is unavailable ({detail})")
        result = generate_chronos2_predictions(
            suite.primary,
            manifest_path=arguments.job,
            output_dir=arguments.output,
            resume=bool(arguments.resume),
            backend=arguments.backend,
            variate_batch_size=arguments.batch_size,
        )
        payload = {
            "schema_version": "chronos2-raw-generation-result/v1",
            "output_manifest": str(result.output_manifest),
            "backend": result.backend,
            "variate_batch_size": result.variate_batch_size,
            "task_batch_size": result.task_batch_size,
            "completed_rows": result.completed_rows,
            "output_digest": result.output_digest,
            "resumed_from_row": result.resumed_from_row,
            "graph_capture_ms": result.graph_capture_ms,
        }
    elif settings.model_lane == "fincast":
        from .raw_generator import generate_raw_predictions

        if not isinstance(suite.primary, FinCastAdapter):
            detail = suite.primary.provenance.memory_status or "unavailable"
            raise RuntimeError(f"the pinned FinCast adapter is unavailable ({detail})")
        result = generate_raw_predictions(
            suite.primary,
            manifest_path=arguments.job,
            output_dir=arguments.output,
            resume=bool(arguments.resume),
            backend=arguments.backend,
            batch_size=arguments.batch_size,
        )
        payload = {
            "schema_version": "fincast-raw-generation-result/v1",
            "output_manifest": str(result.output_manifest),
            "backend": result.backend,
            "batch_size": result.batch_size,
            "completed_rows": result.completed_rows,
            "output_digest": result.output_digest,
            "resumed_from_row": result.resumed_from_row,
            "fallback_reason": result.fallback_reason,
        }
    else:
        raise ValueError(
            "raw-generate requires AI_MODEL_LANE=fincast or chronos_2"
        )
    sys.stdout.write(
        json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )
    return 0


def _raw_benchmark(arguments: argparse.Namespace) -> int:
    if (
        arguments.job is None
        or arguments.output is None
        or arguments.backend is None
        or arguments.batch_size is None
    ):
        raise ValueError(
            "raw-benchmark requires --job, --output, --backend, and --batch-size"
        )
    settings = AISettings.from_env()
    if settings.model_lane == "chronos_2":
        from .chronos2_benchmark import (
            Chronos2BenchmarkProtocol,
            run_chronos2_benchmark_to_file,
        )

        result = run_chronos2_benchmark_to_file(
            manifest_path=arguments.job,
            output_path=arguments.output,
            backend=arguments.backend,
            variate_batch_size=arguments.batch_size,
            protocol=Chronos2BenchmarkProtocol(
                rounds=arguments.rounds,
                warmups=arguments.warmups,
                iterations=arguments.iterations,
            ),
        )
        batch_payload = {
            "variate_batch_size": result["variate_batch_size"],
            "task_batch_size": result.get("task_batch_size"),
        }
    else:
        from .raw_benchmark import BenchmarkProtocol, run_benchmark_to_file

        result = run_benchmark_to_file(
            manifest_path=arguments.job,
            output_path=arguments.output,
            backend=arguments.backend,
            batch_size=arguments.batch_size,
            protocol=BenchmarkProtocol(
                rounds=arguments.rounds,
                warmups=arguments.warmups,
                iterations=arguments.iterations,
            ),
        )
        batch_payload = {"batch_size": result["batch_size"]}
    sys.stdout.write(
        json.dumps(
            {
                "schema_version": result["schema_version"],
                "status": result["status"],
                "backend": result["backend"],
                **batch_payload,
                "output": str(arguments.output),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )
    return 0


def _raw_compatibility(arguments: argparse.Namespace) -> int:
    if arguments.job is None or arguments.output is None:
        raise ValueError("raw-compatibility requires --job and --output")
    from .raw_compatibility import write_raw_transport_compatibility

    settings = AISettings.from_env()
    if settings.model_lane != "fincast":
        raise ValueError("raw-compatibility requires AI_MODEL_LANE=fincast")
    suite = load_production_model_suite(settings)
    if not isinstance(suite.primary, FinCastAdapter):
        detail = suite.primary.provenance.memory_status or "unavailable"
        raise RuntimeError(f"the pinned FinCast adapter is unavailable ({detail})")
    result = write_raw_transport_compatibility(
        suite.primary,
        manifest_path=arguments.job,
        output_path=arguments.output,
    )
    sys.stdout.write(
        json.dumps(
            {
                "schema_version": result["schema_version"],
                "status": result["status"],
                "exact_digest": result["exact_digest"],
                "output": str(arguments.output),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )
    return 0


def _bounded_json_object(path: Path, *, maximum_bytes: int = 1 << 20) -> dict[str, object]:
    if not path.is_absolute() or path.resolve(strict=True) != path or path.is_symlink():
        raise ValueError("JSON evidence path must be an absolute normalized regular file")
    if path.stat().st_size > maximum_bytes:
        raise ValueError("JSON evidence exceeds its bounded size")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("JSON evidence must contain an object")
    return value


def _raw_tensorrt_challenger(arguments: argparse.Namespace) -> int:
    if (
        arguments.job is None
        or arguments.output is None
        or arguments.plugin_source is None
        or arguments.provenance is None
    ):
        raise ValueError(
            "raw-tensorrt-challenger requires --job, --output, --plugin-source, "
            "and --provenance"
        )
    from .tensorrt_challenger import run_tensorrt_challenger_probe

    evidence = _bounded_json_object(arguments.provenance)
    raw_provenance = evidence.get("provenance")
    if not isinstance(raw_provenance, dict):
        raise ValueError("TensorRT provenance evidence has no provenance object")
    result = run_tensorrt_challenger_probe(
        manifest_path=arguments.job,
        output_path=arguments.output,
        plugin_source=arguments.plugin_source,
        model_provenance=raw_provenance,
    )
    sys.stdout.write(
        json.dumps(
            {
                "schema_version": result["schema_version"],
                "status": result["status"],
                "reasons": result["environment"]["reasons"],
                "output": str(arguments.output),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n"
    )
    return 0


def _raw_tensorrt_export(arguments: argparse.Namespace) -> int:
    if (
        arguments.job is None
        or arguments.output is None
        or arguments.batch_size is None
    ):
        raise ValueError("raw-tensorrt-export requires --job, --output, and --batch-size")
    from .tensorrt_export import export_static_onnx_from_manifest

    result = export_static_onnx_from_manifest(
        settings=AISettings.from_env(),
        manifest_path=arguments.job,
        output_path=arguments.output,
        batch_size=arguments.batch_size,
    )
    sys.stdout.write(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n"
    )
    return 0


def main() -> int:
    arguments = _parser().parse_args()
    if arguments.command == "healthcheck":
        return _healthcheck(AISettings.from_env())
    if arguments.command == "raw-generate":
        return _raw_generate(arguments)
    if arguments.command == "raw-benchmark":
        return _raw_benchmark(arguments)
    if arguments.command == "raw-compatibility":
        return _raw_compatibility(arguments)
    if arguments.command == "raw-tensorrt-challenger":
        return _raw_tensorrt_challenger(arguments)
    if arguments.command == "raw-tensorrt-export":
        return _raw_tensorrt_export(arguments)
    _settings, service = _runtime()
    if arguments.command == "preflight-json":
        return _preflight(service)
    if arguments.command == "forecast-json":
        return _json_request(service)
    asyncio.run(serve(service))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
