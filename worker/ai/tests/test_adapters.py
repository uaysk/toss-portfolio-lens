from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import portfolio_ai_worker.adapters as adapters
from portfolio_ai_worker.settings import AISettings

from .helpers import settings


def test_missing_pinned_offline_snapshots_are_unavailable_without_model_download_or_torch(
    tmp_path, monkeypatch
) -> None:
    manifest = Path(__file__).parents[1] / "model-manifest.json"
    configured = settings(tmp_path, manifest_path=manifest)

    class FakeTorch:
        pass

    monkeypatch.setattr(adapters, "preflight_device", lambda _settings: adapters.RuntimeDevice("cpu", FakeTorch()))
    loaded = adapters.load_production_adapter(configured)
    assert loaded.provenance.loaded is False
    assert loaded.provenance.model_revision == "901c26c1332695a2a8f243eb2f37243a37bea320"
    result = loaded.predict_batch((), seed=0)
    assert result == []


def test_model_dependencies_are_optional_at_module_import() -> None:
    assert adapters.RawPrediction is not None
    assert adapters.KronosAdapter is not None


def test_offline_snapshot_rejects_required_symlink_outside_cache(tmp_path) -> None:
    root = tmp_path / "models"
    snapshot = root / "chronos-bolt-small"
    snapshot.mkdir(parents=True)
    (snapshot / ".revision").write_text("pinned-revision", encoding="utf-8")
    outside = tmp_path / "outside-config.json"
    outside.write_text("{}", encoding="utf-8")
    (snapshot / "config.json").symlink_to(outside)
    (snapshot / "model.safetensors").write_bytes(b"offline-test")
    with pytest.raises(adapters.AdapterLoadError, match="inside AI_MODEL_CACHE_DIR"):
        adapters._snapshot(root, "chronos-bolt-small", "pinned-revision")


def test_chronos_loader_forbids_download_and_remote_code(tmp_path, monkeypatch) -> None:
    configured = settings(tmp_path)
    snapshot = configured.model_cache_dir / "chronos-bolt-small"
    snapshot.mkdir(parents=True)
    (snapshot / ".revision").write_text("revision-a", encoding="utf-8")
    (snapshot / "config.json").write_text("{}", encoding="utf-8")
    (snapshot / "model.safetensors").write_bytes(b"offline-test")
    captured: dict[str, object] = {}

    class FakePipelineType:
        @staticmethod
        def from_pretrained(path: str, **kwargs: object) -> object:
            captured.update({"path": path, **kwargs})
            return object()

    fake_chronos = SimpleNamespace(BaseChronosPipeline=FakePipelineType)
    real_import = adapters.importlib.import_module
    monkeypatch.setattr(
        adapters.importlib,
        "import_module",
        lambda name: fake_chronos if name == "chronos" else real_import(name),
    )
    runtime = adapters.RuntimeDevice("cpu", SimpleNamespace(float32="float32"))
    instance = adapters.ChronosBoltAdapter(
        configured,
        {
            "model_id": "amazon/chronos-bolt-small",
            "revision": "revision-a",
            "tokenizer_id": None,
            "tokenizer_revision": None,
            "loader_version": "chronos-forecasting-test",
            "license": "Apache-2.0",
        },
        "chronos-forecasting-test",
        runtime,
    )
    assert instance.provenance.loaded is True
    assert captured["path"] == str(snapshot)
    assert captured["local_files_only"] is True
    assert captured["trust_remote_code"] is False


def test_production_settings_cannot_select_a_test_adapter(monkeypatch) -> None:
    monkeypatch.setenv("AI_MODEL_PRIMARY", "deterministic-test-adapter")
    with pytest.raises(ValueError, match="kronos-small or chronos-bolt-small"):
        AISettings.from_env()


def test_malformed_manifest_degrades_to_strict_unavailable_provenance(tmp_path, monkeypatch) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "scalping-ai-model-manifest/v1",
                "kronos_source": {"revision": ""},
                "models": {"kronos-small": {"revision": "missing-required-fields"}},
            }
        ),
        encoding="utf-8",
    )
    configured = settings(tmp_path, manifest_path=manifest)
    monkeypatch.setattr(
        adapters,
        "preflight_device",
        lambda _settings: adapters.RuntimeDevice("cpu", SimpleNamespace(float32="float32")),
    )
    loaded = adapters.load_production_adapter(configured)
    assert loaded.provenance.loaded is False
    assert loaded.provenance.model_id == "kronos-small"
    assert loaded.provenance.model_revision == "unavailable"
    assert loaded.provenance.device == "unavailable"
    assert loaded.provenance.source_revision == "unavailable"


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
    fake_torch = SimpleNamespace(cuda=fake_cuda)
    monkeypatch.setattr(adapters, "_import_torch", lambda: fake_torch)
    configured = settings(
        tmp_path,
        device="cuda",
        allow_cpu_fallback=True,
        expected_cuda_capability="6.1",
    )
    assert adapters.preflight_device(configured).name == "cpu"


def test_incompatible_visible_cuda_is_an_error_when_cpu_fallback_is_disabled(tmp_path, monkeypatch) -> None:
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
    with pytest.raises(adapters.AdapterLoadError, match="does not include sm_61"):
        adapters.preflight_device(configured)


def test_production_loader_records_cpu_when_p40_arch_is_missing_from_torch(tmp_path, monkeypatch) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "scalping-ai-model-manifest/v1",
                "kronos_source": {"revision": "unused-for-chronos"},
                "models": {
                    "chronos-bolt-small": {
                        "model_id": "amazon/chronos-bolt-small",
                        "revision": "revision-a",
                        "tokenizer_id": None,
                        "tokenizer_revision": None,
                        "loader_version": "chronos-forecasting-test",
                        "license": "Apache-2.0",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    configured = settings(
        tmp_path,
        manifest_path=manifest,
        primary_model="chronos-bolt-small",
        fallback_model=None,
        device="cuda",
        allow_cpu_fallback=True,
        expected_cuda_capability="6.1",
    )
    snapshot = configured.model_cache_dir / "chronos-bolt-small"
    snapshot.mkdir(parents=True)
    (snapshot / ".revision").write_text("revision-a", encoding="utf-8")
    (snapshot / "config.json").write_text("{}", encoding="utf-8")
    (snapshot / "model.safetensors").write_bytes(b"offline-test")
    fake_cuda = SimpleNamespace(
        is_available=lambda: True,
        get_device_capability=lambda: (6, 1),
        get_arch_list=lambda: ("sm_75", "sm_80"),
    )
    fake_torch = SimpleNamespace(cuda=fake_cuda, float32="float32")

    class FakePipelineType:
        @staticmethod
        def from_pretrained(_path: str, **_kwargs: object) -> object:
            return object()

    fake_chronos = SimpleNamespace(BaseChronosPipeline=FakePipelineType)
    real_import = adapters.importlib.import_module
    monkeypatch.setattr(adapters, "_import_torch", lambda: fake_torch)
    monkeypatch.setattr(
        adapters.importlib,
        "import_module",
        lambda name: fake_chronos if name == "chronos" else real_import(name),
    )
    loaded = adapters.load_production_adapter(configured)
    assert loaded.provenance.loaded is True
    assert loaded.provenance.device == "cpu"
    assert loaded.provenance.attention_backend == "math"
