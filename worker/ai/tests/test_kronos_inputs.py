from __future__ import annotations

import struct
import math
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

import portfolio_ai_worker.adapters as adapters
from portfolio_ai_worker.adapters import InferenceSeries, KronosAdapter, RuntimeDevice
from portfolio_ai_worker.contracts import PriceBar


class _Series(list[Any]):
    @property
    def dt(self) -> SimpleNamespace:
        return SimpleNamespace(tz=self[0].tzinfo if self else None)


class _DataFrame:
    def __init__(self, rows: list[dict[str, float]]) -> None:
        self._rows = rows
        self.columns = tuple(rows[0]) if rows else ()

    def __contains__(self, column: str) -> bool:
        return column in self.columns

    def __getitem__(self, column: str) -> list[float]:
        return [row[column] for row in self._rows]

    def iterrows(self) -> Any:
        return iter(enumerate(self._rows))


@pytest.fixture(autouse=True)
def _fake_optional_model_dependencies(monkeypatch: pytest.MonkeyPatch) -> None:
    real_import = adapters.importlib.import_module

    def import_module(name: str) -> Any:
        if name == "numpy":
            return SimpleNamespace(isfinite=math.isfinite)
        if name == "pandas":
            return SimpleNamespace(DataFrame=_DataFrame, Series=_Series)
        return real_import(name)

    monkeypatch.setattr(adapters.importlib, "import_module", import_module)


class _PredictorSpy:
    def __init__(self) -> None:
        self.call: dict[str, Any] | None = None

    def predict_batch(self, **kwargs: Any) -> list[Any]:
        self.call = kwargs
        return list(kwargs["df_list"])


def _adapter(spy: _PredictorSpy) -> KronosAdapter:
    adapter = object.__new__(KronosAdapter)
    adapter._predictor = spy
    adapter._sample_count = 1
    adapter._runtime = RuntimeDevice(
        "cpu",
        SimpleNamespace(
            manual_seed=lambda _seed: None,
            inference_mode=lambda: nullcontext(),
        ),
    )
    return adapter


def _bar(
    timestamp: datetime,
    *,
    ordinal: int,
    volume: float | None = None,
    amount: float | None = None,
) -> PriceBar:
    close = 100.125 + ordinal * 0.25
    return PriceBar(
        timestamp=timestamp,
        open=close - 0.125,
        high=close + 0.5,
        low=close - 0.5,
        close=close,
        volume=volume,
        amount=amount,
        complete=True,
    )


def _series(
    *,
    timezone_name: str,
    timestamps: tuple[datetime, ...],
    volumes: tuple[float | None, ...] | None = None,
    amounts: tuple[float | None, ...] | None = None,
) -> InferenceSeries:
    volumes = volumes or (None,) * len(timestamps)
    amounts = amounts or (None,) * len(timestamps)
    bars = tuple(
        _bar(
            timestamp,
            ordinal=index,
            volume=volumes[index],
            amount=amounts[index],
        )
        for index, timestamp in enumerate(timestamps)
    )
    return InferenceSeries(
        instrument_key="TEST",
        timezone=timezone_name,
        bars=bars,
        future_timestamps=tuple(timestamps[-1] + timedelta(minutes=index) for index in range(1, 3)),
    )


def _utc_instants(values: Any) -> list[datetime]:
    return [
        (value.to_pydatetime() if hasattr(value, "to_pydatetime") else value).astimezone(timezone.utc)
        for value in values
    ]


@pytest.mark.parametrize(
    ("timezone_name", "timestamps", "expected_wall_times"),
    [
        (
            "Asia/Seoul",
            (
                datetime(2025, 1, 2, 0, 0, tzinfo=timezone.utc),
                datetime(2025, 1, 2, 0, 1, tzinfo=timezone.utc),
            ),
            ("2025-01-02T09:00:00+09:00", "2025-01-02T09:01:00+09:00"),
        ),
        (
            "America/New_York",
            (
                datetime(2025, 3, 9, 6, 59, tzinfo=timezone.utc),
                datetime(2025, 3, 9, 7, 0, tzinfo=timezone.utc),
            ),
            ("2025-03-09T01:59:00-05:00", "2025-03-09T03:00:00-04:00"),
        ),
        (
            "UTC",
            (
                datetime(2025, 3, 9, 6, 59, tzinfo=timezone.utc),
                datetime(2025, 3, 9, 7, 0, tzinfo=timezone.utc),
            ),
            ("2025-03-09T06:59:00+00:00", "2025-03-09T07:00:00+00:00"),
        ),
    ],
)
def test_kronos_presents_exchange_local_timestamps_without_changing_instants(
    timezone_name: str,
    timestamps: tuple[datetime, ...],
    expected_wall_times: tuple[str, ...],
) -> None:
    spy = _PredictorSpy()
    item = _series(timezone_name=timezone_name, timestamps=timestamps)

    _adapter(spy).predict_batch((item,), seed=41)

    assert spy.call is not None
    x_timestamps = spy.call["x_timestamp_list"][0]
    y_timestamps = spy.call["y_timestamp_list"][0]
    assert str(x_timestamps.dt.tz) == timezone_name
    assert str(y_timestamps.dt.tz) == timezone_name
    assert tuple(value.isoformat() for value in x_timestamps) == expected_wall_times
    assert _utc_instants(x_timestamps) == list(timestamps)
    assert _utc_instants(y_timestamps) == list(item.future_timestamps)


@pytest.mark.parametrize(
    ("volumes", "amounts", "expected_optional_columns"),
    [
        (
            (1.25, None, 3.75),
            (101.125, 202.25, 303.375),
            ("amount",),
        ),
        (
            (1.25, 2.5, 3.75),
            (101.125, None, 303.375),
            ("volume",),
        ),
        (
            (1.25, 2.5, 3.75),
            (101.125, 202.25, 303.375),
            ("volume", "amount"),
        ),
    ],
)
def test_kronos_only_passes_complete_optional_channels(
    volumes: tuple[float | None, ...],
    amounts: tuple[float | None, ...],
    expected_optional_columns: tuple[str, ...],
) -> None:
    spy = _PredictorSpy()
    timestamps = tuple(datetime(2025, 1, 2, 0, index, tzinfo=timezone.utc) for index in range(3))
    item = _series(
        timezone_name="UTC",
        timestamps=timestamps,
        volumes=volumes,
        amounts=amounts,
    )

    _adapter(spy).predict_batch((item,), seed=42)

    assert spy.call is not None
    frame = spy.call["df_list"][0]
    assert tuple(frame.columns) == ("open", "high", "low", "close", *expected_optional_columns)
    for column in ("open", "high", "low", "close"):
        expected_bits = [
            struct.pack("!d", float(getattr(bar, column)))
            for bar in item.bars
        ]
        actual_bits = [struct.pack("!d", float(value)) for value in frame[column]]
        assert actual_bits == expected_bits
    for column, expected in (("volume", volumes), ("amount", amounts)):
        if column not in expected_optional_columns:
            assert column not in frame
            continue
        assert all(value is not None for value in expected)
        expected_bits = [struct.pack("!d", value) for value in expected if value is not None]
        actual_bits = [struct.pack("!d", float(value)) for value in frame[column]]
        assert actual_bits == expected_bits
