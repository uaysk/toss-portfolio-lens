from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile


SOURCE_PATH = Path(__file__).with_name("high-vol-stack-source.py")
SPEC = importlib.util.spec_from_file_location("high_vol_stack_source", SOURCE_PATH)
assert SPEC is not None and SPEC.loader is not None
SOURCE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SOURCE
SPEC.loader.exec_module(SOURCE)


class HighVolatilitySourceTests(unittest.TestCase):
    def write_completed_resume_fixture(
        self,
        run_dir: Path,
        *,
        smoke: bool,
    ) -> dict[str, object]:
        archive = run_dir / "raw" / "klines" / "BTCUSDT.zip"
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b"archive")
        exchange_info = run_dir / "raw" / "exchange-info.json"
        exchange_info.write_text("{}\n", encoding="utf-8")
        prepared = run_dir / "prepared" / "rules.json"
        prepared.parent.mkdir()
        prepared.write_text("{}\n", encoding="utf-8")
        prediction = run_dir / "predictions" / "chronos2.jsonl"
        prediction.parent.mkdir()
        prediction.write_text("{}\n", encoding="utf-8")
        for name in ("origins.json", "run-manifest.json", "schedule.json"):
            (run_dir / name).write_text("{}\n", encoding="utf-8")
        snapshot = (
            "scanner-snapshots-smoke.json"
            if smoke
            else "scanner-snapshots.jsonl"
        )
        (run_dir / snapshot).write_text("{}\n", encoding="utf-8")
        (run_dir / "SOURCE_COMPLETE").write_text(
            "2026-07-30T00:00:00.000Z\n",
            encoding="utf-8",
        )
        manifest: dict[str, object] = {
            "schemaVersion": SOURCE.RESUME_MANIFEST_VERSION,
            "inputHash": "input",
            "modelHash": "model",
            "archiveHashes": SOURCE.hash_tree(run_dir / "raw"),
            "outputHashes": SOURCE.source_output_hashes(
                run_dir,
                smoke=smoke,
            ),
        }
        SOURCE.atomic_json(run_dir / "source-resume-manifest.json", manifest)
        return manifest

    def test_completed_resume_requires_exact_archive_and_output_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            self.write_completed_resume_fixture(run_dir, smoke=False)

            valid, reasons, mismatches = SOURCE.completed_resume_is_valid(
                run_dir,
                input_hash="input",
                model_hash="model",
                smoke=False,
            )
            self.assertTrue(valid)
            self.assertEqual(reasons, [])
            self.assertEqual(mismatches, [])

            archive = run_dir / "raw" / "klines" / "BTCUSDT.zip"
            archive.write_bytes(b"changed")
            valid, reasons, mismatches = SOURCE.completed_resume_is_valid(
                run_dir,
                input_hash="input",
                model_hash="model",
                smoke=False,
            )
            self.assertFalse(valid)
            self.assertIn("archive_hash_mismatch", reasons)
            self.assertEqual(mismatches, ["klines/BTCUSDT.zip"])

    def test_completed_resume_rejects_empty_or_partial_hash_manifests(self) -> None:
        cases = (
            ("archiveHashes", lambda values: {}),
            ("outputHashes", lambda values: {}),
            (
                "archiveHashes",
                lambda values: dict(list(values.items())[:-1]),
            ),
            (
                "outputHashes",
                lambda values: dict(list(values.items())[:-1]),
            ),
        )
        for field, mutate in cases:
            with self.subTest(field=field, mutation=mutate), (
                tempfile.TemporaryDirectory()
            ) as directory:
                run_dir = Path(directory)
                manifest = self.write_completed_resume_fixture(
                    run_dir,
                    smoke=False,
                )
                values = manifest[field]
                assert isinstance(values, dict)
                manifest[field] = mutate(values)
                SOURCE.atomic_json(
                    run_dir / "source-resume-manifest.json",
                    manifest,
                )

                valid, reasons, _mismatches = (
                    SOURCE.completed_resume_is_valid(
                        run_dir,
                        input_hash="input",
                        model_hash="model",
                        smoke=False,
                    )
                )

                self.assertFalse(valid)
                if manifest[field]:
                    self.assertIn(
                        "archive_hash_mismatch"
                        if field == "archiveHashes"
                        else "output_hash_mismatch",
                        reasons,
                    )
                else:
                    self.assertIn(
                        "archive_hash_manifest_invalid"
                        if field == "archiveHashes"
                        else "output_hash_manifest_invalid",
                        reasons,
                    )

    def test_completed_resume_uses_smoke_specific_output_tree(self) -> None:
        for smoke in (False, True):
            with self.subTest(smoke=smoke), (
                tempfile.TemporaryDirectory()
            ) as directory:
                run_dir = Path(directory)
                self.write_completed_resume_fixture(run_dir, smoke=smoke)

                valid, reasons, _mismatches = (
                    SOURCE.completed_resume_is_valid(
                        run_dir,
                        input_hash="input",
                        model_hash="model",
                        smoke=smoke,
                    )
                )
                self.assertTrue(valid, reasons)

                valid, reasons, _mismatches = (
                    SOURCE.completed_resume_is_valid(
                        run_dir,
                        input_hash="input",
                        model_hash="model",
                        smoke=not smoke,
                    )
                )
                self.assertFalse(valid)
                self.assertIn("output_hash_tree_invalid", reasons)

    def test_invalid_resume_is_preserved_in_failure_area(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            (run_dir / "prepared").mkdir()
            (run_dir / "prepared" / "rules.json").write_text(
                "{}\n",
                encoding="utf-8",
            )
            (run_dir / "SOURCE_COMPLETE").write_text(
                "complete\n",
                encoding="utf-8",
            )
            SOURCE.atomic_json(
                run_dir / "source-resume-manifest.json",
                {"schemaVersion": SOURCE.RESUME_MANIFEST_VERSION},
            )

            destination = SOURCE.preserve_invalid_resume(
                run_dir,
                ["output_hash_mismatch"],
            )

            self.assertFalse((run_dir / "SOURCE_COMPLETE").exists())
            self.assertTrue((destination / "SOURCE_COMPLETE").is_file())
            self.assertTrue(
                (destination / "prepared" / "rules.json").is_file()
            )
            rejection = json.loads(
                (destination / "resume-rejection.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(rejection["reasons"], ["output_hash_mismatch"])

    def test_archive_days_exclude_the_unfinished_truth_tail_day(self) -> None:
        days = SOURCE.complete_archive_days(
            datetime(2026, 6, 1, tzinfo=timezone.utc),
            datetime(2026, 7, 29, tzinfo=timezone.utc),
        )

        self.assertEqual(days[0].isoformat(), "2026-06-01")
        self.assertEqual(days[-1].isoformat(), "2026-07-28")
        self.assertNotIn("2026-07-29", {item.isoformat() for item in days})

    def test_rest_tail_requires_every_real_finalized_minute(self) -> None:
        start = datetime(2026, 7, 29, 0, 0, tzinfo=timezone.utc)
        end = datetime(2026, 7, 29, 0, 2, tzinfo=timezone.utc)
        start_ms = int(start.timestamp() * 1000)
        payload = [
            [
                start_ms,
                "100",
                "101",
                "99",
                "100.5",
                "12",
                start_ms + SOURCE.MINUTE_MS - 1,
                "1206",
                8,
                "7",
                "703.5",
                "0",
            ],
            [
                start_ms + SOURCE.MINUTE_MS,
                "100.5",
                "102",
                "100",
                "101",
                "10",
                start_ms + 2 * SOURCE.MINUTE_MS - 1,
                "1010",
                6,
                "4",
                "404",
                "0",
            ],
        ]

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "BTCUSDT.json"
            with patch.object(
                SOURCE,
                "request_bytes",
                return_value=json.dumps(payload).encode("utf-8"),
            ):
                SOURCE.download_rest_klines(
                    path,
                    "BTCUSDT",
                    start,
                    end,
                )
            parsed = list(SOURCE.rest_kline_rows(json.loads(
                path.read_text(encoding="utf-8")
            )))

        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[-1]["closeTime"], int(end.timestamp() * 1000) - 1)
        self.assertEqual(parsed[-1]["tradeCount"], 6)

    def test_rest_tail_rejects_a_missing_minute(self) -> None:
        start = datetime(2026, 7, 29, 0, 0, tzinfo=timezone.utc)
        end = datetime(2026, 7, 29, 0, 2, tzinfo=timezone.utc)
        start_ms = int(start.timestamp() * 1000)
        payload = [[
            start_ms,
            "100",
            "101",
            "99",
            "100.5",
            "12",
            start_ms + SOURCE.MINUTE_MS - 1,
            "1206",
            8,
            "7",
            "703.5",
            "0",
        ]]

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "BTCUSDT.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(
                RuntimeError,
                "supplemental REST klines are incomplete",
            ):
                SOURCE.download_rest_klines(
                    path,
                    "BTCUSDT",
                    start,
                    end,
                )

    def test_rest_cache_path_is_bound_to_the_exact_range(self) -> None:
        raw = Path("/tmp/raw")
        first = SOURCE.rest_kline_cache_path(
            raw,
            "BTCUSDT",
            datetime(2026, 7, 28, tzinfo=timezone.utc),
            datetime(2026, 7, 29, tzinfo=timezone.utc),
        )
        second = SOURCE.rest_kline_cache_path(
            raw,
            "BTCUSDT",
            datetime(2026, 7, 29, tzinfo=timezone.utc),
            datetime(2026, 7, 29, 1, tzinfo=timezone.utc),
        )

        self.assertNotEqual(first, second)
        self.assertEqual(first.parent.name, "BTCUSDT")

    def test_missing_core_archive_is_recovered_from_finalized_rest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            archive = (
                raw
                / "klines"
                / "BTCUSDT"
                / "1m"
                / "BTCUSDT-1m-2026-07-28.zip"
            )
            jobs = [(
                archive,
                "https://example.invalid/BTCUSDT.zip",
                "klines",
                "BTCUSDT",
                "2026-07-28",
            )]
            errors = {"BTCUSDT": ["klines:2026-07-28:HTTP_404"]}

            def finalized_rest(
                path: Path,
                _symbol: str,
                _start: datetime,
                _end: datetime,
            ) -> None:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("[]", encoding="utf-8")

            with patch.object(
                SOURCE,
                "download_rest_klines",
                side_effect=finalized_rest,
            ):
                recovered = SOURCE.recover_missing_kline_archives(
                    raw,
                    jobs,
                    errors,
                )

        self.assertNotIn("BTCUSDT", errors)
        self.assertEqual(recovered["BTCUSDT"][0]["day"], "2026-07-28")
        self.assertIn(
            "HTTP_404",
            recovered["BTCUSDT"][0]["replacedErrors"],
        )

    def test_core_cross_asset_feature_cache_matches_causal_windows(self) -> None:
        base = 1_800_000_000_000

        def bars(scale: float) -> list[dict[str, float | int]]:
            return [
                {
                    "openTime": base + index * SOURCE.MINUTE_MS,
                    "closeTime": base + (index + 1) * SOURCE.MINUTE_MS - 1,
                    "open": scale + index,
                    "high": scale + index + 1,
                    "low": scale + index - 1,
                    "close": scale + index + 0.5,
                    "volume": 10 + index,
                    "quoteVolume": 1_000 + index,
                    "tradeCount": 20 + index,
                    "takerBuyVolume": 5 + index,
                    "takerBuyQuoteVolume": 500 + index,
                }
                for index in range(70)
            ]

        source_bars = {
            "BTCUSDT": bars(10_000),
            "ETHUSDT": bars(2_000),
            "SOLUSDT": bars(100),
        }
        repository = SOURCE.Repository(
            source_bars,
            {symbol: ([], []) for symbol in source_bars},
            {symbol: ([], []) for symbol in source_bars},
            {
                symbol: {"tickSize": 0.01, "listingAtMs": 0}
                for symbol in source_bars
            },
        )
        origin = int(source_bars["SOLUSDT"][-1]["closeTime"])

        features = repository.feature_bars("SOLUSDT", origin, 10)

        self.assertAlmostEqual(
            features[-1]["btc_realized_volatility"],
            SOURCE.realized_volatility(source_bars["BTCUSDT"][-61:]),
        )
        expected_short = SOURCE.math.log(
            float(source_bars["BTCUSDT"][-1]["close"])
            / float(source_bars["BTCUSDT"][-6]["close"])
        )
        self.assertAlmostEqual(features[-1]["btc_short_return"], expected_short)

    def test_both_model_lanes_use_fixed_batch_prefetch(self) -> None:
        class FakeRepository:
            def __init__(self) -> None:
                self.thread_names: list[str] = []

            def feature_bars(
                self,
                _symbol: str,
                origin_ms: int,
                _count: int,
            ) -> list[dict[str, object]]:
                self.thread_names.append(threading.current_thread().name)
                return [{"timestamp": SOURCE.iso_ms(origin_ms), "complete": True}]

        class FakeClient:
            def __init__(self) -> None:
                self.batch_sizes: list[int] = []

            def request(self, payload: dict[str, object]) -> dict[str, object]:
                series = payload["series"]
                assert isinstance(series, list)
                self.batch_sizes.append(len(series))
                return {}

        schedule = [
            {
                "originAt": SOURCE.iso_ms(
                    1_800_000_000_000 + index * SOURCE.MINUTE_MS
                ),
                "originMs": 1_800_000_000_000 + index * SOURCE.MINUTE_MS,
                "candidateSymbols": ["SOLUSDT"],
            }
            for index in range(5)
        ]

        def normalized(
            lane: str,
            symbol: str,
            origin_ms: int,
            _response: object,
            _latency_ms: float,
            batch_size: int,
            _digest: str,
        ) -> dict[str, object]:
            return {
                "lane": lane,
                "symbol": symbol,
                "originAt": SOURCE.iso_ms(origin_ms),
                "inferenceBatchSize": batch_size,
            }

        with tempfile.TemporaryDirectory() as directory, patch.object(
            SOURCE,
            "normalize_worker_series",
            side_effect=normalized,
        ):
            for lane in ("chronos2", "fincast"):
                repository = FakeRepository()
                client = FakeClient()
                state = {
                    "models": {
                        lane: {
                            "completed": 0,
                            "total": 0,
                            "retries": 0,
                        }
                    },
                    "heartbeatAt": SOURCE.iso_ms(1_800_000_000_000),
                }
                output = SOURCE.infer_lane(
                    Path(directory) / lane,
                    lane,
                    repository,
                    schedule,
                    client,
                    state,
                )

                self.assertEqual(len(output), 5)
                self.assertEqual(client.batch_sizes, [4, 1])
                self.assertTrue(
                    all(
                        f"{lane}-input-prefetch" in name
                        for name in repository.thread_names
                    )
                )
                self.assertEqual(
                    state["models"][lane]["executionOptimizationVersion"],
                    SOURCE.EXECUTION_OPTIMIZATION_VERSION,
                )

    def test_book_ticker_preserves_last_real_quote_per_30_second_bucket(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "BTCUSDT-bookTicker-2024-01-01.zip"
            rows = "\n".join(
                (
                    "update_id,best_bid_price,best_bid_qty,best_ask_price,"
                    "best_ask_qty,transaction_time,event_time",
                    "1,100,2,101,3,1000,1001",
                    "2,100.5,4,101,5,2000,2001",
                    "3,102,6,103,7,31000,31001",
                )
            )
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("BTCUSDT-bookTicker-2024-01-01.csv", rows)

            parsed = list(SOURCE.book_ticker_rows(path))

        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0][0], 2001)
        self.assertEqual(parsed[0][1]["bidPrice"], 100.5)
        self.assertEqual(parsed[1][0], 31001)
        self.assertEqual(parsed[1][1]["askQuantity"], 7)

    def test_scanner_records_five_hard_gate_finalists(self) -> None:
        origin = 1_800_000_000_000
        observations = []
        for index in range(6):
            observations.append(
                {
                    "symbol": f"ASSET{index}USDT",
                    "observedAtMs": origin,
                    "listingAtMs": origin - 365 * SOURCE.DAY_MS,
                    "missingRate": 0,
                    "tradingAmountUsd": 100_000_000 + index * 1_000_000,
                    "tradeCount": 100_000 + index,
                    "medianSpreadBps": 2,
                    "p95SpreadBps": 3,
                    "depthUsd": 1_000_000,
                    "abnormalGap": False,
                    "fundingRate": 0,
                    "basisRate": 0,
                    "realizedVolatility": 0.01 + index * 0.001,
                    "normalizedAtr": 0.01 + index * 0.001,
                    "rollingRange": 0.02 + index * 0.001,
                    "bollingerWidthExpansion": 1 + index * 0.01,
                    "relativeVolume": 1 + index * 0.01,
                    "liquidityQuality": 0.9,
                }
            )

        result = SOURCE.scan_candidates(observations, origin)

        self.assertEqual(result["eligibleCandidateCount"], 6)
        self.assertEqual(len(result["topFive"]), 5)
        self.assertEqual(len(result["selectedSymbols"]), 1)


if __name__ == "__main__":
    unittest.main()
