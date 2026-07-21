from __future__ import annotations

import asyncio
import json
import socket
import stat
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .contracts import AI_REQUEST_ADAPTER, AI_RESPONSE_ADAPTER, REQUEST_ID_RE
from .service import AIService


async def _read_frame(reader: asyncio.StreamReader, maximum: int) -> bytes | None:
    try:
        header = await reader.readexactly(4)
    except asyncio.IncompleteReadError as error:
        if not error.partial:
            return None
        raise ValueError("truncated frame header") from error
    length = int.from_bytes(header, byteorder="big", signed=False)
    if length < 1 or length > maximum:
        raise ValueError(f"frame length must be between 1 and {maximum} bytes")
    try:
        return await reader.readexactly(length)
    except asyncio.IncompleteReadError as error:
        raise ValueError("truncated frame body") from error


def _envelope(payload: bytes) -> tuple[str, str]:
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


async def _write_response(
    writer: asyncio.StreamWriter,
    service: AIService,
    response: Any,
) -> None:
    payload = AI_RESPONSE_ADAPTER.dump_json(response)
    if len(payload) > service.settings.max_response_bytes:
        payload = AI_RESPONSE_ADAPTER.dump_json(
            service.protocol_error(
                request_id=response.request_id,
                mode=response.mode,
                code="RESPONSE_LIMIT_EXCEEDED",
                message="The response exceeded AI_MAX_RESPONSE_BYTES and was not sent.",
            )
        )
    writer.write(len(payload).to_bytes(4, byteorder="big", signed=False))
    writer.write(payload)
    await writer.drain()


async def _handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, service: AIService) -> None:
    try:
        while True:
            try:
                payload = await _read_frame(reader, service.settings.max_request_bytes)
            except ValueError as error:
                await _write_response(
                    writer,
                    service,
                    service.protocol_error(code="INVALID_FRAME", message=str(error)),
                )
                return
            if payload is None:
                return
            request_id, mode = _envelope(payload)
            try:
                request = AI_REQUEST_ADAPTER.validate_json(payload)
            except ValidationError as error:
                first = error.errors(include_url=False, include_input=False)[0]
                message = f"Request validation failed at {'.'.join(map(str, first['loc']))}: {first['msg']}"
                response = service.protocol_error(
                    request_id=request_id,
                    mode=mode,
                    code="INVALID_REQUEST",
                    message=message,
                )
            else:
                # GPU inference is intentionally serialized on the server event-loop thread. CUDA model state is not
                # moved between executor threads, and other clients remain queued behind the configured microbatches.
                response = service.handle(request)
            await _write_response(writer, service, response)
    finally:
        writer.close()
        await writer.wait_closed()


def _prepare_socket(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        return
    mode = path.lstat().st_mode
    if not stat.S_ISSOCK(mode):
        raise RuntimeError(f"refusing to replace non-socket path: {path}")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.2)
    try:
        probe.connect(str(path))
    except (ConnectionRefusedError, FileNotFoundError, TimeoutError):
        path.unlink(missing_ok=True)
    else:
        raise RuntimeError(f"AI worker socket is already accepting connections: {path}")
    finally:
        probe.close()


async def serve(service: AIService) -> None:
    path = service.settings.socket_path
    _prepare_socket(path)
    server = await asyncio.start_unix_server(
        lambda reader, writer: _handle_client(reader, writer, service),
        path=str(path),
    )
    path.chmod(0o660)
    try:
        async with server:
            await server.serve_forever()
    finally:
        if path.exists() and stat.S_ISSOCK(path.lstat().st_mode):
            path.unlink(missing_ok=True)
