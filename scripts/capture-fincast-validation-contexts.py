#!/usr/bin/env python3
"""Capture the fixed, credential-free Binance USD-M FinCast qualification set."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE_URL = "https://fapi.binance.com"
INTERVAL_MS = 60_000
FIXED_END_MS = 1_782_864_000_000  # 2026-07-01T00:00:00Z
SYMBOLS = (
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "LINKUSDT",
    "AVAXUSDT",
    "DOTUSDT",
    "LTCUSDT",
    "BCHUSDT",
    "TRXUSDT",
    "SUIUSDT",
    "AAVEUSDT",
    "NEARUSDT",
)
ORIGIN_INDICES = (599, 719, 839, 959, 1079, 1199, 1319, 1439)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def request_json(path: str, parameters: dict[str, object] | None = None) -> object:
    query = f"?{urlencode(parameters)}" if parameters else ""
    request = Request(
        f"{BASE_URL}{path}{query}",
        headers={"Accept": "application/json", "User-Agent": "toss-portfolio-lens-fincast-provisioner/1"},
    )
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def iso(milliseconds: int) -> str:
    return datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> int:
    args = parse_args()
    exchange = request_json("/fapi/v1/exchangeInfo")
    if not isinstance(exchange, dict) or not isinstance(exchange.get("symbols"), list):
        raise RuntimeError("Binance exchangeInfo response is invalid")
    instruments = {item.get("symbol"): item for item in exchange["symbols"] if isinstance(item, dict)}
    contexts: list[dict[str, object]] = []
    for symbol in SYMBOLS:
        instrument = instruments.get(symbol)
        if (
            not isinstance(instrument, dict)
            or instrument.get("status") != "TRADING"
            or instrument.get("contractType") != "PERPETUAL"
            or instrument.get("quoteAsset") != "USDT"
            or instrument.get("marginAsset") != "USDT"
            or not isinstance(instrument.get("onboardDate"), int)
            or instrument["onboardDate"] > FIXED_END_MS - 7 * 24 * 60 * 60 * 1000
        ):
            raise RuntimeError(f"{symbol} is not an eligible Binance USD-M USDT perpetual")
        payload = request_json(
            "/fapi/v1/klines",
            {
                "symbol": symbol,
                "interval": "1m",
                "endTime": FIXED_END_MS - 1,
                "limit": 1500,
            },
        )
        if not isinstance(payload, list) or len(payload) != 1500:
            raise RuntimeError(f"{symbol} did not return 1500 finalized one-minute bars")
        opens = [int(row[0]) for row in payload if isinstance(row, list) and len(row) >= 7]
        closes_at = [int(row[6]) for row in payload if isinstance(row, list) and len(row) >= 7]
        closes = [float(row[4]) for row in payload if isinstance(row, list) and len(row) >= 7]
        if (
            len(opens) != 1500
            or any(current - previous != INTERVAL_MS for previous, current in zip(opens, opens[1:], strict=False))
            or any(close_at >= FIXED_END_MS for close_at in closes_at)
            or any(not math.isfinite(value) or value <= 0 for value in closes)
        ):
            raise RuntimeError(f"{symbol} contains a gap, incomplete bar, or invalid close")
        for sample, origin_index in enumerate(ORIGIN_INDICES):
            start_index = origin_index - 511
            context_closes = closes[start_index : origin_index + 1]
            contexts.append(
                {
                    "instrument_key": f"BINANCE_USDM:{symbol}:{sample}",
                    "symbol": symbol,
                    "interval": "1m",
                    "context_start_at": iso(opens[start_index]),
                    "input_end_at": iso(closes_at[origin_index]),
                    "bar_count": 512,
                    "round_trip_cost_bps": 8.0,
                    "closes": context_closes,
                }
            )
        time.sleep(0.05)
    if len(contexts) != 128:
        raise RuntimeError("qualification capture did not produce exactly 128 contexts")
    output = {
        "schema_version": "fincast-crypto-contexts/v1",
        "source": {
            "venue": "BINANCE_USDM",
            "endpoint": "/fapi/v1/klines",
            "contract_type": "PERPETUAL",
            "quote_asset": "USDT",
            "interval": "1m",
            "fixed_end_at": iso(FIXED_END_MS),
            "complete_only": True,
            "round_trip_cost_bps": 8.0,
        },
        "contexts": contexts,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        raise RuntimeError("qualification fixture already exists; capture will not overwrite it")
    args.output.write_text(
        json.dumps(output, ensure_ascii=True, allow_nan=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"captured {len(contexts)} fixed contexts in {args.output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HTTPError, URLError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"FinCast context capture failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
