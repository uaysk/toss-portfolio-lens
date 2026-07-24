from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import portfolio_ai_worker.adapters as adapters
from portfolio_ai_worker.settings import AISettings

from .helpers import bars, future, settings


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


def test_bolt_can_only_be_configured_as_an_explicit_fallback(monkeypatch) -> None:
    monkeypatch.setenv("AI_MODEL_PRIMARY", "chronos-bolt-small")
    monkeypatch.delenv("AI_MODEL_FALLBACK", raising=False)
    with pytest.raises(ValueError, match="only through AI_MODEL_FALLBACK"):
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
    assert loaded.provenance.model_id == "NeoQuasar/Kronos-small"
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
    with pytest.raises(adapters.AdapterLoadError, match="compatible cubin for sm_61"):
        adapters.preflight_device(configured)


def test_p40_accepts_same_major_lower_minor_cubin(tmp_path, monkeypatch) -> None:
    fake_cuda = SimpleNamespace(
        is_available=lambda: True,
        get_device_capability=lambda: (6, 1),
        get_arch_list=lambda: ("sm_60", "sm_70", "compute_90"),
        get_device_name=lambda: "Tesla P40",
    )
    fake_torch = SimpleNamespace(cuda=fake_cuda)
    monkeypatch.setattr(adapters, "_import_torch", lambda: fake_torch)
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


def test_production_loader_records_cpu_when_p40_arch_is_missing_from_torch(tmp_path, monkeypatch) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "scalping-ai-model-manifest/v1",
                "kronos_source": {"revision": "unused-for-chronos"},
                "models": {
                    "chronos-2": {
                        "model_id": "amazon/chronos-2",
                        "revision": "revision-primary",
                        "tokenizer_id": None,
                        "tokenizer_revision": None,
                        "loader_version": "chronos-forecasting-test",
                        "license": "Apache-2.0",
                    },
                    "chronos-bolt-small": {
                        "model_id": "amazon/chronos-bolt-small",
                        "revision": "revision-a",
                        "tokenizer_id": None,
                        "tokenizer_revision": None,
                        "loader_version": "chronos-forecasting-test",
                        "license": "Apache-2.0",
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    configured = settings(
        tmp_path,
        manifest_path=manifest,
        primary_model="chronos-2",
        fallback_model="chronos-bolt-small",
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
    assert loaded.provenance.model_id == "amazon/chronos-bolt-small"
    assert loaded.provenance.fallback_from == "amazon/chronos-2"


def test_direct_settings_validation_cannot_bypass_bolt_fallback_only_invariant(tmp_path) -> None:
    with pytest.raises(ValueError, match="only as the explicit fallback"):
        settings(
            tmp_path,
            primary_model="chronos-bolt-small",
            fallback_model=None,
        )


def test_default_settings_require_chronos2_kronos_and_p40_without_implicit_fallback(monkeypatch) -> None:
    for name in (
        "AI_MODEL_PRIMARY",
        "AI_MODEL_COMPANION",
        "AI_MODEL_FALLBACK",
        "AI_DEVICE",
        "AI_ALLOW_CPU_FALLBACK",
        "AI_EXPECTED_CUDA_CAPABILITY",
        "AI_EXPECTED_CUDA_DEVICE_NAME",
    ):
        monkeypatch.delenv(name, raising=False)
    configured = AISettings.from_env()
    assert configured.primary_model == "chronos-2"
    assert configured.companion_model == "kronos-small"
    assert configured.fallback_model is None
    assert configured.device == "cuda"
    assert configured.allow_cpu_fallback is False
    assert configured.expected_cuda_capability == "6.1"
    assert configured.expected_cuda_device_name == "Tesla P40"


def test_empty_expected_cuda_device_name_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("AI_EXPECTED_CUDA_DEVICE_NAME", " ")
    with pytest.raises(ValueError, match="AI_EXPECTED_CUDA_DEVICE_NAME cannot be empty"):
        AISettings.from_env()


def test_manifest_pins_the_reviewed_chronos2_revision() -> None:
    manifest_path = Path(__file__).parents[1] / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["models"]["chronos-2"] == {
        "model_id": "amazon/chronos-2",
        "revision": "254b5357164a84326913b0695216f690752ac55d",
        "tokenizer_id": None,
        "tokenizer_revision": None,
        "license": "Apache-2.0",
        "loader_version": "chronos-forecasting-2.1.0",
    }


def test_chronos2_feature_frame_is_causal_and_contains_ohlcv_return_volatility_and_liquidity() -> None:
    history = bars(80)
    item = adapters.InferenceSeries(
        instrument_key="US:TSLA",
        bars=history,
        future_timestamps=future(history[-1].timestamp),
    )
    rows = adapters._chronos_frame_rows(item)
    assert len(rows) == len(history)
    assert rows[-1]["model_timestamp"] == history[-1].timestamp
    assert all(row["model_timestamp"] <= history[-1].timestamp for row in rows)
    assert set(rows[-1]) == {
        "item_id",
        "model_timestamp",
        "target_close",
        "open",
        "high",
        "low",
        "volume",
        "amount",
        "return_1",
        "range_return",
        "realized_volatility_20",
        "liquidity_log",
    }
    assert rows[0]["return_1"] == 0
    assert rows[-1]["realized_volatility_20"] > 0
    assert rows[-1]["liquidity_log"] > 0


def test_chronos2_loader_is_local_only_and_disables_remote_code(tmp_path, monkeypatch) -> None:
    configured = settings(tmp_path)
    snapshot = configured.model_cache_dir / "chronos-2"
    snapshot.mkdir(parents=True)
    (snapshot / ".revision").write_text("revision-chronos2", encoding="utf-8")
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
    runtime = adapters.RuntimeDevice(
        "cuda",
        SimpleNamespace(float32="float32"),
        device_name="Tesla P40",
        cuda_capability="6.1",
    )
    instance = adapters.Chronos2Adapter(
        configured,
        {
            "model_id": "amazon/chronos-2",
            "revision": "revision-chronos2",
            "tokenizer_id": None,
            "tokenizer_revision": None,
            "loader_version": "chronos-forecasting-test",
            "license": "Apache-2.0",
        },
        "chronos-forecasting-test",
        runtime,
    )
    assert instance.provenance.model_id == "amazon/chronos-2"
    assert instance.provenance.device_name == "Tesla P40"
    assert instance.provenance.cuda_capability == "6.1"
    assert captured["path"] == str(snapshot)
    assert captured["local_files_only"] is True
    assert captured["trust_remote_code"] is False
    assert captured["attn_implementation"] == "eager"


def test_model_suite_uses_bolt_only_as_an_explicit_degraded_chronos2_fallback(
    tmp_path,
    monkeypatch,
) -> None:
    manifest_path = Path(__file__).parents[1] / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    configured = settings(
        tmp_path,
        manifest_path=manifest_path,
        primary_model="chronos-2",
        fallback_model="chronos-bolt-small",
        device="cuda",
        allow_cpu_fallback=False,
    )
    snapshot = configured.model_cache_dir / "chronos-bolt-small"
    snapshot.mkdir(parents=True)
    (snapshot / ".revision").write_text(
        manifest["models"]["chronos-bolt-small"]["revision"],
        encoding="utf-8",
    )
    (snapshot / "config.json").write_text("{}", encoding="utf-8")
    (snapshot / "model.safetensors").write_bytes(b"offline-test")

    class FakePipelineType:
        @staticmethod
        def from_pretrained(_path: str, **_kwargs: object) -> object:
            return object()

    fake_chronos = SimpleNamespace(BaseChronosPipeline=FakePipelineType)
    real_import = adapters.importlib.import_module
    monkeypatch.setattr(
        adapters.importlib,
        "import_module",
        lambda name: fake_chronos if name == "chronos" else real_import(name),
    )
    runtime = adapters.RuntimeDevice(
        "cuda",
        SimpleNamespace(float32="float32"),
        device_name="Tesla P40",
        cuda_capability="6.1",
    )
    monkeypatch.setattr(adapters, "preflight_device", lambda _settings: runtime)

    suite = adapters.load_production_model_suite(configured)
    assert suite.primary.provenance.model_id == "amazon/chronos-bolt-small"
    assert suite.primary.provenance.fallback_from == "amazon/chronos-2"
    assert suite.primary.provenance.fallback_reason is not None
    assert suite.runs[1].adapter.provenance.model_id == "NeoQuasar/Kronos-small"
    assert suite.runs[1].adapter.provenance.loaded is False


def test_model_suite_rejects_cpu_even_when_legacy_cpu_fallback_is_enabled(tmp_path, monkeypatch) -> None:
    configured = settings(
        tmp_path,
        manifest_path=Path(__file__).parents[1] / "model-manifest.json",
        primary_model="chronos-2",
        fallback_model=None,
        device="cuda",
        allow_cpu_fallback=True,
    )
    monkeypatch.setattr(
        adapters,
        "preflight_device",
        lambda _settings: adapters.RuntimeDevice("cpu", SimpleNamespace(float32="float32")),
    )
    suite = adapters.load_production_model_suite(configured)
    assert all(binding.adapter.provenance.loaded is False for binding in suite.runs)
    assert all(binding.adapter.provenance.device == "unavailable" for binding in suite.runs)


@pytest.mark.parametrize(
    ("runtime", "reason"),
    [
        (
            adapters.RuntimeDevice(
                "cuda",
                SimpleNamespace(float32="float32"),
                device_name=None,
                cuda_capability="6.1",
            ),
            "CUDA device name is unavailable",
        ),
        (
            adapters.RuntimeDevice(
                "cuda",
                SimpleNamespace(float32="float32"),
                device_name="Quadro P6000",
                cuda_capability="6.1",
            ),
            "does not match required 'Tesla P40'",
        ),
        (
            adapters.RuntimeDevice(
                "cuda",
                SimpleNamespace(float32="float32"),
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
        manifest_path=Path(__file__).parents[1] / "model-manifest.json",
        primary_model="chronos-2",
        fallback_model=None,
        device="cuda",
        allow_cpu_fallback=False,
        expected_cuda_device_name="Tesla P40",
    )
    monkeypatch.setattr(adapters, "preflight_device", lambda _settings: runtime)

    suite = adapters.load_production_model_suite(configured)

    assert all(binding.adapter.provenance.loaded is False for binding in suite.runs)
    assert all(reason in getattr(binding.adapter, "message") for binding in suite.runs)


def test_model_suite_keeps_expected_identities_when_manifest_is_missing(tmp_path) -> None:
    configured = settings(
        tmp_path,
        manifest_path=tmp_path / "missing-manifest.json",
        primary_model="chronos-2",
        fallback_model=None,
        device="cuda",
        allow_cpu_fallback=False,
    )

    suite = adapters.load_production_model_suite(configured)

    assert tuple(binding.adapter.provenance.model_id for binding in suite.runs) == (
        "amazon/chronos-2",
        "NeoQuasar/Kronos-small",
    )
    assert all(binding.adapter.provenance.loaded is False for binding in suite.runs)
