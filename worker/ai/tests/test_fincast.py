from __future__ import annotations

from pathlib import Path
import hashlib
import importlib.util
import json
import sys
from types import ModuleType, SimpleNamespace

import pytest
from pydantic import ValidationError

import portfolio_ai_worker.fincast as fincast_module
from portfolio_ai_worker.adapters import AdapterLoadError
from portfolio_ai_worker.fincast import (
    FinCastAdapter,
    MemoryPressureError,
    _attention_softmax_structure_matches,
    _promote_horizon_output,
    _remember_input_dtype,
    _restore_output_dtype,
    _restore_router_outputs,
    import_decoder_from_source,
    is_fincast_fp32_island_key,
    observe_fincast_decode_output_dtypes,
    project_native_quantiles,
    validate_fincast_mixed_inference_observations,
    validate_fincast_mixed_model_dtypes,
    verify_pinned_attention_softmax_structure,
)
from portfolio_ai_worker.precision_validation import (
    FinCastPrecisionValidation,
    MixedPrecisionMetrics,
    PrecisionArtifact,
    QualificationEnvironment,
    cost_exceeding_direction,
    precision_failure_reasons,
    qualification_environment_from_torch,
    serialize_precision_validation,
    validate_qualification_runtime,
)


def _artifact(file: str, peak: int, *, complete: bool = True) -> PrecisionArtifact:
    return PrecisionArtifact(
        file=file,
        sha256="a" * 64,
        peak_vram_bytes=peak,
        peak_vram_measurement="cuda_allocated_or_reserved",
        peak_vram_measurement_complete=complete,
    )


def _completed_validation(metrics: MixedPrecisionMetrics) -> FinCastPrecisionValidation:
    reasons = precision_failure_reasons(metrics)
    return FinCastPrecisionValidation(
        schema_version="fincast-precision-validation/v2",
        model_id="Vincent05R/FinCast",
        model_revision="2d7d90b159db8961d27c2cf165d51195902ef92b",
        source_revision="488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
        mixed_runtime_policy_version="fincast-mixed-runtime-policy/v1",
        qualification_environment=QualificationEnvironment(
            torch_version="2.6.0",
            cuda_runtime_version="12.4",
            gpu_name="Tesla P40",
            cuda_capability="6.1",
        ),
        context_fixture_sha256="b" * 64,
        context_count=128,
        quantile_tail_policy="tail_clamped_q10_q90",
        fp32=_artifact("model.fp32.safetensors", 10_000),
        mixed_fp16=_artifact("model.mixed-fp16.safetensors", 6_000),
        mixed_run_status="completed",
        mixed_runtime_failure=None,
        mixed_metrics=metrics,
        mixed_failure_reasons=reasons,
        selected_precision="mixed_float16" if not reasons else "float32",
    )


def _validation_script() -> object:
    script = Path(__file__).resolve().parents[3] / "scripts" / "validate-fincast-precision.py"
    module_name = "validate_fincast_precision_test"
    specification = importlib.util.spec_from_file_location(module_name, script)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[module_name] = module
    specification.loader.exec_module(module)
    return module


def _prepare_script() -> object:
    script = Path(__file__).resolve().parents[3] / "scripts" / "prepare-fincast-model-cache.py"
    module_name = "prepare_fincast_model_cache_test"
    specification = importlib.util.spec_from_file_location(module_name, script)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[module_name] = module
    specification.loader.exec_module(module)
    return module


def _qualification_torch(cuda: object | None = None) -> object:
    bounded_cuda = cuda or SimpleNamespace(
        get_device_name=lambda: "Tesla P40",
        get_device_capability=lambda: (6, 1),
    )
    return SimpleNamespace(
        __version__="2.6.0+cu124",
        version=SimpleNamespace(cuda="12.4"),
        cuda=bounded_cuda,
    )


def test_native_quantiles_use_documented_tail_clamp_without_extrapolation() -> None:
    projected = project_native_quantiles((10, 20, 30, 40, 50, 60, 70, 80, 90))

    assert tuple(projected) == (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)
    assert projected == {
        0.05: 10,
        0.1: 10,
        0.25: 25,
        0.5: 50,
        0.75: 75,
        0.9: 90,
        0.95: 90,
    }
    with pytest.raises(ValueError, match="crossing"):
        project_native_quantiles((10, 20, 30, 40, 39, 60, 70, 80, 90))


def test_precision_gate_requires_every_fixed_threshold() -> None:
    passing = MixedPrecisionMetrics(
        finite=True,
        quantile_monotonic=True,
        signal_direction_agreement=0.99,
        q50_median_iqr_ratio=0.05,
        q50_p95_iqr_ratio=0.15,
        peak_vram_reduction=0.25,
    )
    assert precision_failure_reasons(passing) == ()
    failing = passing.model_copy(
        update={
            "finite": False,
            "quantile_monotonic": False,
            "signal_direction_agreement": 0.989,
            "q50_median_iqr_ratio": 0.051,
            "q50_p95_iqr_ratio": 0.151,
            "peak_vram_reduction": 0.249,
        }
    )
    assert precision_failure_reasons(failing) == (
        "non_finite_output",
        "quantile_crossing",
        "signal_direction_agreement_below_99pct",
        "q50_median_error_above_5pct_fp32_iqr",
        "q50_p95_error_above_15pct_fp32_iqr",
        "peak_vram_reduction_below_25pct",
    )


def test_cost_exceeding_direction_matches_node_cdf_threshold_and_tie_policy() -> None:
    assert cost_exceeding_direction([(0.1, -0.02), (0.5, 0.01), (0.9, 0.04)], 0.001) == 1
    assert cost_exceeding_direction([(0.1, -0.04), (0.5, -0.01), (0.9, 0.02)], 0.001) == -1
    assert cost_exceeding_direction([(0.1, -0.001), (0.5, 0), (0.9, 0.001)], 0.01) == 0


def test_failed_mixed_validation_selects_lossless_fp32_artifact() -> None:
    metrics = MixedPrecisionMetrics(
        finite=True,
        quantile_monotonic=True,
        signal_direction_agreement=0.98,
        q50_median_iqr_ratio=0.01,
        q50_p95_iqr_ratio=0.02,
        peak_vram_reduction=0.4,
    )
    validation = _completed_validation(metrics)
    assert validation.selected_precision == "float32"
    with pytest.raises(ValidationError, match="selected precision"):
        validation.model_copy(update={"selected_precision": "mixed_float16"}).model_validate(
            validation.model_copy(update={"selected_precision": "mixed_float16"}).model_dump()
        )


def test_passing_mixed_qualification_selects_fp16(tmp_path: Path) -> None:
    module = _validation_script()
    output = [[[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]]]
    runs = iter(
        (
            module.PrecisionRunResult(output, 10_000, True, None),
            module.PrecisionRunResult(output, 6_000, True, None),
        )
    )
    module.run_precision = lambda *_args: next(runs)
    fp32_path = tmp_path / "model.fp32.safetensors"
    mixed_path = tmp_path / "model.mixed-fp16.safetensors"
    fp32_path.write_bytes(b"fp32")
    mixed_path.write_bytes(b"mixed")
    validation = module.qualify_precision(
        Path("/unused/source"),
        fp32_path,
        mixed_path,
        [{"closes": [5.0] * 512, "round_trip_cost_bps": 8.0}],
        "b" * 64,
        _qualification_torch(),
    )

    assert validation.mixed_run_status == "completed"
    assert validation.mixed_runtime_failure is None
    assert validation.mixed_metrics is not None
    assert validation.mixed_metrics.peak_vram_reduction == pytest.approx(0.4)
    assert validation.mixed_failure_reasons == ()
    assert validation.selected_precision == "mixed_float16"


def test_precision_validation_serializes_as_standard_finite_json() -> None:
    validation = _completed_validation(
        MixedPrecisionMetrics(
            finite=True,
            quantile_monotonic=True,
            signal_direction_agreement=1.0,
            q50_median_iqr_ratio=0.01,
            q50_p95_iqr_ratio=0.02,
            peak_vram_reduction=0.4,
        )
    )

    payload = serialize_precision_validation(validation)
    decoded = json.loads(
        payload,
        parse_constant=lambda value: pytest.fail(f"non-standard JSON number was serialized: {value}"),
    )
    assert decoded["selected_precision"] == "mixed_float16"
    assert "NaN" not in payload
    assert "Infinity" not in payload

    invalid_metrics = MixedPrecisionMetrics.model_construct(
        finite=True,
        quantile_monotonic=True,
        signal_direction_agreement=1.0,
        q50_median_iqr_ratio=float("nan"),
        q50_p95_iqr_ratio=0.02,
        peak_vram_reduction=0.4,
    )
    invalid_validation = validation.model_copy(update={"mixed_metrics": invalid_metrics})
    with pytest.raises(ValidationError):
        serialize_precision_validation(invalid_validation)


def test_precision_validation_v2_binds_policy_and_exact_qualification_environment() -> None:
    validation = _completed_validation(
        MixedPrecisionMetrics(
            finite=True,
            quantile_monotonic=True,
            signal_direction_agreement=1.0,
            q50_median_iqr_ratio=0.01,
            q50_p95_iqr_ratio=0.02,
            peak_vram_reduction=0.4,
        )
    )
    observed = qualification_environment_from_torch(_qualification_torch())
    assert observed == validation.qualification_environment
    validate_qualification_runtime(validation, _qualification_torch())

    missing_policy = validation.model_dump(mode="python")
    missing_policy.pop("mixed_runtime_policy_version")
    with pytest.raises(ValidationError, match="mixed_runtime_policy_version"):
        FinCastPrecisionValidation.model_validate(missing_policy)

    missing_environment = validation.model_dump(mode="python")
    missing_environment.pop("qualification_environment")
    with pytest.raises(ValidationError, match="qualification_environment"):
        FinCastPrecisionValidation.model_validate(missing_environment)


@pytest.mark.parametrize(
    ("torch_version", "cuda_version", "gpu_name", "capability"),
    (
        ("2.6.1", "12.4", "Tesla P40", (6, 1)),
        ("2.6.0", "12.5", "Tesla P40", (6, 1)),
        ("2.6.0", "12.4", "Tesla P100", (6, 1)),
        ("2.6.0", "12.4", "Tesla P40", (6, 0)),
    ),
)
def test_qualification_environment_rejects_any_runtime_drift(
    torch_version: str,
    cuda_version: str,
    gpu_name: str,
    capability: tuple[int, int],
) -> None:
    torch = SimpleNamespace(
        __version__=torch_version,
        version=SimpleNamespace(cuda=cuda_version),
        cuda=SimpleNamespace(
            get_device_name=lambda: gpu_name,
            get_device_capability=lambda: capability,
        ),
    )
    with pytest.raises(ValueError, match="pinned qualification environment"):
        qualification_environment_from_torch(torch)


def _write_qualification_cache(root: Path) -> tuple[Path, dict[str, str]]:
    model = root / "fincast"
    model.mkdir(parents=True)
    (model / ".revision").write_text(
        "2d7d90b159db8961d27c2cf165d51195902ef92b\n",
        encoding="utf-8",
    )
    artifacts = {
        "model.fp32.safetensors": b"lossless-fp32",
        "model.mixed-fp16.safetensors": b"mixed-fp16",
    }
    hashes: dict[str, str] = {}
    for name, contents in artifacts.items():
        path = model / name
        path.write_bytes(contents)
        hashes[name] = hashlib.sha256(contents).hexdigest()
    (model / ".artifact-sha256.json").write_text(
        json.dumps(hashes, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return root, hashes


def test_validator_verifies_regular_artifacts_against_cache_hash_manifest(
    tmp_path: Path,
) -> None:
    module = _validation_script()
    cache, expected_hashes = _write_qualification_cache(tmp_path / "cache")

    resolved_cache, fp32, mixed, hashes = module.verify_qualification_cache(cache)

    assert resolved_cache == cache.resolve()
    assert fp32 == (cache / "fincast" / "model.fp32.safetensors").resolve()
    assert mixed == (cache / "fincast" / "model.mixed-fp16.safetensors").resolve()
    assert hashes == expected_hashes


@pytest.mark.parametrize(
    "symlink_target",
    ("cache", "model", "revision", "hash_manifest", "fp32", "mixed_fp16"),
)
def test_validator_rejects_cache_model_and_artifact_symlinks_before_gpu(
    tmp_path: Path,
    symlink_target: str,
) -> None:
    module = _validation_script()
    cache, _hashes = _write_qualification_cache(tmp_path / "cache")
    model = cache / "fincast"
    candidate = cache
    if symlink_target == "cache":
        link = tmp_path / "cache-link"
        link.symlink_to(cache, target_is_directory=True)
        candidate = link
    elif symlink_target == "model":
        real_model = cache / "fincast-real"
        model.rename(real_model)
        model.symlink_to(real_model, target_is_directory=True)
    else:
        name = {
            "revision": ".revision",
            "hash_manifest": ".artifact-sha256.json",
            "fp32": "model.fp32.safetensors",
            "mixed_fp16": "model.mixed-fp16.safetensors",
        }[symlink_target]
        original = model / name
        target = tmp_path / f"real-{name}"
        original.rename(target)
        original.symlink_to(target)

    with pytest.raises(RuntimeError, match="symlink"):
        module.verify_qualification_cache(candidate)


def test_validator_rejects_hash_manifest_mismatch_before_gpu(tmp_path: Path) -> None:
    module = _validation_script()
    cache, _hashes = _write_qualification_cache(tmp_path / "cache")
    (cache / "fincast" / "model.fp32.safetensors").write_bytes(b"tampered")

    with pytest.raises(RuntimeError, match="SHA-256"):
        module.verify_qualification_cache(cache)


def test_mixed_runtime_exception_atomically_writes_sanitized_fp32_fallback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _validation_script()
    fp32_path = tmp_path / "model.fp32.safetensors"
    mixed_path = tmp_path / "model.mixed-fp16.safetensors"
    fp32_path.write_bytes(b"lossless-fp32")
    mixed_path.write_bytes(b"mixed-fp16")
    reference = [[[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]]]

    class FakeCuda:
        def __init__(self) -> None:
            self.empty_cache_calls = 0
            self.peak = 0

        def empty_cache(self) -> None:
            self.empty_cache_calls += 1

        def reset_peak_memory_stats(self) -> None:
            self.peak = 0

        def get_device_name(self) -> str:
            return "Tesla P40"

        def get_device_capability(self) -> tuple[int, int]:
            return (6, 1)

        def max_memory_allocated(self) -> int:
            return self.peak

        def max_memory_reserved(self) -> int:
            return max(0, self.peak - 1_000)

    cuda = FakeCuda()
    fake_torch = _qualification_torch(cuda)

    def fake_load_model(
        _source: Path,
        artifact: Path,
        _precision: str,
        _runtime: object,
    ) -> object:
        if artifact == fp32_path:
            cuda.peak = 10_000
            return object()
        cuda.peak = 6_000
        raise RuntimeError(
            "CUDA out of memory while loading /sensitive/cache/model.safetensors at 0x7f001234"
        )

    monkeypatch.setattr(module, "_load_model", fake_load_model)
    monkeypatch.setattr(module, "_forecast", lambda *_args: reference)
    gc_calls: list[bool] = []
    monkeypatch.setattr(module.gc, "collect", lambda: gc_calls.append(True))

    validation = module.qualify_precision(
        Path("/unused/source"),
        fp32_path,
        mixed_path,
        [{"closes": [5.0] * 512, "round_trip_cost_bps": 8.0}],
        "b" * 64,
        fake_torch,
    )

    assert validation.selected_precision == "float32"
    assert validation.mixed_run_status == "runtime_failed"
    assert validation.mixed_metrics is None
    assert validation.mixed_runtime_failure is not None
    assert validation.mixed_runtime_failure.code == "mixed_cuda_out_of_memory"
    assert validation.mixed_runtime_failure.stage == "load"
    assert validation.mixed_runtime_failure.exception_class == "RuntimeError"
    assert validation.mixed_failure_reasons == ("mixed_cuda_out_of_memory",)
    assert validation.mixed_fp16.peak_vram_bytes == 6_000
    assert validation.mixed_fp16.peak_vram_measurement_complete is False
    assert cuda.empty_cache_calls == 4
    assert len(gc_calls) == 2

    output = tmp_path / "precision-validation.json"
    payload = module.write_validation_atomic(output, validation)
    persisted = json.loads(output.read_text(encoding="utf-8"))
    assert persisted["selected_precision"] == "float32"
    assert persisted["mixed_run_status"] == "runtime_failed"
    assert persisted["mixed_runtime_failure"] == {
        "code": "mixed_cuda_out_of_memory",
        "exception_class": "RuntimeError",
        "stage": "load",
    }
    assert payload + "\n" == output.read_text(encoding="utf-8")
    assert "/sensitive/" not in payload
    assert "0x7f001234" not in payload
    assert not tuple(tmp_path.glob(".precision-validation-*.tmp"))

    tampered = validation.model_copy(update={"selected_precision": "mixed_float16"})
    with pytest.raises(ValidationError, match="selected precision"):
        serialize_precision_validation(tampered)


def test_unsupported_mixed_operation_uses_only_bounded_failure_fields() -> None:
    module = _validation_script()
    observation = module._sanitized_failure(
        RuntimeError("operator is not implemented for Half at /secret/source.py:99"),
        "inference",
    )
    failure = module._runtime_failure(observation)

    assert failure.model_dump() == {
        "code": "mixed_unsupported_operation",
        "stage": "inference",
        "exception_class": "RuntimeError",
    }


def test_mixed_observation_mismatch_falls_back_without_applying_invariant_to_fp32(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _validation_script()
    fp32_path = tmp_path / "model.fp32.safetensors"
    mixed_path = tmp_path / "model.mixed-fp16.safetensors"
    fp32_path.write_bytes(b"lossless-fp32")
    mixed_path.write_bytes(b"mixed-fp16")
    reference = [[[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]]]

    class FakeCuda:
        def __init__(self) -> None:
            self.peak = 0

        def empty_cache(self) -> None:
            pass

        def reset_peak_memory_stats(self) -> None:
            self.peak = 0

        def get_device_name(self) -> str:
            return "Tesla P40"

        def get_device_capability(self) -> tuple[int, int]:
            return (6, 1)

        def max_memory_allocated(self) -> int:
            return self.peak

        def max_memory_reserved(self) -> int:
            return self.peak

    cuda = FakeCuda()
    fake_torch = _qualification_torch(cuda)
    model_without_observations = SimpleNamespace(modules=lambda: ())

    def fake_load_model(
        _source: Path,
        artifact: Path,
        _precision: str,
        _runtime: object,
    ) -> object:
        cuda.peak = 10_000 if artifact == fp32_path else 6_000
        return model_without_observations

    monkeypatch.setattr(module, "_load_model", fake_load_model)
    monkeypatch.setattr(module, "_forecast", lambda *_args: reference)
    validation = module.qualify_precision(
        Path("/unused/source"),
        fp32_path,
        mixed_path,
        [{"closes": [5.0] * 512, "round_trip_cost_bps": 8.0}],
        "b" * 64,
        fake_torch,
    )

    assert validation.selected_precision == "float32"
    assert validation.mixed_run_status == "runtime_failed"
    assert validation.mixed_runtime_failure is not None
    assert validation.mixed_runtime_failure.code == "mixed_evaluation_failure"
    assert validation.mixed_runtime_failure.stage == "evaluation"
    assert validation.mixed_runtime_failure.exception_class == "OtherException"
    assert validation.mixed_fp16.peak_vram_bytes == 6_000
    assert validation.mixed_fp16.peak_vram_measurement_complete is True


def test_fp32_runtime_failure_remains_fail_closed() -> None:
    module = _validation_script()
    failure = module.PrecisionRunFailureObservation(
        stage="load",
        category="stage_failure",
        exception_class="RuntimeError",
    )
    module.run_precision = lambda *_args: module.PrecisionRunResult(None, 4_000, False, failure)

    with pytest.raises(RuntimeError, match="FP32 FinCast baseline runtime failed"):
        module.qualify_precision(
            Path("/unused/source"),
            Path("/unused/model.fp32.safetensors"),
            Path("/unused/model.mixed-fp16.safetensors"),
            [{"closes": [5.0] * 512, "round_trip_cost_bps": 8.0}],
            "b" * 64,
            _qualification_torch(),
        )


class _FakeTensor:
    def __init__(self, dtype: str) -> None:
        self.dtype = dtype

    def float(self) -> "_FakeTensor":
        return _FakeTensor("torch.float32")

    def to(self, *, dtype: str) -> "_FakeTensor":
        return _FakeTensor(dtype)


class RMSNorm:
    def __init__(self, parameters: dict[str, _FakeTensor]) -> None:
        self._parameters = parameters

    def named_parameters(self, *, recurse: bool = True) -> tuple[tuple[str, _FakeTensor], ...]:
        del recurse
        return tuple(self._parameters.items())

    def named_buffers(self, *, recurse: bool = True) -> tuple[tuple[str, _FakeTensor], ...]:
        del recurse
        return ()


class TopNGating:
    def __init__(
        self,
        parameters: dict[str, _FakeTensor],
        buffers: dict[str, _FakeTensor],
    ) -> None:
        self._parameters = parameters
        self._buffers = buffers

    def named_parameters(self, *, recurse: bool = True) -> tuple[tuple[str, _FakeTensor], ...]:
        del recurse
        return tuple(self._parameters.items())

    def named_buffers(self, *, recurse: bool = True) -> tuple[tuple[str, _FakeTensor], ...]:
        del recurse
        return tuple(self._buffers.items())


class _HorizonLayer:
    pass


class _MixedBoundaryModel:
    def __init__(
        self,
        *,
        ordinary_dtype: str = "torch.float16",
        island_dtype: str = "torch.float32",
    ) -> None:
        prefix = "stacked_transformer.layers.0"
        input_norm_weight = _FakeTensor(island_dtype)
        moe_norm_gamma = _FakeTensor(island_dtype)
        router_weight = _FakeTensor(island_dtype)
        threshold_train = _FakeTensor(island_dtype)
        threshold_eval = _FakeTensor(island_dtype)
        router_zero = _FakeTensor(island_dtype)
        self.input_norm = RMSNorm({"weight": input_norm_weight})
        self.moe_norm = RMSNorm({"gamma": moe_norm_gamma})
        self.router = TopNGating(
            {"to_gates.weight": router_weight},
            {
                "threshold_train": threshold_train,
                "threshold_eval": threshold_eval,
                "zero": router_zero,
            },
        )
        self.horizon_ff_layer = _HorizonLayer()
        self._parameters = {
            "input_ff_layer.hidden_layer.0.weight": _FakeTensor(ordinary_dtype),
            f"{prefix}.self_attn.scaling": _FakeTensor(ordinary_dtype),
            f"{prefix}.input_layernorm.weight": input_norm_weight,
            f"{prefix}.moe.moe_prenorm.gamma": moe_norm_gamma,
            f"{prefix}.moe.moe.gate.to_gates.weight": router_weight,
            "horizon_ff_layer.output_layer.weight": _FakeTensor(ordinary_dtype),
        }
        self._buffers = {
            f"{prefix}.moe.moe.gate.threshold_train": threshold_train,
            f"{prefix}.moe.moe.gate.threshold_eval": threshold_eval,
            f"{prefix}.moe.moe.gate.zero": router_zero,
            f"{prefix}.moe.moe.experts.dummy": _FakeTensor(ordinary_dtype),
        }
        self._modules = (
            ("", self),
            (f"{prefix}.input_layernorm", self.input_norm),
            (f"{prefix}.moe.moe_prenorm", self.moe_norm),
            (f"{prefix}.moe.moe.gate", self.router),
            ("horizon_ff_layer", self.horizon_ff_layer),
        )

    def named_parameters(self) -> tuple[tuple[str, _FakeTensor], ...]:
        return tuple(self._parameters.items())

    def named_buffers(self) -> tuple[tuple[str, _FakeTensor], ...]:
        return tuple(self._buffers.items())

    def named_modules(self) -> tuple[tuple[str, object], ...]:
        return self._modules

    def modules(self) -> tuple[object, ...]:
        return tuple(module for _name, module in self._modules)


def test_fp32_island_predicate_and_loaded_model_dtype_boundary_are_exhaustive() -> None:
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.input_layernorm.weight"
    )
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.moe.moe_prenorm.gamma"
    )
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.moe.moe.gate.to_gates.weight"
    )
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.moe.moe.gate.threshold_eval"
    )
    assert is_fincast_fp32_island_key(
        "stacked_transformer.layers.0.moe.moe.gate.zero"
    )
    assert not is_fincast_fp32_island_key("horizon_ff_layer.output_layer.weight")

    validate_fincast_mixed_model_dtypes(_MixedBoundaryModel())
    with pytest.raises(AdapterLoadError, match="mixed dtype boundary"):
        validate_fincast_mixed_model_dtypes(
            _MixedBoundaryModel(ordinary_dtype="torch.float32")
        )
    with pytest.raises(AdapterLoadError, match="mixed dtype boundary"):
        validate_fincast_mixed_model_dtypes(
            _MixedBoundaryModel(island_dtype="torch.float16")
        )


def test_provisioning_uses_the_shared_fp32_island_predicate() -> None:
    module = _prepare_script()

    class ProvisionTensor:
        def __init__(self, *, floating: bool) -> None:
            self.dtype = SimpleNamespace(is_floating_point=floating)

        def to(self, *, dtype: str) -> tuple[str, str]:
            return ("converted", dtype)

    island = ProvisionTensor(floating=True)
    ordinary = ProvisionTensor(floating=True)
    integer = ProvisionTensor(floating=False)
    converted = module.mixed_state_dict(
        {
            "stacked_transformer.layers.0.input_layernorm.weight": island,
            "horizon_ff_layer.output_layer.weight": ordinary,
            "integer_buffer": integer,
        },
        SimpleNamespace(float16="fp16"),
    )

    assert converted["stacked_transformer.layers.0.input_layernorm.weight"] is island
    assert converted["horizon_ff_layer.output_layer.weight"] == ("converted", "fp16")
    assert converted["integer_buffer"] is integer


def test_precision_hooks_observe_compute_restore_horizon_and_decode_dtypes() -> None:
    model = _MixedBoundaryModel()
    for module in (model.input_norm, model.moe_norm):
        compute_args = _remember_input_dtype(module, (_FakeTensor("torch.float16"),))
        assert compute_args[0].dtype == "torch.float32"
        restored = _restore_output_dtype(module, (), _FakeTensor("torch.float32"))
        assert restored.dtype == "torch.float16"

    router_args = _remember_input_dtype(model.router, (_FakeTensor("torch.float16"),))
    assert router_args[0].dtype == "torch.float32"
    router = _restore_router_outputs(
        model.router,
        (),
        (
            _FakeTensor("torch.float32"),
            _FakeTensor("torch.float32"),
            _FakeTensor("torch.float32"),
            _FakeTensor("torch.float32"),
        ),
    )
    assert router[0].dtype == "torch.float16"
    assert router[1].dtype == "torch.float16"
    assert router[2].dtype == "torch.float32"
    assert router[3].dtype == "torch.float32"

    promoted = _promote_horizon_output(
        model.horizon_ff_layer,
        (),
        _FakeTensor("torch.float16"),
    )
    assert promoted.dtype == "torch.float32"
    observe_fincast_decode_output_dtypes(
        model,
        _FakeTensor("torch.float32"),
        _FakeTensor("torch.float32"),
    )
    validate_fincast_mixed_inference_observations(model)

    _restore_output_dtype(model.input_norm, (), _FakeTensor("torch.float16"))
    with pytest.raises(AdapterLoadError, match="RMSNorm dtype observation"):
        validate_fincast_mixed_inference_observations(model)


def test_attention_softmax_structural_invariant_is_exact_and_hash_gated(
    tmp_path: Path,
) -> None:
    reviewed_expression = """
class TimesFMAttention:
    def forward(self, scores, q):
        scores = F.softmax(scores.float(), dim=-1).type_as(q)
        return scores
"""
    assert _attention_softmax_structure_matches(reviewed_expression)
    assert not _attention_softmax_structure_matches(
        reviewed_expression.replace("scores.float()", "scores")
    )
    assert not _attention_softmax_structure_matches(
        reviewed_expression.replace(".type_as(q)", "")
    )
    assert not _attention_softmax_structure_matches(
        reviewed_expression.replace("F.softmax", "torch.softmax")
    )

    source = tmp_path / "fincast-source"
    decoder = source / "src" / "ffm" / "pytorch_patched_decoder_MOE.py"
    decoder.parent.mkdir(parents=True)
    decoder.write_text(reviewed_expression, encoding="utf-8")
    with pytest.raises(AdapterLoadError, match="pinned SHA-256"):
        verify_pinned_attention_softmax_structure(source)


def test_fincast_adapter_rechecks_nvml_headroom_after_model_load(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = SimpleNamespace(
        model_cache_dir=tmp_path,
        fincast_nvml_device_index=0,
        fincast_min_vram_headroom_bytes=1_000,
        fincast_context_bars=512,
    )
    cuda = SimpleNamespace(
        empty_cache_calls=0,
        get_device_name=lambda: "Tesla P40",
        get_device_capability=lambda: (6, 1),
    )

    def empty_cache() -> None:
        cuda.empty_cache_calls += 1

    cuda.empty_cache = empty_cache
    runtime = SimpleNamespace(torch=_qualification_torch(cuda))
    nvml_values = iter((1_600, 999))
    nvml_calls: list[int] = []

    def fake_nvml(device_index: int) -> int:
        nvml_calls.append(device_index)
        return next(nvml_values)

    loads: list[bool] = []
    monkeypatch.setattr(fincast_module, "_source_snapshot", lambda *_args: tmp_path)
    monkeypatch.setattr(
        fincast_module,
        "_artifact_selection",
        lambda *_args: (
            _completed_validation(
                MixedPrecisionMetrics(
                    finite=True,
                    quantile_monotonic=True,
                    signal_direction_agreement=1.0,
                    q50_median_iqr_ratio=0.01,
                    q50_p95_iqr_ratio=0.02,
                    peak_vram_reduction=0.4,
                )
            ),
            tmp_path / "model.mixed-fp16.safetensors",
            "mixed_float16",
            500,
        ),
    )
    monkeypatch.setattr(fincast_module, "nvml_free_bytes", fake_nvml)
    monkeypatch.setattr(
        fincast_module,
        "_load_model",
        lambda *_args: loads.append(True) or object(),
    )

    with pytest.raises(
        MemoryPressureError,
        match="^memory_pressure: FinCast post-load VRAM headroom is below the configured minimum$",
    ):
        FinCastAdapter(settings, {}, {}, runtime)

    assert nvml_calls == [0, 0]
    assert loads == [True]
    assert cuda.empty_cache_calls == 1


def _write_minimal_decoder_source(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "fincast-source"
    package = source / "src" / "ffm"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("raise RuntimeError('must not execute')\n", encoding="utf-8")
    decoder_path = package / "pytorch_patched_decoder_MOE.py"
    decoder_path.write_text(
        "from st_moe_pytorch import MoE\nSENTINEL = 'minimal-reviewed-decoder'\n",
        encoding="utf-8",
    )
    dependency = source / "src" / "st_moe_pytorch"
    dependency.mkdir()
    (dependency / "__init__.py").write_text(
        "from .st_moe_pytorch import MoE\n",
        encoding="utf-8",
    )
    (dependency / "st_moe_pytorch.py").write_text(
        "from . import distributed\nclass MoE: pass\n",
        encoding="utf-8",
    )
    (dependency / "distributed.py").write_text("SENTINEL = 'pinned'\n", encoding="utf-8")
    return source, decoder_path


def test_decoder_import_bypasses_initializer_and_pins_dependency_closure(
    tmp_path: Path,
) -> None:
    source, decoder_path = _write_minimal_decoder_source(tmp_path)
    module_names = (
        "ffm",
        "ffm.pytorch_patched_decoder_MOE",
        "st_moe_pytorch",
        "st_moe_pytorch.st_moe_pytorch",
        "st_moe_pytorch.distributed",
    )
    previous = {name: sys.modules.pop(name, None) for name in module_names}
    source_path = str(source / "src")
    sys.path.insert(0, source_path)
    try:
        decoder = import_decoder_from_source(source)
        assert decoder.SENTINEL == "minimal-reviewed-decoder"
        assert Path(decoder.__file__).resolve() == decoder_path.resolve()
        assert Path(sys.modules["st_moe_pytorch"].__file__).resolve() == (
            source / "src" / "st_moe_pytorch" / "__init__.py"
        ).resolve()
        assert Path(sys.modules["st_moe_pytorch.st_moe_pytorch"].__file__).resolve() == (
            source / "src" / "st_moe_pytorch" / "st_moe_pytorch.py"
        ).resolve()
        assert Path(sys.modules["st_moe_pytorch.distributed"].__file__).resolve() == (
            source / "src" / "st_moe_pytorch" / "distributed.py"
        ).resolve()
    finally:
        sys.path.remove(source_path)
        for name in reversed(module_names):
            sys.modules.pop(name, None)
            if previous[name] is not None:
                sys.modules[name] = previous[name]


@pytest.mark.parametrize(
    "module_name",
    (
        "st_moe_pytorch",
        "st_moe_pytorch.st_moe_pytorch",
        "st_moe_pytorch.distributed",
    ),
)
def test_decoder_import_rejects_preloaded_external_dependencies(
    tmp_path: Path,
    module_name: str,
) -> None:
    source, _decoder_path = _write_minimal_decoder_source(tmp_path)
    module_names = (
        "ffm",
        "ffm.pytorch_patched_decoder_MOE",
        "st_moe_pytorch",
        "st_moe_pytorch.st_moe_pytorch",
        "st_moe_pytorch.distributed",
    )
    previous = {name: sys.modules.pop(name, None) for name in module_names}
    external = ModuleType(module_name)
    external.__file__ = "/external/site-packages/st_moe_pytorch.py"
    if module_name == "st_moe_pytorch":
        external.__path__ = ["/external/site-packages/st_moe_pytorch"]
    sys.modules[module_name] = external
    source_path = str(source / "src")
    sys.path.insert(0, source_path)
    try:
        with pytest.raises(AdapterLoadError, match="different source"):
            import_decoder_from_source(source)
    finally:
        sys.path.remove(source_path)
        for name in reversed(module_names):
            sys.modules.pop(name, None)
            if previous[name] is not None:
                sys.modules[name] = previous[name]


def test_fixed_validation_fixture_is_actual_finalized_binance_data() -> None:
    fixture = Path(__file__).parent / "fixtures" / "fincast-crypto-contexts.json"
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == (
        "3ee014f25181c595949580acec1ad83908819e3f283b378f449ab679bef75f6f"
    )
    payload = json.loads(fixture.read_text(encoding="utf-8"))
    assert payload["source"] == {
        "complete_only": True,
        "contract_type": "PERPETUAL",
        "endpoint": "/fapi/v1/klines",
        "fixed_end_at": "2026-07-01T00:00:00Z",
        "interval": "1m",
        "quote_asset": "USDT",
        "round_trip_cost_bps": 8.0,
        "venue": "BINANCE_USDM",
    }
    assert len(payload["contexts"]) == 128
    assert len({item["symbol"] for item in payload["contexts"]}) == 16
    assert {item["bar_count"] for item in payload["contexts"]} == {512}
    assert {len(item["closes"]) for item in payload["contexts"]} == {512}


def test_non_finite_mixed_output_records_failure_instead_of_blocking_fp32_fallback(
    tmp_path: Path,
) -> None:
    module = _validation_script()
    reference = [[[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]]]
    candidate = [[[1.0, 2.0, 3.0, 4.0, float("nan"), 6.0, 7.0, 8.0, 9.0]]]
    runs = iter(
        (
            module.PrecisionRunResult(reference, 10_000, True, None),
            module.PrecisionRunResult(candidate, 6_000, True, None),
        )
    )
    module.run_precision = lambda *_args: next(runs)
    contexts = [{"closes": [5.0] * 512, "round_trip_cost_bps": 8.0}]
    fp32_path = tmp_path / "model.fp32.safetensors"
    mixed_path = tmp_path / "model.mixed-fp16.safetensors"
    fp32_path.write_bytes(b"fp32")
    mixed_path.write_bytes(b"mixed")
    validation = module.qualify_precision(
        Path("/unused/source"),
        fp32_path,
        mixed_path,
        contexts,
        "b" * 64,
        _qualification_torch(),
    )

    assert validation.mixed_run_status == "completed"
    assert validation.mixed_runtime_failure is None
    assert validation.mixed_metrics is not None
    assert validation.mixed_metrics.finite is False
    assert validation.mixed_metrics.quantile_monotonic is False
    assert "non_finite_output" in validation.mixed_failure_reasons
    assert validation.selected_precision == "float32"
