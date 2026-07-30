from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import numpy as np


ROOT = Path(__file__).resolve().parents[3]
CONVERTER = ROOT / "scripts" / "convert-chronos2-output-to-policy-artifact.py"
SUMMARIZER = ROOT / "scripts" / "summarize-chronos2-qualification.py"
STATE = ROOT / "scripts" / "chronos2-qualification-state.py"
RUNTIME_PROVENANCE = (
    ROOT / "scripts" / "compose-chronos2-runtime-provenance.py"
)
CONTEXT_RUNNER = ROOT / "scripts" / "run-chronos2-context-qualification-worker.sh"
CONTEXT_SUMMARIZER = (
    ROOT / "scripts" / "summarize-chronos2-context-benchmarks.py"
)
QUANTILES = [
    0.01,
    0.05,
    0.1,
    0.15,
    0.2,
    0.25,
    0.3,
    0.35,
    0.4,
    0.45,
    0.5,
    0.55,
    0.6,
    0.65,
    0.7,
    0.75,
    0.8,
    0.85,
    0.9,
    0.95,
    0.99,
]


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _json(path: Path, value: object) -> bytes:
    payload = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return payload


def _origins(rows: int, *, timespec: str = "auto") -> bytes:
    start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    lines = []
    for row in range(rows):
        origin = start + timedelta(minutes=15 * row)
        lines.append(
            json.dumps(
                {
                    "row_id": row,
                    "instrument_key": "crypto:BTCUSDT",
                    "origin": origin.isoformat(timespec=timespec),
                    "future_timestamps": [
                        (origin + timedelta(minutes=index + 1)).isoformat(
                            timespec=timespec
                        )
                        for index in range(60)
                    ],
                    "metadata": {"symbol": "BTCUSDT"},
                },
                separators=(",", ":"),
            )
        )
    return ("\n".join(lines) + "\n").encode()


def test_chronos_output_projects_exact_native_deciles(tmp_path: Path) -> None:
    rows = 2
    fincast = tmp_path / "fincast"
    fincast.mkdir()
    contexts = np.ones((rows, 512), dtype="<f4").tobytes()
    origins = _origins(rows)
    (fincast / "contexts.f32").write_bytes(contexts)
    (fincast / "origins.jsonl").write_bytes(origins)
    fincast_manifest = _json(
        fincast / "manifest.json",
        {
            "schema_version": "fincast-raw-input/v1",
            "cadence_seconds": 60,
            "horizon_minutes": [5, 15, 30, 60],
            "row_count": rows,
            "row_order": "row_id_ascending",
            "context_bars": 512,
            "model_seed": 17,
            "files": {
                "contexts": {
                    "name": "contexts.f32",
                    "size_bytes": len(contexts),
                    "sha256": _sha(contexts),
                },
                "origins": {
                    "name": "origins.jsonl",
                    "size_bytes": len(origins),
                    "sha256": _sha(origins),
                },
            },
            "metadata": {"durationHours": 1},
        },
    )

    chronos_input = tmp_path / "chronos-input"
    chronos_input.mkdir()
    chronos_origins = _origins(rows, timespec="microseconds")
    (chronos_input / "origins.jsonl").write_bytes(chronos_origins)
    _json(
        chronos_input / "manifest.json",
        {
            "schema_version": "chronos2-raw-input/v2",
            "profile": "close_only",
            "row_count": rows,
            "context_bars": 1024,
            "native_quantiles": QUANTILES,
            "files": {
                "origins": {
                    "name": "origins.jsonl",
                    "size_bytes": len(chronos_origins),
                    "sha256": _sha(chronos_origins),
                },
            },
        },
    )

    source = np.empty((rows, 4, 22), dtype="<f4")
    quantile_prices = np.asarray(
        [100 + index for index in range(len(QUANTILES))],
        dtype=np.float32,
    )
    source[:, :, 0] = quantile_prices[10]
    source[:, :, 1:] = quantile_prices
    source_payload = source.tobytes()
    chronos_output = tmp_path / "chronos-output"
    (chronos_output / "chunks").mkdir(parents=True)
    binary_name = "chunks/chunk-0000000000-0000000002.f32"
    (chronos_output / binary_name).write_bytes(source_payload)
    metadata_name = "chunks/chunk-0000000000-0000000002.json"
    _json(
        chronos_output / metadata_name,
        {
            "start_row": 0,
            "end_row": rows,
            "latency": {"wall_ms": 10},
            "gpu_telemetry": {},
            "output": {
                "name": binary_name,
                "size_bytes": len(source_payload),
                "sha256": _sha(source_payload),
                "shape": [rows, 4, 22],
            },
        },
    )
    _json(
        chronos_output / "manifest.json",
        {
            "schema_version": "chronos2-raw-predictions/v1",
            "complete": True,
            "completed_rows": rows,
            "row_count": rows,
            "output_shape": [rows, 4, 22],
            "backend": "gpu_gather",
            "variate_batch_size": 48,
            "input_artifact_digest": "a" * 64,
            "chunks": [metadata_name],
            "provenance": {"model_id": "amazon/chronos-2"},
        },
    )
    output = tmp_path / "policy"
    result = subprocess.run(
        [
            sys.executable,
            str(CONVERTER),
            "--fincast-input",
            str(fincast / "manifest.json"),
            "--chronos-input",
            str(chronos_input / "manifest.json"),
            "--chronos-output",
            str(chronos_output),
            "--output",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(result.stdout)["row_count"] == rows
    projected = np.fromfile(
        output / binary_name,
        dtype="<f4",
    ).reshape(rows, 4, 10)
    expected = [
        quantile_prices[QUANTILES.index(value)]
        for value in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    ]
    assert projected[0, 0, 0] == quantile_prices[10]
    np.testing.assert_array_equal(projected[0, 0, 1:], expected)
    assert _sha(fincast_manifest) == json.loads(
        (output / "manifest.json").read_bytes()
    )["input_manifest_sha256"]
    assert json.loads((output / "manifest.json").read_bytes())["context_bars"] == 1024


def _benchmark(batch: int, throughput: float, backend: str) -> dict[str, object]:
    return {
        "schema_version": "chronos2-p40-raw-benchmark/v1",
        "status": "passed",
        "backend": backend,
        "variate_batch_size": batch,
        "model_load_ms": 1000,
        "rejection_reasons": [],
        "accuracy_gate": {"passed": True, "direction_match_rate": 1},
        "repeat_output_digest": {"stable": True},
        "memory": {
            "headroom_passed": True,
            "torch_peak_reserved_bytes": 1024,
        },
        "timing": {
            "tasks_per_second": {"median": throughput},
            "variates_per_second": {"median": throughput},
            "wall_ms": {"p50": 10, "p95": 11},
        },
    }


def _comparison(pinball: float) -> dict[str, object]:
    accuracy = {
        "direction_accuracy": 0.51,
        "q50_return_mae": 0.01,
        "q50_return_rmse": 0.02,
        "up_probability_brier": 0.25,
        "q10_q90_interval_coverage": 0.8,
        "mean_pinball_loss": pinball,
    }
    return {
        "realized_accuracy": {
            "reference": {**accuracy, "mean_pinball_loss": 0.02},
            "candidate": accuracy,
            "paired": {
                "candidate_q50_error_wins": 10,
                "candidate_q50_error_losses": 8,
                "direction_disagreements": 2,
            },
        },
        "model_signal_returns": {
            "profiles": [
                {
                    "reference": {
                        "total_return": 0.01,
                        "maximum_drawdown": 0.02,
                    },
                    "candidate": {
                        "total_return": 0.011,
                        "maximum_drawdown": 0.019,
                    },
                }
            ]
        },
    }


def test_summary_applies_three_percent_batch_rule_and_covariate_guard(
    tmp_path: Path,
) -> None:
    profiles = (
        "close_only",
        "ohlcv_calendar",
        "microstructure_calendar",
        "derivatives_calendar",
    )
    for profile in profiles:
        root = tmp_path / "benchmarks" / profile
        root.mkdir(parents=True)
        for batch, throughput in zip((16, 24, 32, 48, 50), (90, 99, 100, 99, 98)):
            _json(
                root / f"batch-worker-local-b{batch}.json",
                _benchmark(batch, throughput, "worker_local"),
            )
        for backend in (
            "pipeline_eager",
            "worker_local",
            "no_padding",
            "gpu_gather",
            "cuda_graph",
        ):
            _json(
                root / f"stage-{backend}-b24.json",
                _benchmark(24, 100 + 10 * list((
                    "pipeline_eager",
                    "worker_local",
                    "no_padding",
                    "gpu_gather",
                    "cuda_graph",
                )).index(backend), backend),
            )
    comparisons = tmp_path / "comparisons"
    comparisons.mkdir()
    for profile in profiles:
        _json(
            comparisons / f"{profile}.json",
            _comparison(0.009 if profile == "ohlcv_calendar" else 0.01),
        )
    output = tmp_path / "summary.json"
    subprocess.run(
        [
            sys.executable,
            str(SUMMARIZER),
            "--run-dir",
            str(tmp_path),
            "--output",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    value = json.loads(output.read_bytes())
    assert value["profiles"]["close_only"]["batch_sweep"][
        "selected_variate_batch_size"
    ] == 24
    assert value["profiles"]["close_only"]["optimization"][
        "selected_backend"
    ] == "cuda_graph"
    assert value["profile_selection"]["selected_profile"] == "ohlcv_calendar"
    assert value["profile_selection"]["additional_covariates_improved_holdout"] is True
    assert value["profile_selection"]["candidate_evaluations"]["ohlcv_calendar"][
        "eligible"
    ] is True
    assert value["profile_selection"]["candidate_evaluations"]["close_only"][
        "rejection_reasons"
    ] == []


def test_dashboard_state_writer_tracks_steps_and_metrics(tmp_path: Path) -> None:
    run = tmp_path / "pilot"
    run.mkdir()
    base = [
        sys.executable,
        str(STATE),
    ]
    subprocess.run(
        [
            *base,
            "init",
            "--run-dir",
            str(run),
            "--run-id",
            "chronos2-pilot-test",
            "--mode",
            "pilot",
            "--duration-hours",
            "6",
            "--end-exclusive",
            "2026-07-28T00:00:00Z",
            "--budget-hours",
            "2",
        ],
        check=True,
    )
    subprocess.run(
        [
            *base,
            "step-start",
            "--run-dir",
            str(run),
            "--step-id",
            "preflight",
        ],
        check=True,
    )
    subprocess.run(
        [
            *base,
            "step-complete",
            "--run-dir",
            str(run),
            "--step-id",
            "preflight",
            "--message",
            "verified",
        ],
        check=True,
    )
    metrics = tmp_path / "metrics.json"
    _json(metrics, {"estimatedFullDurationMs": 4_000_000})
    subprocess.run(
        [
            *base,
            "experiment-metrics",
            "--run-dir",
            str(run),
            "--json-file",
            str(metrics),
        ],
        check=True,
    )
    value = json.loads((run / "state.json").read_bytes())
    assert value["steps"][0]["status"] == "completed"
    assert value["experiment"]["metrics"]["estimatedFullDurationMs"] == 4_000_000
    assert len((run / "events.jsonl").read_text().splitlines()) == 4
    assert json.loads((tmp_path / "latest.json").read_bytes()) == {
        "runId": "chronos2-pilot-test"
    }


def test_dashboard_state_writer_supports_context_window_phase_transition(
    tmp_path: Path,
) -> None:
    run = tmp_path / "context"
    run.mkdir()
    base = [sys.executable, str(STATE)]
    subprocess.run(
        [
            *base,
            "init",
            "--run-dir",
            str(run),
            "--run-id",
            "chronos2-context-test",
            "--mode",
            "full",
            "--duration-hours",
            "840",
            "--end-exclusive",
            "2026-07-27T00:00:00Z",
            "--budget-hours",
            "12",
            "--experiment",
            "context-window",
        ],
        check=True,
    )
    subprocess.run(
        [
            *base,
            "phase",
            "--run-dir",
            str(run),
            "--phase",
            "full",
        ],
        check=True,
    )
    metrics = tmp_path / "context-metrics.json"
    _json(
        metrics,
        {
            "pilotGatePassed": True,
            "selectedContextBars": 2048,
            "resultStatus": "development_context_selected_holdout_pending",
        },
    )
    subprocess.run(
        [
            *base,
            "experiment-metrics",
            "--run-dir",
            str(run),
            "--json-file",
            str(metrics),
        ],
        check=True,
    )
    value = json.loads((run / "state.json").read_bytes())
    assert value["config"]["dockerBuild"] is False
    assert value["experiment"]["phase"] == "full"
    assert value["experiment"]["contexts"] == [512, 1024, 2048, 4096, 8192]
    assert value["experiment"]["resultStatus"] == (
        "development_context_selected_holdout_pending"
    )
    assert "resultStatus" not in value["experiment"]["metrics"]
    assert len(value["steps"]) == 12


def test_context_runner_is_pinned_resumable_and_restores_gpu_peers() -> None:
    source = CONTEXT_RUNNER.read_text()
    assert "CONTEXTS=(512 1024 2048 4096 8192)" in source
    assert "BATCHES=(1 2 4 8 12 16 24 32 48 50)" in source
    assert (
        "BACKENDS=(pipeline_eager worker_local no_padding gpu_gather)"
        in source
    )
    assert "AI_ALLOW_CPU_FALLBACK=false" in source
    assert "trap cleanup EXIT" in source
    assert "restore_gpu_services" in source
    assert "--resume" in source
    assert "cuda_graph" not in source
    assert "docker build" not in source
    assert "docker pull" not in source


def test_context_summary_selects_across_every_batch_backend_pair(
    tmp_path: Path,
) -> None:
    phase = tmp_path / "full"
    contexts = (512, 1024, 2048, 4096, 8192)
    batches = (1, 2, 4, 8, 12, 16, 24, 32, 48, 50)
    backends = ("pipeline_eager", "worker_local", "no_padding", "gpu_gather")
    for context in contexts:
        directory = phase / "benchmarks" / str(context)
        for batch in batches:
            for backend in backends:
                p95 = 1 if (batch, backend) == (50, "gpu_gather") else 10
                _json(
                    directory / f"candidate-{backend}-b{batch}.json",
                    {
                        "schema_version": "chronos2-p40-raw-benchmark/v1",
                        "status": "passed",
                        "backend": backend,
                        "variate_batch_size": batch,
                        "task_batch_size": max(1, batch // 5),
                        "model_load_ms": 1,
                        "accuracy_gate": {
                            "finite": True,
                            "quantile_monotonicity": True,
                        },
                        "repeat_output_digest": {"stable": True},
                        "memory": {
                            "headroom_passed": True,
                            "torch_peak_reserved_bytes": 1024,
                            "minimum_nvml_free_bytes": 3 * 1024**3,
                        },
                        "timing": {
                            "wall_ms": {"p95": p95},
                            "tasks_per_second": {"median": 1000 / p95},
                        },
                        "input": {"artifact_digest": f"{context:064x}"},
                        "rounds": [],
                    },
                )
    parity = tmp_path / "origin-parity.json"
    _json(
        parity,
        {
            "status": "passed",
            "full_row_count": 6720,
            "baseline_identity_digest": "a" * 64,
        },
    )
    output = tmp_path / "selection.json"
    subprocess.run(
        [
            sys.executable,
            str(CONTEXT_SUMMARIZER),
            "--phase-root",
            str(phase),
            "--origin-parity",
            str(parity),
            "--output",
            str(output),
            "--mode",
            "full",
        ],
        check=True,
    )
    value = json.loads(output.read_bytes())
    assert value["status"] == "passed"
    for context in contexts:
        selected = value["contexts"][str(context)]
        assert selected["selected_batch_size"] == 50
        assert selected["selected_backend"] == "gpu_gather"


def test_runtime_provenance_distinguishes_host_headers_from_bundled_runtime(
    tmp_path: Path,
) -> None:
    preflight = tmp_path / "preflight.json"
    model = tmp_path / "runtime-model.json"
    framework = tmp_path / "runtime-framework.json"
    output = tmp_path / "runtime.json"
    _json(
        preflight,
        {
            "schema_version": "chronos2-p40-preflight/v1",
            "gpu": "Tesla P40",
            "driver": "580.173.02",
            "power_limit_w": 160,
            "cuda_nvcc": "Cuda compilation tools, release 12.2, V12.2.140",
            "cudnn_header": (
                "#define CUDNN_MAJOR 8 #define CUDNN_MINOR 9 "
                "#define CUDNN_PATCHLEVEL 7"
            ),
        },
    )
    _json(
        model,
        {
            "schema_version": "chronos2-model-cache/v1",
            "model_id": "amazon/chronos-2",
            "revision": "2" * 40,
            "checkpoint_sha256": "d" * 64,
        },
    )
    _json(
        framework,
        {
            "schema_version": "chronos2-framework-runtime/v1",
            "python": "3.12.13",
            "torch": "2.6.0+cu124",
            "cuda_runtime": "12.4",
            "cudnn_runtime": "9.1.0",
            "cudnn_runtime_integer": 90100,
        },
    )
    subprocess.run(
        [
            sys.executable,
            str(RUNTIME_PROVENANCE),
            "--preflight",
            str(preflight),
            "--model",
            str(model),
            "--framework",
            str(framework),
            "--image-id",
            f"sha256:{'a' * 64}",
            "--output",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    value = json.loads(output.read_bytes())
    assert value["host"]["cuda_toolkit_nvcc"].endswith("V12.2.140")
    assert value["framework"]["cuda_runtime"] == "12.4"
    assert value["framework"]["cudnn_runtime"] == "9.1.0"
    assert value["requested_runtime"] == {"cuda": "12.2", "cudnn": "8.9.7"}
    assert value["exact_requested_runtime"] is False
