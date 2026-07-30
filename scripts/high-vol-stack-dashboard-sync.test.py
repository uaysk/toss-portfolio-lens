from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE_PATH = Path(__file__).with_name("high-vol-stack-dashboard-sync.py")
SPEC = importlib.util.spec_from_file_location(
    "high_vol_stack_dashboard_sync",
    SOURCE_PATH,
)
assert SPEC is not None and SPEC.loader is not None
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


class HighVolatilityDashboardSyncTests(unittest.TestCase):
    def fixture(self, run_dir: Path) -> None:
        write_json(
            run_dir / "state.json",
            {
                "startedAt": "2026-07-30T00:00:00.000Z",
                "phase": "infer-chronos2",
                "evaluation": {
                    "calibrationStart": "2026-06-01T00:00:00.000Z",
                    "start": "2026-06-15T00:00:00.000Z",
                    "endExclusive": "2026-07-29T00:00:00.000Z",
                },
                "data": {
                    "requestedCandidates": [
                        "SOLUSDT",
                        "DOGEUSDT",
                        "XRPUSDT",
                    ],
                    "usableCandidates": ["SOLUSDT", "DOGEUSDT"],
                    "errors": {"restKlines": []},
                },
                "models": {
                    "chronos2": {
                        "contextBars": 2048,
                        "cadenceSeconds": 60,
                        "status": "running",
                        "completed": 12,
                        "total": 40,
                        "currentOriginAt": "2026-06-15T03:00:00.000Z",
                    },
                    "fincast": {
                        "contextBars": 512,
                        "cadenceSeconds": 60,
                        "status": "queued",
                        "completed": 0,
                        "total": 40,
                    },
                },
            },
        )
        write_json(
            run_dir / "run-manifest.json",
            {
                "models": {
                    "chronos2": {
                        "modelId": "amazon/chronos-2",
                        "modelRevision": "chronos-revision",
                    },
                    "fincast": {
                        "modelId": "Vincent05R/FinCast",
                        "modelRevision": "fincast-revision",
                    },
                },
            },
        )
        (run_dir / "pipeline.log").write_text(
            "source started\nchronos origin 12/40\n",
            encoding="utf-8",
        )

    def test_projects_a_running_source_phase(self) -> None:
        observed = datetime(2026, 7, 30, 1, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            self.fixture(run_dir)
            with patch.object(SYNC, "telemetry", return_value=None):
                state, events = SYNC.build_projection(
                    run_dir,
                    "high-vol-test",
                    observed_at=observed,
                )

        self.assertEqual(state["status"], "running")
        self.assertEqual(
            state["experiment"]["kind"],
            "high-volatility-profitability-backtest",
        )
        self.assertEqual(state["experiment"]["phase"], "infer-chronos2")
        self.assertEqual(state["experiment"]["models"]["chronos2"]["completed"], 12)
        self.assertEqual(state["config"]["durationHours"], 1056)
        self.assertEqual(state["activeStepId"], "infer-chronos2")
        self.assertTrue(any(event["type"] == "step_started" for event in events))

    def test_failure_marker_is_projected_with_the_log_reason(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            self.fixture(run_dir)
            (run_dir / "FAILED").write_text("failed\n", encoding="utf-8")
            (run_dir / "pipeline.log").write_text(
                "RuntimeError: causal tail is incomplete\n",
                encoding="utf-8",
            )
            with patch.object(SYNC, "telemetry", return_value=None):
                state, _events = SYNC.build_projection(run_dir, "failed-run")

        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["experiment"]["phase"], "failed")
        self.assertIn(
            "causal tail is incomplete",
            state["experiment"]["failureReason"],
        )

    def test_publish_writes_latest_and_terminal_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "source"
            dashboard_root = root / "dashboard"
            run_dir.mkdir()
            self.fixture(run_dir)
            (run_dir / "COMPLETE").write_text("complete\n", encoding="utf-8")
            write_json(
                run_dir / "comparison-summary.json",
                {
                    "variants": {
                        "chronos2_rust": {
                            "metrics": {
                                "grossReturn": 0.02,
                                "netReturn": 0.01,
                                "maximumDrawdown": 0.03,
                                "sharpe": 0.8,
                                "tradeCount": 5,
                            },
                        },
                        "chronos2_fincast_veto_rust": {
                            "metrics": {
                                "grossReturn": 0.03,
                                "netReturn": 0.018,
                                "maximumDrawdown": 0.025,
                                "sharpe": 1.1,
                                "tradeCount": 4,
                                "vetoCount": 2,
                            },
                        },
                    },
                },
            )
            with patch.object(SYNC, "telemetry", return_value=None):
                status = SYNC.publish(run_dir, dashboard_root, "complete-run")

            latest = json.loads(
                (dashboard_root / "latest.json").read_text(encoding="utf-8")
            )
            projected = json.loads(
                (dashboard_root / "complete-run" / "state.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(status, "completed")
        self.assertEqual(latest["runId"], "complete-run")
        self.assertEqual(
            projected["experiment"]["results"]["chronos2FincastVetoRust"][
                "vetoCount"
            ],
            2,
        )

    def test_publish_rejects_a_projection_that_would_overwrite_the_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "same-run"
            run_dir.mkdir()
            self.fixture(run_dir)
            with patch.object(SYNC, "telemetry", return_value=None):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "must differ from the source run",
                ):
                    SYNC.publish(run_dir, root, "same-run")


if __name__ == "__main__":
    unittest.main()
