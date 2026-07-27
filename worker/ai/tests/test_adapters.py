from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import portfolio_ai_worker.adapters as adapters
from portfolio_ai_worker.settings import AISettings

from .helpers import settings


MODEL_REVISION = "2b554741eca47781b64468546e77fef3e85130e6"
TOKENIZER_REVISION = "0e0117387f39004a9016484a186a908917e22426"
SOURCE_REVISION = "67b630e67f6a18c9e9be918d9b4337c960db1e9a"


def _manifest_path() -> Path:
    return Path(__file__).parents[1] / "model-manifest.json"


def _write_file_snapshot(root: Path, folder: str, revision: str) -> Path:
    snapshot = root / folder
    snapshot.mkdir(parents=True)
    (snapshot / ".revision").write_text(revision, encoding="utf-8")
    (snapshot / "config.json").write_text("{}", encoding="utf-8")
    (snapshot / "model.safetensors").write_bytes(b"offline-test")
    return snapshot


def _write_source_snapshot(root: Path) -> Path:
    source = root / "kronos-source"
    (source / "model").mkdir(parents=True)
    (source / ".source-revision").write_text(SOURCE_REVISION, encoding="utf-8")
    (source / "model" / "kronos.py").write_text("# test", encoding="utf-8")
    (source / "model" / "module.py").write_text("# test", encoding="utf-8")
    (source / "LICENSE").write_text("MIT", encoding="utf-8")
    return source


def test_missing_pinned_offline_snapshots_are_unavailable_without_download_or_torch(tmp_path, monkeypatch) -> None:
    configured = settings(tmp_path, manifest_path=_manifest_path())
    monkeypatch.setattr(
        adapters,
        "preflight_device",
        lambda _settings: adapters.RuntimeDevice("cpu", SimpleNamespace()),
    )

    loaded = adapters.load_production_adapter(configured)

    assert loaded.provenance.loaded is False
    assert loaded.provenance.model_id == "NeoQuasar/Kronos-base"
    assert loaded.provenance.model_revision == MODEL_REVISION
    assert loaded.predict_batch((), seed=0) == []


def test_model_dependencies_are_optional_at_module_import() -> None:
    assert adapters.RawPrediction is not None
    assert adapters.KronosAdapter is not None


def test_offline_snapshot_rejects_required_symlink_outside_cache(tmp_path) -> None:
    root = tmp_path / "models"
    snapshot = root / "kronos-base"
    snapshot.mkdir(parents=True)
    (snapshot / ".revision").write_text("pinned-revision", encoding="utf-8")
    outside = tmp_path / "outside-config.json"
    outside.write_text("{}", encoding="utf-8")
    (snapshot / "config.json").symlink_to(outside)
    (snapshot / "model.safetensors").write_bytes(b"offline-test")

    with pytest.raises(adapters.AdapterLoadError, match="inside AI_MODEL_CACHE_DIR"):
        adapters._snapshot(root, "kronos-base", "pinned-revision")


def test_malformed_manifest_degrades_to_strict_kronos_base_unavailable_provenance(tmp_path, monkeypatch) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "scalping-ai-model-manifest/v1",
                "kronos_source": {"revision": ""},
                "models": {"kronos-base": {"revision": "missing-required-fields"}},
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
    assert loaded.provenance.model_id == "NeoQuasar/Kronos-base"
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
    monkeypatch.setattr(adapters, "_import_torch", lambda: SimpleNamespace(cuda=fake_cuda))
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
    configured = settings(
        tmp_path,
        device="cuda",
        allow_cpu_fallback=False,
        expected_cuda_capability="6.1",
    )

    runtime = adapters.preflight_device(configured)

    assert runtime.name == "cuda"
    assert runtime.device_name == "Tesla P40"
    assert runtime.cuda_capability == "6.1"


@pytest.mark.parametrize("allow_cpu_fallback", [False, True])
def test_non_p40_device_name_never_passes_cuda_preflight(
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


def test_default_settings_are_fixed_to_single_model_and_p40(monkeypatch) -> None:
    for variable in (
        "AI_DEVICE",
        "AI_ALLOW_CPU_FALLBACK",
        "AI_EXPECTED_CUDA_CAPABILITY",
        "AI_EXPECTED_CUDA_DEVICE_NAME",
        "AI_MODEL_LANE",
        "AI_MIN_CONTEXT_BARS",
        "AI_MAX_CONTEXT_BARS",
        "AI_KRONOS_KV_CACHE_ENABLED",
    ):
        monkeypatch.delenv(variable, raising=False)

    configured = AISettings.from_env()

    assert not hasattr(configured, "primary_model")
    assert not hasattr(configured, "companion_model")
    assert not hasattr(configured, "fallback_model")
    assert configured.device == "cuda"
    assert configured.allow_cpu_fallback is False
    assert configured.expected_cuda_capability == "6.1"
    assert configured.expected_cuda_device_name == "Tesla P40"
    assert configured.model_lane == "fincast"
    assert configured.min_context_bars == 512
    assert configured.max_context_bars == 512
    assert configured.kronos_kv_cache_enabled is False


def test_manifest_pins_only_reviewed_kronos_base_and_tokenizer_revisions() -> None:
    manifest = json.loads(_manifest_path().read_text(encoding="utf-8"))

    assert manifest["schema_version"] == "scalping-ai-model-manifest/v2"
    assert set(manifest["models"]) == {"kronos-base", "fincast"}
    assert manifest["models"]["kronos-base"] == {
        "model_id": "NeoQuasar/Kronos-base",
        "revision": MODEL_REVISION,
        "tokenizer_id": "NeoQuasar/Kronos-Tokenizer-base",
        "tokenizer_revision": TOKENIZER_REVISION,
        "license": "MIT",
        "loader_version": "kronos-source-67b630e",
    }
    assert manifest["kronos_source"]["revision"] == SOURCE_REVISION
    assert manifest["fincast_source"]["repository"] == "https://github.com/vincent05r/FinCast-fts"
    assert manifest["fincast_source"]["revision"] == "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4"
    assert (
        manifest["fincast_source"]["archive_sha256"]
        == "ed4c3967c6d548465307fc0b63895ac9c9d8b44a950ccf936ab97e1755451a91"
    )
    assert manifest["fincast_source"]["license"] == "Apache-2.0"
    assert len(manifest["fincast_source"]["required_file_sha256"]) == 6
    assert manifest["fincast_paper"]["revision"] == "2508.19609v1"
    assert (
        manifest["fincast_paper"]["sha256"]
        == "c8dc23c7e0013d85732af1dee2785263b42c7384fc1a9a0f73bfdbb0d5061244"
    )
    assert manifest["models"]["fincast"]["revision"] == "2d7d90b159db8961d27c2cf165d51195902ef92b"
    assert (
        manifest["models"]["fincast"]["checkpoint_sha256"]
        == "d5ca999b02c944effa60d2b94174dc4d5a0cd2c0543ae289b2e36f37431492a8"
    )
    assert (
        manifest["models"]["fincast"]["validation_contexts_sha256"]
        == "3ee014f25181c595949580acec1ad83908819e3f283b378f449ab679bef75f6f"
    )


@pytest.mark.parametrize(
    ("cache_enabled", "expected_install_count", "expected_loader_version"),
    [
        (False, 0, "kronos-source-67b630e"),
        (True, 1, "kronos-source-67b630e-kv-cache-v1"),
    ],
)
def test_kronos_base_loader_is_local_only_and_uses_pinned_paths(
    tmp_path,
    monkeypatch,
    cache_enabled: bool,
    expected_install_count: int,
    expected_loader_version: str,
) -> None:
    configured = settings(tmp_path, kronos_kv_cache_enabled=cache_enabled)
    source = _write_source_snapshot(configured.model_cache_dir)
    model_path = _write_file_snapshot(configured.model_cache_dir, "kronos-base", MODEL_REVISION)
    tokenizer_path = _write_file_snapshot(
        configured.model_cache_dir,
        "kronos-tokenizer-base",
        TOKENIZER_REVISION,
    )
    captured: list[tuple[str, dict[str, object]]] = []

    class FakeLoadable:
        @staticmethod
        def from_pretrained(path: str, **kwargs: object) -> SimpleNamespace:
            captured.append((path, kwargs))
            return SimpleNamespace(eval=lambda: None)

    class FakePredictor:
        def __init__(self, **kwargs: object) -> None:
            self.kwargs = kwargs

    fake_module = SimpleNamespace(
        __file__=str(source / "model" / "kronos.py"),
        Kronos=FakeLoadable,
        KronosTokenizer=FakeLoadable,
        KronosPredictor=FakePredictor,
    )
    real_import = adapters.importlib.import_module
    monkeypatch.setattr(
        adapters.importlib,
        "import_module",
        lambda name: fake_module if name == "model.kronos" else real_import(name),
    )
    installed: list[tuple[object, object, str]] = []
    monkeypatch.setattr(
        adapters,
        "install_kronos_kv_cache",
        lambda module, model, *, source_revision: installed.append(
            (module, model, source_revision)
        ),
    )
    runtime = adapters.RuntimeDevice(
        "cuda",
        SimpleNamespace(),
        device_name="Tesla P40",
        cuda_capability="6.1",
    )
    instance = adapters.KronosAdapter(
        configured,
        {
            "model_id": "NeoQuasar/Kronos-base",
            "revision": MODEL_REVISION,
            "tokenizer_id": "NeoQuasar/Kronos-Tokenizer-base",
            "tokenizer_revision": TOKENIZER_REVISION,
            "loader_version": "kronos-source-67b630e",
            "license": "MIT",
        },
        SOURCE_REVISION,
        runtime,
    )

    assert instance.provenance.model_id == "NeoQuasar/Kronos-base"
    assert instance.provenance.device_name == "Tesla P40"
    assert instance.provenance.cuda_capability == "6.1"
    assert instance.provenance.loader_version == expected_loader_version
    assert captured == [
        (str(model_path), {"local_files_only": True}),
        (str(tokenizer_path), {"local_files_only": True}),
    ]
    assert installed == (
        [(fake_module, instance._predictor.kwargs["model"], SOURCE_REVISION)]
        if expected_install_count
        else []
    )


def test_model_suite_rejects_cpu_even_when_cpu_fallback_is_enabled(tmp_path, monkeypatch) -> None:
    configured = settings(
        tmp_path,
        manifest_path=_manifest_path(),
        device="cuda",
        allow_cpu_fallback=True,
    )
    monkeypatch.setattr(
        adapters,
        "preflight_device",
        lambda _settings: adapters.RuntimeDevice("cpu", SimpleNamespace()),
    )

    suite = adapters.load_production_model_suite(configured)

    assert len(suite.runs) == 1
    assert suite.runs[0].role == "kronos_base"
    assert suite.runs[0].expected_model_id == "NeoQuasar/Kronos-base"
    assert suite.primary is suite.runs[0].adapter
    assert suite.primary.provenance.loaded is False
    assert suite.primary.provenance.device == "unavailable"


@pytest.mark.parametrize(
    ("runtime", "reason"),
    [
        (
            adapters.RuntimeDevice(
                "cuda",
                SimpleNamespace(),
                device_name=None,
                cuda_capability="6.1",
            ),
            "CUDA device name is unavailable",
        ),
        (
            adapters.RuntimeDevice(
                "cuda",
                SimpleNamespace(),
                device_name="Quadro P6000",
                cuda_capability="6.1",
            ),
            "does not match required 'Tesla P40'",
        ),
        (
            adapters.RuntimeDevice(
                "cuda",
                SimpleNamespace(),
                device_name="Tesla P40",
                cuda_capability=None,
            ),
            "CUDA capability unavailable does not match required 6.1",
        ),
    ],
)
def test_model_suite_rejects_missing_or_mismatched_p40_identity(
    tmp_path,
    monkeypatch,
    runtime,
    reason,
) -> None:
    configured = settings(
        tmp_path,
        manifest_path=_manifest_path(),
        device="cuda",
        allow_cpu_fallback=False,
        expected_cuda_device_name="Tesla P40",
    )
    monkeypatch.setattr(adapters, "preflight_device", lambda _settings: runtime)

    suite = adapters.load_production_model_suite(configured)

    assert suite.primary.provenance.loaded is False
    assert reason in getattr(suite.primary, "message")


def test_model_suite_keeps_expected_identity_when_manifest_is_missing(tmp_path) -> None:
    configured = settings(
        tmp_path,
        manifest_path=tmp_path / "missing-manifest.json",
        device="cuda",
        allow_cpu_fallback=False,
    )

    suite = adapters.load_production_model_suite(configured)

    assert len(suite.runs) == 1
    assert suite.primary.provenance.model_id == "NeoQuasar/Kronos-base"
    assert suite.primary.provenance.loaded is False


def test_fincast_lane_is_independent_and_fails_closed_without_cache(tmp_path, monkeypatch) -> None:
    configured = settings(
        tmp_path,
        manifest_path=_manifest_path(),
        model_lane="fincast",
        device="cuda",
        allow_cpu_fallback=False,
        min_context_bars=512,
        max_context_bars=512,
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
    assert suite.runs[0].role == "fincast"
    assert suite.runs[0].expected_model_id == "Vincent05R/FinCast"
    assert suite.primary.provenance.model_id == "Vincent05R/FinCast"
    assert suite.primary.provenance.loaded is False
    assert suite.primary.provenance.precision_validation == "unavailable"
