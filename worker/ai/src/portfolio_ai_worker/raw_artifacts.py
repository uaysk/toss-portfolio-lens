from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError, field_validator, model_validator

RAW_INPUT_SCHEMA = "fincast-raw-input/v1"
RAW_OUTPUT_SCHEMA = "fincast-raw-predictions/v1"
RAW_ROUTING_POLICY = "fincast-row-routing-uniform/v1"
RAW_CONTEXT_BARS = 512
RAW_HORIZONS_MINUTES = (5, 15, 30, 60)
RAW_OUTPUT_COLUMNS = 10
RAW_OUTPUT_HORIZONS = 4
RAW_MAX_ROWS = 10_000_000
RAW_MAX_MANIFEST_BYTES = 1 << 20
RAW_MAX_ORIGIN_LINE_BYTES = 1 << 20
RAW_CHUNK_DIRECTORY = "chunks"
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SAFE_FILE_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")


class RawArtifactError(ValueError):
    pass


class RawFileSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str
    size_bytes: int = Field(ge=1)
    sha256: str

    @field_validator("name")
    @classmethod
    def _safe_name(cls, value: str) -> str:
        if not _SAFE_FILE_NAME.fullmatch(value) or Path(value).name != value:
            raise ValueError("artifact filename must be a bounded basename")
        return value

    @field_validator("sha256")
    @classmethod
    def _sha256(cls, value: str) -> str:
        if not _SHA256_PATTERN.fullmatch(value):
            raise ValueError("artifact SHA-256 must be lowercase hexadecimal")
        return value


class RawInputFiles(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    contexts: RawFileSpec
    origins: RawFileSpec

    @model_validator(mode="after")
    def _fixed_names(self) -> RawInputFiles:
        if self.contexts.name != "contexts.f32" or self.origins.name != "origins.jsonl":
            raise ValueError("raw input files must use the versioned canonical names")
        return self


class RawInputManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["fincast-raw-input/v1"]
    cadence_seconds: Literal[15, 30, 60]
    horizon_minutes: tuple[int, int, int, int]
    row_count: int = Field(ge=1, le=RAW_MAX_ROWS)
    row_order: Literal["row_id_ascending"]
    context_bars: Literal[512]
    model_seed: int = Field(ge=0, le=(1 << 63) - 1)
    files: RawInputFiles
    metadata: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("horizon_minutes", mode="before")
    @classmethod
    def _fixed_horizons(
        cls,
        value: tuple[int, int, int, int] | list[int],
    ) -> tuple[int, int, int, int]:
        value = tuple(value)
        if value != RAW_HORIZONS_MINUTES:
            raise ValueError("raw input horizons must be ordered 5, 15, 30, and 60 minutes")
        return value

    @model_validator(mode="after")
    def _binary_size(self) -> RawInputManifest:
        expected = self.row_count * RAW_CONTEXT_BARS * np.dtype("<f4").itemsize
        if self.files.contexts.size_bytes != expected:
            raise ValueError("contexts.f32 size does not match [rows,512] little-endian FP32")
        return self


class RawOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    row_id: int = Field(ge=0, le=RAW_MAX_ROWS - 1)
    instrument_key: str = Field(min_length=1, max_length=256)
    origin: datetime
    future_timestamps: tuple[datetime, ...]
    metadata: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("future_timestamps", mode="before")
    @classmethod
    def _future_timestamp_tuple(
        cls,
        value: tuple[datetime | str, ...] | list[datetime | str],
    ) -> tuple[datetime, ...]:
        return tuple(
            datetime.fromisoformat(item) if isinstance(item, str) else item
            for item in value
        )

    @model_validator(mode="after")
    def _timestamps(self) -> RawOrigin:
        if self.origin.tzinfo is None or self.origin.utcoffset() is None:
            raise ValueError("origin must carry an explicit timezone")
        if len(self.future_timestamps) < max(RAW_HORIZONS_MINUTES):
            raise ValueError("origin must preserve at least 60 future minute timestamps")
        previous = self.origin
        for timestamp in self.future_timestamps:
            if timestamp.tzinfo is None or timestamp.utcoffset() is None:
                raise ValueError("future timestamps must carry explicit timezones")
            if timestamp <= previous:
                raise ValueError("future timestamps must be strictly increasing")
            previous = timestamp
        return self


class RawPredictionFile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str
    size_bytes: int = Field(ge=1)
    sha256: str
    dtype: Literal["little-endian-float32"]
    shape: tuple[int, Literal[4], Literal[10]]

    @field_validator("shape", mode="before")
    @classmethod
    def _shape_tuple(
        cls,
        value: tuple[int, Literal[4], Literal[10]] | list[int],
    ) -> tuple[int, Literal[4], Literal[10]]:
        return tuple(value)  # type: ignore[return-value]

    @field_validator("name")
    @classmethod
    def _safe_name(cls, value: str) -> str:
        candidate = Path(value)
        if (
            candidate.is_absolute()
            or len(candidate.parts) != 2
            or candidate.parts[0] != RAW_CHUNK_DIRECTORY
            or not _SAFE_FILE_NAME.fullmatch(candidate.parts[1])
        ):
            raise ValueError("prediction chunk path is unsafe")
        return value

    @field_validator("sha256")
    @classmethod
    def _sha256(cls, value: str) -> str:
        if not _SHA256_PATTERN.fullmatch(value):
            raise ValueError("prediction SHA-256 must be lowercase hexadecimal")
        return value

    @model_validator(mode="after")
    def _size_matches_shape(self) -> RawPredictionFile:
        expected = math.prod(self.shape) * np.dtype("<f4").itemsize
        if self.size_bytes != expected:
            raise ValueError("prediction chunk size does not match its FP32 shape")
        return self


class RawChunkMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["fincast-raw-prediction-chunk/v1"]
    start_row: int = Field(ge=0, le=RAW_MAX_ROWS - 1)
    end_row: int = Field(ge=1, le=RAW_MAX_ROWS)
    input_digest: str
    output: RawPredictionFile
    backend: Literal[
        "eager",
        "no_padding",
        "batched_experts",
        "cuda_graph",
        "tensorrt_fp32",
        "tensorrt_int8",
    ]
    batch_size: int = Field(ge=1, le=4096)
    routing_seed_policy: Literal["fincast-row-routing-uniform/v1"]
    model_seed: int = Field(ge=0, le=(1 << 63) - 1)
    provenance: dict[str, JsonValue]
    latency: dict[str, JsonValue]
    gpu_telemetry: dict[str, JsonValue]

    @field_validator("input_digest")
    @classmethod
    def _digest(cls, value: str) -> str:
        if not _SHA256_PATTERN.fullmatch(value):
            raise ValueError("chunk input digest must be lowercase hexadecimal")
        return value

    @model_validator(mode="after")
    def _range_matches_shape(self) -> RawChunkMetadata:
        if self.end_row <= self.start_row:
            raise ValueError("chunk row range must be non-empty")
        if self.output.shape[0] != self.end_row - self.start_row:
            raise ValueError("chunk row range does not match prediction shape")
        return self


class RawOutputManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["fincast-raw-predictions/v1"]
    input_manifest_sha256: str
    input_artifact_digest: str
    cadence_seconds: Literal[15, 30, 60]
    horizon_minutes: tuple[int, int, int, int]
    row_count: int = Field(ge=1, le=RAW_MAX_ROWS)
    context_bars: Literal[512]
    output_shape: tuple[int, Literal[4], Literal[10]]
    backend: Literal[
        "eager",
        "no_padding",
        "batched_experts",
        "cuda_graph",
        "tensorrt_fp32",
        "tensorrt_int8",
    ]
    batch_size: int = Field(ge=1, le=4096)
    routing_seed_policy: Literal["fincast-row-routing-uniform/v1"]
    model_seed: int = Field(ge=0, le=(1 << 63) - 1)
    provenance: dict[str, JsonValue]
    chunks: tuple[str, ...]
    completed_rows: int = Field(ge=0, le=RAW_MAX_ROWS)
    complete: bool

    @field_validator("input_manifest_sha256", "input_artifact_digest")
    @classmethod
    def _digests(cls, value: str) -> str:
        if not _SHA256_PATTERN.fullmatch(value):
            raise ValueError("output manifest digest must be lowercase hexadecimal")
        return value

    @field_validator("horizon_minutes", mode="before")
    @classmethod
    def _fixed_horizons(
        cls,
        value: tuple[int, int, int, int] | list[int],
    ) -> tuple[int, int, int, int]:
        value = tuple(value)
        if value != RAW_HORIZONS_MINUTES:
            raise ValueError("raw output horizons must remain ordered")
        return value

    @field_validator("output_shape", mode="before")
    @classmethod
    def _output_shape_tuple(
        cls,
        value: tuple[int, Literal[4], Literal[10]] | list[int],
    ) -> tuple[int, Literal[4], Literal[10]]:
        return tuple(value)  # type: ignore[return-value]

    @field_validator("chunks", mode="before")
    @classmethod
    def _safe_chunks(cls, value: tuple[str, ...] | list[str]) -> tuple[str, ...]:
        value = tuple(value)
        for name in value:
            candidate = Path(name)
            if (
                candidate.is_absolute()
                or len(candidate.parts) != 2
                or candidate.parts[0] != RAW_CHUNK_DIRECTORY
                or not candidate.name.endswith(".json")
                or not _SAFE_FILE_NAME.fullmatch(candidate.name)
            ):
                raise ValueError("output manifest contains an unsafe chunk path")
        if len(set(value)) != len(value):
            raise ValueError("output manifest contains duplicate chunks")
        return value

    @model_validator(mode="after")
    def _completion(self) -> RawOutputManifest:
        if self.output_shape != (self.row_count, RAW_OUTPUT_HORIZONS, RAW_OUTPUT_COLUMNS):
            raise ValueError("raw output shape must be [rows,4,10]")
        if self.completed_rows > self.row_count:
            raise ValueError("completed row count exceeds the artifact")
        if self.complete != (self.completed_rows == self.row_count):
            raise ValueError("output completion marker is inconsistent")
        return self


@dataclass(frozen=True)
class LoadedRawInput:
    manifest_path: Path
    root: Path
    manifest: RawInputManifest
    manifest_sha256: str
    contexts_path: Path
    origins_path: Path
    artifact_digest: str


@dataclass(frozen=True)
class ResumeState:
    next_row: int
    chunks: tuple[RawChunkMetadata, ...]
    chunk_metadata_names: tuple[str, ...]


def sha256_path(path: Path, *, chunk_bytes: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk_bytes):
            digest.update(block)
    return digest.hexdigest()


def _require_absolute_nonsymlink(path: Path, label: str, *, regular_file: bool) -> Path:
    if not path.is_absolute():
        raise RawArtifactError(f"{label} must be absolute")
    if path.is_symlink():
        raise RawArtifactError(f"{label} must not be a symlink")
    resolved = path.resolve(strict=True)
    if resolved != path:
        raise RawArtifactError(f"{label} must not traverse symlinked path components")
    if regular_file and not path.is_file():
        raise RawArtifactError(f"{label} must be a regular file")
    return path


def _read_bounded_json(path: Path, limit: int) -> tuple[bytes, Any]:
    size = path.stat().st_size
    if size <= 0 or size > limit:
        raise RawArtifactError(f"{path.name} exceeds its bounded JSON size")
    payload = path.read_bytes()
    try:
        return payload, json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RawArtifactError(f"{path.name} is not valid UTF-8 JSON") from error


def _artifact_member(root: Path, spec: RawFileSpec, label: str) -> Path:
    candidate = root / spec.name
    _require_absolute_nonsymlink(candidate, label, regular_file=True)
    if candidate.parent != root:
        raise RawArtifactError(f"{label} escapes the manifest directory")
    stat = candidate.stat()
    if stat.st_size != spec.size_bytes:
        raise RawArtifactError(f"{label} size differs from manifest")
    if sha256_path(candidate) != spec.sha256:
        raise RawArtifactError(f"{label} SHA-256 differs from manifest")
    return candidate


def _validate_origins(path: Path, row_count: int) -> None:
    observed = 0
    with path.open("rb") as handle:
        for observed, line in enumerate(handle, start=1):
            if len(line) > RAW_MAX_ORIGIN_LINE_BYTES:
                raise RawArtifactError("origins.jsonl contains an oversized row")
            if not line.endswith(b"\n") or not line.strip():
                raise RawArtifactError("origins.jsonl rows must be non-empty newline-delimited JSON")
            try:
                origin = RawOrigin.model_validate_json(line)
            except (ValidationError, UnicodeDecodeError) as error:
                raise RawArtifactError(f"origins.jsonl row {observed - 1} is invalid") from error
            if origin.row_id != observed - 1:
                raise RawArtifactError("origins.jsonl row IDs must be contiguous and ordered")
            if observed > row_count:
                raise RawArtifactError("origins.jsonl contains more rows than the manifest")
    if observed != row_count:
        raise RawArtifactError("origins.jsonl row count differs from the manifest")


def _validate_context_values(path: Path, row_count: int) -> None:
    contexts = np.memmap(path, mode="r", dtype="<f4", shape=(row_count, RAW_CONTEXT_BARS))
    try:
        for start in range(0, row_count, 8192):
            values = np.asarray(contexts[start : start + 8192])
            if not np.isfinite(values).all() or not (values > 0).all():
                raise RawArtifactError("contexts.f32 must contain only finite positive closes")
    finally:
        del contexts


def load_raw_input(manifest_path: Path) -> LoadedRawInput:
    manifest_path = _require_absolute_nonsymlink(
        manifest_path,
        "raw input manifest",
        regular_file=True,
    )
    root = manifest_path.parent
    if root.resolve(strict=True) != root or root.is_symlink():
        raise RawArtifactError("raw input directory must not traverse symlinks")
    payload, decoded = _read_bounded_json(manifest_path, RAW_MAX_MANIFEST_BYTES)
    try:
        manifest = RawInputManifest.model_validate(decoded)
    except ValidationError as error:
        raise RawArtifactError("raw input manifest does not match fincast-raw-input/v1") from error
    contexts_path = _artifact_member(root, manifest.files.contexts, "contexts.f32")
    origins_path = _artifact_member(root, manifest.files.origins, "origins.jsonl")
    _validate_origins(origins_path, manifest.row_count)
    _validate_context_values(contexts_path, manifest.row_count)
    manifest_sha256 = hashlib.sha256(payload).hexdigest()
    artifact_digest = hashlib.sha256(
        (
            RAW_INPUT_SCHEMA
            + "\0"
            + manifest_sha256
            + "\0"
            + manifest.files.contexts.sha256
            + "\0"
            + manifest.files.origins.sha256
        ).encode("ascii")
    ).hexdigest()
    return LoadedRawInput(
        manifest_path=manifest_path,
        root=root,
        manifest=manifest,
        manifest_sha256=manifest_sha256,
        contexts_path=contexts_path,
        origins_path=origins_path,
        artifact_digest=artifact_digest,
    )


def open_contexts(artifact: LoadedRawInput) -> np.memmap:
    return np.memmap(
        artifact.contexts_path,
        mode="r",
        dtype="<f4",
        shape=(artifact.manifest.row_count, RAW_CONTEXT_BARS),
    )


def routing_uniforms(
    row_ids: np.ndarray,
    *,
    model_seed: int,
    decode_passes: int,
    layers: int,
    top_n: int = 2,
    tokens: int = 16,
) -> np.ndarray:
    """Build versioned stateless U[0,1) values keyed by row and logical position."""

    bounded_rows = np.asarray(row_ids, dtype=np.uint64)
    if bounded_rows.ndim != 1 or len(bounded_rows) == 0:
        raise RawArtifactError("routing row IDs must be a non-empty vector")
    if decode_passes not in (1, 2) or layers <= 0 or top_n <= 0 or tokens <= 0:
        raise RawArtifactError("routing tensor dimensions are invalid")
    passes = np.arange(decode_passes, dtype=np.uint64)[:, None, None, None, None]
    layer_ids = np.arange(layers, dtype=np.uint64)[None, :, None, None, None]
    top_ids = np.arange(top_n, dtype=np.uint64)[None, None, :, None, None]
    rows = bounded_rows[None, None, None, :, None]
    token_ids = np.arange(tokens, dtype=np.uint64)[None, None, None, None, :]
    with np.errstate(over="ignore"):
        state = (
            np.uint64(model_seed)
            ^ (rows * np.uint64(0xD6E8FEB86659FD93))
            ^ (passes * np.uint64(0xA0761D6478BD642F))
            ^ (layer_ids * np.uint64(0xE7037ED1A0B428DB))
            ^ (top_ids * np.uint64(0x8EBC6AF09C88C6E3))
            ^ (token_ids * np.uint64(0x589965CC75374CC3))
        )
        state += np.uint64(0x9E3779B97F4A7C15)
        state = (state ^ (state >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        state = (state ^ (state >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        state ^= state >> np.uint64(31)
    mantissa = (state >> np.uint64(40)).astype(np.uint32)
    uniforms = ((mantissa.astype(np.float32) + np.float32(0.5)) / np.float32(1 << 24)).astype(
        np.float32,
        copy=False,
    )
    # Adding 0.5 at FP32 precision can round the largest 24-bit mantissa to
    # exactly 2**24, producing 1.0. Preserve every existing interior value and
    # clamp only that endpoint so all backends receive the same open-interval
    # routing contract.
    np.minimum(
        uniforms,
        np.nextafter(np.float32(1.0), np.float32(0.0)),
        out=uniforms,
    )
    return uniforms


def secure_output_directory(path: Path) -> Path:
    if not path.is_absolute():
        raise RawArtifactError("raw output directory must be absolute")
    resolved = path.resolve(strict=False)
    if resolved != path:
        raise RawArtifactError("raw output directory must not traverse symlinks")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir() or path.resolve(strict=True) != path:
        raise RawArtifactError("raw output directory must be a regular non-symlink directory")
    chunks = path / RAW_CHUNK_DIRECTORY
    chunks.mkdir(mode=0o700, exist_ok=True)
    if chunks.is_symlink() or not chunks.is_dir() or chunks.resolve(strict=True) != chunks:
        raise RawArtifactError("raw chunk directory must be a regular non-symlink directory")
    return path


def atomic_write(path: Path, payload: bytes, *, mode: int = 0o600) -> None:
    if path.is_symlink():
        raise RawArtifactError(f"refusing to replace symlink: {path.name}")
    descriptor, temporary_text = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_text)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def canonical_json_bytes(value: BaseModel | dict[str, Any]) -> bytes:
    payload = value.model_dump(mode="json") if isinstance(value, BaseModel) else value
    return (
        json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def chunk_stem(start_row: int, end_row: int) -> str:
    if start_row < 0 or end_row <= start_row or end_row > RAW_MAX_ROWS:
        raise RawArtifactError("chunk range is invalid")
    return f"chunk-{start_row:010d}-{end_row:010d}"


def chunk_input_digest(artifact: LoadedRawInput, start_row: int, contexts: np.ndarray) -> str:
    bounded = np.ascontiguousarray(contexts, dtype="<f4")
    digest = hashlib.sha256()
    digest.update(artifact.artifact_digest.encode("ascii"))
    digest.update(b"\0")
    digest.update(str(start_row).encode("ascii"))
    digest.update(b"\0")
    digest.update(bounded.tobytes(order="C"))
    return digest.hexdigest()


def write_prediction_chunk(
    output_dir: Path,
    predictions: np.ndarray,
    *,
    start_row: int,
    input_digest: str,
    backend: str,
    batch_size: int,
    model_seed: int,
    provenance: dict[str, JsonValue],
    latency: dict[str, JsonValue],
    gpu_telemetry: dict[str, JsonValue],
) -> RawChunkMetadata:
    values = np.ascontiguousarray(predictions, dtype="<f4")
    if values.ndim != 3 or values.shape[1:] != (RAW_OUTPUT_HORIZONS, RAW_OUTPUT_COLUMNS):
        raise RawArtifactError("raw predictions must have shape [rows,4,10]")
    if len(values) == 0 or not np.isfinite(values).all():
        raise RawArtifactError("raw predictions must be non-empty and finite")
    if np.any(np.diff(values[:, :, 1:], axis=-1) < 0):
        raise RawArtifactError("native q10 through q90 must be monotonic")
    end_row = start_row + len(values)
    stem = chunk_stem(start_row, end_row)
    relative_binary = f"{RAW_CHUNK_DIRECTORY}/{stem}.f32"
    binary_path = output_dir / relative_binary
    payload = values.tobytes(order="C")
    atomic_write(binary_path, payload)
    output_file = RawPredictionFile(
        name=relative_binary,
        size_bytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        dtype="little-endian-float32",
        shape=(len(values), RAW_OUTPUT_HORIZONS, RAW_OUTPUT_COLUMNS),
    )
    metadata = RawChunkMetadata(
        schema_version="fincast-raw-prediction-chunk/v1",
        start_row=start_row,
        end_row=end_row,
        input_digest=input_digest,
        output=output_file,
        backend=backend,
        batch_size=batch_size,
        routing_seed_policy=RAW_ROUTING_POLICY,
        model_seed=model_seed,
        provenance=provenance,
        latency=latency,
        gpu_telemetry=gpu_telemetry,
    )
    metadata_path = output_dir / RAW_CHUNK_DIRECTORY / f"{stem}.json"
    atomic_write(metadata_path, canonical_json_bytes(metadata))
    return metadata


def _load_chunk(output_dir: Path, metadata_path: Path) -> RawChunkMetadata:
    _require_absolute_nonsymlink(metadata_path, "raw chunk metadata", regular_file=True)
    _, decoded = _read_bounded_json(metadata_path, RAW_MAX_MANIFEST_BYTES)
    try:
        metadata = RawChunkMetadata.model_validate(decoded)
    except ValidationError as error:
        raise RawArtifactError(f"invalid raw chunk metadata: {metadata_path.name}") from error
    expected_name = f"{chunk_stem(metadata.start_row, metadata.end_row)}.json"
    if metadata_path.name != expected_name:
        raise RawArtifactError("chunk metadata filename differs from its row range")
    binary_path = output_dir / metadata.output.name
    _require_absolute_nonsymlink(binary_path, "raw prediction chunk", regular_file=True)
    if binary_path.stat().st_size != metadata.output.size_bytes:
        raise RawArtifactError("raw prediction chunk size differs from metadata")
    if sha256_path(binary_path) != metadata.output.sha256:
        raise RawArtifactError("raw prediction chunk SHA-256 differs from metadata")
    values = np.memmap(binary_path, mode="r", dtype="<f4", shape=metadata.output.shape)
    try:
        if not np.isfinite(values).all() or np.any(np.diff(values[:, :, 1:], axis=-1) < 0):
            raise RawArtifactError("raw prediction chunk fails finite or monotonicity validation")
    finally:
        del values
    return metadata


def load_resume_state(
    output_dir: Path,
    *,
    artifact: LoadedRawInput,
    backend: str,
    batch_size: int,
    provenance: dict[str, JsonValue],
) -> ResumeState:
    output_dir = secure_output_directory(output_dir)
    manifest_path = output_dir / "manifest.json"
    prior_manifest: RawOutputManifest | None = None
    if manifest_path.exists():
        _require_absolute_nonsymlink(manifest_path, "raw output manifest", regular_file=True)
        _, decoded = _read_bounded_json(manifest_path, RAW_MAX_MANIFEST_BYTES)
        try:
            prior_manifest = RawOutputManifest.model_validate(decoded)
        except ValidationError as error:
            raise RawArtifactError("raw output manifest is invalid") from error
        expected = (
            artifact.manifest_sha256,
            artifact.artifact_digest,
            artifact.manifest.cadence_seconds,
            artifact.manifest.row_count,
            backend,
            batch_size,
            artifact.manifest.model_seed,
            provenance,
        )
        observed = (
            prior_manifest.input_manifest_sha256,
            prior_manifest.input_artifact_digest,
            prior_manifest.cadence_seconds,
            prior_manifest.row_count,
            prior_manifest.backend,
            prior_manifest.batch_size,
            prior_manifest.model_seed,
            prior_manifest.provenance,
        )
        if observed != expected:
            raise RawArtifactError("resume output does not match the requested input, backend, or provenance")
    chunk_paths = sorted((output_dir / RAW_CHUNK_DIRECTORY).glob("chunk-*.json"))
    chunks: list[RawChunkMetadata] = []
    names: list[str] = []
    next_row = 0
    contexts = open_contexts(artifact)
    try:
        for metadata_path in chunk_paths:
            metadata = _load_chunk(output_dir, metadata_path)
            if metadata.start_row != next_row:
                raise RawArtifactError("resume chunks are not one verified contiguous row range")
            if (
                metadata.end_row > artifact.manifest.row_count
                or metadata.backend != backend
                or metadata.batch_size != batch_size
                or metadata.model_seed != artifact.manifest.model_seed
                or metadata.provenance != provenance
            ):
                raise RawArtifactError("resume chunk does not match the active raw generation contract")
            expected_input_digest = chunk_input_digest(
                artifact,
                metadata.start_row,
                np.asarray(contexts[metadata.start_row : metadata.end_row]),
            )
            if metadata.input_digest != expected_input_digest:
                raise RawArtifactError("raw prediction chunk input digest differs from contexts.f32")
            chunks.append(metadata)
            names.append(f"{RAW_CHUNK_DIRECTORY}/{metadata_path.name}")
            next_row = metadata.end_row
    finally:
        del contexts
    if prior_manifest is not None:
        prior_names = prior_manifest.chunks
        if tuple(names[: len(prior_names)]) != prior_names:
            raise RawArtifactError("raw output manifest is not a prefix of verified resume chunks")
        if prior_manifest.completed_rows > next_row:
            raise RawArtifactError("raw output manifest advances beyond verified resume chunks")
    return ResumeState(next_row=next_row, chunks=tuple(chunks), chunk_metadata_names=tuple(names))


def write_output_manifest(
    output_dir: Path,
    *,
    artifact: LoadedRawInput,
    backend: str,
    batch_size: int,
    provenance: dict[str, JsonValue],
    state: ResumeState,
) -> RawOutputManifest:
    manifest = RawOutputManifest(
        schema_version=RAW_OUTPUT_SCHEMA,
        input_manifest_sha256=artifact.manifest_sha256,
        input_artifact_digest=artifact.artifact_digest,
        cadence_seconds=artifact.manifest.cadence_seconds,
        horizon_minutes=artifact.manifest.horizon_minutes,
        row_count=artifact.manifest.row_count,
        context_bars=RAW_CONTEXT_BARS,
        output_shape=(
            artifact.manifest.row_count,
            RAW_OUTPUT_HORIZONS,
            RAW_OUTPUT_COLUMNS,
        ),
        backend=backend,
        batch_size=batch_size,
        routing_seed_policy=RAW_ROUTING_POLICY,
        model_seed=artifact.manifest.model_seed,
        provenance=provenance,
        chunks=state.chunk_metadata_names,
        completed_rows=state.next_row,
        complete=state.next_row == artifact.manifest.row_count,
    )
    atomic_write(output_dir / "manifest.json", canonical_json_bytes(manifest))
    return manifest
