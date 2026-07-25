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
from portfolio_ai_worker.fincast import (  # noqa: E402
    MODEL_REVISION,
    SOURCE_REVISION,
    _load_model,
    _source_snapshot,
    observe_fincast_decode_output_dtypes,
    validate_fincast_mixed_inference_observations,
)
from portfolio_ai_worker.precision_validation import (  # noqa: E402
    SCHEMA_VERSION,
    FinCastPrecisionValidation,
    MixedPrecisionMetrics,
    MixedPrecisionRuntimeFailure,
    PrecisionArtifact,
    MIXED_RUNTIME_POLICY_VERSION,
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
) -> ForecastOutput:
    dtype = torch.float16 if precision == "mixed_float16" else torch.float32
    output: list[list[list[float]]] = []
    for index, context in enumerate(contexts):
        torch.manual_seed(index)
        torch.cuda.manual_seed_all(index)
        closes = context["closes"]
        input_ts = torch.tensor([closes], dtype=dtype, device="cuda")
        paddings = torch.zeros((1, 572), dtype=dtype, device="cuda")
        frequency = torch.zeros((1, 1), dtype=torch.long, device="cuda")
        with torch.inference_mode():
            _mean, full = model.decode(
                input_ts=input_ts,
                paddings=paddings,
                freq=frequency,
                horizon_len=60,
                output_patch_len=128,
                max_len=512,
                return_forecast_on_context=False,
            )
        if precision == "mixed_float16":
            observe_fincast_decode_output_dtypes(model, _mean, full)
        native = full[0, :, 1:].float().cpu().tolist()
        output.append(native)
    return output


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
        output = _forecast(model, contexts, torch, precision)
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


def qualification_metrics(
    fp32: ForecastOutput,
    mixed: ForecastOutput,
    contexts: list[dict[str, object]],
    fp32_peak: int,
    mixed_peak: int,
) -> MixedPrecisionMetrics:
    finite = all(math.isfinite(value) for context in mixed for row in context for value in row)
    monotonic = all(quantile_is_monotonic(row) for context in mixed for row in context)
    agreements = 0
    comparisons = 0
    ratios: list[float] = []
    for context_index, (reference_context, candidate_context) in enumerate(zip(fp32, mixed, strict=True)):
        base = float(contexts[context_index]["closes"][-1])  # type: ignore[index]
        cost = float(contexts[context_index]["round_trip_cost_bps"]) / 10_000
        for reference, candidate in zip(reference_context, candidate_context, strict=True):
            comparisons += 1
            if not quantile_is_monotonic(candidate):
                ratios.append(1_000_000_000.0)
                continue
            reference_projected = (
                (0.05, reference[0]),
                (0.1, reference[0]),
                (0.25, (reference[1] + reference[2]) / 2),
                (0.5, reference[4]),
                (0.75, (reference[6] + reference[7]) / 2),
                (0.9, reference[8]),
                (0.95, reference[8]),
            )
            candidate_projected = (
                (0.05, candidate[0]),
                (0.1, candidate[0]),
                (0.25, (candidate[1] + candidate[2]) / 2),
                (0.5, candidate[4]),
                (0.75, (candidate[6] + candidate[7]) / 2),
                (0.9, candidate[8]),
                (0.95, candidate[8]),
            )
            reference_direction = cost_exceeding_direction(
                [(quantile, price / base - 1) for quantile, price in reference_projected],
                cost,
            )
            candidate_direction = cost_exceeding_direction(
                [(quantile, price / base - 1) for quantile, price in candidate_projected],
                cost,
            )
            agreements += reference_direction == candidate_direction
            reference_q25 = (reference[1] + reference[2]) / 2
            reference_q75 = (reference[6] + reference[7]) / 2
            scale = max(reference_q75 - reference_q25, abs(base) * 1e-9, 1e-12)
            ratio = abs(candidate[4] - reference[4]) / scale
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
    if not all(quantile_is_monotonic(row) for context in fp32_run.forecasts for row in context):
        raise RuntimeError("FP32 FinCast baseline is non-finite or has crossing quantiles")

    mixed_run = run_precision(source, mixed_path, "mixed_float16", contexts, torch)
    runtime_failure: MixedPrecisionRuntimeFailure | None = None
    metrics: MixedPrecisionMetrics | None = None
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
            metrics = qualification_metrics(
                fp32_run.forecasts,
                mixed_run.forecasts,
                contexts,
                fp32_run.peak_vram_bytes,
                mixed_run.peak_vram_bytes,
            )
        except Exception as error:
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
        quantile_tail_policy="tail_clamped_q10_q90",
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
