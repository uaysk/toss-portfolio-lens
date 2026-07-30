#!/usr/bin/env python3
"""Project a complete Chronos-2 raw run into the existing policy-audit shape.

The output intentionally uses the FinCast raw container schema only as an
interchange envelope. Provenance and backend names retain the Chronos-2 model
identity, and the source 22-column chunks remain the authoritative artifact.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any

import numpy as np


MAXIMUM_JSON_BYTES = 1 << 20
HORIZONS = 4
CHRONOS_COLUMNS = 22
POLICY_COLUMNS = 10
CHRONOS_QUANTILES = (
    0.01,
    0.05,
    0.1,
    0.15,
    0.2,
    0.25,
    0.3,
    0.35,
    0.4,
    0.45,
    0.5,
    0.55,
    0.6,
    0.65,
    0.7,
    0.75,
    0.8,
    0.85,
    0.9,
    0.95,
    0.99,
)
POLICY_QUANTILES = tuple(value / 10 for value in range(1, 10))
SAFE_CHUNK = re.compile(r"^chunks/chunk-(\d{10})-(\d{10})\.json$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def absolute_file(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_file()
    ):
        raise argparse.ArgumentTypeError("input must be an absolute regular file")
    return path


def absolute_directory(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_dir()
    ):
        raise argparse.ArgumentTypeError("input must be an absolute directory")
    return path


def absolute_output(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=False) != path:
        raise argparse.ArgumentTypeError("output must be an absolute normalized path")
    return path


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fincast-input", type=absolute_file, required=True)
    parser.add_argument("--chronos-input", type=absolute_file, required=True)
    parser.add_argument("--chronos-output", type=absolute_directory, required=True)
    parser.add_argument("--output", type=absolute_output, required=True)
    return parser.parse_args()


def read_json(path: Path, label: str) -> tuple[bytes, dict[str, Any]]:
    if path.stat().st_size < 2 or path.stat().st_size > MAXIMUM_JSON_BYTES:
        raise ValueError(f"{label} exceeds the JSON size bound")
    payload = path.read_bytes()
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return payload, value


def file_spec(
    value: object,
    label: str,
    *,
    nested_chunk: bool = False,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    name = value.get("name")
    size = value.get("size_bytes")
    digest = value.get("sha256")
    if (
        not isinstance(name, str)
        or (
            not re.fullmatch(r"chunks/chunk-\d{10}-\d{10}\.f32", name)
            if nested_chunk
            else Path(name).name != name
        )
        or not isinstance(size, int)
        or size < 1
        or not isinstance(digest, str)
        or not SHA256.fullmatch(digest)
    ):
        raise ValueError(f"{label} is invalid")
    return {"name": name, "size_bytes": size, "sha256": digest}


def verified_member(root: Path, spec: dict[str, Any], label: str) -> Path:
    path = root / spec["name"]
    if (
        path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_file()
        or path.stat().st_size != spec["size_bytes"]
        or file_sha256(path) != spec["sha256"]
    ):
        raise ValueError(f"{label} differs from its manifest")
    return path


def fincast_contract(path: Path) -> dict[str, Any]:
    payload, manifest = read_json(path, "FinCast input manifest")
    files = manifest.get("files")
    if (
        manifest.get("schema_version") != "fincast-raw-input/v1"
        or not isinstance(files, dict)
        or not isinstance(manifest.get("row_count"), int)
        or manifest["row_count"] < 1
        or manifest.get("cadence_seconds") != 60
        or not isinstance(manifest.get("model_seed"), int)
    ):
        raise ValueError("FinCast input manifest contract is invalid")
    contexts = file_spec(files.get("contexts"), "FinCast contexts")
    origins = file_spec(files.get("origins"), "FinCast origins")
    root = path.parent
    verified_member(root, contexts, "FinCast contexts")
    origins_path = verified_member(root, origins, "FinCast origins")
    manifest_digest = sha256(payload)
    artifact_digest = sha256(
        (
            "fincast-raw-input/v1\0"
            f"{manifest_digest}\0{contexts['sha256']}\0{origins['sha256']}"
        ).encode()
    )
    return {
        "manifest": manifest,
        "manifest_sha256": manifest_digest,
        "artifact_digest": artifact_digest,
        "origins_path": origins_path,
    }


def normalized_timestamp(value: object, label: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be an ISO-8601 string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{label} must be a valid ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def semantic_origins(path: Path) -> tuple[tuple[object, ...], ...]:
    rows: list[tuple[object, ...]] = []
    with path.open("rb") as handle:
        for row_id, line in enumerate(handle):
            value = json.loads(line)
            if not isinstance(value, dict) or value.get("row_id") != row_id:
                raise ValueError("origin rows must be contiguous objects")
            instrument_key = value.get("instrument_key")
            future_timestamps = value.get("future_timestamps")
            if not isinstance(instrument_key, str) or not isinstance(
                future_timestamps,
                list,
            ):
                raise ValueError("origin instrument and future timestamps are invalid")
            rows.append(
                (
                    value.get("row_id"),
                    instrument_key,
                    normalized_timestamp(value.get("origin"), "origin"),
                    tuple(
                        normalized_timestamp(timestamp, "future timestamp")
                        for timestamp in future_timestamps
                    ),
                )
            )
    return tuple(rows)


def chronos_contract(
    input_manifest_path: Path,
    output_root: Path,
    *,
    expected_rows: int,
    expected_origins: tuple[tuple[object, ...], ...],
) -> tuple[dict[str, Any], dict[str, Any]]:
    _input_payload, input_manifest = read_json(
        input_manifest_path,
        "Chronos-2 input manifest",
    )
    input_files = input_manifest.get("files")
    context_bars = input_manifest.get("context_bars", 512)
    if (
        input_manifest.get("schema_version")
        not in {"chronos2-raw-input/v1", "chronos2-raw-input/v2"}
        or input_manifest.get("row_count") != expected_rows
        or not isinstance(input_files, dict)
        or input_manifest.get("native_quantiles") != list(CHRONOS_QUANTILES)
        or not isinstance(context_bars, int)
        or context_bars < 1
    ):
        raise ValueError("Chronos-2 input manifest contract is invalid")
    origins = file_spec(input_files.get("origins"), "Chronos-2 origins")
    origins_path = verified_member(input_manifest_path.parent, origins, "Chronos-2 origins")
    if semantic_origins(origins_path) != expected_origins:
        raise ValueError("Chronos-2 and FinCast origin order differs")

    output_path = output_root / "manifest.json"
    if (
        output_path.is_symlink()
        or output_path.resolve(strict=True) != output_path
        or not output_path.is_file()
    ):
        raise ValueError("Chronos-2 output manifest is unavailable")
    _output_payload, output = read_json(output_path, "Chronos-2 output manifest")
    if (
        output.get("schema_version") != "chronos2-raw-predictions/v1"
        or output.get("complete") is not True
        or output.get("completed_rows") != expected_rows
        or output.get("row_count") != expected_rows
        or output.get("output_shape") != [expected_rows, HORIZONS, CHRONOS_COLUMNS]
        or not isinstance(output.get("backend"), str)
        or not isinstance(output.get("variate_batch_size"), int)
        or not isinstance(output.get("chunks"), list)
        or not output["chunks"]
    ):
        raise ValueError("Chronos-2 output is incomplete or malformed")
    return input_manifest, output


def atomic_write(path: Path, payload: bytes) -> None:
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


def canonical(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode()


def project(values: np.ndarray) -> np.ndarray:
    if (
        values.ndim != 3
        or values.shape[1:] != (HORIZONS, CHRONOS_COLUMNS)
        or not np.isfinite(values).all()
        or np.any(np.diff(values[:, :, 1:], axis=-1) < 0)
    ):
        raise ValueError("Chronos-2 output fails shape, finite, or monotonicity checks")
    indices = [1 + CHRONOS_QUANTILES.index(value) for value in POLICY_QUANTILES]
    projected = np.empty((len(values), HORIZONS, POLICY_COLUMNS), dtype="<f4")
    projected[:, :, 0] = values[:, :, 0]
    projected[:, :, 1:] = values[:, :, indices]
    return projected


def main() -> int:
    args = arguments()
    fincast = fincast_contract(args.fincast_input)
    expected_origins = semantic_origins(fincast["origins_path"])
    row_count = int(fincast["manifest"]["row_count"])
    if len(expected_origins) != row_count:
        raise ValueError("FinCast origins do not match row_count")
    chronos_input, chronos_output = chronos_contract(
        args.chronos_input,
        args.chronos_output,
        expected_rows=row_count,
        expected_origins=expected_origins,
    )
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError("policy artifact output directory must be empty")
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.output.is_symlink() or args.output.resolve(strict=True) != args.output:
        raise ValueError("policy artifact output directory is unsafe")
    chunks_root = args.output / "chunks"
    chunks_root.mkdir(mode=0o700)
    chunks: list[str] = []
    next_row = 0
    source_digest = hashlib.sha256()
    projected_digest = hashlib.sha256()
    for chunk_index, raw_name in enumerate(chronos_output["chunks"]):
        if not isinstance(raw_name, str):
            raise ValueError("Chronos-2 chunk name must be a string")
        match = SAFE_CHUNK.fullmatch(raw_name)
        if match is None:
            raise ValueError("Chronos-2 chunk path is unsafe")
        metadata_path = args.chronos_output / raw_name
        _metadata_payload, metadata = read_json(
            metadata_path,
            f"Chronos-2 chunk {chunk_index}",
        )
        start_row = metadata.get("start_row")
        end_row = metadata.get("end_row")
        output = metadata.get("output")
        if (
            not isinstance(start_row, int)
            or not isinstance(end_row, int)
            or start_row != next_row
            or end_row <= start_row
            or not isinstance(output, dict)
            or output.get("shape") != [end_row - start_row, HORIZONS, CHRONOS_COLUMNS]
        ):
            raise ValueError("Chronos-2 chunks are not one contiguous range")
        source_spec = file_spec(
            output,
            f"Chronos-2 chunk {chunk_index} output",
            nested_chunk=True,
        )
        source_path = args.chronos_output / source_spec["name"]
        if (
            source_path.is_symlink()
            or source_path.resolve(strict=True) != source_path
            or not source_path.is_file()
            or source_path.stat().st_size != source_spec["size_bytes"]
            or file_sha256(source_path) != source_spec["sha256"]
        ):
            raise ValueError("Chronos-2 prediction chunk differs from its manifest")
        source_payload = source_path.read_bytes()
        source_digest.update(source_payload)
        values = np.frombuffer(source_payload, dtype="<f4").reshape(
            end_row - start_row,
            HORIZONS,
            CHRONOS_COLUMNS,
        )
        projected = project(values)
        projected_payload = projected.tobytes(order="C")
        projected_digest.update(projected_payload)
        stem = f"chunk-{start_row:010d}-{end_row:010d}"
        binary_name = f"chunks/{stem}.f32"
        binary_path = args.output / binary_name
        atomic_write(binary_path, projected_payload)
        metadata_name = f"chunks/{stem}.json"
        converted_metadata = {
            "schema_version": "fincast-raw-prediction-chunk/v1",
            "start_row": start_row,
            "end_row": end_row,
            "input_digest": sha256(
                (
                    f"{fincast['artifact_digest']}\0"
                    f"{chronos_output.get('input_artifact_digest')}\0{start_row}\0{end_row}"
                ).encode()
            ),
            "output": {
                "name": binary_name,
                "size_bytes": len(projected_payload),
                "sha256": sha256(projected_payload),
                "dtype": "little-endian-float32",
                "shape": [end_row - start_row, HORIZONS, POLICY_COLUMNS],
            },
            "backend": f"chronos2_{chronos_output['backend']}",
            "batch_size": chronos_output["variate_batch_size"],
            "routing_seed_policy": "not-applicable-chronos2-deterministic",
            "model_seed": fincast["manifest"]["model_seed"],
            "provenance": {
                **(
                    chronos_output.get("provenance")
                    if isinstance(chronos_output.get("provenance"), dict)
                    else {}
                ),
                "model_family": "chronos-2",
                "policy_projection": "native-q10-through-q90-exact-selection/v1",
                "source_chunk_sha256": source_spec["sha256"],
            },
            "latency": metadata.get("latency", {}),
            "gpu_telemetry": metadata.get("gpu_telemetry", {}),
        }
        atomic_write(args.output / metadata_name, canonical(converted_metadata))
        chunks.append(metadata_name)
        next_row = end_row
    if next_row != row_count:
        raise ValueError("Chronos-2 chunks do not cover all rows")
    converted_manifest = {
        "schema_version": "fincast-raw-predictions/v1",
        "input_manifest_sha256": fincast["manifest_sha256"],
        "input_artifact_digest": fincast["artifact_digest"],
        "cadence_seconds": fincast["manifest"]["cadence_seconds"],
        "horizon_minutes": [5, 15, 30, 60],
        "row_count": row_count,
        "context_bars": chronos_input.get("context_bars", 512),
        "output_shape": [row_count, HORIZONS, POLICY_COLUMNS],
        "backend": f"chronos2_{chronos_output['backend']}",
        "batch_size": chronos_output["variate_batch_size"],
        "routing_seed_policy": "not-applicable-chronos2-deterministic",
        "model_seed": fincast["manifest"]["model_seed"],
        "provenance": {
            **(
                chronos_output.get("provenance")
                if isinstance(chronos_output.get("provenance"), dict)
                else {}
            ),
            "model_family": "chronos-2",
            "input_profile": chronos_input.get("profile"),
            "source_output_digest": source_digest.hexdigest(),
            "policy_projection": "native-q10-through-q90-exact-selection/v1",
        },
        "chunks": chunks,
        "completed_rows": row_count,
        "complete": True,
    }
    manifest_payload = canonical(converted_manifest)
    atomic_write(args.output / "manifest.json", manifest_payload)
    print(
        json.dumps(
            {
                "schema_version": "chronos2-policy-projection-result/v1",
                "profile": chronos_input.get("profile"),
                "backend": chronos_output["backend"],
                "variate_batch_size": chronos_output["variate_batch_size"],
                "row_count": row_count,
                "manifest": str(args.output / "manifest.json"),
                "manifest_sha256": sha256(manifest_payload),
                "source_output_digest": source_digest.hexdigest(),
                "projected_output_digest": projected_digest.hexdigest(),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
