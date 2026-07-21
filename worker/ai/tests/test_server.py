from __future__ import annotations

import asyncio
import json

from portfolio_ai_worker.contracts import AI_RESPONSE_ADAPTER, ForecastRequest, ForecastSeries
from portfolio_ai_worker.server import _handle_client
from portfolio_ai_worker.service import AIService

from .helpers import DeterministicAdapter, bars, future, settings


async def _read_frame(reader: asyncio.StreamReader) -> bytes:
    length = int.from_bytes(await reader.readexactly(4), "big")
    return await reader.readexactly(length)


class _MemoryWriter:
    def __init__(self) -> None:
        self.buffer = bytearray()
        self.closed = False

    def write(self, value: bytes) -> None:
        self.buffer.extend(value)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None


def _request() -> ForecastRequest:
    history = bars(80)
    return ForecastRequest(
        schema_version="scalping-ai/v1",
        request_id="uds-1",
        mode="forecast",
        series=(
            ForecastSeries(
                instrument_key="KRX:005930",
                timezone="Asia/Seoul",
                input_end_at=history[-1].timestamp,
                future_timestamps=future(history[-1].timestamp),
                bars=history,
            ),
        ),
    )


async def _round_trip(tmp_path) -> None:
    configured = settings(tmp_path)
    service = AIService(configured, DeterministicAdapter())
    reader = asyncio.StreamReader()
    writer = _MemoryWriter()
    valid = _request().model_dump_json().encode()
    invalid_value = json.loads(valid)
    invalid_value["horizons_minutes"] = [1, 5, 15, 30]
    invalid = json.dumps(invalid_value, separators=(",", ":")).encode()
    reader.feed_data(len(valid).to_bytes(4, "big") + valid)
    reader.feed_data(len(invalid).to_bytes(4, "big") + invalid)
    reader.feed_eof()
    await _handle_client(reader, writer, service)  # type: ignore[arg-type]

    output = asyncio.StreamReader()
    output.feed_data(bytes(writer.buffer))
    output.feed_eof()
    response = AI_RESPONSE_ADAPTER.validate_json(await _read_frame(output))
    assert response.request_id == "uds-1"
    assert response.status == "available"
    rejected = AI_RESPONSE_ADAPTER.validate_json(await _read_frame(output))
    assert rejected.status == "unavailable"
    assert rejected.error is not None
    assert rejected.error.code == "INVALID_REQUEST"
    assert writer.closed is True


def test_four_byte_big_endian_framing_and_reusable_connection(tmp_path) -> None:
    asyncio.run(_round_trip(tmp_path))
