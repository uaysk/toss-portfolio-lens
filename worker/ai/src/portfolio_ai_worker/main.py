from __future__ import annotations

import argparse
import asyncio
import json
import sys

from pydantic import ValidationError

from .adapters import load_production_adapter
from .contracts import AI_REQUEST_ADAPTER, AI_RESPONSE_ADAPTER
from .server import _envelope, serve
from .service import AIService
from .settings import AISettings


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Toss Portfolio Lens offline AI forecasting worker")
    parser.add_argument("command", choices=("serve", "forecast-json", "preflight-json"), nargs="?", default="serve")
    return parser


def _runtime() -> tuple[AISettings, AIService]:
    settings = AISettings.from_env()
    adapter = load_production_adapter(settings)
    return settings, AIService(settings, adapter)


def _preflight(service: AIService) -> int:
    provenance = service.adapter.provenance
    output = {
        "schema_version": "scalping-ai-preflight/v1",
        "status": "available" if provenance.loaded else "unavailable",
        "model": provenance.model_dump(mode="json"),
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
    return 0 if provenance.loaded else 2


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


def main() -> int:
    arguments = _parser().parse_args()
    _settings, service = _runtime()
    if arguments.command == "preflight-json":
        return _preflight(service)
    if arguments.command == "forecast-json":
        return _json_request(service)
    asyncio.run(serve(service))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
