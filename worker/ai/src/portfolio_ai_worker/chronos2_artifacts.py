from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError, field_validator, model_validator

from .chronos2 import (
    CHRONOS2_INPUT_PROFILES,
    CHRONOS2_NATIVE_QUANTILES,
    CHRONOS2_PADDED_PREDICTION_STEPS,
    Chronos2InputProfile,
)
from .chronos2_raw_inference import (
    CHRONOS2_RAW_HORIZONS,
    CHRONOS2_RAW_OUTPUT_COLUMNS,
    CHRONOS2_RAW_OUTPUT_SCHEMA,
    Chronos2RawBackend,
    chronos2_raw_output_digest,
)
from .raw_artifacts import (
    RAW_MAX_MANIFEST_BYTES,
    RAW_MAX_ORIGIN_LINE_BYTES,
    RAW_MAX_ROWS,
    RawArtifactError,
    RawFileSpec,
    RawOrigin,
    atomic_write,
    canonical_json_bytes,
    secure_output_directory,
    sha256_path,
)

CHRONOS2_RAW_INPUT_SCHEMA = "chronos2-raw-input/v1"
CHRONOS2_RAW_INPUT_SCHEMA_V2 = "chronos2-raw-input/v2"
CHRONOS2_RAW_CHUNK_SCHEMA = "chronos2-raw-prediction-chunk/v1"
CHRONOS2_RAW_CHUNK_DIRECTORY = "chunks"
CHRONOS2_DETERMINISM_POLICY = "chronos2-deterministic-no-rng-cross-learning-disabled/v1"
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SAFE_FILE_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")


class Chronos2InputFiles(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    contexts: RawFileSpec
    context_mask: RawFileSpec
    future_covariates: RawFileSpec
    future_covariates_mask: RawFileSpec
    origins: RawFileSpec

    @model_validator(mode="after")
    def _canonical_names(self) -> Chronos2InputFiles:
        expected = {
            "contexts": "contexts.f32",
            "context_mask": "context-mask.u8",
            "future_covariates": "future-covariates.f32",
            "future_covariates_mask": "future-covariates-mask.u8",
            "origins": "origins.jsonl",
        }
        for field, name in expected.items():
            if getattr(self, field).name != name:
                raise ValueError(f"Chronos-2 raw input {field} must use {name}")
        return self


class Chronos2InputManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["chronos2-raw-input/v1", "chronos2-raw-input/v2"]
    profile: Literal[
        "close_only",
        "ohlcv_calendar",
        "microstructure_calendar",
        "derivatives_calendar",
    ]
    cadence_seconds: Literal[60]
    horizon_minutes: tuple[Literal[5], Literal[15], Literal[30], Literal[60]]
    prediction_steps: Literal[60]
    padded_prediction_steps: Literal[64]
    row_count: int = Field(ge=1, le=RAW_MAX_ROWS)
    row_order: Literal["row_id_ascending"]
    context_bars: Literal[512, 1024, 2048, 4096, 8192]
    variate_names: tuple[str, ...] = Field(min_length=1, max_length=64)
    target_variate_index: Literal[0]
    native_quantiles: tuple[float, ...]
    files: Chronos2InputFiles
    metadata: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("horizon_minutes", "variate_names", mode="before")
    @classmethod
    def _tuples(cls, value: tuple[Any, ...] | list[Any]) -> tuple[Any, ...]:
        return tuple(value)

    @field_validator("variate_names")
    @classmethod
    def _unique_variates(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if (
            value[0] != "target_close"
            or len(set(value)) != len(value)
            or any(not _SAFE_FILE_NAME.fullmatch(item) for item in value)
        ):
            raise ValueError("Chronos-2 variates must be unique safe names with target_close first")
        return value

    @field_validator("native_quantiles", mode="before")
    @classmethod
    def _quantiles(cls, value: tuple[float, ...] | list[float]) -> tuple[float, ...]:
        result = tuple(float(item) for item in value)
        if result != CHRONOS2_NATIVE_QUANTILES:
            raise ValueError("Chronos-2 raw input must preserve all pinned native quantiles")
        return result

    @model_validator(mode="after")
    def _binary_sizes(self) -> Chronos2InputManifest:
        if self.schema_version == CHRONOS2_RAW_INPUT_SCHEMA and self.context_bars != 512:
            raise ValueError("chronos2-raw-input/v1 remains fixed at 512 context bars")
        rows = self.row_count
        variates = len(self.variate_names)
        context_values = rows * variates * self.context_bars
        future_values = rows * variates * CHRONOS2_PADDED_PREDICTION_STEPS
        expected = {
            "contexts": context_values * np.dtype("<f4").itemsize,
            "context_mask": context_values,
            "future_covariates": future_values * np.dtype("<f4").itemsize,
            "future_covariates_mask": future_values,
        }
        for field, size in expected.items():
            if getattr(self.files, field).size_bytes != size:
                raise ValueError(f"Chronos-2 {field} binary size differs from its fixed shape")
        return self


class Chronos2PredictionFile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str
    size_bytes: int = Field(ge=1)
    sha256: str
    dtype: Literal["little-endian-float32"]
    shape: tuple[int, Literal[4], Literal[22]]

    @field_validator("shape", mode="before")
    @classmethod
    def _shape_tuple(cls, value: tuple[int, int, int] | list[int]) -> tuple[int, int, int]:
        return tuple(value)

    @field_validator("name")
    @classmethod
    def _safe_name(cls, value: str) -> str:
        candidate = Path(value)
        if (
            candidate.is_absolute()
            or len(candidate.parts) != 2
            or candidate.parts[0] != CHRONOS2_RAW_CHUNK_DIRECTORY
            or not _SAFE_FILE_NAME.fullmatch(candidate.parts[1])
        ):
            raise ValueError("Chronos-2 prediction chunk path is unsafe")
        return value

    @field_validator("sha256")
    @classmethod
    def _digest(cls, value: str) -> str:
        if not _SHA256_PATTERN.fullmatch(value):
            raise ValueError("Chronos-2 prediction SHA-256 is invalid")
        return value

    @model_validator(mode="after")
    def _size(self) -> Chronos2PredictionFile:
        if self.size_bytes != math.prod(self.shape) * np.dtype("<f4").itemsize:
            raise ValueError("Chronos-2 prediction chunk size differs from its shape")
        return self


class Chronos2Chunk(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["chronos2-raw-prediction-chunk/v1"]
    start_row: int = Field(ge=0, le=RAW_MAX_ROWS - 1)
    end_row: int = Field(ge=1, le=RAW_MAX_ROWS)
    input_digest: str
    output: Chronos2PredictionFile
    backend: Literal[
        "pipeline_eager",
        "worker_local",
        "no_padding",
        "gpu_gather",
        "cuda_graph",
    ]
    variate_batch_size: int = Field(ge=1, le=4096)
    task_batch_size: int = Field(ge=1, le=4096)
    determinism_policy: Literal[
        "chronos2-deterministic-no-rng-cross-learning-disabled/v1"
    ]
    provenance: dict[str, JsonValue]
    latency: dict[str, JsonValue]
    gpu_telemetry: dict[str, JsonValue]

    @field_validator("input_digest")
    @classmethod
    def _input_digest(cls, value: str) -> str:
        if not _SHA256_PATTERN.fullmatch(value):
            raise ValueError("Chronos-2 chunk input digest is invalid")
        return value

    @model_validator(mode="after")
    def _range(self) -> Chronos2Chunk:
        if (
            self.end_row <= self.start_row
            or self.output.shape[0] != self.end_row - self.start_row
        ):
            raise ValueError("Chronos-2 chunk range differs from its output shape")
        return self


class Chronos2OutputManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["chronos2-raw-predictions/v1"]
    input_manifest_sha256: str
    input_artifact_digest: str
    profile: str
    row_count: int = Field(ge=1, le=RAW_MAX_ROWS)
    output_shape: tuple[int, Literal[4], Literal[22]]
    horizons_minutes: tuple[Literal[5], Literal[15], Literal[30], Literal[60]]
    output_columns: tuple[str, ...]
    backend: Literal[
        "pipeline_eager",
        "worker_local",
        "no_padding",
        "gpu_gather",
        "cuda_graph",
    ]
    variate_batch_size: int = Field(ge=1, le=4096)
    task_batch_size: int = Field(ge=1, le=4096)
    determinism_policy: Literal[
        "chronos2-deterministic-no-rng-cross-learning-disabled/v1"
    ]
    provenance: dict[str, JsonValue]
    chunks: tuple[str, ...]
    completed_rows: int = Field(ge=0, le=RAW_MAX_ROWS)
    complete: bool

    @field_validator(
        "output_shape",
        "horizons_minutes",
        "output_columns",
        "chunks",
        mode="before",
    )
    @classmethod
    def _tuples(cls, value: tuple[Any, ...] | list[Any]) -> tuple[Any, ...]:
        return tuple(value)

    @field_validator("input_manifest_sha256", "input_artifact_digest")
    @classmethod
    def _digests(cls, value: str) -> str:
        if not _SHA256_PATTERN.fullmatch(value):
            raise ValueError("Chronos-2 output manifest digest is invalid")
        return value

    @model_validator(mode="after")
    def _shape(self) -> Chronos2OutputManifest:
        if self.output_shape != (self.row_count, 4, CHRONOS2_RAW_OUTPUT_COLUMNS):
            raise ValueError("Chronos-2 raw output shape must be [rows,4,22]")
        if self.complete != (self.completed_rows == self.row_count):
            raise ValueError("Chronos-2 raw completion marker is inconsistent")
        if len(self.output_columns) != CHRONOS2_RAW_OUTPUT_COLUMNS:
            raise ValueError("Chronos-2 raw output columns are incomplete")
        return self


@dataclass(frozen=True, slots=True)
class LoadedChronos2Input:
    manifest_path: Path
    root: Path
    manifest: Chronos2InputManifest
    manifest_sha256: str
    artifact_digest: str
    paths: dict[str, Path]


@dataclass(frozen=True, slots=True)
class Chronos2ResumeState:
    next_row: int
    chunks: tuple[Chronos2Chunk, ...]
    chunk_names: tuple[str, ...]


def _absolute_regular(path: Path, label: str) -> Path:
    if (
        not path.is_absolute()
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_file()
    ):
        raise RawArtifactError(f"{label} must be an absolute normalized regular file")
    return path


def _read_json(path: Path) -> tuple[bytes, Any]:
    if path.stat().st_size < 1 or path.stat().st_size > RAW_MAX_MANIFEST_BYTES:
        raise RawArtifactError(f"{path.name} exceeds its bounded JSON size")
    payload = path.read_bytes()
    try:
        return payload, json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RawArtifactError(f"{path.name} is invalid UTF-8 JSON") from error


def _member(root: Path, spec: RawFileSpec) -> Path:
    path = root / spec.name
    _absolute_regular(path, spec.name)
    if path.parent != root or path.stat().st_size != spec.size_bytes:
        raise RawArtifactError(f"{spec.name} size or location differs from the manifest")
    if sha256_path(path) != spec.sha256:
        raise RawArtifactError(f"{spec.name} SHA-256 differs from the manifest")
    return path


def _validate_origins(path: Path, row_count: int) -> None:
    count = 0
    with path.open("rb") as handle:
        for count, line in enumerate(handle, start=1):
            if (
                len(line) > RAW_MAX_ORIGIN_LINE_BYTES
                or not line.endswith(b"\n")
                or not line.strip()
            ):
                raise RawArtifactError("Chronos-2 origins contain an oversized or malformed row")
            try:
                origin = RawOrigin.model_validate_json(line)
            except (ValidationError, UnicodeDecodeError) as error:
                raise RawArtifactError(f"Chronos-2 origin row {count - 1} is invalid") from error
            if origin.row_id != count - 1:
                raise RawArtifactError("Chronos-2 origin row IDs must be contiguous")
    if count != row_count:
        raise RawArtifactError("Chronos-2 origin count differs from its manifest")


def load_chronos2_input(manifest_path: Path) -> LoadedChronos2Input:
    manifest_path = _absolute_regular(manifest_path, "Chronos-2 raw manifest")
    root = manifest_path.parent
    if root.is_symlink() or root.resolve(strict=True) != root:
        raise RawArtifactError("Chronos-2 input directory must not traverse symlinks")
    payload, decoded = _read_json(manifest_path)
    try:
        manifest = Chronos2InputManifest.model_validate(decoded)
    except ValidationError as error:
        raise RawArtifactError(
            "input does not match chronos2-raw-input/v1 or chronos2-raw-input/v2"
        ) from error
    paths = {
        field: _member(root, getattr(manifest.files, field))
        for field in (
            "contexts",
            "context_mask",
            "future_covariates",
            "future_covariates_mask",
            "origins",
        )
    }
    _validate_origins(paths["origins"], manifest.row_count)
    manifest_sha256 = hashlib.sha256(payload).hexdigest()
    artifact_digest = hashlib.sha256(
        (
            manifest.schema_version
            + "\0"
            + manifest_sha256
            + "\0"
            + "\0".join(
                getattr(manifest.files, field).sha256
                for field in (
                    "contexts",
                    "context_mask",
                    "future_covariates",
                    "future_covariates_mask",
                    "origins",
                )
            )
        ).encode("ascii")
    ).hexdigest()
    artifact = LoadedChronos2Input(
        manifest_path=manifest_path,
        root=root,
        manifest=manifest,
        manifest_sha256=manifest_sha256,
        artifact_digest=artifact_digest,
        paths=paths,
    )
    validate_chronos2_values(artifact)
    return artifact


def open_chronos2_arrays(
    artifact: LoadedChronos2Input,
) -> tuple[np.memmap, np.memmap, np.memmap, np.memmap]:
    shape = (
        artifact.manifest.row_count,
        len(artifact.manifest.variate_names),
    )
    contexts = np.memmap(
        artifact.paths["contexts"],
        mode="r",
        dtype="<f4",
        shape=(*shape, artifact.manifest.context_bars),
    )
    context_mask = np.memmap(
        artifact.paths["context_mask"],
        mode="r",
        dtype=np.uint8,
        shape=(*shape, artifact.manifest.context_bars),
    )
    future = np.memmap(
        artifact.paths["future_covariates"],
        mode="r",
        dtype="<f4",
        shape=(*shape, CHRONOS2_PADDED_PREDICTION_STEPS),
    )
    future_mask = np.memmap(
        artifact.paths["future_covariates_mask"],
        mode="r",
        dtype=np.uint8,
        shape=(*shape, CHRONOS2_PADDED_PREDICTION_STEPS),
    )
    return contexts, context_mask, future, future_mask


def validate_chronos2_values(artifact: LoadedChronos2Input) -> None:
    arrays = open_chronos2_arrays(artifact)
    contexts, context_mask, future, future_mask = arrays
    try:
        for start in range(0, artifact.manifest.row_count, 2048):
            stop = min(start + 2048, artifact.manifest.row_count)
            context_values = np.asarray(contexts[start:stop])
            context_masks = np.asarray(context_mask[start:stop])
            future_values = np.asarray(future[start:stop])
            future_masks = np.asarray(future_mask[start:stop])
            if not np.isfinite(context_values).all() or not np.isfinite(future_values).all():
                raise RawArtifactError("Chronos-2 raw binaries must contain finite values")
            if np.any((context_masks != 0) & (context_masks != 1)) or np.any(
                (future_masks != 0) & (future_masks != 1)
            ):
                raise RawArtifactError("Chronos-2 raw masks must be binary")
            if np.any(context_masks[:, 0] != 1) or np.any(context_values[:, 0] <= 0):
                raise RawArtifactError("Chronos-2 target closes must be positive and observed")
            if np.any(future_masks[:, 0] != 0):
                raise RawArtifactError("Chronos-2 future target values cannot be known")
    finally:
        del arrays


def chronos2_task_batch_size(variate_batch_size: int, variate_count: int) -> int:
    if variate_batch_size < 1 or variate_batch_size > 4096 or variate_count < 1:
        raise RawArtifactError("Chronos-2 batch or variate count is invalid")
    # Chronos-2's public batch size counts flattened target/covariate
    # variates, not logical forecast tasks. Keep a multivariate task atomic,
    # and never exceed the requested variate batch when at least one complete
    # task fits. A single task may necessarily exceed a smaller requested
    # batch (for example the 18-variate derivatives profile at B16).
    return max(1, variate_batch_size // variate_count)


def chunk_input_digest(
    artifact: LoadedChronos2Input,
    start_row: int,
    arrays: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray],
) -> str:
    digest = hashlib.sha256()
    digest.update(artifact.artifact_digest.encode("ascii"))
    digest.update(b"\0")
    digest.update(str(start_row).encode("ascii"))
    for value, dtype in zip(
        arrays,
        ("<f4", np.uint8, "<f4", np.uint8),
        strict=True,
    ):
        digest.update(b"\0")
        digest.update(np.ascontiguousarray(value, dtype=dtype).tobytes(order="C"))
    return digest.hexdigest()


def _chunk_stem(start_row: int, end_row: int) -> str:
    if start_row < 0 or end_row <= start_row or end_row > RAW_MAX_ROWS:
        raise RawArtifactError("Chronos-2 chunk range is invalid")
    return f"chunk-{start_row:010d}-{end_row:010d}"


def write_chronos2_chunk(
    output_dir: Path,
    predictions: np.ndarray,
    *,
    start_row: int,
    input_digest: str,
    backend: Chronos2RawBackend,
    variate_batch_size: int,
    task_batch_size: int,
    provenance: dict[str, JsonValue],
    latency: dict[str, JsonValue],
    gpu_telemetry: dict[str, JsonValue],
) -> Chronos2Chunk:
    values = np.ascontiguousarray(predictions, dtype="<f4")
    chronos2_raw_output_digest(values)
    end_row = start_row + len(values)
    stem = _chunk_stem(start_row, end_row)
    relative = f"{CHRONOS2_RAW_CHUNK_DIRECTORY}/{stem}.f32"
    payload = values.tobytes(order="C")
    atomic_write(output_dir / relative, payload)
    output = Chronos2PredictionFile(
        name=relative,
        size_bytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        dtype="little-endian-float32",
        shape=(len(values), 4, CHRONOS2_RAW_OUTPUT_COLUMNS),
    )
    chunk = Chronos2Chunk(
        schema_version=CHRONOS2_RAW_CHUNK_SCHEMA,
        start_row=start_row,
        end_row=end_row,
        input_digest=input_digest,
        output=output,
        backend=backend,
        variate_batch_size=variate_batch_size,
        task_batch_size=task_batch_size,
        determinism_policy=CHRONOS2_DETERMINISM_POLICY,
        provenance=provenance,
        latency=latency,
        gpu_telemetry=gpu_telemetry,
    )
    atomic_write(
        output_dir / CHRONOS2_RAW_CHUNK_DIRECTORY / f"{stem}.json",
        canonical_json_bytes(chunk),
    )
    return chunk


def _load_chunk(output_dir: Path, path: Path) -> Chronos2Chunk:
    _absolute_regular(path, "Chronos-2 chunk metadata")
    _payload, decoded = _read_json(path)
    try:
        chunk = Chronos2Chunk.model_validate(decoded)
    except ValidationError as error:
        raise RawArtifactError(f"Chronos-2 chunk metadata is invalid: {path.name}") from error
    if path.name != f"{_chunk_stem(chunk.start_row, chunk.end_row)}.json":
        raise RawArtifactError("Chronos-2 chunk filename differs from its range")
    output_path = output_dir / chunk.output.name
    _absolute_regular(output_path, "Chronos-2 prediction chunk")
    if (
        output_path.stat().st_size != chunk.output.size_bytes
        or sha256_path(output_path) != chunk.output.sha256
    ):
        raise RawArtifactError("Chronos-2 prediction chunk digest or size differs")
    values = np.memmap(
        output_path,
        mode="r",
        dtype="<f4",
        shape=chunk.output.shape,
    )
    try:
        chronos2_raw_output_digest(np.asarray(values))
    finally:
        del values
    return chunk


def load_chronos2_resume_state(
    output_dir: Path,
    *,
    artifact: LoadedChronos2Input,
    backend: Chronos2RawBackend,
    variate_batch_size: int,
    task_batch_size: int,
    provenance: dict[str, JsonValue],
) -> Chronos2ResumeState:
    output_dir = secure_output_directory(output_dir)
    arrays = open_chronos2_arrays(artifact)
    chunks: list[Chronos2Chunk] = []
    names: list[str] = []
    next_row = 0
    try:
        for path in sorted(
            (output_dir / CHRONOS2_RAW_CHUNK_DIRECTORY).glob("chunk-*.json")
        ):
            chunk = _load_chunk(output_dir, path)
            if (
                chunk.start_row != next_row
                or chunk.backend != backend
                or chunk.variate_batch_size != variate_batch_size
                or chunk.task_batch_size != task_batch_size
                or chunk.provenance != provenance
                or chunk.end_row > artifact.manifest.row_count
            ):
                raise RawArtifactError("Chronos-2 resume chunks are not one matching contiguous range")
            sliced = tuple(
                np.asarray(value[chunk.start_row : chunk.end_row])
                for value in arrays
            )
            if chunk.input_digest != chunk_input_digest(
                artifact,
                chunk.start_row,
                sliced,  # type: ignore[arg-type]
            ):
                raise RawArtifactError("Chronos-2 resume chunk input digest differs")
            chunks.append(chunk)
            names.append(f"{CHRONOS2_RAW_CHUNK_DIRECTORY}/{path.name}")
            next_row = chunk.end_row
    finally:
        del arrays
    return Chronos2ResumeState(
        next_row=next_row,
        chunks=tuple(chunks),
        chunk_names=tuple(names),
    )


def write_chronos2_output_manifest(
    output_dir: Path,
    *,
    artifact: LoadedChronos2Input,
    backend: Chronos2RawBackend,
    variate_batch_size: int,
    task_batch_size: int,
    provenance: dict[str, JsonValue],
    state: Chronos2ResumeState,
) -> Chronos2OutputManifest:
    columns = (
        "point_q50",
        *(f"q{value:g}" for value in CHRONOS2_NATIVE_QUANTILES),
    )
    manifest = Chronos2OutputManifest(
        schema_version=CHRONOS2_RAW_OUTPUT_SCHEMA,
        input_manifest_sha256=artifact.manifest_sha256,
        input_artifact_digest=artifact.artifact_digest,
        profile=artifact.manifest.profile,
        row_count=artifact.manifest.row_count,
        output_shape=(
            artifact.manifest.row_count,
            len(CHRONOS2_RAW_HORIZONS),
            CHRONOS2_RAW_OUTPUT_COLUMNS,
        ),
        horizons_minutes=CHRONOS2_RAW_HORIZONS,
        output_columns=columns,
        backend=backend,
        variate_batch_size=variate_batch_size,
        task_batch_size=task_batch_size,
        determinism_policy=CHRONOS2_DETERMINISM_POLICY,
        provenance=provenance,
        chunks=state.chunk_names,
        completed_rows=state.next_row,
        complete=state.next_row == artifact.manifest.row_count,
    )
    atomic_write(output_dir / "manifest.json", canonical_json_bytes(manifest))
    return manifest


def validated_profile(value: str) -> Chronos2InputProfile:
    if value not in CHRONOS2_INPUT_PROFILES:
        raise RawArtifactError("unsupported Chronos-2 input profile")
    return value  # type: ignore[return-value]


def empty_output_required(output_dir: Path) -> Path:
    if output_dir.exists():
        if output_dir.is_symlink() or not output_dir.is_dir():
            raise RawArtifactError("Chronos-2 output must be a non-symlink directory")
        if any(output_dir.iterdir()):
            raise RawArtifactError("Chronos-2 output must be empty unless --resume is used")
    return secure_output_directory(output_dir)
