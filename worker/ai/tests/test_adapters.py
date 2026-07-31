from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import portfolio_ai_worker.adapters as adapters
from portfolio_ai_worker.settings import AISettings

from .helpers import settings


def _manifest_path() -> Path:
    return Path(__file__).parents[1] / "model-manifest.json"


def test_model_dependencies_remain_optional_at_module_import() -> None:
    assert adapters.RawPrediction is not None
    assert adapters.ProductionModelBinding is not None


def test_offline_snapshot_rejects_required_symlink_outside_cache(tmp_path) -> None:
    root = tmp_path / "models"
    snapshot = root / "chronos-2"
    snapshot.mkdir(parents=True)
    (snapshot / ".revision").write_text("pinned-revision", encoding="utf-8")
    outside = tmp_path / "outside-config.json"
    outside.write_text("{}", encoding="utf-8")
    (snapshot / "config.json").symlink_to(outside)
    (snapshot / "model.safetensors").write_bytes(b"offline-test")

    with pytest.raises(adapters.AdapterLoadError, match="inside AI_MODEL_CACHE_DIR"):
        adapters._snapshot(root, "chronos-2", "pinned-revision")


@pytest.mark.parametrize(
    ("capability", "compiled_arches"),
    [
        ((7, 5), ("sm_75",)),
        ((6, 1), ("sm_75", "sm_80")),
    ],
)
def test_incompatible_visible_cuda_falls_back_to_cpu_when_allowed(
    tmp_path,
    monkeypatch,
    capability,
    compiled_arches,
) -> None:
    fake_cuda = SimpleNamespace(
        is_available=lambda: True,
        get_device_capability=lambda: capability,
        get_arch_list=lambda: compiled_arches,
    )
    monkeypatch.setattr(adapters, "_import_torch", lambda: SimpleNamespace(cuda=fake_cuda))
    configured = settings(
        tmp_path,
        device="cuda",
        allow_cpu_fallback=True,
        expected_cuda_capability="6.1",
    )
    assert adapters.preflight_device(configured).name == "cpu"


def test_incompatible_visible_cuda_fails_closed(tmp_path, monkeypatch) -> None:
    fake_cuda = SimpleNamespace(
        is_available=lambda: True,
        get_device_capability=lambda: (6, 1),
        get_arch_list=lambda: ("sm_75", "sm_80"),
    )
    monkeypatch.setattr(adapters, "_import_torch", lambda: SimpleNamespace(cuda=fake_cuda))
    configured = settings(
        tmp_path,
        device="cuda",
        allow_cpu_fallback=False,
        expected_cuda_capability="6.1",
    )
    with pytest.raises(adapters.AdapterLoadError, match="compatible cubin for sm_61"):
        adapters.preflight_device(configured)


def test_p40_accepts_same_major_lower_minor_cubin(tmp_path, monkeypatch) -> None:
    fake_cuda = SimpleNamespace(
        is_available=lambda: True,
        get_device_capability=lambda: (6, 1),
        get_arch_list=lambda: ("sm_60", "sm_70", "compute_90"),
        get_device_name=lambda: "Tesla P40",
    )
    monkeypatch.setattr(adapters, "_import_torch", lambda: SimpleNamespace(cuda=fake_cuda))
    runtime = adapters.preflight_device(settings(
        tmp_path,
        device="cuda",
        allow_cpu_fallback=False,
        expected_cuda_capability="6.1",
    ))
    assert runtime.name == "cuda"
    assert runtime.device_name == "Tesla P40"
    assert runtime.cuda_capability == "6.1"


@pytest.mark.parametrize("allow_cpu_fallback", [False, True])
def test_non_p40_device_never_passes_preflight(
    tmp_path,
    monkeypatch,
    allow_cpu_fallback,
) -> None:
    fake_cuda = SimpleNamespace(
        is_available=lambda: True,
        get_device_capability=lambda: (6, 1),
        get_arch_list=lambda: ("sm_60",),
        get_device_name=lambda: "Quadro P6000",
    )
    monkeypatch.setattr(adapters, "_import_torch", lambda: SimpleNamespace(cuda=fake_cuda))
    configured = settings(
        tmp_path,
        device="cuda",
        allow_cpu_fallback=allow_cpu_fallback,
        expected_cuda_capability="6.1",
        expected_cuda_device_name="Tesla P40",
    )
    if allow_cpu_fallback:
        assert adapters.preflight_device(configured).name == "cpu"
    else:
        with pytest.raises(adapters.AdapterLoadError, match="does not match required 'Tesla P40'"):
            adapters.preflight_device(configured)


def test_default_settings_are_fincast_only_and_strict_p40(monkeypatch) -> None:
    for variable in (
        "AI_DEVICE",
        "AI_ALLOW_CPU_FALLBACK",
        "AI_EXPECTED_CUDA_CAPABILITY",
        "AI_EXPECTED_CUDA_DEVICE_NAME",
        "AI_MODEL_LANE",
        "AI_MIN_CONTEXT_BARS",
        "AI_MAX_CONTEXT_BARS",
    ):
        monkeypatch.delenv(variable, raising=False)

    configured = AISettings.from_env()
    assert configured.device == "cuda"
    assert configured.allow_cpu_fallback is False
    assert configured.expected_cuda_capability == "6.1"
    assert configured.expected_cuda_device_name == "Tesla P40"
    assert configured.model_lane == "fincast"
    assert configured.min_context_bars == 512
    assert configured.max_context_bars == 512
    assert not hasattr(configured, "kronos_kv_cache_enabled")


def test_only_fincast_and_chronos2_lanes_are_accepted(monkeypatch) -> None:
    monkeypatch.setenv("AI_MODEL_LANE", "chronos_2")
    configured = AISettings.from_env()
    assert configured.model_lane == "chronos_2"

    monkeypatch.setenv("AI_MODEL_LANE", "removed-model")
    with pytest.raises(ValueError, match="fincast or chronos_2"):
        AISettings.from_env()


def test_chronos2_cuda_graph_backend_is_explicit_and_validated(monkeypatch) -> None:
    monkeypatch.setenv("AI_MODEL_LANE", "chronos_2")
    monkeypatch.setenv("AI_CHRONOS2_INFERENCE_BACKEND", "cuda_graph")
    assert AISettings.from_env().chronos2_inference_backend == "cuda_graph"

    monkeypatch.setenv("AI_CHRONOS2_INFERENCE_BACKEND", "silent_fallback")
    with pytest.raises(ValueError, match="AI_CHRONOS2_INFERENCE_BACKEND"):
        AISettings.from_env()


def test_manifest_pins_only_fincast_and_chronos2() -> None:
    manifest = json.loads(_manifest_path().read_text(encoding="utf-8"))
    assert manifest["schema_version"] == "scalping-ai-model-manifest/v2"
    assert set(manifest["models"]) == {"fincast", "chronos-2"}
    assert "kronos_source" not in manifest
    assert manifest["models"]["fincast"]["model_id"] == "Vincent05R/FinCast"
    assert manifest["models"]["fincast"]["license"] == "Apache-2.0"
    assert manifest["models"]["chronos-2"] == {
        "model_id": "amazon/chronos-2",
        "revision": "254b5357164a84326913b0695216f690752ac55d",
        "checkpoint_file": "model.safetensors",
        "checkpoint_sha256": "ddcda3c7508bf2528087723e98a20707cc04b7f370ae275a9fd88078ddba4f42",
        "native_quantiles": [
            0.01, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45,
            0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99,
        ],
        "context_length": 8192,
        "input_patch_size": 16,
        "output_patch_size": 16,
        "max_output_patches": 64,
        "license": "Apache-2.0",
        "loader_version": "chronos-forecasting-2.3.1",
    }


@pytest.mark.parametrize(
    ("model_lane", "expected_role", "expected_model_id"),
    [
        ("fincast", "fincast", "Vincent05R/FinCast"),
        ("chronos_2", "chronos_2", "amazon/chronos-2"),
    ],
)
def test_missing_cache_fails_closed_with_lane_identity(
    tmp_path,
    monkeypatch,
    model_lane,
    expected_role,
    expected_model_id,
) -> None:
    configured = settings(
        tmp_path,
        manifest_path=_manifest_path(),
        model_lane=model_lane,
        device="cuda",
        allow_cpu_fallback=False,
        min_context_bars=512,
        max_context_bars=512 if model_lane == "fincast" else 8192,
        chronos2_context_bars=512,
    )
    monkeypatch.setattr(
        adapters,
        "preflight_device",
        lambda _settings: adapters.RuntimeDevice(
            "cuda",
            SimpleNamespace(),
            device_name="Tesla P40",
            cuda_capability="6.1",
        ),
    )

    suite = adapters.load_production_model_suite(configured)
    assert len(suite.runs) == 1
    assert suite.runs[0].role == expected_role
    assert suite.runs[0].expected_model_id == expected_model_id
    assert suite.primary.provenance.model_id == expected_model_id
    assert suite.primary.provenance.loaded is False
    assert suite.primary.provenance.precision_validation == "unavailable"
