from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any

import numpy as np

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WORKER_SOURCE = REPOSITORY_ROOT / "worker" / "ai" / "src"
sys.path.insert(0, str(WORKER_SOURCE))

from portfolio_ai_worker.adapters import InferenceSeries  # noqa: E402
from portfolio_ai_worker.chronos2 import (  # noqa: E402
    CHRONOS2_CONTEXT_BARS,
    CHRONOS2_CONTEXT_WINDOWS,
    CHRONOS2_NATIVE_QUANTILES,
    CHRONOS2_PADDED_PREDICTION_STEPS,
    chronos2_prepared_tensors,
)
from portfolio_ai_worker.chronos2_artifacts import (  # noqa: E402
    CHRONOS2_RAW_INPUT_SCHEMA,
    CHRONOS2_RAW_INPUT_SCHEMA_V2,
    Chronos2InputFiles,
    Chronos2InputManifest,
    validated_profile,
)
from portfolio_ai_worker.contracts import PriceBar, SeriesCadence  # noqa: E402
from portfolio_ai_worker.raw_artifacts import (  # noqa: E402
    RAW_MAX_ORIGIN_LINE_BYTES,
    RawFileSpec,
    RawOrigin,
    atomic_write,
    canonical_json_bytes,
    secure_output_directory,
    sha256_path,
)

MAX_MARKET_BAR_LINE_BYTES = 16 * 1024
MAX_MARKET_BARS_PER_SYMBOL = 60_000


def _absolute_file(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_file()
    ):
        raise argparse.ArgumentTypeError(
            "input must be an absolute normalized regular file"
        )
    return path


def _absolute_output(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=False) != path:
        raise argparse.ArgumentTypeError(
            "output must be an absolute normalized path"
        )
    return path


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build a fixed-shape chronos2-raw-input/v1 artifact from "
            "causal Binance market bars and ordered replay origins"
        )
    )
    parser.add_argument("--market-bars", type=_absolute_file, required=True)
    parser.add_argument("--origins", type=_absolute_file, required=True)
    parser.add_argument("--output", type=_absolute_output, required=True)
    parser.add_argument(
        "--profile",
        choices=(
            "close_only",
            "ohlcv_calendar",
            "microstructure_calendar",
            "derivatives_calendar",
        ),
        required=True,
    )
    parser.add_argument(
        "--context-bars",
        type=int,
        choices=CHRONOS2_CONTEXT_WINDOWS,
        default=CHRONOS2_CONTEXT_BARS,
    )
    parser.add_argument(
        "--schema-version",
        choices=(CHRONOS2_RAW_INPUT_SCHEMA, CHRONOS2_RAW_INPUT_SCHEMA_V2),
        default=CHRONOS2_RAW_INPUT_SCHEMA,
    )
    return parser.parse_args()


def _optional_float(value: object) -> float | None:
    if value is None:
        return None
    parsed = float(value)
    if not np.isfinite(parsed):
        raise ValueError("market bar optional values must be finite")
    return parsed


def _required_float(value: object, name: str) -> float:
    parsed = _optional_float(value)
    if parsed is None:
        raise ValueError(f"market bar is missing {name}")
    return parsed


def _timestamp(value: object) -> datetime:
    if isinstance(value, (int, float)) and np.isfinite(value):
        return datetime.fromtimestamp(float(value) / 1_000, tz=timezone.utc)
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is not None and parsed.utcoffset() is not None:
            return parsed
    raise ValueError("market bar timestamp must be epoch milliseconds or RFC3339")


def _price_bar(value: dict[str, Any]) -> PriceBar:
    close_timestamp = value.get("close_time", value.get("timestamp"))
    return PriceBar(
        timestamp=_timestamp(close_timestamp),
        open=_required_float(value.get("open"), "open"),
        high=_required_float(value.get("high"), "high"),
        low=_required_float(value.get("low"), "low"),
        close=_required_float(value.get("close"), "close"),
        volume=_optional_float(value.get("volume")),
        amount=_optional_float(value.get("quote_volume", value.get("amount"))),
        trade_count=(
            int(value["trade_count"])
            if value.get("trade_count") is not None
            else None
        ),
        taker_buy_volume=_optional_float(
            value.get("taker_buy_volume")
        ),
        taker_buy_amount=_optional_float(
            value.get("taker_buy_quote_volume", value.get("taker_buy_amount"))
        ),
        mark_price=_optional_float(value.get("mark_price")),
        index_price=_optional_float(value.get("index_price")),
        premium_index=_optional_float(value.get("premium_index")),
        funding_rate=_optional_float(value.get("funding_rate")),
        complete=True,
    )


def _load_market_bars(path: Path) -> dict[str, tuple[PriceBar, ...]]:
    grouped: dict[str, list[PriceBar]] = {}
    with path.open("rb") as handle:
        for line_number, line in enumerate(handle, start=1):
            if (
                len(line) > MAX_MARKET_BAR_LINE_BYTES
                or not line.endswith(b"\n")
                or not line.strip()
            ):
                raise ValueError(
                    f"market bar row {line_number} is oversized or malformed"
                )
            try:
                value = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(
                    f"market bar row {line_number} is invalid JSON"
                ) from error
            if not isinstance(value, dict):
                raise ValueError(f"market bar row {line_number} must be an object")
            symbol = str(value.get("symbol", "")).strip().upper()
            if not symbol or len(symbol) > 32:
                raise ValueError(f"market bar row {line_number} has an invalid symbol")
            grouped.setdefault(symbol, []).append(_price_bar(value))
    if not grouped:
        raise ValueError("market bar input is empty")
    output: dict[str, tuple[PriceBar, ...]] = {}
    for symbol, values in grouped.items():
        values.sort(key=lambda item: item.timestamp)
        if len(values) > MAX_MARKET_BARS_PER_SYMBOL:
            raise ValueError(f"{symbol} exceeds the bounded market bar count")
        for previous, current in zip(values, values[1:], strict=False):
            if current.timestamp - previous.timestamp != timedelta(minutes=1):
                raise ValueError(f"{symbol} market bars are not continuous one-minute rows")
        output[symbol] = tuple(values)
    return output


def _load_origins(path: Path) -> tuple[RawOrigin, ...]:
    origins: list[RawOrigin] = []
    with path.open("rb") as handle:
        for line_number, line in enumerate(handle, start=1):
            if (
                len(line) > RAW_MAX_ORIGIN_LINE_BYTES
                or not line.endswith(b"\n")
                or not line.strip()
            ):
                raise ValueError(
                    f"origin row {line_number} is oversized or malformed"
                )
            origin = RawOrigin.model_validate_json(line)
            if origin.row_id != line_number - 1:
                raise ValueError("origin row IDs must be contiguous and ordered")
            origins.append(origin)
    if not origins:
        raise ValueError("origin input is empty")
    return tuple(origins)


def _symbol(origin: RawOrigin) -> str:
    candidate = origin.metadata.get("symbol")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip().upper()
    return origin.instrument_key.rsplit(":", maxsplit=1)[-1].upper()


def _atomic_memmap(
    output: Path,
    name: str,
    *,
    dtype: str | type[np.uint8],
    shape: tuple[int, ...],
) -> tuple[Path, np.memmap]:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{name}.",
        suffix=".tmp",
        dir=output,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    values = np.memmap(temporary, mode="w+", dtype=dtype, shape=shape)
    return temporary, values


def _finalize_memmap(
    temporary: Path,
    values: np.memmap,
    final: Path,
) -> None:
    values.flush()
    descriptor = os.open(temporary, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    del values
    os.replace(temporary, final)


def main() -> int:
    arguments = _arguments()
    if (
        arguments.schema_version == CHRONOS2_RAW_INPUT_SCHEMA
        and arguments.context_bars != CHRONOS2_CONTEXT_BARS
    ):
        raise ValueError("chronos2-raw-input/v1 remains fixed at 512 context bars")
    profile = validated_profile(arguments.profile)
    bars_by_symbol = _load_market_bars(arguments.market_bars)
    origins = _load_origins(arguments.origins)
    if arguments.output.exists() and any(arguments.output.iterdir()):
        raise ValueError("Chronos-2 raw output directory must be empty")
    output = secure_output_directory(arguments.output)
    chunks = output / "chunks"
    if any(chunks.iterdir()):
        raise ValueError("Chronos-2 raw input chunk directory must be empty")
    chunks.rmdir()

    first_symbol = _symbol(origins[0])
    first_bars = bars_by_symbol.get(first_symbol)
    if first_bars is None:
        raise ValueError(f"market bars do not contain {first_symbol}")
    first_index = {
        bar.timestamp: index
        for index, bar in enumerate(first_bars)
    }.get(origins[0].origin)
    if first_index is None or first_index + 1 < arguments.context_bars:
        raise ValueError(
            f"first origin lacks a complete {arguments.context_bars}-bar causal context"
        )
    first_series = InferenceSeries(
        instrument_key=origins[0].instrument_key,
        timezone="UTC",
        bars=first_bars[
            first_index - arguments.context_bars + 1 : first_index + 1
        ],
        future_timestamps=origins[0].future_timestamps,
        input_cadence=SeriesCadence(
            candle_seconds=60,
            gap_policy="continuous",
        ),
    )
    first = chronos2_prepared_tensors(
        [first_series],
        profile,
        context_bars=arguments.context_bars,
    )
    variate_names = first[4]
    row_count = len(origins)
    shape = (row_count, len(variate_names))
    temporary_files: list[Path] = []
    try:
        context_temp, contexts = _atomic_memmap(
            output,
            "contexts.f32",
            dtype="<f4",
            shape=(*shape, arguments.context_bars),
        )
        temporary_files.append(context_temp)
        context_mask_temp, context_mask = _atomic_memmap(
            output,
            "context-mask.u8",
            dtype=np.uint8,
            shape=(*shape, arguments.context_bars),
        )
        temporary_files.append(context_mask_temp)
        future_temp, future = _atomic_memmap(
            output,
            "future-covariates.f32",
            dtype="<f4",
            shape=(*shape, CHRONOS2_PADDED_PREDICTION_STEPS),
        )
        temporary_files.append(future_temp)
        future_mask_temp, future_mask = _atomic_memmap(
            output,
            "future-covariates-mask.u8",
            dtype=np.uint8,
            shape=(*shape, CHRONOS2_PADDED_PREDICTION_STEPS),
        )
        temporary_files.append(future_mask_temp)
        indices_by_symbol = {
            symbol: {bar.timestamp: index for index, bar in enumerate(values)}
            for symbol, values in bars_by_symbol.items()
        }
        origin_lines: list[bytes] = []
        for row, origin in enumerate(origins):
            symbol = _symbol(origin)
            market = bars_by_symbol.get(symbol)
            origin_index = indices_by_symbol.get(symbol, {}).get(origin.origin)
            if (
                market is None
                or origin_index is None
                or origin_index + 1 < arguments.context_bars
            ):
                raise ValueError(
                    f"origin {row} lacks a complete causal {symbol} context"
                )
            series = InferenceSeries(
                instrument_key=origin.instrument_key,
                timezone="UTC",
                bars=market[
                    origin_index - arguments.context_bars + 1 : origin_index + 1
                ],
                future_timestamps=origin.future_timestamps,
                input_cadence=SeriesCadence(
                    candle_seconds=60,
                    gap_policy="continuous",
                ),
            )
            prepared = chronos2_prepared_tensors(
                [series],
                profile,
                context_bars=arguments.context_bars,
            )
            if prepared[4] != variate_names:
                raise ValueError("Chronos-2 variate order changed between rows")
            contexts[row] = prepared[0][0]
            context_mask[row] = prepared[1][0]
            future[row] = prepared[2][0]
            future_mask[row] = prepared[3][0]
            if not bool(context_mask[row].all()):
                raise ValueError(
                    f"profile {profile} has missing past covariates at origin {row}; "
                    "the optimized fixed-shape qualification requires complete coverage"
                )
            origin_lines.append(
                canonical_json_bytes(
                    origin.model_copy(
                        update={
                            "metadata": {
                                **origin.metadata,
                                "chronos2_profile": profile,
                                "chronos2_variate_count": len(variate_names),
                            }
                        }
                    )
                )
            )
        _finalize_memmap(context_temp, contexts, output / "contexts.f32")
        temporary_files.remove(context_temp)
        _finalize_memmap(
            context_mask_temp,
            context_mask,
            output / "context-mask.u8",
        )
        temporary_files.remove(context_mask_temp)
        _finalize_memmap(
            future_temp,
            future,
            output / "future-covariates.f32",
        )
        temporary_files.remove(future_temp)
        _finalize_memmap(
            future_mask_temp,
            future_mask,
            output / "future-covariates-mask.u8",
        )
        temporary_files.remove(future_mask_temp)
        atomic_write(output / "origins.jsonl", b"".join(origin_lines))
    finally:
        for temporary in temporary_files:
            temporary.unlink(missing_ok=True)

    specs = {
        name: RawFileSpec(
            name=file_name,
            size_bytes=(output / file_name).stat().st_size,
            sha256=sha256_path(output / file_name),
        )
        for name, file_name in {
            "contexts": "contexts.f32",
            "context_mask": "context-mask.u8",
            "future_covariates": "future-covariates.f32",
            "future_covariates_mask": "future-covariates-mask.u8",
            "origins": "origins.jsonl",
        }.items()
    }
    manifest = Chronos2InputManifest(
        schema_version=arguments.schema_version,
        profile=profile,
        cadence_seconds=60,
        horizon_minutes=(5, 15, 30, 60),
        prediction_steps=60,
        padded_prediction_steps=64,
        row_count=row_count,
        row_order="row_id_ascending",
        context_bars=arguments.context_bars,
        variate_names=variate_names,
        target_variate_index=0,
        native_quantiles=CHRONOS2_NATIVE_QUANTILES,
        files=Chronos2InputFiles(**specs),
        metadata={
            "source_market_bars": str(arguments.market_bars),
            "source_market_bars_sha256": sha256_path(arguments.market_bars),
            "source_origins": str(arguments.origins),
            "source_origins_sha256": sha256_path(arguments.origins),
            "missing_value_policy": "complete_profile_coverage_required",
            "cross_learning": False,
            "left_padding_created": False,
            "zero_padding_created": False,
        },
    )
    payload = canonical_json_bytes(manifest)
    atomic_write(output / "manifest.json", payload)
    sys.stdout.write(
        json.dumps(
            {
                "schema_version": manifest.schema_version,
                "manifest": str(output / "manifest.json"),
                "manifest_sha256": hashlib.sha256(payload).hexdigest(),
                "profile": profile,
                "row_count": row_count,
                "variate_count": len(variate_names),
                "variate_names": variate_names,
                "context_bars": arguments.context_bars,
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
