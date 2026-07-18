from __future__ import annotations

import gzip
import hashlib
import hmac
import json
import math
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

SCHEMA_VERSION = "1.0"
SUPPORTED_ENGINE_VERSION = "portfolio-lens-2026.07"
ARTIFACT_FORMAT = "application/json"
ARTIFACT_ENCODING = "gzip"


class JobKind(StrEnum):
    BACKTEST = "backtest"
    OPTIMIZATION = "optimization"
    WALK_FORWARD = "walk_forward"
    STRESS_TEST = "stress_test"
    WEIGHT_SENSITIVITY = "weight_sensitivity"
    START_DATE_SENSITIVITY = "start_date_sensitivity"
    REBALANCE_SENSITIVITY = "rebalance_sensitivity"
    CASH_FLOW_SENSITIVITY = "cash_flow_sensitivity"


class WorkerInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["1.0"]
    engine_version: str = Field(min_length=1, max_length=64)
    run_id: str = Field(min_length=1, max_length=64)
    job_kind: JobKind
    data_revision: str = Field(min_length=1, max_length=128)
    request_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    payload: dict[str, Any]

    @field_validator("job_kind", mode="before")
    @classmethod
    def parse_job_kind(cls, value: Any) -> JobKind:
        return value if isinstance(value, JobKind) else JobKind(value)


class OutputArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    type: str = Field(min_length=1, max_length=64)
    content: Any
    row_count: int | None = Field(default=None, ge=0)


class WorkerOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["1.0"]
    engine_version: str = Field(min_length=1, max_length=64)
    run_id: str = Field(min_length=1, max_length=64)
    job_kind: JobKind
    status: Literal["completed", "failed", "cancelled"]
    summary: Any = None
    result: Any = None
    error: Any = None
    warnings: list[str]
    artifacts: list[OutputArtifact] | None = None

    @field_validator("job_kind", mode="before")
    @classmethod
    def parse_job_kind(cls, value: Any) -> JobKind:
        return value if isinstance(value, JobKind) else JobKind(value)

    @field_validator("warnings")
    @classmethod
    def deduplicate_warnings(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))


Contract = WorkerInput | WorkerOutput
CONTRACT_ADAPTER = TypeAdapter(Contract)


def _utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", errors="surrogatepass")


def _canonical_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("worker payload contains a non-finite number")
        return 0 if value == 0 else value
    if isinstance(value, list):
        return [_canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _canonical_value(value[key])
            for key in sorted(value, key=_utf16_sort_key)
        }
    raise TypeError(f"worker payload contains a non-JSON value: {type(value).__name__}")


def canonical_json(value: BaseModel | dict[str, Any]) -> bytes:
    raw = value.model_dump(mode="json", exclude_none=True) if isinstance(value, BaseModel) else value
    return json.dumps(
        _canonical_value(raw),
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")


def encode_artifact(value: Contract) -> tuple[bytes, str, int]:
    source = canonical_json(value)
    return gzip.compress(source, compresslevel=6, mtime=0), hashlib.sha256(source).hexdigest(), len(source)


def decode_artifact(content: bytes, expected_checksum: str, *, expect_input: bool) -> WorkerInput | WorkerOutput:
    source = gzip.decompress(content)
    checksum = hashlib.sha256(source).hexdigest()
    if not hmac.compare_digest(checksum, expected_checksum):
        raise ValueError("worker artifact checksum mismatch")
    parsed = json.loads(source)
    return WorkerInput.model_validate(parsed) if expect_input else WorkerOutput.model_validate(parsed)
