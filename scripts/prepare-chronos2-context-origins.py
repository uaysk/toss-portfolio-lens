#!/usr/bin/env python3
"""Verify the fixed five-week origin set and create its final-24h pilot subset."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any


EXPECTED_FULL_ROWS = 6_720
EXPECTED_PILOT_ROWS = 192
END_EXCLUSIVE = datetime(2026, 7, 27, tzinfo=timezone.utc)


def absolute_file(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_file()
    ):
        raise argparse.ArgumentTypeError("input must be an absolute normalized regular file")
    return path


def new_file(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=False) != path or path.exists():
        raise argparse.ArgumentTypeError("output must be a new absolute normalized path")
    return path


def timestamp(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("origin timestamps must be strings")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("origin timestamps must include a timezone")
    return parsed.astimezone(timezone.utc)


def load(path: Path) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    with path.open("rb") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.endswith(b"\n") or len(line) > 64 * 1024:
                raise ValueError(f"origin row {line_number} is malformed")
            value = json.loads(line)
            if not isinstance(value, dict) or value.get("row_id") != line_number - 1:
                raise ValueError("origin rows must be contiguous JSON objects")
            future = value.get("future_timestamps")
            if not isinstance(future, list) or len(future) != 60:
                raise ValueError("origin rows must retain 60 future timestamps")
            values.append(value)
    return values


def identity(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "row_id": value["row_id"],
        "instrument_key": value["instrument_key"],
        "origin": timestamp(value["origin"]).isoformat(),
        "future_timestamps": [
            timestamp(item).isoformat()
            for item in value["future_timestamps"]
        ],
    }


def digest(values: list[dict[str, Any]]) -> str:
    payload = b"".join(
        (
            json.dumps(identity(value), sort_keys=True, separators=(",", ":"))
            + "\n"
        ).encode()
        for value in values
    )
    return hashlib.sha256(payload).hexdigest()


def atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-origins", type=absolute_file, required=True)
    parser.add_argument("--collected-origins", type=absolute_file, required=True)
    parser.add_argument("--pilot-output", type=new_file, required=True)
    parser.add_argument("--report-output", type=new_file, required=True)
    arguments = parser.parse_args()

    baseline = load(arguments.baseline_origins)
    collected = load(arguments.collected_origins)
    if len(baseline) != EXPECTED_FULL_ROWS or len(collected) != EXPECTED_FULL_ROWS:
        raise ValueError("five-week context qualification requires exactly 6,720 origins")
    baseline_digest = digest(baseline)
    collected_digest = digest(collected)
    if baseline_digest != collected_digest:
        raise ValueError("collected scored origins differ from the read-only baseline")

    pilot_start = END_EXCLUSIVE - timedelta(hours=24)
    selected = [
        value
        for value in baseline
        if pilot_start <= timestamp(value["origin"]) < END_EXCLUSIVE
    ]
    if len(selected) != EXPECTED_PILOT_ROWS:
        raise ValueError("final 24-hour pilot must contain exactly 192 BTC/ETH origins")
    pilot = [
        {
            **value,
            "row_id": row_id,
            "metadata": {
                **(value.get("metadata") if isinstance(value.get("metadata"), dict) else {}),
                "chronos2_context_pilot": True,
                "baseline_row_id": value["row_id"],
            },
        }
        for row_id, value in enumerate(selected)
    ]
    pilot_payload = b"".join(
        (json.dumps(value, separators=(",", ":")) + "\n").encode()
        for value in pilot
    )
    atomic_write(arguments.pilot_output, pilot_payload)
    report = {
        "schema_version": "chronos2-context-origin-parity/v1",
        "status": "passed",
        "full_row_count": len(baseline),
        "pilot_row_count": len(pilot),
        "baseline_identity_digest": baseline_digest,
        "collected_identity_digest": collected_digest,
        "pilot_identity_digest": digest(pilot),
        "pilot_start": pilot_start.isoformat(),
        "end_exclusive": END_EXCLUSIVE.isoformat(),
    }
    atomic_write(
        arguments.report_output,
        (json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode(),
    )
    print(json.dumps(report, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
