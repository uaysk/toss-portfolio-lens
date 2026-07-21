from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import signal
import ssl
import stat
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import ValidationError
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed, NegotiationError
from websockets.http11 import Request, Response

from .contracts import AI_REQUEST_ADAPTER, AI_RESPONSE_ADAPTER, REQUEST_ID_RE, AIRequest, AIResponse
from .service import AIService

TRANSPORT_VERSION = "scalping-ai-ws/v1"
SUBPROTOCOL = "scalping-ai-ws.v1"
HEALTH_PATH = "/health/live"
MINIMUM_AUTH_TOKEN_BYTES = 32
MAXIMUM_AUTH_TOKEN_BYTES = 4_096
MAXIMUM_ENVELOPE_OVERHEAD_BYTES = 16 * 1_024


class TransportError(ValueError):
    pass


class WorkerBusyError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class TransportEnvelope:
    type: Literal["request", "cancel", "status"]
    request_id: str
    payload: dict[str, Any] | None = None


@dataclass(slots=True, eq=False)
class InferenceJob:
    request: AIRequest
    future: asyncio.Future[AIResponse]
    cancelled: bool = False
    active: bool = False
    counted_as_queued: bool = True


def _safe_mode(payload: object) -> str:
    return "evaluate" if isinstance(payload, dict) and payload.get("mode") == "evaluate" else "forecast"


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise TransportError(f"duplicate JSON field: {key}")
        value[key] = item
    return value


def _invalid_constant(value: str) -> None:
    raise TransportError(f"non-finite JSON number is unsupported: {value}")


def _parse_envelope(message: str) -> TransportEnvelope:
    try:
        value = json.loads(message, object_pairs_hook=_strict_object, parse_constant=_invalid_constant)
    except json.JSONDecodeError as error:
        raise TransportError("WebSocket messages must contain valid JSON") from error
    if not isinstance(value, dict):
        raise TransportError("WebSocket messages must be JSON objects")
    if value.get("transport_version") != TRANSPORT_VERSION:
        raise TransportError("unsupported AI WebSocket transport version")
    request_id = value.get("request_id")
    if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
        raise TransportError("invalid transport request_id")
    message_type = value.get("type")
    if message_type == "request":
        if set(value) != {"transport_version", "type", "request_id", "payload"}:
            raise TransportError("request envelope contains unsupported fields")
        payload = value.get("payload")
        if not isinstance(payload, dict):
            raise TransportError("request payload must be an object")
        return TransportEnvelope(type="request", request_id=request_id, payload=payload)
    if message_type in {"cancel", "status"}:
        if set(value) != {"transport_version", "type", "request_id"}:
            raise TransportError(f"{message_type} envelope contains unsupported fields")
        return TransportEnvelope(type=message_type, request_id=request_id)
    raise TransportError("unsupported AI WebSocket message type")


def _serialize(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _atomic_token(path: Path, generate: bool) -> str:
    if generate and not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                payload = (secrets.token_urlsafe(48) + "\n").encode("utf-8")
                offset = 0
                while offset < len(payload):
                    offset += os.write(descriptor, payload[offset:])
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            temporary.unlink(missing_ok=True)
    try:
        metadata = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("AI WebSocket auth token path must be a regular file")
        token = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ValueError("AI WebSocket auth token file is unavailable") from error
    size = len(token.encode("utf-8"))
    if size < MINIMUM_AUTH_TOKEN_BYTES or size > MAXIMUM_AUTH_TOKEN_BYTES:
        raise ValueError(
            f"AI WebSocket auth token must contain {MINIMUM_AUTH_TOKEN_BYTES}~{MAXIMUM_AUTH_TOKEN_BYTES} bytes"
        )
    if any(character.isspace() for character in token):
        raise ValueError("AI WebSocket auth token cannot contain whitespace")
    return token


class InferenceScheduler:
    def __init__(self, service: AIService) -> None:
        self.service = service
        self.queue: asyncio.Queue[InferenceJob | None] = asyncio.Queue(
            maxsize=service.settings.websocket_queue_capacity
        )
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="portfolio-ai-inference")
        self.consumer: asyncio.Task[None] | None = None
        self.active: InferenceJob | None = None
        self.accepting = True
        self._queued_requests = 0

    @property
    def active_requests(self) -> int:
        return int(self.active is not None)

    @property
    def queued_requests(self) -> int:
        return self._queued_requests

    def start(self) -> None:
        if self.consumer is None:
            self.consumer = asyncio.create_task(self._consume(), name="portfolio-ai-inference-consumer")

    def enqueue(self, request: AIRequest) -> InferenceJob:
        if not self.accepting:
            raise WorkerBusyError("AI worker is shutting down")
        future: asyncio.Future[AIResponse] = asyncio.get_running_loop().create_future()
        job = InferenceJob(request=request, future=future)
        try:
            self.queue.put_nowait(job)
        except asyncio.QueueFull as error:
            raise WorkerBusyError("AI inference queue is full") from error
        self._queued_requests += 1
        return job

    def cancel(self, job: InferenceJob) -> None:
        job.cancelled = True
        if job.counted_as_queued:
            job.counted_as_queued = False
            self._queued_requests -= 1
        if not job.future.done():
            job.future.cancel()

    async def _consume(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            job = await self.queue.get()
            if job is not None and job.counted_as_queued:
                job.counted_as_queued = False
                self._queued_requests -= 1
            try:
                if job is None:
                    return
                if job.cancelled:
                    continue
                job.active = True
                self.active = job
                response = await loop.run_in_executor(self.executor, self.service.handle, job.request)
                if not job.cancelled and not job.future.done():
                    job.future.set_result(response)
            except Exception as error:
                if job is not None and not job.cancelled and not job.future.done():
                    job.future.set_result(
                        self.service.protocol_error(
                            request_id=job.request.request_id,
                            mode=job.request.mode,
                            code="INFERENCE_FAILED",
                            message=f"AI inference failed ({type(error).__name__}); no forecast was fabricated.",
                        )
                    )
            finally:
                if job is not None:
                    job.active = False
                    if self.active is job:
                        self.active = None
                self.queue.task_done()

    async def close(self) -> None:
        if not self.accepting:
            return
        self.accepting = False
        while True:
            try:
                job = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if job is not None:
                if job.counted_as_queued:
                    job.counted_as_queued = False
                    self._queued_requests -= 1
                job.cancelled = True
                if not job.future.done():
                    job.future.set_result(
                        self.service.protocol_error(
                            request_id=job.request.request_id,
                            mode=job.request.mode,
                            code="WORKER_SHUTTING_DOWN",
                            message="AI worker is shutting down before this request started.",
                        )
                    )
            self.queue.task_done()
        await self.queue.put(None)
        if self.consumer is not None:
            await self.consumer
        self.executor.shutdown(wait=True, cancel_futures=True)


class WebSocketRuntime:
    def __init__(self, service: AIService, token: str) -> None:
        self.service = service
        self.token = token
        self.scheduler = InferenceScheduler(service)
        self.connection_count = 0
        self._reserved_connections: set[ServerConnection] = set()

    def _authorized(self, request: Request) -> bool:
        try:
            header = request.headers.get("Authorization")
        except Exception:
            return False
        if not isinstance(header, str) or not header.startswith("Bearer "):
            return False
        candidate = header[7:]
        return bool(candidate) and hmac.compare_digest(candidate, self.token)

    def process_request(self, connection: ServerConnection, request: Request) -> Response | None:
        if request.path == HEALTH_PATH:
            response = connection.respond(200, '{"status":"ok"}\n')
            response.headers["Content-Type"] = "application/json; charset=utf-8"
            response.headers["Cache-Control"] = "no-store"
            return response
        if request.path != self.service.settings.websocket_path:
            return connection.respond(404, "Not Found\n")
        if not self._authorized(request):
            response = connection.respond(401, "Unauthorized\n")
            response.headers["WWW-Authenticate"] = 'Bearer realm="scalping-ai"'
            response.headers["Cache-Control"] = "no-store"
            return response
        if self.connection_count >= self.service.settings.websocket_max_connections:
            return connection.respond(503, "AI worker connection limit reached\n")
        self.connection_count += 1
        self._reserved_connections.add(connection)
        return None

    def process_response(self, connection: ServerConnection, _request: Request, response: Response) -> Response:
        if response.status_code != 101 and connection in self._reserved_connections:
            self._reserved_connections.remove(connection)
            self.connection_count -= 1
        return response

    @staticmethod
    def select_subprotocol(_connection: ServerConnection, offered: list[str]) -> str:
        if SUBPROTOCOL not in offered:
            raise NegotiationError(f"the {SUBPROTOCOL} subprotocol is required")
        return SUBPROTOCOL

    def status(self) -> dict[str, object]:
        model = self.service.adapter.provenance
        status = (
            "available"
            if model.loaded and self.scheduler.accepting
            else ("degraded" if self.scheduler.accepting else "unavailable")
        )
        return {
            "status": status,
            "model": {
                "loaded": model.loaded,
                "device": model.device,
                "model_id": model.model_id,
                "model_revision": model.model_revision,
            },
            "active_requests": self.scheduler.active_requests,
            "queued_requests": self.scheduler.queued_requests,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    async def _send(self, connection: ServerConnection, lock: asyncio.Lock, value: object) -> None:
        encoded = _serialize(value).encode("utf-8")
        if len(encoded) > self.service.settings.max_response_bytes + MAXIMUM_ENVELOPE_OVERHEAD_BYTES:
            raise ValueError("AI WebSocket envelope exceeds its configured wire limit")
        async with lock:
            await connection.send(encoded.decode("utf-8"))

    async def _send_response(
        self,
        connection: ServerConnection,
        lock: asyncio.Lock,
        request_id: str,
        response: AIResponse,
    ) -> None:
        payload = AI_RESPONSE_ADAPTER.dump_python(response, mode="json")
        if len(AI_RESPONSE_ADAPTER.dump_json(response)) > self.service.settings.max_response_bytes:
            response = self.service.protocol_error(
                request_id=request_id,
                mode=response.mode,
                code="RESPONSE_LIMIT_EXCEEDED",
                message="The response exceeded AI_MAX_RESPONSE_BYTES and was not sent.",
            )
            payload = AI_RESPONSE_ADAPTER.dump_python(response, mode="json")
        envelope = {
            "transport_version": TRANSPORT_VERSION,
            "type": "response",
            "request_id": request_id,
            "payload": payload,
        }
        await self._send(connection, lock, envelope)

    async def _complete_request(
        self,
        connection: ServerConnection,
        lock: asyncio.Lock,
        request_id: str,
        job: InferenceJob,
    ) -> None:
        try:
            response = await job.future
            if response.request_id != request_id:
                response = self.service.protocol_error(
                    request_id=request_id,
                    mode=response.mode,
                    code="RESPONSE_IDENTITY_MISMATCH",
                    message="The AI response identity did not match its transport request.",
                )
            await self._send_response(connection, lock, request_id, response)
        except (asyncio.CancelledError, ConnectionClosed):
            self.scheduler.cancel(job)
        except ValueError:
            self.scheduler.cancel(job)
            await connection.close(1011, "AI response serialization failed")

    async def handler(self, connection: ServerConnection) -> None:
        pending: dict[str, tuple[InferenceJob, asyncio.Task[None]]] = {}
        send_lock = asyncio.Lock()
        try:
            async for raw in connection:
                if not isinstance(raw, str):
                    await connection.close(1003, "text messages are required")
                    return
                if len(raw.encode("utf-8")) > (
                    self.service.settings.max_request_bytes + MAXIMUM_ENVELOPE_OVERHEAD_BYTES
                ):
                    await connection.close(1009, "message too large")
                    return
                try:
                    envelope = await asyncio.to_thread(_parse_envelope, raw)
                except TransportError as error:
                    await connection.close(1002, str(error)[:120])
                    return
                if envelope.type == "status":
                    await self._send(
                        connection,
                        send_lock,
                        {
                            "transport_version": TRANSPORT_VERSION,
                            "type": "status_response",
                            "request_id": envelope.request_id,
                            "status": self.status(),
                        },
                    )
                    continue
                if envelope.type == "cancel":
                    active = pending.pop(envelope.request_id, None)
                    if active is not None:
                        job, task = active
                        self.scheduler.cancel(job)
                        task.cancel()
                    continue
                payload = envelope.payload or {}
                mode = _safe_mode(payload)
                if len(_serialize(payload).encode("utf-8")) > self.service.settings.max_request_bytes:
                    await self._send_response(
                        connection,
                        send_lock,
                        envelope.request_id,
                        self.service.protocol_error(
                            request_id=envelope.request_id,
                            mode=mode,
                            code="REQUEST_LIMIT_EXCEEDED",
                            message="The payload exceeded AI_MAX_REQUEST_BYTES.",
                        ),
                    )
                    continue
                if envelope.request_id in pending:
                    await self._send_response(
                        connection,
                        send_lock,
                        envelope.request_id,
                        self.service.protocol_error(
                            request_id=envelope.request_id,
                            mode=mode,
                            code="DUPLICATE_REQUEST_ID",
                            message="A request with this identity is already in flight on this connection.",
                        ),
                    )
                    continue
                if len(pending) >= self.service.settings.websocket_max_in_flight:
                    await self._send_response(
                        connection,
                        send_lock,
                        envelope.request_id,
                        self.service.protocol_error(
                            request_id=envelope.request_id,
                            mode=mode,
                            code="WORKER_BUSY",
                            message="The connection reached AI_WEBSOCKET_MAX_IN_FLIGHT.",
                        ),
                    )
                    continue
                try:
                    request = await asyncio.to_thread(AI_REQUEST_ADAPTER.validate_json, _serialize(payload))
                except ValidationError as error:
                    first = error.errors(include_url=False, include_input=False)[0]
                    await self._send_response(
                        connection,
                        send_lock,
                        envelope.request_id,
                        self.service.protocol_error(
                            request_id=envelope.request_id,
                            mode=mode,
                            code="INVALID_REQUEST",
                            message=f"Request validation failed at {'.'.join(map(str, first['loc']))}: {first['msg']}",
                        ),
                    )
                    continue
                if request.request_id != envelope.request_id:
                    await self._send_response(
                        connection,
                        send_lock,
                        envelope.request_id,
                        self.service.protocol_error(
                            request_id=envelope.request_id,
                            mode=request.mode,
                            code="REQUEST_IDENTITY_MISMATCH",
                            message="Payload request_id must match the transport request_id.",
                        ),
                    )
                    continue
                try:
                    job = self.scheduler.enqueue(request)
                except WorkerBusyError as error:
                    await self._send_response(
                        connection,
                        send_lock,
                        envelope.request_id,
                        self.service.protocol_error(
                            request_id=envelope.request_id,
                            mode=request.mode,
                            code="WORKER_BUSY",
                            message=str(error),
                        ),
                    )
                    continue
                task = asyncio.create_task(
                    self._complete_request(connection, send_lock, envelope.request_id, job),
                    name=f"portfolio-ai-request-{envelope.request_id}",
                )
                pending[envelope.request_id] = (job, task)

                def completed(_task: asyncio.Task[None], request_id: str = envelope.request_id) -> None:
                    pending.pop(request_id, None)

                task.add_done_callback(completed)
        except ConnectionClosed:
            pass
        finally:
            remaining = tuple(pending.values())
            for job, task in remaining:
                self.scheduler.cancel(job)
                task.cancel()
            if remaining:
                await asyncio.gather(*(task for _job, task in remaining), return_exceptions=True)
            if connection in self._reserved_connections:
                self._reserved_connections.remove(connection)
                self.connection_count -= 1


def _tls_context(service: AIService) -> ssl.SSLContext | None:
    certificate = service.settings.websocket_tls_cert_file
    key = service.settings.websocket_tls_key_file
    if certificate is None or key is None:
        return None
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certificate, key)
    return context


async def serve_websocket(service: AIService) -> None:
    settings = service.settings
    token = _atomic_token(settings.websocket_auth_token_file, settings.websocket_generate_auth_token)
    runtime = WebSocketRuntime(service, token)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    server = await serve(
        runtime.handler,
        settings.websocket_host,
        settings.websocket_port,
        origins=[None],
        subprotocols=[SUBPROTOCOL],
        select_subprotocol=runtime.select_subprotocol,
        compression=None,
        process_request=runtime.process_request,
        process_response=runtime.process_response,
        server_header=None,
        ping_interval=settings.websocket_ping_interval_seconds,
        ping_timeout=settings.websocket_ping_timeout_seconds,
        close_timeout=settings.websocket_close_timeout_seconds,
        max_size=settings.max_request_bytes + MAXIMUM_ENVELOPE_OVERHEAD_BYTES,
        max_queue=1,
        ssl=_tls_context(service),
    )
    runtime.scheduler.start()
    installed_signals: list[signal.Signals] = []
    for candidate in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(candidate, stop.set)
            installed_signals.append(candidate)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        await stop.wait()
    except asyncio.CancelledError:
        pass
    finally:
        server.close(close_connections=False)
        await runtime.scheduler.close()
        await asyncio.gather(
            *(connection.close(1001, "AI worker shutting down") for connection in tuple(server.connections)),
            return_exceptions=True,
        )
        await server.wait_closed()
        for candidate in installed_signals:
            loop.remove_signal_handler(candidate)
