from __future__ import annotations

import asyncio
import json
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedError, InvalidStatus

from portfolio_ai_worker.main import _healthcheck
from portfolio_ai_worker.service import AIService
from portfolio_ai_worker.settings import AISettings
from portfolio_ai_worker.transport import SUBPROTOCOL, TRANSPORT_VERSION, _atomic_token, serve_websocket

from .helpers import DeterministicAdapter, bars, future, settings


def _port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _payload(request_id: str) -> dict[str, object]:
    history = bars(80)
    return {
        "schema_version": "scalping-ai/v1",
        "request_id": request_id,
        "mode": "forecast",
        "horizons_minutes": [5, 15, 30, 60],
        "quantiles": [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95],
        "seed": 7,
        "series": [
            {
                "instrument_key": "KRX:005930",
                "timezone": "Asia/Seoul",
                "input_end_at": history[-1].timestamp.isoformat(),
                "future_timestamps": [value.isoformat() for value in future(history[-1].timestamp)],
                "bars": [item.model_dump(mode="json") for item in history],
            }
        ],
    }


def _envelope(message_type: str, request_id: str, payload: object | None = None) -> str:
    value: dict[str, object] = {
        "transport_version": TRANSPORT_VERSION,
        "type": message_type,
        "request_id": request_id,
    }
    if payload is not None:
        value["payload"] = payload
    return json.dumps(value, separators=(",", ":"))


async def _wait_for_listener(port: int) -> None:
    for _ in range(100):
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
        except OSError:
            await asyncio.sleep(0.01)
            continue
        writer.write(b"GET /health/live HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        await writer.drain()
        response = await reader.read()
        writer.close()
        await writer.wait_closed()
        if response.startswith(b"HTTP/1.1 200"):
            return
    raise AssertionError("WebSocket listener did not start")


async def _worker(tmp_path, adapter=None, **updates):
    token = "t" * 48
    token_path = tmp_path / "auth" / "token"
    token_path.parent.mkdir()
    token_path.write_text(token + "\n", encoding="utf-8")
    configured = replace(
        settings(tmp_path),
        websocket_host="127.0.0.1",
        websocket_port=_port(),
        websocket_auth_token_file=token_path,
        websocket_generate_auth_token=False,
        **updates,
    ).validate()
    service = AIService(configured, adapter or DeterministicAdapter())
    task = asyncio.create_task(serve_websocket(service))
    await _wait_for_listener(configured.websocket_port)
    return configured, token, task


async def _stop(task: asyncio.Task[None]) -> None:
    task.cancel()
    await asyncio.wait_for(task, 5)


def test_auth_token_is_generated_atomically_and_validated(tmp_path) -> None:
    token_path = tmp_path / "nested" / "token"
    with ThreadPoolExecutor(max_workers=8) as executor:
        generated_values = tuple(executor.map(lambda _index: _atomic_token(token_path, True), range(32)))
    assert len(set(generated_values)) == 1
    generated = generated_values[0]
    assert len(generated.encode()) >= 32
    assert token_path.stat().st_mode & 0o777 == 0o600
    assert _atomic_token(token_path, True) == generated
    token_path.write_text("too-short", encoding="utf-8")
    with pytest.raises(ValueError, match="32~4096"):
        _atomic_token(token_path, False)


def test_websocket_settings_are_bounded_and_tls_files_are_paired(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("AI_WEBSOCKET_HOST", "0.0.0.0")
    monkeypatch.setenv("AI_WEBSOCKET_PORT", "9876")
    monkeypatch.setenv("AI_WEBSOCKET_PATH", "/ws/scalping-ai/v1")
    monkeypatch.setenv("AI_WEBSOCKET_AUTH_TOKEN_FILE", str(tmp_path / "token"))
    monkeypatch.setenv("AI_WEBSOCKET_GENERATE_AUTH_TOKEN", "true")
    configured = AISettings.from_env()
    assert configured.websocket_port == 9876
    assert configured.websocket_generate_auth_token is True

    monkeypatch.setenv("AI_WEBSOCKET_TLS_CERT_FILE", str(tmp_path / "certificate.pem"))
    with pytest.raises(ValueError, match="must be set together"):
        AISettings.from_env()

    monkeypatch.delenv("AI_WEBSOCKET_TLS_CERT_FILE")
    monkeypatch.setenv("AI_WEBSOCKET_MAX_IN_FLIGHT", "0")
    with pytest.raises(ValueError, match="between 1 and 256"):
        AISettings.from_env()

    monkeypatch.setenv("AI_WEBSOCKET_MAX_IN_FLIGHT", "4")
    monkeypatch.setenv("AI_WEBSOCKET_PATH", "/unversioned")
    with pytest.raises(ValueError, match="/ws/scalping-ai/v1"):
        AISettings.from_env()


async def _round_trip(tmp_path) -> None:
    configured, token, task = await _worker(tmp_path)
    uri = f"ws://127.0.0.1:{configured.websocket_port}{configured.websocket_path}"
    try:
        async with connect(
            uri,
            additional_headers={"Authorization": f"Bearer {token}"},
            subprotocols=[SUBPROTOCOL],
            compression=None,
        ) as websocket:
            assert websocket.subprotocol == SUBPROTOCOL
            await websocket.send(_envelope("status", "status-1"))
            status = json.loads(await websocket.recv())
            assert status == {
                "transport_version": TRANSPORT_VERSION,
                "type": "status_response",
                "request_id": "status-1",
                "status": {
                    "status": "available",
                    "model": {
                        "loaded": True,
                        "device": "cpu",
                        "model_id": "test/deterministic",
                        "model_revision": "test-only",
                    },
                    "active_requests": 0,
                    "queued_requests": 0,
                    "generated_at": status["status"]["generated_at"],
                },
            }
            await websocket.send(_envelope("request", "forecast-1", _payload("forecast-1")))
            response = json.loads(await websocket.recv())
            assert response["transport_version"] == TRANSPORT_VERSION
            assert response["type"] == "response"
            assert response["request_id"] == "forecast-1"
            assert response["payload"]["request_id"] == "forecast-1"
            assert response["payload"]["status"] == "available"

        with pytest.raises(InvalidStatus) as missing_auth:
            async with connect(uri, subprotocols=[SUBPROTOCOL], compression=None):
                pass
        assert missing_auth.value.response.status_code == 401

        with pytest.raises(InvalidStatus) as wrong_token:
            async with connect(
                uri,
                additional_headers={"Authorization": f"Bearer {'x' * 48}"},
                subprotocols=[SUBPROTOCOL],
                compression=None,
            ):
                pass
        assert wrong_token.value.response.status_code == 401

        with pytest.raises(InvalidStatus) as missing_subprotocol:
            async with connect(uri, additional_headers={"Authorization": f"Bearer {token}"}, compression=None):
                pass
        assert missing_subprotocol.value.response.status_code == 400

        with pytest.raises(InvalidStatus) as browser_origin:
            async with connect(
                uri,
                origin="https://browser.example",
                additional_headers={"Authorization": f"Bearer {token}"},
                subprotocols=[SUBPROTOCOL],
                compression=None,
            ):
                pass
        assert browser_origin.value.response.status_code == 403
    finally:
        await _stop(task)


def test_authenticated_status_and_forecast_round_trip(tmp_path) -> None:
    asyncio.run(_round_trip(tmp_path))


def test_healthcheck_uses_the_http_liveness_endpoint(tmp_path) -> None:
    async def scenario() -> None:
        configured, _token, task = await _worker(tmp_path)
        try:
            assert await asyncio.to_thread(_healthcheck, configured) == 0
        finally:
            await _stop(task)

    asyncio.run(scenario())


async def _identity_and_text_policy(tmp_path) -> None:
    configured, token, task = await _worker(tmp_path)
    uri = f"ws://127.0.0.1:{configured.websocket_port}{configured.websocket_path}"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with connect(uri, additional_headers=headers, subprotocols=[SUBPROTOCOL], compression=None) as websocket:
            await websocket.send(_envelope("request", "outer-id", _payload("inner-id")))
            response = json.loads(await websocket.recv())
            assert response["request_id"] == "outer-id"
            assert response["payload"]["request_id"] == "outer-id"
            assert response["payload"]["error"]["code"] == "REQUEST_IDENTITY_MISMATCH"

        async with connect(uri, additional_headers=headers, subprotocols=[SUBPROTOCOL], compression=None) as websocket:
            await websocket.send(b"{}")
            with pytest.raises(ConnectionClosedError) as closed:
                await websocket.recv()
            assert closed.value.rcvd.code == 1003
    finally:
        await _stop(task)


def test_request_identity_and_text_only_policy(tmp_path) -> None:
    asyncio.run(_identity_and_text_policy(tmp_path))


async def _protocol_and_payload_limits(tmp_path) -> None:
    configured, token, task = await _worker(tmp_path, max_request_bytes=1_024, websocket_max_connections=1)
    uri = f"ws://127.0.0.1:{configured.websocket_port}{configured.websocket_path}"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with connect(uri, additional_headers=headers, subprotocols=[SUBPROTOCOL], compression=None) as websocket:
            with pytest.raises(InvalidStatus) as limited:
                async with connect(uri, additional_headers=headers, subprotocols=[SUBPROTOCOL], compression=None):
                    pass
            assert limited.value.response.status_code == 503

            oversized_payload = {"request_id": "large-1", "mode": "forecast", "padding": "x" * 1_100}
            await websocket.send(_envelope("request", "large-1", oversized_payload))
            response = json.loads(await websocket.recv())
            assert response["payload"]["error"]["code"] == "REQUEST_LIMIT_EXCEEDED"

        async with connect(uri, additional_headers=headers, subprotocols=[SUBPROTOCOL], compression=None) as websocket:
            invalid = json.loads(_envelope("status", "status-version"))
            invalid["transport_version"] = "scalping-ai-ws/v2"
            await websocket.send(json.dumps(invalid))
            with pytest.raises(ConnectionClosedError) as closed:
                await websocket.recv()
            assert closed.value.rcvd.code == 1002
    finally:
        await _stop(task)


def test_protocol_connection_and_payload_limits(tmp_path) -> None:
    asyncio.run(_protocol_and_payload_limits(tmp_path))


class _SlowAdapter(DeterministicAdapter):
    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def predict_batch(self, series, *, seed):  # noqa: ANN001, ANN201
        self.started.set()
        if not self.release.wait(5):
            raise TimeoutError("test inference was not released")
        return super().predict_batch(series, seed=seed)


async def _backpressure_and_cancel(tmp_path) -> None:
    adapter = _SlowAdapter()
    configured, token, task = await _worker(
        tmp_path,
        adapter,
        websocket_queue_capacity=1,
        websocket_max_in_flight=4,
    )
    uri = f"ws://127.0.0.1:{configured.websocket_port}{configured.websocket_path}"
    try:
        async with connect(
            uri,
            additional_headers={"Authorization": f"Bearer {token}"},
            subprotocols=[SUBPROTOCOL],
            compression=None,
        ) as websocket:
            await websocket.send(_envelope("request", "slow-1", _payload("slow-1")))
            assert await asyncio.to_thread(adapter.started.wait, 2)
            await websocket.send(_envelope("status", "during-inference"))
            live = json.loads(await asyncio.wait_for(websocket.recv(), 1))
            assert live["type"] == "status_response"
            assert live["status"]["active_requests"] == 1

            await websocket.send(_envelope("request", "queued-2", _payload("queued-2")))
            await websocket.send(_envelope("request", "busy-3", _payload("busy-3")))
            busy = json.loads(await asyncio.wait_for(websocket.recv(), 1))
            assert busy["request_id"] == "busy-3"
            assert busy["payload"]["error"]["code"] == "WORKER_BUSY"

            await websocket.send(_envelope("cancel", "slow-1"))
            await websocket.send(_envelope("cancel", "queued-2"))
            await websocket.send(_envelope("status", "after-cancel"))
            after = json.loads(await asyncio.wait_for(websocket.recv(), 1))
            assert after["request_id"] == "after-cancel"
            assert after["status"]["active_requests"] == 1
            assert after["status"]["queued_requests"] == 0
            adapter.release.set()
            await asyncio.sleep(0.05)
            await websocket.send(_envelope("status", "discard-confirmed"))
            discarded = json.loads(await asyncio.wait_for(websocket.recv(), 1))
            assert discarded["request_id"] == "discard-confirmed"
    finally:
        adapter.release.set()
        await _stop(task)


def test_slow_inference_does_not_block_status_and_queue_is_bounded(tmp_path) -> None:
    asyncio.run(_backpressure_and_cancel(tmp_path))
