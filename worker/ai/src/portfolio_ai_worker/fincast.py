from __future__ import annotations

import ast
import ctypes
import importlib
import importlib.machinery
import math
import sys
import types
from pathlib import Path
from typing import Any, Sequence

from .adapters import (
    AdapterLoadError,
    InferenceSeries,
    RawPrediction,
    RuntimeDevice,
    _inside,
    _provenance,
)
from .contracts import FIXED_HORIZONS, FIXED_QUANTILES, ModelProvenance
from .precision_validation import (
    FinCastPrecisionValidation,
    load_precision_validation,
    sha256_file,
    validate_qualification_runtime,
)
from .settings import AISettings

SOURCE_REVISION = "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4"
SOURCE_ARCHIVE_SHA256 = "ed4c3967c6d548465307fc0b63895ac9c9d8b44a950ccf936ab97e1755451a91"
MODEL_REVISION = "2d7d90b159db8961d27c2cf165d51195902ef92b"
NATIVE_QUANTILES = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)
SOURCE_FILE_SHA256 = {
    "LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "src/ffm/__init__.py": "d34f04310fbc42fb6a35d1b0cb033356da617a8cbbd5a3228f07e3089c379434",
    "src/ffm/pytorch_patched_decoder_MOE.py": "58c8d5dfea859c87958e1b35fa2b2eb9c9a1d8bd99813be528adbdaf37c15dbe",
    "src/st_moe_pytorch/__init__.py": "5d67d4f81d080199049af3217f947fa1e6de83671675e1543801995f4c602553",
    "src/st_moe_pytorch/st_moe_pytorch.py": "c38a8789120f6d5009be4fd91cce1a9d75011adb1ddb73f45060b99f0d7ae477",
    "src/st_moe_pytorch/distributed.py": "3a3742c3389be59305c3eb22e88cbaef3fcfec514687856b7b1954a3a5db129a",
}
_ATTENTION_DECODER_PATH = "src/ffm/pytorch_patched_decoder_MOE.py"
_FP32_ISLAND_SUFFIXES = (
    ".input_layernorm.weight",
    ".moe_prenorm.gamma",
    ".gate.to_gates.weight",
    ".gate.threshold_train",
    ".gate.threshold_eval",
    ".gate.zero",
)
_FLOAT16_DTYPE = "torch.float16"
_FLOAT32_DTYPE = "torch.float32"
_OBSERVATION_ATTRIBUTE = "_fincast_mixed_dtype_observation"
_DECODE_OBSERVATION_ATTRIBUTE = "_fincast_decode_dtype_observation"
_PINNED_ST_MOE_FILES = {
    "st_moe_pytorch": "src/st_moe_pytorch/__init__.py",
    "st_moe_pytorch.st_moe_pytorch": "src/st_moe_pytorch/st_moe_pytorch.py",
    "st_moe_pytorch.distributed": "src/st_moe_pytorch/distributed.py",
}


def is_fincast_fp32_island_key(key: str) -> bool:
    """Return whether a pinned FinCast floating state/module key remains FP32."""

    return isinstance(key, str) and any(key.endswith(suffix) for suffix in _FP32_ISLAND_SUFFIXES)


def _attention_softmax_structure_matches(source_text: str) -> bool:
    """Match the exact reviewed FP32-softmax/activation-restore expression."""

    try:
        tree = ast.parse(source_text)
    except (SyntaxError, ValueError):
        return False
    attention_classes = [
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "TimesFMAttention"
    ]
    if len(attention_classes) != 1:
        return False
    forward_methods = [
        node
        for node in attention_classes[0].body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "forward"
    ]
    if len(forward_methods) != 1:
        return False
    expected = ast.parse(
        "F.softmax(scores.float(), dim=-1).type_as(q)",
        mode="eval",
    ).body
    matches = [
        node
        for node in ast.walk(forward_methods[0])
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "scores"
        and ast.dump(node.value, include_attributes=False)
        == ast.dump(expected, include_attributes=False)
    ]
    return len(matches) == 1


def verify_pinned_attention_softmax_structure(source: Path) -> None:
    """Verify the reviewed attention AST only after its exact source hash matches."""

    decoder_path = source / _ATTENTION_DECODER_PATH
    if (
        decoder_path.is_symlink()
        or not decoder_path.is_file()
        or sha256_file(decoder_path) != SOURCE_FILE_SHA256[_ATTENTION_DECODER_PATH]
    ):
        raise AdapterLoadError("FinCast attention source does not match the pinned SHA-256")
    try:
        source_text = decoder_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise AdapterLoadError("FinCast attention source is unreadable") from error
    if not _attention_softmax_structure_matches(source_text):
        raise AdapterLoadError("FinCast attention FP32 softmax structure does not match the reviewed invariant")


class MemoryPressureError(AdapterLoadError):
    pass


class _NvmlMemory(ctypes.Structure):
    _fields_ = [
        ("total", ctypes.c_ulonglong),
        ("free", ctypes.c_ulonglong),
        ("used", ctypes.c_ulonglong),
    ]


def nvml_free_bytes(device_index: int) -> int:
    """Read free device memory directly through NVML.

    Runtime does not shell out or infer availability from PyTorch allocator
    state. If NVML cannot provide authoritative free memory, FinCast remains
    unavailable.
    """

    try:
        nvml = ctypes.CDLL("libnvidia-ml.so.1")
    except OSError as error:
        raise AdapterLoadError("NVML is unavailable for the FinCast VRAM preflight") from error
    init = getattr(nvml, "nvmlInit_v2", None) or getattr(nvml, "nvmlInit", None)
    get_handle = getattr(nvml, "nvmlDeviceGetHandleByIndex_v2", None) or getattr(
        nvml, "nvmlDeviceGetHandleByIndex", None
    )
    get_memory = getattr(nvml, "nvmlDeviceGetMemoryInfo", None)
    shutdown = getattr(nvml, "nvmlShutdown", None)
    if init is None or get_handle is None or get_memory is None or shutdown is None:
        raise AdapterLoadError("NVML does not expose the required memory inspection API")
    handle = ctypes.c_void_p()
    memory = _NvmlMemory()
    if init() != 0:
        raise AdapterLoadError("NVML initialization failed")
    try:
        if get_handle(ctypes.c_uint(device_index), ctypes.byref(handle)) != 0:
            raise AdapterLoadError("NVML could not resolve the configured FinCast GPU")
        if get_memory(handle, ctypes.byref(memory)) != 0:
            raise AdapterLoadError("NVML could not inspect FinCast GPU memory")
    finally:
        shutdown()
    return int(memory.free)


def _regular_file(root: Path, path: Path, label: str) -> Path:
    resolved = _inside(root, path)
    if path.is_symlink() or not resolved.is_file() or resolved.stat().st_size <= 0:
        raise AdapterLoadError(f"{label} must be a non-empty regular file inside AI_MODEL_CACHE_DIR")
    return resolved


def _source_snapshot(root: Path, source_manifest: dict[str, Any]) -> Path:
    if (
        source_manifest.get("revision") != SOURCE_REVISION
        or source_manifest.get("archive_sha256") != SOURCE_ARCHIVE_SHA256
        or source_manifest.get("required_file_sha256") != SOURCE_FILE_SHA256
    ):
        raise AdapterLoadError("FinCast source identity does not match the reviewed manifest")
    source = _inside(root, root / "fincast-source")
    markers = {
        ".source-revision": SOURCE_REVISION,
        ".source-archive-sha256": SOURCE_ARCHIVE_SHA256,
    }
    for name, expected in markers.items():
        marker = _regular_file(root, source / name, f"FinCast {name} marker")
        if marker.read_text(encoding="utf-8").strip() != expected:
            raise AdapterLoadError(f"FinCast {name} marker does not match the reviewed manifest")
    for relative, expected_sha256 in SOURCE_FILE_SHA256.items():
        path = _regular_file(root, source / relative, "FinCast source file")
        if sha256_file(path) != expected_sha256:
            raise AdapterLoadError(f"FinCast source file SHA-256 mismatch: {relative}")
    return source


def _artifact_selection(
    root: Path,
    model_manifest: dict[str, Any],
) -> tuple[FinCastPrecisionValidation, Path, str, int]:
    model_dir = _inside(root, root / "fincast")
    marker = _regular_file(root, model_dir / ".revision", "FinCast model revision marker")
    if marker.read_text(encoding="utf-8").strip() != MODEL_REVISION:
        raise AdapterLoadError("FinCast model revision marker does not match the reviewed manifest")
    validation_name = model_manifest.get("precision_validation")
    if validation_name != "precision-validation.json":
        raise AdapterLoadError("FinCast precision validation filename is not pinned")
    validation = load_precision_validation(
        _regular_file(root, model_dir / validation_name, "FinCast precision validation")
    )
    if validation.context_fixture_sha256 != model_manifest.get("validation_contexts_sha256"):
        raise AdapterLoadError("FinCast validation context SHA-256 does not match the reviewed manifest")
    if (
        validation.quantile_tail_policy != model_manifest.get("quantile_tail_policy")
        or validation.quantile_monotonicity_policy
        != model_manifest.get("quantile_monotonicity_policy")
    ):
        raise AdapterLoadError("FinCast quantile policies do not match the reviewed manifest")
    if validation.selected_precision == "mixed_float16":
        artifact = validation.mixed_fp16
    else:
        artifact = validation.fp32
    path = _regular_file(root, model_dir / artifact.file, "FinCast safetensors artifact")
    if sha256_file(path) != artifact.sha256:
        raise AdapterLoadError("FinCast safetensors SHA-256 does not match precision validation")
    return validation, path, validation.selected_precision, artifact.peak_vram_bytes


def _dtype_name(value: Any) -> str:
    dtype = getattr(value, "dtype", None)
    return str(dtype) if dtype is not None else "unavailable"


def _is_floating_tensor(value: Any) -> bool:
    dtype = getattr(value, "dtype", None)
    dtype_flag = getattr(dtype, "is_floating_point", None)
    if isinstance(dtype_flag, bool):
        return dtype_flag
    name = str(dtype)
    return name == "torch.bfloat16" or name.startswith("torch.float")


def _qualified_name(module_name: str, value_name: str) -> str:
    return f"{module_name}.{value_name}" if module_name else value_name


def _named_floating_tensors(model: Any) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for iterator in (model.named_parameters(), model.named_buffers()):
        for name, tensor in iterator:
            if name in values:
                raise AdapterLoadError("FinCast model exposes a duplicate parameter or buffer name")
            if _is_floating_tensor(tensor):
                values[name] = tensor
    return values


def validate_fincast_mixed_model_dtypes(model: Any) -> None:
    """Exhaustively verify loaded floating parameters and buffers against one boundary."""

    floating = _named_floating_tensors(model)
    if not floating:
        raise AdapterLoadError("FinCast mixed model exposes no floating parameters or buffers")

    class_islands: set[str] = set()
    class_counts = {"RMSNorm": 0, "TopNGating": 0}
    for module_name, module in model.named_modules():
        class_name = type(module).__name__
        if class_name not in class_counts:
            continue
        class_counts[class_name] += 1
        for value_name, tensor in (*module.named_parameters(recurse=True), *module.named_buffers(recurse=True)):
            if _is_floating_tensor(tensor):
                class_islands.add(_qualified_name(module_name, value_name))

    if any(count <= 0 for count in class_counts.values()):
        raise AdapterLoadError("FinCast mixed model is missing a required RMSNorm or TopNGating island")
    predicate_islands = {name for name in floating if is_fincast_fp32_island_key(name)}
    if class_islands != predicate_islands:
        raise AdapterLoadError("FinCast mixed FP32-island ownership differs from the reviewed key predicate")
    if predicate_islands == set(floating):
        raise AdapterLoadError("FinCast mixed model exposes no ordinary FP16 tensors")

    for name, tensor in floating.items():
        expected = _FLOAT32_DTYPE if name in predicate_islands else _FLOAT16_DTYPE
        if _dtype_name(tensor) != expected:
            raise AdapterLoadError("FinCast loaded parameter or buffer violates the mixed dtype boundary")


def _new_dtype_observation() -> dict[str, Any]:
    return {"calls": 0}


def _dtype_observation(module: Any) -> dict[str, Any]:
    marker = getattr(module, _OBSERVATION_ATTRIBUTE, None)
    if not isinstance(marker, dict):
        marker = _new_dtype_observation()
        setattr(module, _OBSERVATION_ATTRIBUTE, marker)
    return marker


def _record_dtype(module: Any, field: str, *values: Any) -> None:
    marker = _dtype_observation(module)
    observed = marker.setdefault(field, set())
    if not isinstance(observed, set):
        raise AdapterLoadError("FinCast dtype observation marker was corrupted")
    observed.update(_dtype_name(value) for value in values)


def _remember_input_dtype(module: Any, args: tuple[Any, ...]) -> tuple[Any, ...]:
    if not args:
        return args
    module._fincast_input_dtype = args[0].dtype
    marker = _dtype_observation(module)
    marker["calls"] = int(marker.get("calls", 0)) + 1
    _record_dtype(module, "activation_input", args[0])
    compute_input = args[0].float()
    _record_dtype(module, "compute_input", compute_input)
    return (compute_input, *args[1:])


def _restore_output_dtype(module: Any, _args: tuple[Any, ...], output: Any) -> Any:
    _record_dtype(module, "compute_output", output)
    dtype = module._fincast_input_dtype
    restored = output.to(dtype=dtype)
    _record_dtype(module, "restored_output", restored)
    return restored


def _restore_router_outputs(module: Any, _args: tuple[Any, ...], output: Any) -> Any:
    dtype = module._fincast_input_dtype
    dispatch, combine, balance_loss, router_z_loss = output
    _record_dtype(module, "compute_output", dispatch, combine)
    _record_dtype(module, "aux_output", balance_loss, router_z_loss)
    restored_dispatch = dispatch.to(dtype=dtype)
    restored_combine = combine.to(dtype=dtype)
    _record_dtype(module, "restored_output", restored_dispatch, restored_combine)
    return restored_dispatch, restored_combine, balance_loss, router_z_loss


def _promote_horizon_output(module: Any, _args: tuple[Any, ...], output: Any) -> Any:
    marker = _dtype_observation(module)
    marker["calls"] = int(marker.get("calls", 0)) + 1
    _record_dtype(module, "pre_promotion_output", output)
    promoted = output.float()
    _record_dtype(module, "promoted_output", promoted)
    return promoted


def observe_fincast_decode_output_dtypes(model: Any, mean: Any, full: Any) -> None:
    marker = getattr(model, _DECODE_OBSERVATION_ATTRIBUTE, None)
    if not isinstance(marker, dict):
        marker = _new_dtype_observation()
        setattr(model, _DECODE_OBSERVATION_ATTRIBUTE, marker)
    marker["calls"] = int(marker.get("calls", 0)) + 1
    for field, value in (("mean_output", mean), ("full_output", full)):
        observed = marker.setdefault(field, set())
        if not isinstance(observed, set):
            raise AdapterLoadError("FinCast decode dtype observation marker was corrupted")
        observed.add(_dtype_name(value))


def _require_dtype_observation(
    marker: Any,
    expected: dict[str, set[str]],
    label: str,
) -> None:
    if not isinstance(marker, dict) or marker.get("calls", 0) <= 0:
        raise AdapterLoadError(f"FinCast mixed {label} hook was not observed during qualification")
    for field, expected_dtypes in expected.items():
        if marker.get(field) != expected_dtypes:
            raise AdapterLoadError(f"FinCast mixed {label} dtype observation violates the reviewed boundary")


def validate_fincast_mixed_inference_observations(model: Any) -> None:
    """Validate tensor-free dtype markers populated by actual mixed inference."""

    counts = {"RMSNorm": 0, "TopNGating": 0}
    for module in model.modules():
        class_name = type(module).__name__
        if class_name == "RMSNorm":
            counts[class_name] += 1
            _require_dtype_observation(
                getattr(module, _OBSERVATION_ATTRIBUTE, None),
                {
                    "activation_input": {_FLOAT16_DTYPE},
                    "compute_input": {_FLOAT32_DTYPE},
                    "compute_output": {_FLOAT32_DTYPE},
                    "restored_output": {_FLOAT16_DTYPE},
                },
                "RMSNorm",
            )
        elif class_name == "TopNGating":
            counts[class_name] += 1
            _require_dtype_observation(
                getattr(module, _OBSERVATION_ATTRIBUTE, None),
                {
                    "activation_input": {_FLOAT16_DTYPE},
                    "compute_input": {_FLOAT32_DTYPE},
                    "compute_output": {_FLOAT32_DTYPE},
                    "aux_output": {_FLOAT32_DTYPE},
                    "restored_output": {_FLOAT16_DTYPE},
                },
                "TopNGating",
            )
    if any(count <= 0 for count in counts.values()):
        raise AdapterLoadError("FinCast mixed inference did not expose every required FP32 island class")

    horizon = getattr(model, "horizon_ff_layer", None)
    _require_dtype_observation(
        getattr(horizon, _OBSERVATION_ATTRIBUTE, None),
        {
            "pre_promotion_output": {_FLOAT16_DTYPE},
            "promoted_output": {_FLOAT32_DTYPE},
        },
        "horizon projection",
    )
    _require_dtype_observation(
        getattr(model, _DECODE_OBSERVATION_ATTRIBUTE, None),
        {
            "mean_output": {_FLOAT32_DTYPE},
            "full_output": {_FLOAT32_DTYPE},
        },
        "final decode output",
    )


def apply_mixed_precision_policy(model: Any) -> None:
    """Apply reviewed FP32 islands around the official FinCast source.

    The pinned decoder already evaluates attention softmax and its own RMSNorm
    arithmetic in FP32. These hooks cover the upstream MoE RMSNorm and router;
    the horizon projection remains FP16 but its returned tensor is promoted
    before inverse normalization and application post-processing.
    """

    model.half()
    for module in model.modules():
        class_name = type(module).__name__
        if class_name == "RMSNorm":
            module.float()
            setattr(module, _OBSERVATION_ATTRIBUTE, _new_dtype_observation())
            module.register_forward_pre_hook(_remember_input_dtype)
            module.register_forward_hook(_restore_output_dtype)
        elif class_name == "TopNGating":
            module.float()
            setattr(module, _OBSERVATION_ATTRIBUTE, _new_dtype_observation())
            module.register_forward_pre_hook(_remember_input_dtype)
            module.register_forward_hook(_restore_router_outputs)
    setattr(model.horizon_ff_layer, _OBSERVATION_ATTRIBUTE, _new_dtype_observation())
    model.horizon_ff_layer.register_forward_hook(_promote_horizon_output)
    setattr(model, _DECODE_OBSERVATION_ATTRIBUTE, _new_dtype_observation())


def import_decoder_from_source(source: Path) -> Any:
    """Import only the reviewed decoder without executing upstream ffm/__init__.

    The upstream package initializer imports training/dataframe/JAX utilities
    that are outside the inference dependency closure. A synthetic package with
    the exact pinned path lets Python resolve the reviewed decoder's relative
    identity while keeping those modules unreachable at runtime.
    """

    package_path = (source / "src" / "ffm").resolve()
    decoder_path = (package_path / "pytorch_patched_decoder_MOE.py").resolve()
    expected_st_moe_paths = {
        name: (source / relative).resolve()
        for name, relative in _PINNED_ST_MOE_FILES.items()
    }
    for name, expected_path in expected_st_moe_paths.items():
        if name not in sys.modules:
            continue
        existing_module = sys.modules[name]
        existing_path = Path(getattr(existing_module, "__file__", "") or "").resolve()
        if existing_path != expected_path:
            raise AdapterLoadError("FinCast dependency is already imported from a different source")
        if name == "st_moe_pytorch":
            existing_paths = tuple(
                Path(item).resolve() for item in getattr(existing_module, "__path__", ())
            )
            if existing_paths != (expected_path.parent,):
                raise AdapterLoadError("FinCast dependency package path differs from the pinned cache")
    existing_decoder = sys.modules.get("ffm.pytorch_patched_decoder_MOE")
    if existing_decoder is not None:
        existing_path = Path(getattr(existing_decoder, "__file__", "")).resolve()
        if existing_path != decoder_path:
            raise AdapterLoadError("FinCast decoder is already imported from a different source")
        decoder = existing_decoder
    else:
        existing_package = sys.modules.get("ffm")
        if existing_package is not None:
            existing_paths = tuple(Path(item).resolve() for item in getattr(existing_package, "__path__", ()))
            if existing_paths != (package_path,):
                raise AdapterLoadError("FinCast package is already imported from a different source")
        else:
            package = types.ModuleType("ffm")
            package.__file__ = str(package_path / "__init__.py")
            package.__package__ = "ffm"
            package.__path__ = [str(package_path)]
            specification = importlib.machinery.ModuleSpec("ffm", loader=None, is_package=True)
            specification.submodule_search_locations = [str(package_path)]
            package.__spec__ = specification
            sys.modules["ffm"] = package
        decoder = importlib.import_module("ffm.pytorch_patched_decoder_MOE")
    imported_path = Path(decoder.__file__ or "").resolve()
    if imported_path != decoder_path:
        raise AdapterLoadError("FinCast source import resolved outside the pinned cache")
    for name, expected_path in expected_st_moe_paths.items():
        if name not in sys.modules:
            raise AdapterLoadError("FinCast decoder did not load its pinned dependency closure")
        imported_module = sys.modules[name]
        imported_dependency_path = Path(
            getattr(imported_module, "__file__", "") or ""
        ).resolve()
        if imported_dependency_path != expected_path:
            raise AdapterLoadError("FinCast dependency import resolved outside the pinned cache")
        if name == "st_moe_pytorch":
            imported_paths = tuple(
                Path(item).resolve() for item in getattr(imported_module, "__path__", ())
            )
            if imported_paths != (expected_path.parent,):
                raise AdapterLoadError("FinCast dependency package path differs from the pinned cache")
    return decoder


def _load_model(source: Path, artifact: Path, precision: str, runtime: RuntimeDevice) -> Any:
    source_root = source / "src"
    source_text = str(source_root)
    if source_text not in sys.path:
        sys.path.insert(0, source_text)
    try:
        if precision == "mixed_float16":
            verify_pinned_attention_softmax_structure(source)
        decoder = import_decoder_from_source(source)
        safetensors = importlib.import_module("safetensors.torch")
        config = decoder.FFMConfig(num_experts=4, gating_top_n=2)
        model = decoder.PatchedTimeSeriesDecoder_MOE(config)
        if precision == "mixed_float16":
            apply_mixed_precision_policy(model)
        else:
            model.float()
        state = safetensors.load_file(str(artifact), device="cpu")
        model.load_state_dict(state, strict=True)
        model.eval()
        model.to(runtime.name)
        if precision == "mixed_float16":
            validate_fincast_mixed_model_dtypes(model)
        return model
    except AdapterLoadError:
        raise
    except Exception as error:
        raise AdapterLoadError(f"failed to load pinned FinCast artifacts: {type(error).__name__}") from error


def rearrange_native_quantiles(values: Sequence[float]) -> tuple[float, ...]:
    """Return finite q10..q90 values in deterministic ascending order."""

    if len(values) != len(NATIVE_QUANTILES):
        raise ValueError("FinCast must return q10 through q90")
    native = tuple(float(value) for value in values)
    if not all(math.isfinite(value) for value in native):
        raise ValueError("FinCast returned non-finite native quantiles")
    return tuple(sorted(native))


def project_native_quantiles(values: Sequence[float]) -> dict[float, float]:
    native = rearrange_native_quantiles(values)
    projected = {
        0.05: native[0],
        0.1: native[0],
        0.25: (native[1] + native[2]) / 2,
        0.5: native[4],
        0.75: (native[6] + native[7]) / 2,
        0.9: native[8],
        0.95: native[8],
    }
    if tuple(projected) != FIXED_QUANTILES:
        raise AssertionError("FinCast quantile projection drifted from the public contract")
    return projected


def fincast_interval_seconds(item: InferenceSeries) -> int:
    if len(item.bars) < 2:
        raise ValueError("FinCast requires at least two timestamped context bars")
    deltas = tuple(
        int((right.timestamp - left.timestamp).total_seconds())
        for left, right in zip(item.bars[-16:-1], item.bars[-15:], strict=True)
    )
    if not deltas or len(set(deltas)) != 1 or deltas[0] not in (15, 30, 60):
        raise ValueError("FinCast context bars must use a continuous 15s, 30s, or 60s interval")
    return deltas[0]


class FinCastAdapter:
    def __init__(
        self,
        settings: AISettings,
        model_manifest: dict[str, Any],
        source_manifest: dict[str, Any],
        runtime: RuntimeDevice,
    ) -> None:
        root = settings.model_cache_dir
        source = _source_snapshot(root, source_manifest)
        validation, artifact, precision, peak_vram_bytes = _artifact_selection(root, model_manifest)
        try:
            validate_qualification_runtime(validation, runtime.torch)
        except ValueError as error:
            raise AdapterLoadError(
                "FinCast runtime does not match its pinned precision qualification"
            ) from error
        free_bytes = nvml_free_bytes(settings.fincast_nvml_device_index)
        required = peak_vram_bytes + settings.fincast_min_vram_headroom_bytes
        if free_bytes < required:
            raise MemoryPressureError(
                f"memory_pressure: FinCast requires {required} free bytes including configured headroom"
            )
        self._runtime = runtime
        self._context_bars = settings.fincast_context_bars
        loaded_model = _load_model(source, artifact, precision, runtime)
        post_load_free_bytes = nvml_free_bytes(settings.fincast_nvml_device_index)
        if post_load_free_bytes < settings.fincast_min_vram_headroom_bytes:
            loaded_model = None
            try:
                runtime.torch.cuda.empty_cache()
            except Exception:
                pass
            raise MemoryPressureError(
                "memory_pressure: FinCast post-load VRAM headroom is below the configured minimum"
            )
        self._model = loaded_model
        self._precision = precision
        self._provenance = _provenance(
            model_manifest,
            source_revision=SOURCE_REVISION,
            device=runtime.name,
            device_name=runtime.device_name,
            cuda_capability=runtime.cuda_capability,
            loaded=True,
            dtype=precision,
            precision_validation=("passed" if precision == "mixed_float16" else "fallback_fp32"),
            peak_vram_bytes=peak_vram_bytes,
            peak_vram_measurement="cuda_allocated_or_reserved",
            memory_status="ok",
            quantile_tail_policy="tail_clamped_q10_q90",
            quantile_monotonicity_policy="fp32_monotone_rearrangement_v1",
            fp32_quantile_observations=validation.fp32_quantile_observations,
            mixed_quantile_observations=validation.mixed_quantile_observations,
            precision_failure_reasons=validation.mixed_failure_reasons,
        )

    @property
    def provenance(self) -> ModelProvenance:
        return self._provenance

    def predict_batch(self, series: Sequence[InferenceSeries], *, seed: int) -> list[RawPrediction]:
        if not series:
            return []
        if any(len(item.bars) < self._context_bars for item in series):
            raise ValueError("FinCast requires 512 complete context bars")
        intervals = tuple(fincast_interval_seconds(item) for item in series)
        if len(set(intervals)) != 1:
            raise ValueError("FinCast batch series must use the same candle interval")
        interval_seconds = intervals[0]
        native_horizon_steps = max(FIXED_HORIZONS) * 60 // interval_seconds
        torch = self._runtime.torch
        dtype = torch.float16 if self._precision == "mixed_float16" else torch.float32
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        contexts = [
            [bar.close for bar in item.bars[-self._context_bars :]]
            for item in series
        ]
        input_ts = torch.tensor(contexts, dtype=dtype, device=self._runtime.name)
        paddings = torch.zeros(
            (len(series), self._context_bars + native_horizon_steps),
            dtype=dtype,
            device=self._runtime.name,
        )
        frequency = torch.zeros((len(series), 1), dtype=torch.long, device=self._runtime.name)
        with torch.inference_mode():
            _mean, full = self._model.decode(
                input_ts=input_ts,
                paddings=paddings,
                freq=frequency,
                horizon_len=native_horizon_steps,
                output_patch_len=128,
                max_len=self._context_bars,
                return_forecast_on_context=False,
            )
        values = full.float().cpu().tolist()
        if len(values) != len(series):
            raise ValueError("FinCast returned a misaligned batch")
        output: list[RawPrediction] = []
        for item, forecast in zip(series, values, strict=True):
            close_quantiles: dict[int, dict[float, float]] = {}
            for horizon in FIXED_HORIZONS:
                native_step = horizon * 60 // interval_seconds
                row = forecast[native_step - 1]
                if len(row) != 1 + len(NATIVE_QUANTILES) or not all(math.isfinite(float(value)) for value in row):
                    raise ValueError("FinCast returned an invalid forecast tensor")
                close_quantiles[horizon] = project_native_quantiles(row[1:])
            output.append(
                RawPrediction(
                    instrument_key=item.instrument_key,
                    close_quantiles=close_quantiles,
                )
            )
        return output
