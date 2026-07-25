from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Literal, TypeAlias

from pydantic import Field, ValidationError, model_validator

from .contracts import (
    FINCAST_QUALIFICATION_CONTEXT_COUNT,
    FINCAST_QUALIFICATION_ROW_COUNT,
    MAX_QUANTILE_ADJUSTMENT_IQR_RATIO,
    QuantileRearrangementObservations,
    StrictModel,
)

SCHEMA_VERSION = "fincast-precision-validation/v3"
MIXED_RUNTIME_POLICY_VERSION = "fincast-mixed-runtime-policy/v1"
EXPECTED_CONTEXT_COUNT = FINCAST_QUALIFICATION_CONTEXT_COUNT
EXPECTED_TORCH_VERSION = "2.6.0"
EXPECTED_CUDA_RUNTIME_VERSION = "12.4"
EXPECTED_GPU_NAME = "Tesla P40"
EXPECTED_CUDA_CAPABILITY = "6.1"
MIN_DIRECTION_AGREEMENT = 0.99
MAX_Q50_MEDIAN_IQR_RATIO = 0.05
MAX_Q50_P95_IQR_RATIO = 0.15
MIN_PEAK_VRAM_REDUCTION = 0.25
QUANTILE_MONOTONICITY_POLICY = "fp32_monotone_rearrangement_v1"
MAX_OBSERVED_QUANTILE_ROWS = FINCAST_QUALIFICATION_ROW_COUNT
MAX_OBSERVED_Q50_ADJUSTMENT_IQR_RATIO = MAX_QUANTILE_ADJUSTMENT_IQR_RATIO

MixedRuntimeFailureCode: TypeAlias = Literal[
    "mixed_cuda_out_of_memory",
    "mixed_unsupported_operation",
    "mixed_setup_failure",
    "mixed_model_load_failure",
    "mixed_inference_failure",
    "mixed_evaluation_failure",
]
MixedRuntimeFailureStage: TypeAlias = Literal["setup", "load", "inference", "evaluation"]
SanitizedExceptionClass: TypeAlias = Literal[
    "OutOfMemoryError",
    "MemoryError",
    "NotImplementedError",
    "RuntimeError",
    "ValueError",
    "TypeError",
    "OtherException",
]
MixedPrecisionFailureReason: TypeAlias = Literal[
    "non_finite_output",
    "quantile_postprocessing_failed",
    "signal_direction_agreement_below_99pct",
    "q50_median_error_above_5pct_fp32_iqr",
    "q50_p95_error_above_15pct_fp32_iqr",
    "peak_vram_reduction_below_25pct",
    "mixed_cuda_out_of_memory",
    "mixed_unsupported_operation",
    "mixed_setup_failure",
    "mixed_model_load_failure",
    "mixed_inference_failure",
    "mixed_evaluation_failure",
]


class PrecisionArtifact(StrictModel):
    file: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    peak_vram_bytes: int = Field(ge=0)
    peak_vram_measurement: Literal["cuda_allocated_or_reserved"]
    peak_vram_measurement_complete: bool


class MixedPrecisionMetrics(StrictModel):
    finite: bool
    quantile_monotonic: bool
    signal_direction_agreement: float = Field(ge=0, le=1)
    q50_median_iqr_ratio: float = Field(ge=0)
    q50_p95_iqr_ratio: float = Field(ge=0)
    peak_vram_reduction: float


class MixedPrecisionRuntimeFailure(StrictModel):
    code: MixedRuntimeFailureCode
    stage: MixedRuntimeFailureStage
    exception_class: SanitizedExceptionClass

    @model_validator(mode="after")
    def stage_matches_failure_code(self) -> "MixedPrecisionRuntimeFailure":
        stage_specific_codes: dict[MixedRuntimeFailureCode, MixedRuntimeFailureStage] = {
            "mixed_setup_failure": "setup",
            "mixed_model_load_failure": "load",
            "mixed_inference_failure": "inference",
            "mixed_evaluation_failure": "evaluation",
        }
        expected_stage = stage_specific_codes.get(self.code)
        if expected_stage is not None and self.stage != expected_stage:
            raise ValueError("mixed runtime failure stage does not match its bounded code")
        if self.exception_class in {"OutOfMemoryError", "MemoryError"} and self.code != "mixed_cuda_out_of_memory":
            raise ValueError("out-of-memory exception class requires the bounded OOM code")
        if self.exception_class == "NotImplementedError" and self.code != "mixed_unsupported_operation":
            raise ValueError("not-implemented exception class requires the bounded unsupported-operation code")
        return self


class QualificationEnvironment(StrictModel):
    torch_version: Literal["2.6.0"]
    cuda_runtime_version: Literal["12.4"]
    gpu_name: Literal["Tesla P40"]
    cuda_capability: Literal["6.1"]


class FinCastPrecisionValidation(StrictModel):
    schema_version: Literal["fincast-precision-validation/v3"]
    model_id: Literal["Vincent05R/FinCast"]
    model_revision: Literal["2d7d90b159db8961d27c2cf165d51195902ef92b"]
    source_revision: Literal["488b19d1d85fa2b3d4b93469530cefdcf1cc97a4"]
    mixed_runtime_policy_version: Literal["fincast-mixed-runtime-policy/v1"]
    qualification_environment: QualificationEnvironment
    context_fixture_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    context_count: Literal[128]
    quantile_tail_policy: Literal["tail_clamped_q10_q90"]
    quantile_monotonicity_policy: Literal["fp32_monotone_rearrangement_v1"]
    fp32_quantile_observations: QuantileRearrangementObservations
    mixed_quantile_observations: QuantileRearrangementObservations | None
    fp32: PrecisionArtifact
    mixed_fp16: PrecisionArtifact
    mixed_run_status: Literal["completed", "runtime_failed"]
    mixed_runtime_failure: MixedPrecisionRuntimeFailure | None
    mixed_metrics: MixedPrecisionMetrics | None
    mixed_failure_reasons: tuple[MixedPrecisionFailureReason, ...]
    selected_precision: Literal["float32", "mixed_float16"]

    @model_validator(mode="after")
    def gate_matches_metrics(self) -> "FinCastPrecisionValidation":
        if (
            self.fp32_quantile_observations.row_count != MAX_OBSERVED_QUANTILE_ROWS
            or self.fp32_quantile_observations.non_finite_value_count != 0
            or not self.fp32_quantile_observations.postprocessed_monotonic
        ):
            raise ValueError(
                "FP32 baseline quantile postprocessing must cover 128x60 finite monotonic rows"
            )
        if self.fp32.file != "model.fp32.safetensors":
            raise ValueError("FP32 fallback artifact name is not pinned")
        if self.fp32.peak_vram_bytes <= 0 or not self.fp32.peak_vram_measurement_complete:
            raise ValueError("FP32 baseline requires a completed positive peak VRAM measurement")
        if self.mixed_fp16.file != "model.mixed-fp16.safetensors":
            raise ValueError("mixed FP16 artifact name is not pinned")

        if self.mixed_run_status == "completed":
            if (
                self.mixed_metrics is None
                or self.mixed_runtime_failure is not None
                or self.mixed_quantile_observations is None
                or self.mixed_quantile_observations.row_count
                != MAX_OBSERVED_QUANTILE_ROWS
            ):
                raise ValueError(
                    "completed mixed qualification requires metrics for all 128x60 rows"
                )
            if self.mixed_fp16.peak_vram_bytes <= 0 or not self.mixed_fp16.peak_vram_measurement_complete:
                raise ValueError("completed mixed qualification requires a completed positive peak measurement")
            if self.mixed_metrics.finite != (
                self.mixed_quantile_observations.non_finite_value_count == 0
            ):
                raise ValueError("mixed finite metric differs from its raw quantile observations")
            if (
                self.mixed_metrics.quantile_monotonic
                != self.mixed_quantile_observations.postprocessed_monotonic
            ):
                raise ValueError("mixed monotonic metric differs from its quantile postprocessing")
        else:
            if (
                self.mixed_metrics is not None
                or self.mixed_runtime_failure is None
                or self.mixed_quantile_observations is not None
            ):
                raise ValueError("failed mixed runtime requires a bounded failure and no numeric metrics")
            if (
                self.mixed_runtime_failure.stage != "evaluation"
                and self.mixed_fp16.peak_vram_measurement_complete
            ):
                raise ValueError("an interrupted mixed run cannot claim a completed peak measurement")

        expected = precision_failure_reasons(
            self.mixed_metrics,
            runtime_failure=self.mixed_runtime_failure,
        )
        if self.mixed_failure_reasons != expected:
            raise ValueError("mixed precision failure reasons do not match the fixed qualification gates")
        selected = "mixed_float16" if not expected else "float32"
        if self.selected_precision != selected:
            raise ValueError("selected precision does not match the fixed qualification gates")
        return self


def qualification_environment_from_torch(torch: object) -> QualificationEnvironment:
    """Return the bounded qualification identity or reject an unqualified runtime."""

    try:
        raw_torch_version = str(getattr(torch, "__version__"))
        torch_version = raw_torch_version.partition("+")[0]
        torch_version_module = getattr(torch, "version")
        cuda_runtime_version = str(getattr(torch_version_module, "cuda"))
        cuda = getattr(torch, "cuda")
        gpu_name = str(cuda.get_device_name()).strip()
        raw_capability = cuda.get_device_capability()
        cuda_capability = f"{int(raw_capability[0])}.{int(raw_capability[1])}"
    except (AttributeError, IndexError, TypeError, ValueError) as error:
        raise ValueError("FinCast qualification environment is unavailable") from error

    observed = {
        "torch_version": torch_version,
        "cuda_runtime_version": cuda_runtime_version,
        "gpu_name": gpu_name,
        "cuda_capability": cuda_capability,
    }
    expected = {
        "torch_version": EXPECTED_TORCH_VERSION,
        "cuda_runtime_version": EXPECTED_CUDA_RUNTIME_VERSION,
        "gpu_name": EXPECTED_GPU_NAME,
        "cuda_capability": EXPECTED_CUDA_CAPABILITY,
    }
    if observed != expected:
        raise ValueError("FinCast runtime does not match the pinned qualification environment")
    return QualificationEnvironment.model_validate(observed)


def validate_qualification_runtime(
    validation: FinCastPrecisionValidation,
    torch: object,
) -> None:
    """Reject stale validation or a runtime that differs from its qualification."""

    if validation.mixed_runtime_policy_version != MIXED_RUNTIME_POLICY_VERSION:
        raise ValueError("FinCast precision validation uses a stale mixed runtime policy")
    observed = qualification_environment_from_torch(torch)
    if observed != validation.qualification_environment:
        raise ValueError("FinCast runtime differs from its precision qualification environment")


def precision_failure_reasons(
    metrics: MixedPrecisionMetrics | None,
    *,
    runtime_failure: MixedPrecisionRuntimeFailure | None = None,
) -> tuple[MixedPrecisionFailureReason, ...]:
    if runtime_failure is not None:
        if metrics is not None:
            raise ValueError("runtime failure and numeric mixed metrics are mutually exclusive")
        return (runtime_failure.code,)
    if metrics is None:
        raise ValueError("numeric mixed metrics are required when no runtime failure is recorded")

    reasons: list[MixedPrecisionFailureReason] = []
    if not metrics.finite:
        reasons.append("non_finite_output")
    if metrics.finite and not metrics.quantile_monotonic:
        reasons.append("quantile_postprocessing_failed")
    if metrics.signal_direction_agreement < MIN_DIRECTION_AGREEMENT:
        reasons.append("signal_direction_agreement_below_99pct")
    if metrics.q50_median_iqr_ratio > MAX_Q50_MEDIAN_IQR_RATIO:
        reasons.append("q50_median_error_above_5pct_fp32_iqr")
    if metrics.q50_p95_iqr_ratio > MAX_Q50_P95_IQR_RATIO:
        reasons.append("q50_p95_error_above_15pct_fp32_iqr")
    if metrics.peak_vram_reduction < MIN_PEAK_VRAM_REDUCTION:
        reasons.append("peak_vram_reduction_below_25pct")
    return tuple(reasons)


def serialize_precision_validation(validation: FinCastPrecisionValidation) -> str:
    """Return canonical standard JSON after revalidating any copied/constructed model."""

    checked = FinCastPrecisionValidation.model_validate(validation.model_dump(mode="python"))
    return json.dumps(
        checked.model_dump(mode="json"),
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_precision_validation(path: Path) -> FinCastPrecisionValidation:
    try:
        raw = path.read_bytes()
        return FinCastPrecisionValidation.model_validate_json(raw)
    except (OSError, ValidationError) as error:
        raise ValueError("FinCast precision validation is unavailable or invalid") from error


def quantile_is_monotonic(values: list[float]) -> bool:
    return all(math.isfinite(value) for value in values) and all(
        right >= left for left, right in zip(values, values[1:], strict=False)
    )


def _interpolate_cdf(points: list[tuple[float, float]], value: float) -> float:
    if value <= points[0][1]:
        return points[0][0]
    if value >= points[-1][1]:
        return points[-1][0]
    for (left_q, left_value), (right_q, right_value) in zip(points, points[1:], strict=False):
        if value > right_value:
            continue
        if right_value == left_value:
            return right_q
        weight = (value - left_value) / (right_value - left_value)
        return left_q + (right_q - left_q) * weight
    return 0.5


def cost_exceeding_direction(
    quantile_returns: list[tuple[float, float]],
    round_trip_cost_rate: float,
) -> int:
    """Mirror server/crypto/futures-risk.ts signalFromQuantileCdf.

    Returns 1 for long, -1 for short, and 0 for flat. The 0.55 threshold and
    tie-to-long behavior intentionally match the Node risk policy.
    """

    points = sorted(quantile_returns)
    if not math.isfinite(round_trip_cost_rate) or round_trip_cost_rate < 0:
        raise ValueError("round-trip cost rate must be finite and non-negative")
    if len(points) < 3 or any(
        not 0 < quantile < 1
        or not math.isfinite(value)
        or (index > 0 and (quantile <= points[index - 1][0] or value < points[index - 1][1]))
        for index, (quantile, value) in enumerate(points)
    ):
        raise ValueError("return quantiles must be finite, strictly keyed, and value-monotone")
    probability_above_cost = min(1.0, max(0.0, 1 - _interpolate_cdf(points, round_trip_cost_rate)))
    probability_below_negative_cost = min(
        1.0,
        max(0.0, _interpolate_cdf(points, -round_trip_cost_rate)),
    )
    confidence = max(probability_above_cost, probability_below_negative_cost)
    if confidence < 0.55:
        return 0
    return 1 if probability_above_cost >= probability_below_negative_cost else -1
