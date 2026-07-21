from __future__ import annotations

import json
from typing import Any

from .contracts import REQUEST_ID_RE
from .service import AIService


def _envelope(payload: bytes) -> tuple[str, str]:
    """Extract a safe identity for the stdin compatibility command."""
    try:
        value: Any = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return "invalid-request", "forecast"
    if not isinstance(value, dict):
        return "invalid-request", "forecast"
    request_id = value.get("request_id")
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        request_id = "invalid-request"
    mode = "evaluate" if value.get("mode") == "evaluate" else "forecast"
    return request_id, mode


async def serve(service: AIService) -> None:
    from .transport import serve_websocket

    await serve_websocket(service)
