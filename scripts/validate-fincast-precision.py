#!/usr/bin/env python3
"""Qualify FinCast mixed FP16 against FP32 on 128 fixed crypto contexts."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import gc
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import uuid

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "worker" / "ai" / "src"))

from portfolio_ai_worker.adapters import RuntimeDevice  # noqa: E402
from portfolio_ai_worker.contracts import (  # noqa: E402
    FINCAST_QUALIFICATION_CANDLE_SECONDS,
    FINCAST_QUALIFICATION_CASE_COUNT,
    FINCAST_QUALIFICATION_CONTEXT_COUNT,
    FINCAST_QUALIFICATION_NATIVE_HORIZON_STEPS,
    FINCAST_QUALIFICATION_ROW_COUNT,
)
from portfolio_ai_worker.fincast import (  # noqa: E402
    MODEL_REVISION,
    SOURCE_REVISION,
    _load_model,
    _source_snapshot,
    fincast_input_dtypes,
    observe_fincast_decode_output_dtypes,
    project_native_quantiles,
    rearrange_native_quantiles,
    validate_fincast_mixed_inference_observations,
)
from portfolio_ai_worker.precision_validation import (  # noqa: E402
    CADENCE_VALIDATION_SCOPE,
    SCHEMA_VERSION,
    FinCastPrecisionValidation,
    MixedPrecisionMetrics,
    MixedPrecisionRuntimeFailure,
    PrecisionArtifact,
    MAX_OBSERVED_Q50_ADJUSTMENT_IQR_RATIO,
    MIXED_RUNTIME_POLICY_VERSION,
    QUANTILE_MONOTONICITY_POLICY,
    SCALE_STRESS_POLICY,
    QuantileRearrangementObservations,
    cost_exceeding_direction,
    precision_failure_reasons,
    qualification_environment_from_torch,
    quantile_is_monotonic,
    serialize_precision_validation,
    sha256_file,
)

CONTEXT_SCHEMA = "fincast-crypto-contexts/v1"
ARTIFACT_FILES = ("model.fp32.safetensors", "model.mixed-fp16.safetensors")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
ForecastOutput = list[list[list[float]]]
_SCALE_STRESS_LAST_CLOSES = (131_072.0, 0.000_01)


@dataclass(frozen=True, slots=True)
class QualificationCase:
    instrument_key: str
    closes: tuple[float, ...]
    round_trip_cost_bps: float
    candle_seconds: int
    horizon_steps: int


@dataclass(frozen=True, slots=True)
class PrecisionRunFailureObservation:
    stage: str
    category: str
    exception_class: str


@dataclass(frozen=True, slots=True)
class PrecisionRunResult:
    forecasts: ForecastOutput | None
    peak_vram_bytes: int
    peak_vram_measurement_complete: bool
    failure: PrecisionRunFailureObservation | None
    quantile_observations: QuantileRearrangementObservations | None = None


def _qualification_cases(
    contexts: list[dict[str, object]],
) -> list[QualificationCase]:
    if len(contexts) != FINCAST_QUALIFICATION_CONTEXT_COUNT:
        raise ValueError("FinCast qualification requires exactly 128 source contexts")

    normalized: list[tuple[str, tuple[float, ...], float]] = []
    for index, context in enumerate(contexts):
        closes = tuple(float(value) for value in context["closes"])  # type: ignore[arg-type]
        cost_bps = float(context["round_trip_cost_bps"])
        if (
            len(closes) != 512
            or any(not math.isfinite(value) or value <= 0 for value in closes)
            or not math.isfinite(cost_bps)
            or cost_bps < 0
        ):
            raise ValueError("FinCast qualification source context is invalid")
        instrument_key = str(context.get("instrument_key", f"context-{index}"))
        normalized.append((instrument_key, closes, cost_bps))

    stress_source_key, stress_source_closes, stress_cost_bps = normalized[0]
    for target_last_close in _SCALE_STRESS_LAST_CLOSES:
        scale = target_last_close / stress_source_closes[-1]
        scaled = tuple(value * scale for value in stress_source_closes[:-1]) + (
            target_last_close,
        )
        if any(not math.isfinite(value) or value <= 0 for value in scaled):
            raise ValueError("FinCast qualification scale-stress context is invalid")
        normalized.append(
            (
                f"{stress_source_key}:scale-stress:{target_last_close:.8g}",
                scaled,
                stress_cost_bps,
            )
        )

    cases = [
        QualificationCase(
            instrument_key=instrument_key,
            closes=closes,
            round_trip_cost_bps=cost_bps,
            candle_seconds=candle_seconds,
            horizon_steps=horizon_steps,
        )
        for instrument_key, closes, cost_bps in normalized
        for candle_seconds, horizon_steps in zip(
            FINCAST_QUALIFICATION_CANDLE_SECONDS,
            FINCAST_QUALIFICATION_NATIVE_HORIZON_STEPS,
            strict=True,
        )
    ]
    if len(cases) != FINCAST_QUALIFICATION_CASE_COUNT:
        raise ValueError("FinCast qualification case construction is incomplete")
    return cases


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=REPOSITORY_ROOT / "worker" / "ai" / "model-manifest.json",
    )
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--contexts", type=Path, required=True)
    parser.add_argument("--device-index", type=int, default=0)
    return parser.parse_args()


def load_contexts(path: Path) -> tuple[list[dict[str, object]], str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    contexts = payload.get("contexts") if isinstance(payload, dict) else None
    source = payload.get("source") if isinstance(payload, dict) else None
    if (
        payload.get("schema_version") != CONTEXT_SCHEMA
        or source
        != {
            "venue": "BINANCE_USDM",
            "endpoint": "/fapi/v1/klines",
            "contract_type": "PERPETUAL",
            "quote_asset": "USDT",
            "interval": "1m",
            "fixed_end_at": "2026-07-01T00:00:00Z",
            "complete_only": True,
            "round_trip_cost_bps": 8.0,
        }
        or not isinstance(contexts, list)
        or len(contexts) != 128
    ):
        raise RuntimeError("FinCast validation requires exactly 128 fixed crypto contexts")
    normalized: list[dict[str, object]] = []
    keys: set[str] = set()
    for value in contexts:
        if not isinstance(value, dict):
            raise RuntimeError("FinCast validation context must be an object")
        key = value.get("instrument_key")
        closes = value.get("closes")
        cost_bps = value.get("round_trip_cost_bps")
        if (
            not isinstance(key, str)
            or not key
            or key in keys
            or not isinstance(closes, list)
            or len(closes) != 512
            or isinstance(cost_bps, bool)
            or not isinstance(cost_bps, (int, float))
            or not math.isfinite(float(cost_bps))
            or float(cost_bps) < 0
        ):
            raise RuntimeError("FinCast validation context identity, shape, or cost is invalid")
        numeric = [float(item) for item in closes]
        if any(not math.isfinite(item) or item <= 0 for item in numeric):
            raise RuntimeError("FinCast validation closes must be finite and positive")
        keys.add(key)
        normalized.append(
            {
                "instrument_key": key,
                "closes": numeric,
                "round_trip_cost_bps": float(cost_bps),
            }
        )
    return normalized, sha256_file(path)


def _has_symlink_component(path: Path) -> bool:
    absolute = path.absolute()
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        if current.is_symlink():
            return True
    return False


def _require_regular_file(path: Path, label: str) -> Path:
    if _has_symlink_component(path):
        raise RuntimeError(f"{label} must not be a symlink")
    try:
        metadata = path.stat(follow_symlinks=False)
    except OSError as error:
        raise RuntimeError(f"{label} is unavailable") from error
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0:
        raise RuntimeError(f"{label} must be a non-empty regular file")
    return path.resolve(strict=True)


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON object key")
        value[key] = item
    return value


def verify_qualification_cache(
    cache_path: Path,
) -> tuple[Path, Path, Path, dict[str, str]]:
    """Verify immutable cache identities before importing Torch or touching the GPU."""

    absolute_cache = cache_path.expanduser().absolute()
    if _has_symlink_component(absolute_cache) or not absolute_cache.is_dir():
        raise RuntimeError("FinCast cache directory must be a regular non-symlink directory")
    cache_dir = absolute_cache.resolve(strict=True)
    model_candidate = cache_dir / "fincast"
    if _has_symlink_component(model_candidate) or not model_candidate.is_dir():
        raise RuntimeError("FinCast model directory must be a regular non-symlink directory")
    model_dir = model_candidate.resolve(strict=True)
    revision = _require_regular_file(
        model_dir / ".revision",
        "FinCast model revision marker",
    )
    try:
        cached_revision = revision.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as error:
        raise RuntimeError("FinCast model revision marker is invalid") from error
    if cached_revision != MODEL_REVISION:
        raise RuntimeError("FinCast model revision marker is invalid")
    hash_manifest = _require_regular_file(
        model_dir / ".artifact-sha256.json",
        "FinCast artifact SHA-256 manifest",
    )
    try:
        raw_manifest = hash_manifest.read_bytes()
        if len(raw_manifest) > 4096:
            raise ValueError("artifact SHA-256 manifest is too large")
        decoded = json.loads(raw_manifest, object_pairs_hook=_unique_json_object)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("FinCast artifact SHA-256 manifest is invalid") from error
    if not isinstance(decoded, dict) or set(decoded) != set(ARTIFACT_FILES):
        raise RuntimeError("FinCast artifact SHA-256 manifest is invalid")
    hashes: dict[str, str] = {}
    for name in ARTIFACT_FILES:
        expected = decoded.get(name)
        if not isinstance(expected, str) or SHA256_PATTERN.fullmatch(expected) is None:
            raise RuntimeError("FinCast artifact SHA-256 manifest is invalid")
        artifact = _require_regular_file(model_dir / name, "FinCast safetensors artifact")
        if sha256_file(artifact) != expected:
            raise RuntimeError("FinCast safetensors SHA-256 does not match its cache manifest")
        hashes[name] = expected
    return cache_dir, model_dir / ARTIFACT_FILES[0], model_dir / ARTIFACT_FILES[1], hashes


def _forecast(
    model: object,
    contexts: list[dict[str, object]],
    torch: object,
    precision: str,
) -> tuple[ForecastOutput, QuantileRearrangementObservations]:
    output: list[list[list[float]]] = []
    for index, case in enumerate(_qualification_cases(contexts)):
        torch.manual_seed(index)
        torch.cuda.manual_seed_all(index)
        # Runtime keeps raw prices and the decoder's patch normalization in
        # FP32. Mixed inference enters FP16 only at the first learned layer.
        input_dtype, padding_dtype = fincast_input_dtypes(torch, precision)
        input_ts = torch.tensor([case.closes], dtype=input_dtype, device="cuda")
        paddings = torch.zeros(
            (1, 512 + case.horizon_steps),
            dtype=padding_dtype,
            device="cuda",
        )
        frequency = torch.zeros((1, 1), dtype=torch.long, device="cuda")
        with torch.inference_mode():
            _mean, full = model.decode(
                input_ts=input_ts,
                paddings=paddings,
                freq=frequency,
                horizon_len=case.horizon_steps,
                output_patch_len=128,
                max_len=512,
                return_forecast_on_context=False,
            )
        if precision == "mixed_float16":
            observe_fincast_decode_output_dtypes(model, _mean, full)
        native = full[0, :, 1:].float().cpu().tolist()
        output.append(native)
    return _postprocess_qualification_forecasts(output)


def _sanitized_failure(error: Exception, stage: str) -> PrecisionRunFailureObservation:
    exception_name = type(error).__name__
    safe_exception_class = (
        exception_name
        if exception_name
        in {
            "OutOfMemoryError",
            "MemoryError",
            "NotImplementedError",
            "RuntimeError",
            "ValueError",
            "TypeError",
        }
        else "OtherException"
    )
    try:
        normalized_message = str(error).casefold()
    except Exception:
        normalized_message = ""
    if exception_name in {"OutOfMemoryError", "MemoryError"} or any(
        marker in normalized_message
        for marker in (
            "out of memory",
            "memory allocation",
            "cublas_status_alloc_failed",
        )
    ):
        category = "cuda_out_of_memory"
    elif exception_name == "NotImplementedError" or any(
        marker in normalized_message
        for marker in (
            "not implemented",
            "not supported",
            "unsupported operation",
            "unsupported operator",
        )
    ):
        category = "unsupported_operation"
    else:
        category = "stage_failure"
    return PrecisionRunFailureObservation(
        stage=stage,
        category=category,
        exception_class=safe_exception_class,
    )


def _safe_peak_vram(torch: object) -> int:
    try:
        return max(
            0,
            int(max(torch.cuda.max_memory_allocated(), torch.cuda.max_memory_reserved())),
        )
    except Exception:
        return 0


def run_precision(
    source: Path,
    artifact: Path,
    precision: str,
    contexts: list[dict[str, object]],
    torch: object,
) -> PrecisionRunResult:
    model: object | None = None
    stage = "setup"
    peak_vram_bytes = 0
    peak_vram_measurement_complete = False
    try:
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        runtime = RuntimeDevice(
            "cuda",
            torch,
            device_name=str(torch.cuda.get_device_name()),
            cuda_capability=".".join(str(item) for item in torch.cuda.get_device_capability()),
        )
        stage = "load"
        model = _load_model(source, artifact, precision, runtime)
        stage = "inference"
        output, quantile_observations = _forecast(model, contexts, torch, precision)
        stage = "evaluation"
        peak_vram_bytes = max(
            0,
            int(max(torch.cuda.max_memory_allocated(), torch.cuda.max_memory_reserved())),
        )
        peak_vram_measurement_complete = True
        if precision == "mixed_float16":
            validate_fincast_mixed_inference_observations(model)
        return PrecisionRunResult(
            forecasts=output,
            peak_vram_bytes=peak_vram_bytes,
            peak_vram_measurement_complete=True,
            failure=None,
            quantile_observations=quantile_observations,
        )
    except Exception as error:
        return PrecisionRunResult(
            forecasts=None,
            peak_vram_bytes=(
                peak_vram_bytes
                if peak_vram_measurement_complete
                else _safe_peak_vram(torch)
            ),
            peak_vram_measurement_complete=peak_vram_measurement_complete,
            failure=_sanitized_failure(error, stage),
        )
    finally:
        model = None
        try:
            gc.collect()
        except Exception:
            pass
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _require_qualification_forecast_shape(forecasts: ForecastOutput) -> None:
    expected_horizons = FINCAST_QUALIFICATION_NATIVE_HORIZON_STEPS * (
        FINCAST_QUALIFICATION_CONTEXT_COUNT + len(_SCALE_STRESS_LAST_CLOSES)
    )
    if len(forecasts) != FINCAST_QUALIFICATION_CASE_COUNT or any(
        len(case) != expected
        for case, expected in zip(forecasts, expected_horizons, strict=True)
    ):
        raise ValueError(
            "FinCast qualification requires 390 ordered native-cadence cases "
            "(15s/240, 30s/120, 60s/60) and 54,600 output rows"
        )


def _postprocess_qualification_forecasts(
    forecasts: ForecastOutput,
) -> tuple[ForecastOutput, QuantileRearrangementObservations]:
    """Rearrange native rows and summarize only rows whose order changed.

    q50 adjustment ratios use the postprocessed q75-q25 IQR, floored by
    max(abs(postprocessed q50) * 1e-9, 1e-12).
    """

    _require_qualification_forecast_shape(forecasts)
    normalized: ForecastOutput = []
    row_count = 0
    non_finite_value_count = 0
    crossing_row_count = 0
    crossing_adjacent_pair_count = 0
    adjusted_row_count = 0
    q50_adjustment_iqr_ratios: list[float] = []
    postprocessed_monotonic = True

    for context in forecasts:
        normalized_context: list[list[float]] = []
        for values in context:
            if len(values) != 9:
                raise ValueError("FinCast qualification must return q10 through q90")
            native = [float(value) for value in values]
            row_count += 1
            non_finite_value_count += sum(not math.isfinite(value) for value in native)
            crossing_pairs = sum(
                math.isfinite(left) and math.isfinite(right) and right < left
                for left, right in zip(native, native[1:], strict=False)
            )
            crossing_adjacent_pair_count += crossing_pairs
            crossing_row_count += crossing_pairs > 0

            if all(math.isfinite(value) for value in native):
                rearranged = list(rearrange_native_quantiles(native))
                adjusted = rearranged != native
                adjusted_row_count += adjusted
                if adjusted:
                    projected = project_native_quantiles(rearranged)
                    iqr = max(
                        projected[0.75] - projected[0.25],
                        abs(projected[0.5]) * 1e-9,
                        1e-12,
                    )
                    q50_ratio = abs(projected[0.5] - native[4]) / iqr
                    q50_adjustment_iqr_ratios.append(
                        min(
                            q50_ratio
                            if math.isfinite(q50_ratio)
                            else MAX_OBSERVED_Q50_ADJUSTMENT_IQR_RATIO,
                            MAX_OBSERVED_Q50_ADJUSTMENT_IQR_RATIO,
                        )
                    )
            else:
                rearranged = native
            postprocessed_monotonic = (
                postprocessed_monotonic and quantile_is_monotonic(rearranged)
            )
            normalized_context.append(rearranged)
        normalized.append(normalized_context)

    if row_count == 0:
        raise ValueError("FinCast qualification returned no quantile rows")
    if q50_adjustment_iqr_ratios:
        q50_ratio_median = _percentile(q50_adjustment_iqr_ratios, 0.5)
        q50_ratio_p95 = _percentile(q50_adjustment_iqr_ratios, 0.95)
        q50_ratio_max = max(q50_adjustment_iqr_ratios)
    else:
        q50_ratio_median = q50_ratio_p95 = q50_ratio_max = 0.0
    observations = QuantileRearrangementObservations(
        row_count=row_count,
        non_finite_value_count=non_finite_value_count,
        crossing_row_count=crossing_row_count,
        crossing_adjacent_pair_count=crossing_adjacent_pair_count,
        adjusted_row_count=adjusted_row_count,
        q50_adjustment_iqr_ratio_median=q50_ratio_median,
        q50_adjustment_iqr_ratio_p95=q50_ratio_p95,
        q50_adjustment_iqr_ratio_max=q50_ratio_max,
        postprocessed_monotonic=postprocessed_monotonic,
    )
    return normalized, observations


def qualification_metrics(
    fp32: ForecastOutput,
    mixed: ForecastOutput,
    cases: list[QualificationCase],
    fp32_peak: int,
    mixed_peak: int,
) -> MixedPrecisionMetrics:
    finite = all(math.isfinite(value) for context in mixed for row in context for value in row)
    monotonic = True
    for context in mixed:
        for row in context:
            try:
                rearrange_native_quantiles(row)
            except (TypeError, ValueError):
                monotonic = False
                break
        if not monotonic:
            break
    agreements = 0
    comparisons = 0
    ratios: list[float] = []
    for case, reference_context, candidate_context in zip(
        cases,
        fp32,
        mixed,
        strict=True,
    ):
        base = case.closes[-1]
        cost = case.round_trip_cost_bps / 10_000
        for reference, candidate in zip(reference_context, candidate_context, strict=True):
            comparisons += 1
            try:
                reference_native = rearrange_native_quantiles(reference)
                candidate_native = rearrange_native_quantiles(candidate)
            except (TypeError, ValueError):
                ratios.append(1_000_000_000.0)
                continue
            reference_projected = project_native_quantiles(reference_native)
            candidate_projected = project_native_quantiles(candidate_native)
            reference_direction = cost_exceeding_direction(
                [(quantile, price / base - 1) for quantile, price in reference_projected.items()],
                cost,
            )
            candidate_direction = cost_exceeding_direction(
                [(quantile, price / base - 1) for quantile, price in candidate_projected.items()],
                cost,
            )
            agreements += reference_direction == candidate_direction
            reference_q25 = reference_projected[0.25]
            reference_q75 = reference_projected[0.75]
            scale = max(reference_q75 - reference_q25, abs(base) * 1e-9, 1e-12)
            ratio = abs(candidate_projected[0.5] - reference_projected[0.5]) / scale
            ratios.append(ratio if math.isfinite(ratio) else 1_000_000_000.0)
    reduction = 1 - mixed_peak / fp32_peak if fp32_peak > 0 else float("-inf")
    return MixedPrecisionMetrics(
        finite=finite,
        quantile_monotonic=monotonic,
        signal_direction_agreement=agreements / comparisons,
        q50_median_iqr_ratio=_percentile(ratios, 0.5),
        q50_p95_iqr_ratio=_percentile(ratios, 0.95),
        peak_vram_reduction=reduction,
    )


def _runtime_failure(observation: PrecisionRunFailureObservation) -> MixedPrecisionRuntimeFailure:
    if observation.category == "cuda_out_of_memory":
        code = "mixed_cuda_out_of_memory"
    elif observation.category == "unsupported_operation":
        code = "mixed_unsupported_operation"
    else:
        code = {
            "setup": "mixed_setup_failure",
            "load": "mixed_model_load_failure",
            "inference": "mixed_inference_failure",
            "evaluation": "mixed_evaluation_failure",
        }[observation.stage]
    return MixedPrecisionRuntimeFailure(
        code=code,
        stage=observation.stage,
        exception_class=observation.exception_class,
    )


def qualify_precision(
    source: Path,
    fp32_path: Path,
    mixed_path: Path,
    contexts: list[dict[str, object]],
    fixture_hash: str,
    torch: object,
    artifact_hashes: dict[str, str] | None = None,
) -> FinCastPrecisionValidation:
    qualification_environment = qualification_environment_from_torch(torch)
    fp32_run = run_precision(source, fp32_path, "float32", contexts, torch)
    if (
        fp32_run.failure is not None
        or fp32_run.forecasts is None
        or not fp32_run.peak_vram_measurement_complete
        or fp32_run.peak_vram_bytes <= 0
    ):
        raise RuntimeError("FP32 FinCast baseline runtime failed")
    _require_qualification_forecast_shape(fp32_run.forecasts)
    qualification_cases = _qualification_cases(contexts)
    if fp32_run.quantile_observations is None:
        fp32_forecasts, fp32_observations = _postprocess_qualification_forecasts(
            fp32_run.forecasts
        )
    else:
        fp32_forecasts = fp32_run.forecasts
        fp32_observations = fp32_run.quantile_observations
    if not fp32_observations.postprocessed_monotonic:
        raise RuntimeError("FP32 FinCast baseline is non-finite after quantile postprocessing")

    mixed_run = run_precision(source, mixed_path, "mixed_float16", contexts, torch)
    runtime_failure: MixedPrecisionRuntimeFailure | None = None
    metrics: MixedPrecisionMetrics | None = None
    mixed_observations: QuantileRearrangementObservations | None = None
    if mixed_run.failure is not None:
        runtime_failure = _runtime_failure(mixed_run.failure)
    elif (
        mixed_run.forecasts is None
        or not mixed_run.peak_vram_measurement_complete
        or mixed_run.peak_vram_bytes <= 0
    ):
        runtime_failure = _runtime_failure(
            PrecisionRunFailureObservation(
                stage="evaluation",
                category="stage_failure",
                exception_class="RuntimeError",
            )
        )
    else:
        try:
            _require_qualification_forecast_shape(mixed_run.forecasts)
            if mixed_run.quantile_observations is None:
                mixed_forecasts, mixed_observations = _postprocess_qualification_forecasts(
                    mixed_run.forecasts
                )
            else:
                mixed_forecasts = mixed_run.forecasts
                mixed_observations = mixed_run.quantile_observations
            metrics = qualification_metrics(
                fp32_forecasts,
                mixed_forecasts,
                qualification_cases,
                fp32_run.peak_vram_bytes,
                mixed_run.peak_vram_bytes,
            )
        except Exception as error:
            mixed_observations = None
            runtime_failure = _runtime_failure(_sanitized_failure(error, "evaluation"))

    reasons = precision_failure_reasons(metrics, runtime_failure=runtime_failure)
    mixed_run_status = "runtime_failed" if runtime_failure is not None else "completed"
    return FinCastPrecisionValidation(
        schema_version=SCHEMA_VERSION,
        model_id="Vincent05R/FinCast",
        model_revision=MODEL_REVISION,
        source_revision=SOURCE_REVISION,
        mixed_runtime_policy_version=MIXED_RUNTIME_POLICY_VERSION,
        qualification_environment=qualification_environment,
        context_fixture_sha256=fixture_hash,
        context_count=128,
        qualification_case_count=FINCAST_QUALIFICATION_CASE_COUNT,
        qualification_row_count=FINCAST_QUALIFICATION_ROW_COUNT,
        context_fixture_candle_seconds=60,
        decoder_horizon_shape_candle_seconds=FINCAST_QUALIFICATION_CANDLE_SECONDS,
        validated_native_horizon_steps=FINCAST_QUALIFICATION_NATIVE_HORIZON_STEPS,
        cadence_validation_scope=CADENCE_VALIDATION_SCOPE,
        scale_stress_policy=SCALE_STRESS_POLICY,
        quantile_tail_policy="tail_clamped_q10_q90",
        quantile_monotonicity_policy=QUANTILE_MONOTONICITY_POLICY,
        fp32_quantile_observations=fp32_observations,
        mixed_quantile_observations=mixed_observations,
        fp32=PrecisionArtifact(
            file=fp32_path.name,
            sha256=(
                artifact_hashes[fp32_path.name]
                if artifact_hashes is not None
                else sha256_file(fp32_path)
            ),
            peak_vram_bytes=fp32_run.peak_vram_bytes,
            peak_vram_measurement="cuda_allocated_or_reserved",
            peak_vram_measurement_complete=True,
        ),
        mixed_fp16=PrecisionArtifact(
            file=mixed_path.name,
            sha256=(
                artifact_hashes[mixed_path.name]
                if artifact_hashes is not None
                else sha256_file(mixed_path)
            ),
            peak_vram_bytes=mixed_run.peak_vram_bytes,
            peak_vram_measurement="cuda_allocated_or_reserved",
            peak_vram_measurement_complete=mixed_run.peak_vram_measurement_complete,
        ),
        mixed_run_status=mixed_run_status,
        mixed_runtime_failure=runtime_failure,
        mixed_metrics=metrics,
        mixed_failure_reasons=reasons,
        selected_precision="mixed_float16" if not reasons else "float32",
    )


def write_validation_atomic(output: Path, validation: FinCastPrecisionValidation) -> str:
    payload = serialize_precision_validation(validation)
    temporary = output.parent / f".precision-validation-{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write(payload)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o444)
        os.replace(temporary, output)
        directory_fd = os.open(output.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)
    return payload


def main() -> int:
    args = parse_args()
    manifest = json.loads(args.manifest.resolve(strict=True).read_text(encoding="utf-8"))
    source_manifest = manifest["fincast_source"]
    model_manifest = manifest["models"]["fincast"]
    if source_manifest.get("revision") != SOURCE_REVISION or model_manifest.get("revision") != MODEL_REVISION:
        raise RuntimeError("FinCast validation manifest identity is not pinned")
    contexts, fixture_hash = load_contexts(args.contexts.expanduser().resolve(strict=True))
    if fixture_hash != model_manifest.get("validation_contexts_sha256"):
        raise RuntimeError("FinCast validation context SHA-256 does not match the manifest")
    cache_dir, fp32_path, mixed_path, artifact_hashes = verify_qualification_cache(
        args.cache_dir
    )
    model_dir = fp32_path.parent

    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for FinCast precision qualification")
    torch.cuda.set_device(args.device_index)
    qualification_environment_from_torch(torch)
    source = _source_snapshot(cache_dir, source_manifest)
    validation = qualify_precision(
        source,
        fp32_path,
        mixed_path,
        contexts,
        fixture_hash,
        torch,
        artifact_hashes,
    )
    output = model_dir / "precision-validation.json"
    model_dir.chmod(0o755)
    try:
        payload = write_validation_atomic(output, validation)
    finally:
        model_dir.chmod(0o555)
    print(payload)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"FinCast precision validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
