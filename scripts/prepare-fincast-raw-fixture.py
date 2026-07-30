from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import sys
from typing import Any

import numpy as np

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WORKER_SOURCE = REPOSITORY_ROOT / "worker" / "ai" / "src"
sys.path.insert(0, str(WORKER_SOURCE))

from portfolio_ai_worker.raw_artifacts import (  # noqa: E402
    RAW_CONTEXT_BARS,
    RawFileSpec,
    RawInputFiles,
    RawInputManifest,
    RawOrigin,
    atomic_write,
    canonical_json_bytes,
    secure_output_directory,
)


def _absolute_file(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=True) != path or not path.is_file():
        raise argparse.ArgumentTypeError("fixture must be an absolute normalized regular file")
    return path


def _absolute_output(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=False) != path:
        raise argparse.ArgumentTypeError("output must be an absolute normalized path")
    return path


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert frozen FinCast contexts into fincast-raw-input/v1",
    )
    parser.add_argument("--fixture", type=_absolute_file, required=True)
    parser.add_argument("--output", type=_absolute_output, required=True)
    parser.add_argument("--cadence", type=int, choices=(15, 30, 60), required=True)
    parser.add_argument("--model-seed", type=int, default=17)
    parser.add_argument("--rows", type=int, default=128)
    return parser.parse_args()


def _load_fixture(path: Path, rows: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if rows < 1 or rows > 128:
        raise ValueError("--rows must be between 1 and 128")
    payload = path.read_bytes()
    if len(payload) > 16 * 1024 * 1024:
        raise ValueError("fixture exceeds its bounded size")
    decoded = json.loads(payload)
    if (
        not isinstance(decoded, dict)
        or decoded.get("schema_version") != "fincast-crypto-contexts/v1"
        or not isinstance(decoded.get("contexts"), list)
        or len(decoded["contexts"]) != 128
    ):
        raise ValueError("fixture does not match fincast-crypto-contexts/v1")
    return decoded, decoded["contexts"][:rows]


def main() -> int:
    arguments = _arguments()
    fixture, rows = _load_fixture(arguments.fixture, arguments.rows)
    if arguments.model_seed < 0 or arguments.model_seed > (1 << 63) - 1:
        raise ValueError("--model-seed is outside the raw manifest bound")
    if arguments.output.exists() and any(arguments.output.iterdir()):
        raise ValueError("output must be empty")
    output = secure_output_directory(arguments.output)
    if any((output / "chunks").iterdir()):
        raise ValueError("output chunk directory must be empty")
    (output / "chunks").rmdir()

    contexts = np.asarray(
        [row.get("closes") for row in rows],
        dtype="<f4",
    )
    if (
        contexts.shape != (len(rows), RAW_CONTEXT_BARS)
        or not np.isfinite(contexts).all()
        or not (contexts > 0).all()
    ):
        raise ValueError("fixture contexts must be finite positive [rows,512] closes")
    context_payload = contexts.tobytes(order="C")
    origins: list[bytes] = []
    for row_id, row in enumerate(rows):
        input_end = datetime.fromisoformat(str(row.get("input_end_at")))
        if input_end.tzinfo is None or input_end.utcoffset() is None:
            raise ValueError("fixture input_end_at must include a timezone")
        origin = RawOrigin(
            row_id=row_id,
            instrument_key=str(row.get("instrument_key")),
            origin=input_end,
            future_timestamps=tuple(
                input_end + timedelta(minutes=index + 1)
                for index in range(60)
            ),
            metadata={
                "symbol": str(row.get("symbol")),
                "interval": str(row.get("interval")),
                "fixture_row": row_id,
            },
        )
        origins.append(canonical_json_bytes(origin))
    origin_payload = b"".join(origins)
    contexts_spec = RawFileSpec(
        name="contexts.f32",
        size_bytes=len(context_payload),
        sha256=hashlib.sha256(context_payload).hexdigest(),
    )
    origins_spec = RawFileSpec(
        name="origins.jsonl",
        size_bytes=len(origin_payload),
        sha256=hashlib.sha256(origin_payload).hexdigest(),
    )
    manifest = RawInputManifest(
        schema_version="fincast-raw-input/v1",
        cadence_seconds=arguments.cadence,
        horizon_minutes=(5, 15, 30, 60),
        row_count=len(rows),
        row_order="row_id_ascending",
        context_bars=RAW_CONTEXT_BARS,
        model_seed=arguments.model_seed,
        files=RawInputFiles(contexts=contexts_spec, origins=origins_spec),
        metadata={
            "source_schema": fixture["schema_version"],
            "source_fixture": str(arguments.fixture),
            "source_fixture_sha256": hashlib.sha256(arguments.fixture.read_bytes()).hexdigest(),
            "selection": "frozen_contexts_in_source_order",
        },
    )
    atomic_write(output / "contexts.f32", context_payload)
    atomic_write(output / "origins.jsonl", origin_payload)
    manifest_payload = canonical_json_bytes(manifest)
    atomic_write(output / "manifest.json", manifest_payload)
    sys.stdout.write(
        json.dumps(
            {
                "schema_version": manifest.schema_version,
                "manifest": str(output / "manifest.json"),
                "rows": manifest.row_count,
                "cadence_seconds": manifest.cadence_seconds,
                "manifest_sha256": hashlib.sha256(manifest_payload).hexdigest(),
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
