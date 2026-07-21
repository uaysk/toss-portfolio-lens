from __future__ import annotations

import importlib
import json
import os
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator, Protocol, Sequence

from .contracts import FIXED_QUANTILES, ModelProvenance, PriceBar
from .settings import AISettings


@dataclass(frozen=True, slots=True)
class InferenceSeries:
    instrument_key: str
    bars: tuple[PriceBar, ...]
    future_timestamps: tuple[datetime, ...]


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
        return RuntimeDevice(name="cuda", torch=torch)
    if requested == "cuda" and not settings.allow_cpu_fallback:
        raise AdapterLoadError("CUDA was required but is unavailable")
    if requested == "cuda" and settings.allow_cpu_fallback:
        return RuntimeDevice(name="cpu", torch=torch)
    if requested == "auto" and not settings.allow_cpu_fallback:
        raise AdapterLoadError("CUDA is unavailable and CPU fallback is disabled")
    return RuntimeDevice(name="cpu", torch=torch)


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
    if not isinstance(value, dict) or value.get("schema_version") != "scalping-ai-model-manifest/v1":
        raise AdapterLoadError("pinned model manifest schema is invalid")
    return value


def _inside(root: Path, path: Path) -> Path:
    resolved_root = root.resolve()
    resolved = path.resolve()
    if not resolved.is_relative_to(resolved_root):
        raise AdapterLoadError("model paths must remain inside AI_MODEL_CACHE_DIR")
    return resolved


def _snapshot(root: Path, folder: str, revision: str, *, source: bool = False) -> Path:
    path = _inside(root, root / folder)
    revision_file = path / (".source-revision" if source else ".revision")
    try:
        actual_revision = revision_file.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise AdapterLoadError(f"offline snapshot {folder} is missing its revision marker") from error
    if actual_revision != revision:
        raise AdapterLoadError(f"offline snapshot {folder} revision does not match the pinned manifest")
    if source:
        required = (path / "model" / "kronos.py", path / "model" / "module.py", path / "LICENSE")
    else:
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
    loaded: bool,
    fallback_from: str | None = None,
    fallback_reason: str | None = None,
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
        dtype="float32",
        attention_backend="math" if loaded else "unavailable",
        loaded=loaded,
        fallback_from=fallback_from,
        fallback_reason=fallback_reason,
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


class KronosAdapter:
    def __init__(
        self,
        settings: AISettings,
        manifest_model: dict[str, Any],
        source_revision: str,
        runtime: RuntimeDevice,
        *,
        fallback_from: str | None = None,
        fallback_reason: str | None = None,
    ) -> None:
        root = settings.model_cache_dir
        source = _snapshot(root, "kronos-source", source_revision, source=True)
        model_path = _snapshot(root, "kronos-small", str(manifest_model["revision"]))
        tokenizer_path = _snapshot(root, "kronos-tokenizer-base", str(manifest_model["tokenizer_revision"]))
        source_text = str(source)
        if source_text not in sys.path:
            sys.path.insert(0, source_text)
        try:
            module = importlib.import_module("model.kronos")
            module_path = Path(module.__file__ or "").resolve()
            if not module_path.is_relative_to(source):
                raise AdapterLoadError("Kronos source import resolved outside the pinned cache")
            model = module.Kronos.from_pretrained(str(model_path), local_files_only=True)
            tokenizer = module.KronosTokenizer.from_pretrained(str(tokenizer_path), local_files_only=True)
            model.eval()
            tokenizer.eval()
            self._predictor = module.KronosPredictor(
                model=model,
                tokenizer=tokenizer,
                device=runtime.name,
                max_context=settings.max_context_bars,
            )
        except AdapterLoadError:
            raise
        except Exception as error:
            raise AdapterLoadError(f"failed to load pinned Kronos snapshots: {type(error).__name__}") from error
        self._runtime = runtime
        self._sample_count = settings.sample_count
        self._provenance = _provenance(
            manifest_model,
            source_revision=source_revision,
            device=runtime.name,
            loaded=True,
            fallback_from=fallback_from,
            fallback_reason=fallback_reason,
        )

    @property
    def provenance(self) -> ModelProvenance:
        return self._provenance

    def predict_batch(self, series: Sequence[InferenceSeries], *, seed: int) -> list[RawPrediction]:
        if not series:
            return []
        torch = self._runtime.torch
        numpy = importlib.import_module("numpy")
        pandas = importlib.import_module("pandas")
        torch.manual_seed(seed)
        if self._runtime.name == "cuda":
            torch.cuda.manual_seed_all(seed)
        frames: list[Any] = []
        x_timestamps: list[Any] = []
        y_timestamps: list[Any] = []
        owners: list[str] = []
        for item in series:
            frame = pandas.DataFrame(
                [
                    {
                        "open": bar.open,
                        "high": bar.high,
                        "low": bar.low,
                        "close": bar.close,
                        **({"volume": bar.volume} if bar.volume is not None else {}),
                        **({"amount": bar.amount} if bar.amount is not None else {}),
                    }
                    for bar in item.bars
                ]
            )
            for _ in range(self._sample_count):
                frames.append(frame)
                x_timestamps.append(pandas.Series([bar.timestamp for bar in item.bars]))
                y_timestamps.append(pandas.Series(item.future_timestamps))
                owners.append(item.instrument_key)
        with math_sdpa(torch), torch.inference_mode():
            predicted = self._predictor.predict_batch(
                df_list=frames,
                x_timestamp_list=x_timestamps,
                y_timestamp_list=y_timestamps,
                pred_len=len(series[0].future_timestamps),
                sample_count=1,
                verbose=False,
            )
        grouped: dict[str, list[tuple[PredictedBar, ...]]] = {item.instrument_key: [] for item in series}
        for owner, frame in zip(owners, predicted, strict=True):
            rows: list[PredictedBar] = []
            for _, row in frame.iterrows():
                volume = row.get("volume")
                amount = row.get("amount")
                rows.append(
                    PredictedBar(
                        open=float(row["open"]),
                        high=float(row["high"]),
                        low=float(row["low"]),
                        close=float(row["close"]),
                        volume=float(volume) if volume is not None and numpy.isfinite(volume) else None,
                        amount=float(amount) if amount is not None and numpy.isfinite(amount) else None,
                    )
                )
            grouped[owner].append(tuple(rows))
        return [
            RawPrediction(instrument_key=item.instrument_key, paths=tuple(grouped[item.instrument_key]))
            for item in series
        ]


class ChronosBoltAdapter:
    def __init__(
        self,
        settings: AISettings,
        manifest_model: dict[str, Any],
        source_revision: str,
        runtime: RuntimeDevice,
        *,
        fallback_from: str | None = None,
        fallback_reason: str | None = None,
    ) -> None:
        model_path = _snapshot(settings.model_cache_dir, "chronos-bolt-small", str(manifest_model["revision"]))
        try:
            chronos = importlib.import_module("chronos")
            self._pipeline = chronos.BaseChronosPipeline.from_pretrained(
                str(model_path),
                device_map=runtime.name,
                torch_dtype=runtime.torch.float32,
                local_files_only=True,
                trust_remote_code=False,
            )
        except Exception as error:
            raise AdapterLoadError(f"failed to load pinned Chronos-Bolt snapshot: {type(error).__name__}") from error
        self._runtime = runtime
        self._provenance = _provenance(
            manifest_model,
            source_revision=source_revision,
            device=runtime.name,
            loaded=True,
            fallback_from=fallback_from,
            fallback_reason=fallback_reason,
        )

    @property
    def provenance(self) -> ModelProvenance:
        return self._provenance

    def predict_batch(self, series: Sequence[InferenceSeries], *, seed: int) -> list[RawPrediction]:
        if not series:
            return []
        torch = self._runtime.torch
        torch.manual_seed(seed)
        contexts = [torch.tensor([bar.close for bar in item.bars], dtype=torch.float32) for item in series]
        with math_sdpa(torch), torch.inference_mode():
            quantiles, _mean = self._pipeline.predict_quantiles(
                contexts,
                prediction_length=len(series[0].future_timestamps),
                quantile_levels=list(FIXED_QUANTILES),
            )
        values = quantiles.detach().to(dtype=torch.float32, device="cpu").numpy()
        output: list[RawPrediction] = []
        for series_index, item in enumerate(series):
            by_horizon = {
                horizon: {
                    quantile: float(values[series_index, horizon - 1, quantile_index])
                    for quantile_index, quantile in enumerate(FIXED_QUANTILES)
                }
                for horizon in (5, 15, 30, 60)
            }
            output.append(RawPrediction(instrument_key=item.instrument_key, close_quantiles=by_horizon))
        return output


def _try_load(
    name: str,
    settings: AISettings,
    manifest: dict[str, Any],
    runtime: RuntimeDevice,
    *,
    fallback_from: str | None = None,
    fallback_reason: str | None = None,
) -> ModelAdapter:
    models = manifest.get("models")
    source = manifest.get("kronos_source")
    if not isinstance(models, dict) or not isinstance(source, dict) or name not in models:
        raise AdapterLoadError("model manifest is incomplete")
    model = models[name]
    source_revision = (
        str(source["revision"])
        if name == "kronos-small"
        else str(model.get("loader_version", "chronos-loader-unavailable"))
    )
    if name == "kronos-small":
        return KronosAdapter(
            settings,
            model,
            source_revision,
            runtime,
            fallback_from=fallback_from,
            fallback_reason=fallback_reason,
        )
    return ChronosBoltAdapter(
        settings,
        model,
        source_revision,
        runtime,
        fallback_from=fallback_from,
        fallback_reason=fallback_reason,
    )


def load_production_adapter(settings: AISettings) -> ModelAdapter:
    """Select a model once at startup; request-time fallback is intentionally forbidden."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    manifest: dict[str, Any] | None = None
    primary_error = ""
    try:
        manifest = _load_manifest(settings.manifest_path)
        runtime = preflight_device(settings)
        return _try_load(settings.primary_model, settings, manifest, runtime)
    except Exception as error:
        primary_error = str(error)[:300]
    if settings.fallback_model and manifest is not None:
        try:
            runtime = preflight_device(settings)
            return _try_load(
                settings.fallback_model,
                settings,
                manifest,
                runtime,
                fallback_from=settings.primary_model,
                fallback_reason=primary_error,
            )
        except Exception as error:
            primary_error = f"primary: {primary_error}; fallback: {str(error)[:200]}"
    model_manifest = _safe_unavailable_manifest_model(None, settings.primary_model)
    source_revision = "unavailable"
    if manifest is not None:
        models = manifest.get("models")
        source = manifest.get("kronos_source")
        if isinstance(models, dict):
            model_manifest = _safe_unavailable_manifest_model(
                models.get(settings.primary_model), settings.primary_model
            )
        if isinstance(source, dict):
            candidate_revision = source.get("revision")
            if isinstance(candidate_revision, str) and 0 < len(candidate_revision) <= 256:
                source_revision = candidate_revision
    provenance = _provenance(
        model_manifest,
        source_revision=source_revision,
        device="unavailable",
        loaded=False,
        fallback_from=settings.primary_model if settings.fallback_model else None,
        fallback_reason=(primary_error or "offline model snapshots are unavailable")[:500],
    )
    return UnavailableAdapter(
        provenance,
        "MODEL_UNAVAILABLE",
        "Pinned offline AI model snapshots could not be loaded; no forecast was fabricated.",
    )
