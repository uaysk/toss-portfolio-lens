from __future__ import annotations

import importlib
import json
import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator, Protocol, Sequence
from .contracts import (
    CHRONOS_2_MODEL_ID,
    FINCAST_MODEL_ID,
    ModelProvenance,
    PriceBar,
    QuantileRearrangementObservations,
    SeriesCadence,
)
from .settings import AISettings


@dataclass(frozen=True, slots=True)
class InferenceSeries:
    instrument_key: str
    timezone: str
    bars: tuple[PriceBar, ...]
    future_timestamps: tuple[datetime, ...]
    input_cadence: SeriesCadence | None = None


@dataclass(frozen=True, slots=True)
class PredictedBar:
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None
    amount: float | None = None


@dataclass(frozen=True, slots=True)
class RawPrediction:
    instrument_key: str
    paths: tuple[tuple[PredictedBar, ...], ...] | None = None
    close_quantiles: dict[int, dict[float, float]] | None = None
    unavailable_code: str | None = None
    unavailable_message: str | None = None


class ModelAdapter(Protocol):
    @property
    def provenance(self) -> ModelProvenance: ...

    def predict_batch(
        self,
        series: Sequence[InferenceSeries],
        *,
        seed: int,
    ) -> list[RawPrediction]: ...


class AdapterLoadError(RuntimeError):
    pass


class UnavailableAdapter:
    def __init__(self, provenance: ModelProvenance, code: str, message: str) -> None:
        self._provenance = provenance
        self.code = code
        self.message = message

    @property
    def provenance(self) -> ModelProvenance:
        return self._provenance

    def predict_batch(self, series: Sequence[InferenceSeries], *, seed: int) -> list[RawPrediction]:
        del seed
        return [
            RawPrediction(
                instrument_key=item.instrument_key,
                unavailable_code=self.code,
                unavailable_message=self.message,
            )
            for item in series
        ]


@dataclass(frozen=True, slots=True)
class RuntimeDevice:
    name: str
    torch: Any
    device_name: str | None = None
    cuda_capability: str | None = None


def _import_torch() -> Any:
    try:
        return importlib.import_module("torch")
    except ImportError as error:
        raise AdapterLoadError("torch is not installed in the AI worker image") from error


def _has_compatible_cubin(compiled_arches: Sequence[str], major: int, minor: int) -> bool:
    """Return whether an NVIDIA cubin can execute on the visible device.

    CUDA cubins are binary-compatible with devices that have the same major
    compute capability and an equal or greater minor capability. For example,
    an sm_60 cubin is valid on the Tesla P40's sm_61 device even when PyTorch
    doesn't list an explicit sm_61 build target.
    """
    for architecture in compiled_arches:
        if not architecture.startswith("sm_"):
            continue
        encoded = architecture.removeprefix("sm_")
        if not encoded.isdecimal() or len(encoded) < 2:
            continue
        compiled_major = int(encoded[:-1])
        compiled_minor = int(encoded[-1])
        if compiled_major == major and compiled_minor <= minor:
            return True
    return False


def preflight_device(settings: AISettings) -> RuntimeDevice:
    torch = _import_torch()
    requested = settings.device
    if requested in {"auto", "cuda"} and bool(torch.cuda.is_available()):
        major, minor = torch.cuda.get_device_capability()
        capability = f"{major}.{minor}"
        if settings.expected_cuda_capability and capability != settings.expected_cuda_capability:
            message = f"CUDA capability {capability} does not match required {settings.expected_cuda_capability}"
            if settings.allow_cpu_fallback:
                return RuntimeDevice(name="cpu", torch=torch)
            raise AdapterLoadError(message)
        compiled = tuple(torch.cuda.get_arch_list())
        if not _has_compatible_cubin(compiled, major, minor):
            message = f"installed torch binary does not include a compatible cubin for sm_{major}{minor}"
            if settings.allow_cpu_fallback:
                return RuntimeDevice(name="cpu", torch=torch)
            raise AdapterLoadError(message)
        try:
            device_name = str(torch.cuda.get_device_name()).strip()
        except Exception as error:
            if settings.allow_cpu_fallback:
                return RuntimeDevice(name="cpu", torch=torch)
            raise AdapterLoadError("CUDA device name is unavailable") from error
        if not device_name:
            if settings.allow_cpu_fallback:
                return RuntimeDevice(name="cpu", torch=torch)
            raise AdapterLoadError("CUDA device name is unavailable")
        if device_name != settings.expected_cuda_device_name:
            message = f"CUDA device {device_name!r} does not match required {settings.expected_cuda_device_name!r}"
            if settings.allow_cpu_fallback:
                return RuntimeDevice(name="cpu", torch=torch)
            raise AdapterLoadError(message)
        return RuntimeDevice(
            name="cuda",
            torch=torch,
            device_name=device_name[:256],
            cuda_capability=capability,
        )
    if requested == "cuda" and not settings.allow_cpu_fallback:
        raise AdapterLoadError("CUDA was required but is unavailable")
    if requested == "cuda" and settings.allow_cpu_fallback:
        return RuntimeDevice(name="cpu", torch=torch)
    if requested == "auto" and not settings.allow_cpu_fallback:
        raise AdapterLoadError("CUDA is unavailable and CPU fallback is disabled")
    return RuntimeDevice(name="cpu", torch=torch)


def _require_cuda_runtime(settings: AISettings, runtime: RuntimeDevice) -> None:
    if runtime.name != "cuda":
        raise AdapterLoadError("P40 CUDA execution is required; CPU execution is not admitted")
    if runtime.device_name is None:
        raise AdapterLoadError("P40 CUDA execution is required; CUDA device name is unavailable")
    if runtime.device_name != settings.expected_cuda_device_name:
        raise AdapterLoadError(
            f"CUDA device {runtime.device_name!r} does not match required {settings.expected_cuda_device_name!r}"
        )
    if settings.expected_cuda_capability is not None and runtime.cuda_capability != settings.expected_cuda_capability:
        observed = runtime.cuda_capability or "unavailable"
        raise AdapterLoadError(
            f"CUDA capability {observed} does not match required {settings.expected_cuda_capability}"
        )


@contextmanager
def math_sdpa(torch: Any) -> Iterator[None]:
    """Force the deterministic-compatible SDPA math implementation."""
    attention = getattr(getattr(torch, "nn", None), "attention", None)
    kernel = getattr(attention, "sdpa_kernel", None)
    backend = getattr(attention, "SDPBackend", None)
    if kernel is not None and backend is not None:
        with kernel(backend.MATH):
            yield
        return
    cuda_backends = getattr(getattr(torch, "backends", None), "cuda", None)
    if cuda_backends is None:
        yield
        return
    cuda_backends.enable_flash_sdp(False)
    cuda_backends.enable_mem_efficient_sdp(False)
    cuda_backends.enable_math_sdp(True)
    yield


def _load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AdapterLoadError("pinned model manifest is unavailable or invalid") from error
    if not isinstance(value, dict) or value.get("schema_version") != "scalping-ai-model-manifest/v2":
        raise AdapterLoadError("pinned model manifest schema is invalid")
    return value


def _inside(root: Path, path: Path) -> Path:
    resolved_root = root.resolve()
    resolved = path.resolve()
    if not resolved.is_relative_to(resolved_root):
        raise AdapterLoadError("model paths must remain inside AI_MODEL_CACHE_DIR")
    return resolved


def _snapshot(root: Path, folder: str, revision: str) -> Path:
    path = _inside(root, root / folder)
    revision_file = path / ".revision"
    try:
        actual_revision = revision_file.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise AdapterLoadError(f"offline snapshot {folder} is missing its revision marker") from error
    if actual_revision != revision:
        raise AdapterLoadError(f"offline snapshot {folder} revision does not match the pinned manifest")
    required = (path / "config.json", path / "model.safetensors")
    for item in required:
        _inside(root, item)
        if not item.is_file():
            raise AdapterLoadError(f"offline snapshot {folder} is incomplete")
    return path


def _provenance(
    manifest_model: dict[str, Any],
    *,
    source_revision: str,
    device: str,
    device_name: str | None = None,
    cuda_capability: str | None = None,
    loaded: bool,
    dtype: str = "float32",
    precision_validation: str = "not_required",
    peak_vram_bytes: int | None = None,
    peak_vram_measurement: str | None = None,
    memory_status: str | None = None,
    quantile_tail_policy: str = "native",
    quantile_monotonicity_policy: str = "native",
    fp32_quantile_observations: QuantileRearrangementObservations | None = None,
    mixed_quantile_observations: QuantileRearrangementObservations | None = None,
    precision_failure_reasons: tuple[str, ...] = (),
) -> ModelProvenance:
    return ModelProvenance(
        model_id=str(manifest_model["model_id"]),
        model_revision=str(manifest_model["revision"]),
        tokenizer_id=manifest_model.get("tokenizer_id"),
        tokenizer_revision=manifest_model.get("tokenizer_revision"),
        source_revision=source_revision,
        loader_version=str(manifest_model["loader_version"]),
        license=str(manifest_model["license"]),
        device=device if loaded else "unavailable",
        device_name=device_name if loaded and device == "cuda" else None,
        cuda_capability=cuda_capability if loaded and device == "cuda" else None,
        dtype=dtype,
        attention_backend="math" if loaded else "unavailable",
        loaded=loaded,
        precision_validation=precision_validation if loaded else "unavailable",
        peak_vram_bytes=peak_vram_bytes if loaded else None,
        peak_vram_measurement=peak_vram_measurement if loaded else None,
        memory_status=memory_status or ("ok" if loaded else "unavailable"),
        quantile_tail_policy=quantile_tail_policy if loaded else "unavailable",
        quantile_monotonicity_policy=(
            quantile_monotonicity_policy if loaded else "unavailable"
        ),
        fp32_quantile_observations=fp32_quantile_observations if loaded else None,
        mixed_quantile_observations=mixed_quantile_observations if loaded else None,
        precision_failure_reasons=precision_failure_reasons,
    )


def _safe_unavailable_manifest_model(candidate: object, fallback_name: str) -> dict[str, Any]:
    fallback: dict[str, Any] = {
        "model_id": fallback_name,
        "revision": "unavailable",
        "tokenizer_id": None,
        "tokenizer_revision": None,
        "loader_version": "unavailable",
        "license": "unavailable",
    }
    if not isinstance(candidate, dict):
        return fallback
    required = ("model_id", "revision", "loader_version", "license")
    if any(not isinstance(candidate.get(field), str) or not candidate[field] for field in required):
        return fallback
    tokenizer_id = candidate.get("tokenizer_id")
    tokenizer_revision = candidate.get("tokenizer_revision")
    return {
        **fallback,
        **{field: candidate[field] for field in required},
        "tokenizer_id": tokenizer_id if isinstance(tokenizer_id, str) and tokenizer_id else None,
        "tokenizer_revision": (
            tokenizer_revision if isinstance(tokenizer_revision, str) and tokenizer_revision else None
        ),
    }


def _try_load(
    name: str,
    settings: AISettings,
    manifest: dict[str, Any],
    runtime: RuntimeDevice,
) -> ModelAdapter:
    models = manifest.get("models")
    source_key = {
        "fincast": "fincast_source",
        "chronos-2": "chronos2_source",
    }.get(name)
    if source_key is None:
        raise AdapterLoadError("unsupported production model lane")
    source = manifest.get(source_key)
    if not isinstance(models, dict) or not isinstance(source, dict) or name not in models:
        raise AdapterLoadError("model manifest is incomplete")
    model = models[name]
    if name == "fincast":
        if (
            not isinstance(model, dict)
            or model.get("model_id") != FINCAST_MODEL_ID
            or model.get("revision") != "2d7d90b159db8961d27c2cf165d51195902ef92b"
            or not isinstance(source, dict)
            or source.get("revision") != "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4"
        ):
            raise AdapterLoadError("FinCast manifest identity or revisions are invalid")
        from .fincast import FinCastAdapter

        return FinCastAdapter(settings, model, source, runtime)
    if name == "chronos-2":
        from .chronos2 import Chronos2Adapter, _validate_manifest

        if not isinstance(model, dict) or not isinstance(source, dict):
            raise AdapterLoadError("Chronos-2 manifest is incomplete")
        _validate_manifest(model, source)
        return Chronos2Adapter(settings, model, source, runtime)
    raise AdapterLoadError("unsupported production model lane")


def _enable_offline_runtime() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def _expected_model_id(name: str) -> str:
    return (
        FINCAST_MODEL_ID
        if name == "fincast"
        else CHRONOS_2_MODEL_ID
        if name == "chronos-2"
        else name
    )


def _unavailable_adapter(
    name: str,
    manifest: dict[str, Any] | None,
    reason: str,
) -> ModelAdapter:
    expected_model_id = _expected_model_id(name)
    model_manifest = _safe_unavailable_manifest_model(None, expected_model_id)
    source_revision = "unavailable"
    if manifest is not None:
        models = manifest.get("models")
        if isinstance(models, dict):
            model_manifest = _safe_unavailable_manifest_model(models.get(name), expected_model_id)
            # Keep fail-closed responses contract-valid even when the local
            # manifest itself is malformed. A missing/corrupt snapshot must
            # never erase the identity of the model the role expected.
            model_manifest["model_id"] = expected_model_id
        source_key = {
            "fincast": "fincast_source",
            "chronos-2": "chronos2_source",
        }.get(name)
        source = manifest.get(source_key) if source_key is not None else None
        if isinstance(source, dict):
            candidate_revision = source.get("revision")
            if isinstance(candidate_revision, str) and 0 < len(candidate_revision) <= 256:
                source_revision = candidate_revision
    is_memory_pressure = "memory_pressure" in reason
    provenance = _provenance(
        model_manifest,
        source_revision=source_revision,
        device="unavailable",
        loaded=False,
        memory_status="memory_pressure" if is_memory_pressure else "unavailable",
    )
    detail = (reason or "offline model snapshots are unavailable").strip()[:300]
    return UnavailableAdapter(
        provenance,
        "MEMORY_PRESSURE" if is_memory_pressure else "MODEL_UNAVAILABLE",
        (
            "Pinned offline AI model snapshots or the required P40 CUDA runtime are unavailable "
            f"({detail}); no forecast was fabricated."
        )[:500],
    )


def _load_named_adapter(
    settings: AISettings,
    name: str,
    *,
    require_cuda: bool = False,
) -> ModelAdapter:
    _enable_offline_runtime()
    manifest: dict[str, Any] | None = None
    primary_error = ""
    try:
        manifest = _load_manifest(settings.manifest_path)
        runtime = preflight_device(settings)
        if require_cuda:
            _require_cuda_runtime(settings, runtime)
        return _try_load(name, settings, manifest, runtime)
    except Exception as error:
        primary_error = str(error)[:300]
    return _unavailable_adapter(name, manifest, primary_error)


@dataclass(frozen=True, slots=True)
class ProductionModelBinding:
    role: str
    expected_model_id: str
    adapter: ModelAdapter


@dataclass(frozen=True, slots=True)
class ProductionModelSuite:
    primary: ModelAdapter
    runs: tuple[ProductionModelBinding]


def load_production_model_suite(settings: AISettings) -> ProductionModelSuite:
    """Load exactly one pinned lane per process; missing cache or P40 fails closed."""
    if settings.model_lane == "fincast":
        adapter = _load_named_adapter(settings, "fincast", require_cuda=True)
        runs = (ProductionModelBinding("fincast", FINCAST_MODEL_ID, adapter),)
    elif settings.model_lane == "chronos_2":
        adapter = _load_named_adapter(settings, "chronos-2", require_cuda=True)
        runs = (ProductionModelBinding("chronos_2", CHRONOS_2_MODEL_ID, adapter),)
    else:
        raise AdapterLoadError("unsupported production model lane")
    return ProductionModelSuite(primary=adapter, runs=runs)
