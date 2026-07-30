#!/usr/bin/env python3
"""Prepare causal high-volatility crypto data and pinned model forecasts.

This is the data/model half of the Chronos-2 + Rust versus
Chronos-2 + FinCast-veto + Rust ablation.  The trading decision is deliberately
left to ``high-vol-stack-backtest.ts`` so both variants use the application's
real unified policy engine and Rust adapter.

Only public Binance USD-M data is downloaded.  Model credentials are read from
files already mounted on the inference host and are never copied into an
artifact.
"""

from __future__ import annotations

import argparse
from bisect import bisect_right
from concurrent.futures import Future, ThreadPoolExecutor
import csv
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import tempfile
import time
from typing import Any, Iterator, Mapping, Sequence
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zipfile

from websockets.sync.client import ClientConnection, connect


UTC = timezone.utc
SCHEMA_VERSION = "high-vol-stack-source/v2"
STATE_VERSION = "high-vol-stack-source-state/v2"
MODEL_IDS = {
    "chronos2": "amazon/chronos-2",
    "fincast": "Vincent05R/FinCast",
}
MODEL_REVISIONS = {
    "chronos2": "254b5357164a84326913b0695216f690752ac55d",
    "fincast": "2d7d90b159db8961d27c2cf165d51195902ef92b",
}
MODEL_CONTEXTS = {"chronos2": 2048, "fincast": 512}
HORIZONS = (5, 15, 30, 60)
QUANTILES = (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)
SEED = 17
MINUTE_MS = 60_000
DAY_MS = 86_400_000
ORIGIN_INTERVAL_MINUTES = 15
SCANNER_INTERVAL_MINUTES = 30
CALIBRATION_DAYS = 7
CONTEXT_WARMUP_DAYS = 2
MODEL_SELECTOR_CANDIDATE_COUNT = 3
SCANNER_RECORDED_TOP_COUNT = 5
INFERENCE_TASK_BATCH_SIZES = {"chronos2": 4, "fincast": 4}
INFERENCE_PREFETCH_WORKERS = 4
EXECUTION_OPTIMIZATION_VERSION = "high-vol-fixed-batch-prefetch-v1"
FEATURE_CACHE_VERSION = "core-cross-asset-rolling-v1"
DEFAULT_EVALUATION_START = "2026-07-20T00:00:00Z"
DEFAULT_EVALUATION_END = "2026-07-27T00:00:00Z"
DEFAULT_CANDIDATES = (
    "SOLUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "BNBUSDT",
    "SUIUSDT",
    "ADAUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "HYPEUSDT",
    "ZECUSDT",
)
CORE_SYMBOLS = ("BTCUSDT", "ETHUSDT")
ARCHIVE_ROOT = "https://data.binance.vision/data/futures/um/daily"
FAPI_ROOT = "https://fapi.binance.com/fapi/v1"
RESUME_MANIFEST_VERSION = "high-vol-stack-source-resume/v1"
SOURCE_INPUT_MANIFEST_VERSION = "high-vol-stack-source-input/v1"


def iso_ms(value: int | datetime) -> str:
    instant = (
        value.astimezone(UTC)
        if isinstance(value, datetime)
        else datetime.fromtimestamp(value / 1000, UTC)
    )
    return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_instant(value: str, label: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{label} must be an RFC3339 instant") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a UTC offset")
    return parsed.astimezone(UTC)


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                value,
                handle,
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def append_jsonl(path: Path, values: Sequence[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for value in values:
            handle.write(
                json.dumps(
                    value,
                    ensure_ascii=False,
                    allow_nan=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            )
        handle.flush()
        os.fsync(handle.fileno())


def atomic_jsonl(path: Path, values: Sequence[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            for value in values:
                handle.write(
                    json.dumps(
                        value,
                        ensure_ascii=False,
                        allow_nan=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    values: list[dict[str, Any]] = []
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    if source and not source.endswith("\n"):
        lines = lines[:-1]
    for line in lines:
        if line.strip():
            values.append(json.loads(line))
    return values


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: object) -> str:
    source = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(source).hexdigest()


def hash_tree(root: Path) -> dict[str, str]:
    if not root.is_dir():
        return {}
    paths = sorted(
        (
            path
            for path in root.rglob("*")
            if path.is_file() and not path.name.endswith(".tmp")
        ),
        key=lambda path: path.relative_to(root).as_posix(),
    )
    if any(path.is_symlink() for path in paths):
        raise RuntimeError(f"resume hash tree contains a symlink: {root}")
    with ThreadPoolExecutor(
        max_workers=min(8, max(1, len(paths))),
        thread_name_prefix="source-resume-hash",
    ) as pool:
        hashes = list(pool.map(sha256_file, paths))
    return {
        path.relative_to(root).as_posix(): digest
        for path, digest in zip(paths, hashes, strict=True)
    }


def source_input_contract(
    *,
    evaluation_start: datetime,
    evaluation_end: datetime,
    calibration_days: int,
    candidates: Sequence[str],
    smoke: bool,
) -> dict[str, Any]:
    return {
        "schemaVersion": SOURCE_INPUT_MANIFEST_VERSION,
        "evaluationStart": iso_ms(evaluation_start),
        "evaluationEndExclusive": iso_ms(evaluation_end),
        "calibrationDays": calibration_days,
        "candidateUniverse": list(candidates),
        "smoke": smoke,
        "sourceImplementationHash": sha256_file(Path(__file__).resolve()),
        "dataContract": {
            "archiveRoot": ARCHIVE_ROOT,
            "fapiRoot": FAPI_ROOT,
            "originIntervalMinutes": ORIGIN_INTERVAL_MINUTES,
            "scannerIntervalMinutes": SCANNER_INTERVAL_MINUTES,
            "contextWarmupDays": CONTEXT_WARMUP_DAYS,
            "modelSelectorCandidateCount": MODEL_SELECTOR_CANDIDATE_COUNT,
            "scannerRecordedTopCount": SCANNER_RECORDED_TOP_COUNT,
        },
    }


def source_model_contract() -> dict[str, Any]:
    return {
        "modelIds": MODEL_IDS,
        "modelRevisions": MODEL_REVISIONS,
        "modelContexts": MODEL_CONTEXTS,
        "horizons": HORIZONS,
        "quantiles": QUANTILES,
        "seed": SEED,
        "inferenceTaskBatchSizes": INFERENCE_TASK_BATCH_SIZES,
        "inferencePrefetchWorkers": INFERENCE_PREFETCH_WORKERS,
        "executionOptimizationVersion": EXECUTION_OPTIMIZATION_VERSION,
        "featureCacheVersion": FEATURE_CACHE_VERSION,
    }


def source_output_hashes(run_dir: Path, *, smoke: bool) -> dict[str, str]:
    roots = ("prepared", "predictions")
    values: dict[str, str] = {}
    for root in roots:
        tree = hash_tree(run_dir / root)
        if not tree:
            raise RuntimeError(f"source output tree is empty: {root}")
        values.update(
            (f"{root}/{relative}", digest)
            for relative, digest in tree.items()
        )
    names = (
        "origins.json",
        "run-manifest.json",
        "schedule.json",
        "scanner-snapshots-smoke.json" if smoke else "scanner-snapshots.jsonl",
    )
    for name in names:
        path = run_dir / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"source output is missing or unsafe: {name}")
        values[name] = sha256_file(path)
    return dict(sorted(values.items()))


def parse_hash_manifest(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict) or not value:
        return None
    parsed: dict[str, str] = {}
    for relative, digest in value.items():
        if not isinstance(relative, str) or not relative:
            return None
        relative_path = Path(relative)
        if (
            relative_path.is_absolute()
            or ".." in relative_path.parts
            or relative_path.as_posix() != relative
        ):
            return None
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            return None
        parsed[relative] = digest
    return parsed


def verified_hashes(
    expected: Mapping[str, str],
    actual: Mapping[str, str],
) -> tuple[bool, list[str]]:
    mismatches = [
        relative
        for relative in sorted(set(expected) | set(actual))
        if expected.get(relative) != actual.get(relative)
    ]
    return not mismatches, mismatches


def preserve_invalid_resume(
    run_dir: Path,
    reasons: Sequence[str],
    *,
    archive_mismatches: Sequence[str] = (),
) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
    destination = run_dir / "failures" / f"source-resume-invalid-{stamp}"
    destination.mkdir(parents=True, exist_ok=False)
    for name in (
        "SOURCE_COMPLETE",
        "source-resume-manifest.json",
        "source-input-manifest.json",
        "state.json",
        "run-manifest.json",
        "origins.json",
        "schedule.json",
        "scanner-snapshots.jsonl",
        "scanner-snapshots-smoke.json",
        "prepared",
        "predictions",
    ):
        source = run_dir / name
        if source.exists() and not source.is_symlink():
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, target)
    for relative in archive_mismatches:
        relative_path = Path(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            continue
        source = run_dir / "raw" / relative_path
        if source.is_file() and not source.is_symlink():
            target = destination / "raw" / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, target)
    atomic_json(destination / "resume-rejection.json", {
        "schemaVersion": "high-vol-stack-source-resume-rejection/v1",
        "rejectedAt": iso_ms(datetime.now(UTC)),
        "reasons": list(reasons),
        "archiveMismatches": list(archive_mismatches),
    })
    return destination


def completed_resume_is_valid(
    run_dir: Path,
    *,
    input_hash: str,
    model_hash: str,
    smoke: bool,
) -> tuple[bool, list[str], list[str]]:
    marker = run_dir / "SOURCE_COMPLETE"
    manifest_path = run_dir / "source-resume-manifest.json"
    if not marker.is_file():
        return False, ["source_complete_marker_missing"], []
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False, ["resume_manifest_missing_or_invalid"], []
    reasons: list[str] = []
    if manifest.get("schemaVersion") != RESUME_MANIFEST_VERSION:
        reasons.append("resume_schema_mismatch")
    if manifest.get("inputHash") != input_hash:
        reasons.append("input_hash_mismatch")
    if manifest.get("modelHash") != model_hash:
        reasons.append("model_hash_mismatch")
    archives = parse_hash_manifest(manifest.get("archiveHashes"))
    outputs = parse_hash_manifest(manifest.get("outputHashes"))
    if archives is None:
        reasons.append("archive_hash_manifest_invalid")
        archives = {}
    if outputs is None:
        reasons.append("output_hash_manifest_invalid")
        outputs = {}
    try:
        actual_archives = hash_tree(run_dir / "raw")
    except (OSError, RuntimeError):
        actual_archives = {}
        reasons.append("archive_hash_tree_invalid")
    if not actual_archives:
        reasons.append("archive_hash_tree_empty")
    try:
        actual_outputs = source_output_hashes(run_dir, smoke=smoke)
    except (OSError, RuntimeError):
        actual_outputs = {}
        reasons.append("output_hash_tree_invalid")
    archive_ok, archive_mismatches = verified_hashes(
        archives,
        actual_archives,
    )
    output_ok, output_mismatches = verified_hashes(outputs, actual_outputs)
    if not archive_ok:
        reasons.append("archive_hash_mismatch")
    if not output_ok:
        reasons.append("output_hash_mismatch")
    reasons.extend(f"output:{value}" for value in output_mismatches)
    return not reasons, reasons, archive_mismatches


def day_range(start: date, end_inclusive: date) -> Iterator[date]:
    current = start
    while current <= end_inclusive:
        yield current
        current += timedelta(days=1)


def utc_day_start(value: datetime) -> datetime:
    value = value.astimezone(UTC)
    return datetime(value.year, value.month, value.day, tzinfo=UTC)


def complete_archive_days(
    data_start: datetime,
    evaluation_end: datetime,
) -> list[date]:
    """Return only UTC days completed before the evaluation end instant."""
    archive_end_exclusive = utc_day_start(evaluation_end)
    last_complete_day = archive_end_exclusive.date() - timedelta(days=1)
    if last_complete_day < data_start.date():
        return []
    return list(day_range(data_start.date(), last_complete_day))


def request_bytes(
    url: str,
    timeout: int = 120,
    *,
    attempts: int = 4,
) -> bytes:
    """Read a public market-data URL with bounded transient-error retries."""

    request = Request(url, headers={"User-Agent": "toss-portfolio-lens/1"})
    for attempt in range(attempts):
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read()
        except HTTPError as error:
            transient = error.code in {408, 418, 425, 429} or error.code >= 500
            if not transient or attempt >= attempts - 1:
                raise
            retry_after = error.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after else 2**attempt
            except ValueError:
                delay = 2**attempt
            time.sleep(max(0.25, min(30.0, delay)))
        except OSError:
            if attempt >= attempts - 1:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("market-data request retry loop exited unexpectedly")


def download_archive(path: Path, url: str, *, attempts: int = 3) -> None:
    if path.is_file() and path.stat().st_size > 0:
        if zipfile.is_zipfile(path):
            return
        path.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(attempts):
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        try:
            payload = request_bytes(url)
            if not payload:
                raise ValueError("downloaded archive is empty")
            temporary.write_bytes(payload)
            checksum_text = request_bytes(f"{url}.CHECKSUM").decode("utf-8").strip()
            expected = checksum_text.split()[0].lower()
            observed = hashlib.sha256(payload).hexdigest()
            if expected != observed:
                raise ValueError(f"archive checksum mismatch: {url}")
            os.replace(temporary, path)
            return
        except HTTPError as error:
            temporary.unlink(missing_ok=True)
            if error.code not in {408, 418, 425, 429} and error.code < 500:
                raise
            if attempt >= attempts - 1:
                raise
            time.sleep(2**attempt)
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt >= attempts - 1:
                raise
            time.sleep(2**attempt)


def download_json(path: Path, url: str) -> None:
    if path.is_file() and path.stat().st_size > 0:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = request_bytes(url)
    parsed = json.loads(payload)
    atomic_json(path, parsed)


def rest_kline_rows(payload: Sequence[Sequence[Any]]) -> Iterator[dict[str, Any]]:
    for row in payload:
        if len(row) < 11:
            raise ValueError("REST kline row has too few columns")
        yield {
            "openTime": int(row[0]),
            "closeTime": int(row[6]),
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
            "quoteVolume": float(row[7]),
            "tradeCount": int(row[8]),
            "takerBuyVolume": float(row[9]),
            "takerBuyQuoteVolume": float(row[10]),
        }


def download_rest_klines(
    path: Path,
    symbol: str,
    start: datetime,
    end: datetime,
) -> None:
    """Persist an exact, finalized 1m REST tail without interpolation."""
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)
    if (
        start_ms % MINUTE_MS != 0
        or end_ms % MINUTE_MS != 0
        or end_ms <= start_ms
    ):
        raise ValueError("supplemental REST kline range must align to UTC minutes")
    if path.is_file() and path.stat().st_size > 0:
        payload = json.loads(path.read_text(encoding="utf-8"))
    else:
        payload: list[list[Any]] = []
        cursor = start_ms
        while cursor < end_ms:
            query = urlencode(
                {
                    "symbol": symbol,
                    "interval": "1m",
                    "startTime": cursor,
                    "endTime": end_ms - 1,
                    "limit": 1500,
                }
            )
            batch = json.loads(request_bytes(f"{FAPI_ROOT}/klines?{query}"))
            if not isinstance(batch, list) or not batch:
                raise RuntimeError(
                    f"Binance REST returned no finalized klines for {symbol}"
                )
            payload.extend(batch)
            next_cursor = int(batch[-1][0]) + MINUTE_MS
            if next_cursor <= cursor:
                raise RuntimeError("Binance REST kline pagination did not advance")
            cursor = next_cursor
        atomic_json(path, payload)

    rows = sorted(
        (
            row
            for row in rest_kline_rows(payload)
            if start_ms <= int(row["openTime"]) < end_ms
        ),
        key=lambda row: int(row["openTime"]),
    )
    expected_opens = list(range(start_ms, end_ms, MINUTE_MS))
    observed_opens = [int(row["openTime"]) for row in rows]
    if observed_opens != expected_opens:
        raise RuntimeError(f"{symbol} supplemental REST klines are incomplete")
    for row in rows:
        expected_close = int(row["openTime"]) + MINUTE_MS - 1
        if int(row["closeTime"]) != expected_close or expected_close >= end_ms:
            raise RuntimeError(f"{symbol} supplemental REST kline is not finalized")


def rest_kline_cache_path(
    raw_root: Path,
    symbol: str,
    start: datetime,
    end: datetime,
) -> Path:
    """Return a range-addressed cache path so resumes cannot reuse a stale tail."""

    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)
    return raw_root / "rest-klines" / symbol / f"{start_ms}-{end_ms}.json"


def recover_missing_kline_archives(
    raw_root: Path,
    jobs: Sequence[tuple[Path, str, str, str, str]],
    errors: dict[str, list[str]],
) -> dict[str, list[dict[str, str]]]:
    """Replace unavailable completed daily OHLCV archives with exact REST bars.

    Only finalized one-minute klines are recoverable here. Derivatives and
    order-book archives remain fail-closed because fabricating those fields
    would change scanner/model inputs.
    """

    missing = [
        job
        for job in jobs
        if job[2] == "klines" and not job[0].is_file()
    ]
    recovered: dict[str, list[dict[str, str]]] = {}

    def fetch(
        job: tuple[Path, str, str, str, str],
    ) -> tuple[str, str, datetime, datetime, BaseException | None]:
        _path, _url, _kind, symbol, label = job
        start = datetime.combine(
            date.fromisoformat(label),
            datetime.min.time(),
            tzinfo=UTC,
        )
        end = start + timedelta(days=1)
        try:
            download_rest_klines(
                rest_kline_cache_path(raw_root, symbol, start, end),
                symbol,
                start,
                end,
            )
        except Exception as error:
            return symbol, label, start, end, error
        return symbol, label, start, end, None

    with ThreadPoolExecutor(
        max_workers=4,
        thread_name_prefix="binance-rest-archive-fallback",
    ) as pool:
        results = list(pool.map(fetch, missing))

    for symbol, label, start, end, error in results:
        prefix = f"klines:{label}:"
        prior = [
            value
            for value in errors.get(symbol, ())
            if value.startswith(prefix)
        ]
        if error is not None:
            errors.setdefault(symbol, []).append(
                f"restKlineFallback:{label}:{type(error).__name__}"
            )
            continue
        errors[symbol] = [
            value
            for value in errors.get(symbol, ())
            if not value.startswith(prefix)
        ]
        if not errors[symbol]:
            errors.pop(symbol, None)
        recovered.setdefault(symbol, []).append(
            {
                "day": label,
                "start": iso_ms(start),
                "endExclusive": iso_ms(end),
                "source": "Binance USD-M finalized REST 1m klines",
                "replacedErrors": ",".join(prior),
            }
        )
    return recovered


def single_csv_rows(path: Path) -> Iterator[list[str]]:
    with zipfile.ZipFile(path) as archive:
        members = [
            item
            for item in archive.infolist()
            if not item.is_dir() and item.filename.endswith(".csv")
        ]
        if len(members) != 1 or "/" in members[0].filename:
            raise ValueError(f"unexpected archive layout: {path}")
        with archive.open(members[0]) as binary:
            yield from csv.reader(line.decode("utf-8") for line in binary)


def kline_rows(path: Path) -> Iterator[dict[str, Any]]:
    for row in single_csv_rows(path):
        if not row or row[0].lower() in {"open_time", "timestamp"}:
            continue
        if len(row) < 12:
            raise ValueError(f"kline row has too few columns: {path}")
        open_time = int(row[0])
        close_time = int(row[6])
        yield {
            "openTime": open_time,
            "closeTime": close_time,
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
            "quoteVolume": float(row[7]),
            "tradeCount": int(row[8]),
            "takerBuyVolume": float(row[9]),
            "takerBuyQuoteVolume": float(row[10]),
        }


def reference_closes(path: Path) -> Iterator[tuple[int, float]]:
    for row in single_csv_rows(path):
        if not row or row[0].lower() in {"open_time", "timestamp"}:
            continue
        if len(row) < 7:
            raise ValueError(f"reference kline row has too few columns: {path}")
        yield int(row[6]), float(row[4])


def metric_rows(path: Path) -> Iterator[tuple[int, dict[str, float]]]:
    rows = single_csv_rows(path)
    header = next(rows)
    names = {name: index for index, name in enumerate(header)}
    required = {
        "create_time",
        "sum_open_interest",
        "sum_open_interest_value",
        "count_long_short_ratio",
        "sum_taker_long_short_vol_ratio",
    }
    if not required.issubset(names):
        raise ValueError(f"metrics header is incomplete: {path}")
    for row in rows:
        if not row:
            continue
        observed = datetime.strptime(
            row[names["create_time"]],
            "%Y-%m-%d %H:%M:%S",
        ).replace(tzinfo=UTC)
        yield int(observed.timestamp() * 1000), {
            "openInterest": float(row[names["sum_open_interest"]]),
            "openInterestValue": float(row[names["sum_open_interest_value"]]),
            "longShortRatio": float(row[names["count_long_short_ratio"]]),
            "takerLongShortRatio": float(
                row[names["sum_taker_long_short_vol_ratio"]]
            ),
        }


def depth_rows(path: Path) -> Iterator[tuple[int, float, float]]:
    rows = single_csv_rows(path)
    header = next(rows)
    if header[:4] != ["timestamp", "percentage", "depth", "notional"]:
        raise ValueError(f"bookDepth header is unexpected: {path}")
    for row in rows:
        if not row:
            continue
        observed = datetime.strptime(
            row[0],
            "%Y-%m-%d %H:%M:%S",
        ).replace(tzinfo=UTC)
        yield int(observed.timestamp() * 1000), float(row[1]), float(row[3])


def book_ticker_rows(path: Path) -> Iterator[tuple[int, dict[str, float]]]:
    rows = single_csv_rows(path)
    header = next(rows)
    expected = [
        "update_id",
        "best_bid_price",
        "best_bid_qty",
        "best_ask_price",
        "best_ask_qty",
        "transaction_time",
        "event_time",
    ]
    if header[:7] != expected:
        raise ValueError(f"bookTicker header is unexpected: {path}")
    # The raw stream can contain millions of updates per day. The strategy
    # decides at minute boundaries, so preserve the last event in each 30-second
    # bucket without interpolating a quote that never existed.
    latest_by_bucket: dict[int, tuple[int, dict[str, float]]] = {}
    for row in rows:
        if not row:
            continue
        observed = max(int(row[5]), int(row[6]))
        bucket = observed // 30_000
        latest_by_bucket[bucket] = (
            observed,
            {
                "observedAtMs": observed,
                "bidPrice": float(row[1]),
                "bidQuantity": float(row[2]),
                "askPrice": float(row[3]),
                "askQuantity": float(row[4]),
            },
        )
    yield from (
        value
        for _bucket, value in sorted(latest_by_bucket.items())
    )


def asof_value(
    times: Sequence[int],
    values: Sequence[Any],
    target: int,
) -> Any | None:
    index = bisect_right(times, target) - 1
    return values[index] if index >= 0 else None


def percentile(values: Sequence[float], probability: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = probability * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def realized_volatility(bars: Sequence[Mapping[str, Any]]) -> float:
    window = bars[-61:]
    returns = [
        math.log(float(window[index]["close"]) / float(window[index - 1]["close"]))
        for index in range(1, len(window))
        if float(window[index - 1]["close"]) > 0
    ]
    return statistics.stdev(returns) if len(returns) >= 2 else 0.0


def normalized_atr(bars: Sequence[Mapping[str, Any]]) -> float:
    window = bars[-15:]
    if len(window) < 15:
        return 0.0
    ranges = []
    for index in range(1, len(window)):
        current = window[index]
        previous_close = float(window[index - 1]["close"])
        ranges.append(
            max(
                float(current["high"]) - float(current["low"]),
                abs(float(current["high"]) - previous_close),
                abs(float(current["low"]) - previous_close),
            )
        )
    close = float(window[-1]["close"])
    return statistics.fmean(ranges) / close if close > 0 else 0.0


def bollinger_width_expansion(bars: Sequence[Mapping[str, Any]]) -> float:
    closes = [float(value["close"]) for value in bars[-40:]]
    if len(closes) < 40:
        return 0.0

    def width(values: Sequence[float]) -> float:
        mean = statistics.fmean(values)
        return 4 * statistics.pstdev(values) / mean if mean > 0 else 0.0

    previous = width(closes[:20])
    current = width(closes[20:])
    return max(0.0, current / previous) if previous > 0 else 0.0


def rolling_range(bars: Sequence[Mapping[str, Any]]) -> float:
    window = bars[-60:]
    if len(window) < 2:
        return 0.0
    close = float(window[-1]["close"])
    return (
        (max(float(item["high"]) for item in window)
        - min(float(item["low"]) for item in window))
        / close
        if close > 0
        else 0.0
    )


def roll_spread_bps(bars: Sequence[Mapping[str, Any]], tick_size: float) -> float:
    closes = [float(value["close"]) for value in bars[-62:]]
    if len(closes) < 4:
        return math.inf
    changes = [closes[index] - closes[index - 1] for index in range(1, len(closes))]
    left = changes[:-1]
    right = changes[1:]
    mean_left = statistics.fmean(left)
    mean_right = statistics.fmean(right)
    covariance = statistics.fmean(
        (a - mean_left) * (b - mean_right)
        for a, b in zip(left, right, strict=True)
    )
    midpoint = closes[-1]
    roll = (
        2 * math.sqrt(max(0.0, -covariance)) / midpoint * 10_000
        if midpoint > 0
        else math.inf
    )
    tick = tick_size / midpoint * 10_000 if midpoint > 0 else math.inf
    return max(tick, roll)


def minmax(values: Sequence[float], value: float, inverted: bool = False) -> float:
    if not values:
        return 0.0
    minimum = min(values)
    maximum = max(values)
    scaled = 0.5 if maximum == minimum else (value - minimum) / (maximum - minimum)
    return 1 - scaled if inverted else scaled


def scan_candidates(
    observations: Sequence[Mapping[str, Any]],
    origin_ms: int,
    *,
    symbol_count: int = 1,
) -> dict[str, Any]:
    eligible: list[Mapping[str, Any]] = []
    evaluated: list[dict[str, Any]] = []
    for item in observations:
        reasons: list[str] = []
        if item["observedAtMs"] > origin_ms:
            reasons.append("FUTURE_OBSERVATION")
        if item["symbol"] in CORE_SYMBOLS:
            reasons.append("CORE_ASSET_EXCLUDED")
        if item["listingAtMs"] > origin_ms:
            reasons.append("NOT_YET_LISTED")
        if (origin_ms - item["listingAtMs"]) / DAY_MS < 90:
            reasons.append("LISTING_AGE_TOO_SHORT")
        if item["missingRate"] > 0.02:
            reasons.append("MISSING_DATA")
        if item["tradingAmountUsd"] < 25_000_000:
            reasons.append("TRADING_AMOUNT_TOO_LOW")
        if not math.isfinite(item["medianSpreadBps"]):
            reasons.append("SPREAD_UNAVAILABLE")
        elif (
            item["medianSpreadBps"] > 12
            or item["p95SpreadBps"] > 24
        ):
            reasons.append("SPREAD_TOO_WIDE")
        if item["depthUsd"] < 250_000:
            reasons.append("DEPTH_TOO_LOW")
        if origin_ms - item["observedAtMs"] > 60_000:
            reasons.append("STALE_QUOTE")
        if item["abnormalGap"]:
            reasons.append("ABNORMAL_GAP")
        if (
            item["fundingRate"] is not None
            and abs(item["fundingRate"]) > 0.001
        ):
            reasons.append("EXTREME_FUNDING")
        if (
            item["basisRate"] is not None
            and abs(item["basisRate"]) > 0.02
        ):
            reasons.append("EXTREME_BASIS")
        row = {**item, "eligible": not reasons, "exclusionReasons": reasons}
        evaluated.append(row)
        if not reasons:
            eligible.append(row)

    if eligible:
        amount_values = [math.log1p(float(item["tradingAmountUsd"])) for item in eligible]
        trade_values = [math.log1p(float(item["tradeCount"])) for item in eligible]
        score_fields = (
            ("realizedVolatility", 0.16, False),
            ("normalizedAtr", 0.14, False),
            ("rollingRange", 0.10, False),
            ("bollingerWidthExpansion", 0.10, False),
            ("relativeVolume", 0.12, False),
            ("liquidityQuality", 0.14, False),
            ("medianSpreadBps", 0.08, True),
        )
        for item in eligible:
            score = 0.10 * minmax(
                amount_values,
                math.log1p(float(item["tradingAmountUsd"])),
            )
            score += 0.06 * minmax(
                trade_values,
                math.log1p(float(item["tradeCount"])),
            )
            for field, weight, inverted in score_fields:
                values = [float(candidate[field]) for candidate in eligible]
                score += weight * minmax(values, float(item[field]), inverted)
            depth_penalty = 1 - min(1, float(item["depthUsd"]) / 250_000)
            item["score"] = score - depth_penalty * 0.08
        eligible.sort(
            key=lambda item: (
                -float(item["score"]),
                -float(item["tradingAmountUsd"]),
                str(item["symbol"]),
            )
        )
        ranks = {str(item["symbol"]): index + 1 for index, item in enumerate(eligible)}
    else:
        ranks = {}
    for item in evaluated:
        item["rank"] = ranks.get(str(item["symbol"]))
        item["score"] = (
            next(
                (
                    float(candidate["score"])
                    for candidate in eligible
                    if candidate["symbol"] == item["symbol"]
                ),
                None,
            )
            if item["eligible"]
            else None
        )
    selected = [str(item["symbol"]) for item in eligible[:symbol_count]]
    return {
        "schemaVersion": "high-vol-scanner/python-parity-v1",
        "originAt": iso_ms(origin_ms),
        "settings": {
            "symbolCount": symbol_count,
            "minimumTradingAmountUsd": 25_000_000,
            "maximumSpreadBps": 12,
            "depthRangeBps": 20,
            "rescanIntervalMinutes": SCANNER_INTERVAL_MINUTES,
            "riskAppetite": "balanced",
            "minimumListingDays": 90,
            "maximumMissingRate": 0.02,
            "minimumDepthUsd": 250_000,
        },
        "totalCandidateCount": len(evaluated),
        "eligibleCandidateCount": len(eligible),
        "selectedSymbols": selected,
        "topFive": [
            {
                "symbol": item["symbol"],
                "rank": ranks[str(item["symbol"])],
                "score": item["score"],
                "realizedVolatility": item["realizedVolatility"],
                "tradingAmountUsd": item["tradingAmountUsd"],
                "relativeVolume": item["relativeVolume"],
                "medianSpreadBps": item["medianSpreadBps"],
                "depthUsd": item["depthUsd"],
            }
            for item in eligible[:SCANNER_RECORDED_TOP_COUNT]
        ],
        "candidates": [
            {
                "symbol": item["symbol"],
                "eligible": item["eligible"],
                "rank": item["rank"],
                "score": item["score"],
                "exclusionReasons": item["exclusionReasons"],
            }
            for item in evaluated
        ],
        "observations": [
            {
                "symbol": item["symbol"],
                "observedAt": iso_ms(int(item["observedAtMs"])),
                "listingAt": iso_ms(int(item["listingAtMs"])),
                "quoteAsset": "USDT",
                "contractType": "PERPETUAL",
                "missingRate": item["missingRate"],
                "tradingAmountUsd": item["tradingAmountUsd"],
                "tradeCount": item["tradeCount"],
                "medianSpreadBps": item["medianSpreadBps"],
                "p95SpreadBps": item["p95SpreadBps"],
                "depthUsd": item["depthUsd"],
                "staleQuote": origin_ms - int(item["observedAtMs"]) > 60_000,
                "abnormalGap": item["abnormalGap"],
                "halted": False,
                "fundingRate": item["fundingRate"],
                "basisRate": item["basisRate"],
                "realizedVolatility": item["realizedVolatility"],
                "normalizedAtr": item["normalizedAtr"],
                "rollingRange": item["rollingRange"],
                "bollingerWidthExpansion": item["bollingerWidthExpansion"],
                "relativeVolume": item["relativeVolume"],
                "liquidityQuality": item["liquidityQuality"],
                "featureAvailability": {
                    "finalizedOhlcv": True,
                    "tradeCount": True,
                    "spread": math.isfinite(item["medianSpreadBps"]),
                    "spreadHistory": True,
                    "orderbookDepth": item["depthUsd"] > 0,
                    "funding": item["fundingRate"] is not None,
                    "basis": item["basisRate"] is not None,
                    "openInterest": True,
                    "longShortRatio": True,
                    "liquidationVolume": False,
                },
            }
            for item in evaluated
        ],
    }


class WorkerClient:
    def __init__(self, url: str, token_file: Path) -> None:
        token = token_file.read_text(encoding="utf-8").strip()
        if len(token.encode()) < 32 or any(character.isspace() for character in token):
            raise ValueError("AI worker token file is invalid")
        self.url = url
        self.token = token
        self.connection: ClientConnection | None = None

    def connect(self) -> ClientConnection:
        self.close()
        self.connection = connect(
            self.url,
            additional_headers={"Authorization": f"Bearer {self.token}"},
            subprotocols=["scalping-ai-ws.v1"],
            compression=None,
            max_size=256 * 1024 * 1024,
            open_timeout=30,
            close_timeout=10,
        )
        return self.connection

    def request(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        connection = self.connection or self.connect()
        request_id = str(payload["request_id"])
        envelope = {
            "transport_version": "scalping-ai-ws/v1",
            "type": "request",
            "request_id": request_id,
            "payload": payload,
        }
        try:
            connection.send(json.dumps(envelope, separators=(",", ":"), allow_nan=False))
            while True:
                response = json.loads(connection.recv(timeout=1800))
                if (
                    response.get("type") == "response"
                    and response.get("request_id") == request_id
                ):
                    return dict(response["payload"])
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        if self.connection is not None:
            try:
                self.connection.close()
            except Exception:
                pass
            self.connection = None


class Repository:
    def __init__(
        self,
        bars: Mapping[str, list[dict[str, Any]]],
        depths: Mapping[str, tuple[list[int], list[dict[str, float]]]],
        book_tickers: Mapping[
            str,
            tuple[list[int], list[dict[str, float]]],
        ],
        rules: Mapping[str, Mapping[str, Any]],
    ) -> None:
        self.bars = dict(bars)
        self.depths = dict(depths)
        self.book_tickers = dict(book_tickers)
        self.rules = dict(rules)
        self.bar_times = {
            symbol: [int(value["closeTime"]) for value in values]
            for symbol, values in self.bars.items()
        }
        self.bar_by_time = {
            symbol: {
                int(value["closeTime"]): value
                for value in values
            }
            for symbol, values in self.bars.items()
        }
        self._spread_cache: dict[tuple[str, int], tuple[float, str]] = {}
        self._core_short_returns: dict[str, dict[int, float]] = {}
        self._core_realized_volatility: dict[str, dict[int, float]] = {}
        self._warm_core_feature_cache()

    def _warm_core_feature_cache(self) -> None:
        """Materialize immutable cross-asset features once before inference."""

        for symbol in CORE_SYMBOLS:
            values = self.bars[symbol]
            by_time = self.bar_by_time[symbol]
            short_returns: dict[int, float] = {}
            volatility: dict[int, float] = {}
            for index, item in enumerate(values):
                at = int(item["closeTime"])
                previous = by_time.get(at - 5 * MINUTE_MS)
                previous_close = float(previous["close"]) if previous else 0.0
                if previous_close > 0:
                    short_returns[at] = math.log(
                        float(item["close"]) / previous_close
                    )
                if (
                    index >= 60
                    and at - int(values[index - 60]["closeTime"])
                    == 60 * MINUTE_MS
                ):
                    volatility[at] = realized_volatility(
                        values[index - 60:index + 1]
                    )
            self._core_short_returns[symbol] = short_returns
            self._core_realized_volatility[symbol] = volatility

    def slice(self, symbol: str, origin_ms: int, count: int) -> list[dict[str, Any]]:
        times = self.bar_times[symbol]
        right = bisect_right(times, origin_ms)
        values = self.bars[symbol][max(0, right - count):right]
        if len(values) != count:
            raise ValueError(f"{symbol} has {len(values)}/{count} context bars")
        if int(values[-1]["closeTime"]) != origin_ms:
            raise ValueError(f"{symbol} origin is not a finalized one-minute close")
        for index in range(1, len(values)):
            if int(values[index]["openTime"]) - int(values[index - 1]["openTime"]) != MINUTE_MS:
                raise ValueError(f"{symbol} context contains a one-minute gap")
        return values

    def value(self, symbol: str, close_time_ms: int, field: str = "close") -> float:
        bar = self.bar_by_time[symbol].get(close_time_ms)
        if bar is None:
            raise ValueError(f"{symbol} has no finalized bar at {iso_ms(close_time_ms)}")
        return float(bar[field])

    def depth(self, symbol: str, origin_ms: int) -> dict[str, float] | None:
        times, values = self.depths[symbol]
        return asof_value(times, values, origin_ms)

    def book_ticker(self, symbol: str, origin_ms: int) -> dict[str, float] | None:
        times, values = self.book_tickers.get(symbol, ([], []))
        value = asof_value(times, values, origin_ms)
        if value is None or origin_ms - int(value["observedAtMs"]) > 60_000:
            return None
        return value

    def spread_with_provenance(
        self,
        symbol: str,
        origin_ms: int,
    ) -> tuple[float, str]:
        key = (symbol, origin_ms)
        if key not in self._spread_cache:
            ticker = self.book_ticker(symbol, origin_ms)
            if ticker is not None:
                midpoint = (ticker["bidPrice"] + ticker["askPrice"]) / 2
                spread = (
                    (ticker["askPrice"] - ticker["bidPrice"]) / midpoint * 10_000
                    if midpoint > 0
                    else math.inf
                )
                self._spread_cache[key] = (
                    spread,
                    "binance_historical_bookTicker_direct_v1",
                )
            else:
                bars = self.slice(symbol, origin_ms, min(62, bisect_right(
                    self.bar_times[symbol], origin_ms
                )))
                tick_size = float(self.rules[symbol]["tickSize"])
                self._spread_cache[key] = (
                    roll_spread_bps(bars, tick_size),
                    "max_exchange_tick_roll_effective_spread_v1",
                )
        return self._spread_cache[key]

    def spread(self, symbol: str, origin_ms: int) -> float:
        return self.spread_with_provenance(symbol, origin_ms)[0]

    def feature_bars(
        self,
        symbol: str,
        origin_ms: int,
        count: int,
    ) -> list[dict[str, Any]]:
        values = self.slice(symbol, origin_ms, count)
        output: list[dict[str, Any]] = []
        for item in values:
            at = int(item["closeTime"])
            btc = self.bar_by_time["BTCUSDT"].get(at)
            eth = self.bar_by_time["ETHUSDT"].get(at)

            benchmark = self._core_short_returns["BTCUSDT"].get(at)
            previous = self.bar_by_time[symbol].get(at - 5 * MINUTE_MS)
            own = (
                math.log(float(item["close"]) / float(previous["close"]))
                if previous and float(previous["close"]) > 0
                else None
            )
            output.append(
                {
                    "timestamp": iso_ms(at),
                    "open": item["open"],
                    "high": item["high"],
                    "low": item["low"],
                    "close": item["close"],
                    "volume": item["volume"],
                    "amount": item["quoteVolume"],
                    "trade_count": item["tradeCount"],
                    "taker_buy_volume": item["takerBuyVolume"],
                    "taker_buy_amount": item["takerBuyQuoteVolume"],
                    "mark_price": item.get("markPrice"),
                    "index_price": item.get("indexPrice"),
                    "premium_index": item.get("premiumIndex"),
                    "funding_rate": item.get("fundingRate"),
                    "btc_short_return": benchmark if btc else None,
                    "btc_realized_volatility": (
                        self._core_realized_volatility["BTCUSDT"].get(at)
                        if btc
                        else None
                    ),
                    "eth_short_return": (
                        self._core_short_returns["ETHUSDT"].get(at)
                        if eth
                        else None
                    ),
                    "eth_realized_volatility": (
                        self._core_realized_volatility["ETHUSDT"].get(at)
                        if eth
                        else None
                    ),
                    "benchmark_return": benchmark,
                    "relative_strength": (
                        own - benchmark
                        if own is not None and benchmark is not None
                        else None
                    ),
                    "complete": True,
                }
            )
        return output


@dataclass(frozen=True, slots=True)
class PreparedInferenceTask:
    symbol: str
    origin_ms: int
    bars: list[dict[str, Any]]
    input_digest: str


def prepare_inference_task(
    repository: Repository,
    lane: str,
    item: Mapping[str, Any],
) -> PreparedInferenceTask:
    symbol = str(item["inferenceSymbol"])
    origin_ms = int(item["originMs"])
    bars = repository.feature_bars(
        symbol,
        origin_ms,
        MODEL_CONTEXTS[lane],
    )
    source = json.dumps(
        bars,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    return PreparedInferenceTask(
        symbol=symbol,
        origin_ms=origin_ms,
        bars=bars,
        input_digest=hashlib.sha256(source).hexdigest(),
    )


def request_payload(
    lane: str,
    tasks: Sequence[tuple[str, int, list[dict[str, Any]]]],
) -> dict[str, Any]:
    request_id = f"hv-{lane}-{tasks[0][1]}-{len(tasks)}"
    return {
        "schema_version": "scalping-ai/v1",
        "request_id": request_id,
        "mode": "forecast",
        "forecast_profile": "full",
        "horizons_minutes": list(HORIZONS),
        "quantiles": list(QUANTILES),
        "seed": SEED,
        "series": [
            {
                "instrument_key": f"BINANCE_USDM:{symbol}:{origin_ms}",
                "timezone": "UTC",
                "input_end_at": iso_ms(origin_ms),
                "future_timestamps": [
                    iso_ms(origin_ms + minute * MINUTE_MS)
                    for minute in range(1, 61)
                ],
                "bars": bars,
                "input_cadence": {
                    "candle_seconds": 60,
                    "gap_policy": "continuous",
                },
            }
            for symbol, origin_ms, bars in tasks
        ],
    }


def normalize_worker_series(
    lane: str,
    symbol: str,
    origin_ms: int,
    response: Mapping[str, Any],
    request_latency_ms: float,
    batch_size: int,
    input_digest: str,
) -> dict[str, Any]:
    if response.get("status") == "unavailable":
        raise RuntimeError(f"{lane} unavailable: {response.get('error')}")
    model = response["model"]
    if model["model_id"] != MODEL_IDS[lane]:
        raise RuntimeError(f"{lane} returned the wrong model ID")
    if model["model_revision"] != MODEL_REVISIONS[lane]:
        raise RuntimeError(f"{lane} returned an unpinned model revision")
    loader_version = str(model.get("loader_version") or "")
    if lane == "chronos2" and (
        "compact_causal_v1" not in loader_version
        or "cuda_graph" not in loader_version
    ):
        raise RuntimeError(
            "Chronos-2 worker is not using the required compact CUDA Graph backend"
        )
    key = f"BINANCE_USDM:{symbol}:{origin_ms}"
    matches = [
        value
        for value in response.get("series", ())
        if value.get("instrument_key") == key
    ]
    if len(matches) != 1 or matches[0].get("status") != "available":
        raise RuntimeError(f"{lane} returned no aligned series for {key}")
    series = matches[0]
    if (
        int(
            parse_instant(
                series["input_end_at"],
                f"{lane}.input_end_at",
            ).timestamp()
            * 1000
        )
        != origin_ms
    ):
        raise RuntimeError(f"{lane} input origin mismatch")
    returned = tuple(
        int(value["horizon_minutes"]) for value in series["horizons"]
    )
    if returned != HORIZONS:
        raise RuntimeError(f"{lane} silently truncated or reordered horizons")
    horizons = []
    for item in series["horizons"]:
        expected_target = origin_ms + int(item["horizon_minutes"]) * MINUTE_MS
        if int(parse_instant(item["target_timestamp"], "target").timestamp() * 1000) != expected_target:
            raise RuntimeError(f"{lane} target timestamp mismatch")
        fixed = {
            str(value["quantile"]): float(value["value"])
            for value in item["return_quantiles"]
        }
        native = {
            str(value["quantile"]): float(value["value"])
            for value in item.get("native_return_quantiles", ())
        }
        if len(fixed) != len(QUANTILES):
            raise RuntimeError(f"{lane} fixed quantiles are incomplete")
        if lane == "chronos2" and (
            "0.01" not in native or "0.99" not in native
        ):
            raise RuntimeError("Chronos-2 native tail quantiles are missing")
        horizons.append(
            {
                "horizonMinutes": int(item["horizon_minutes"]),
                "targetTimestamp": item["target_timestamp"],
                "fixedQuantiles": fixed,
                "nativeQuantiles": native or fixed,
                "upProbability": item.get("up_probability"),
                "downProbability": item.get("down_probability"),
                "flatProbability": item.get("flat_probability"),
            }
        )
    return {
        "schemaVersion": "high-vol-stack-model-forecast/v1",
        "lane": lane,
        "symbol": symbol,
        "originAt": iso_ms(origin_ms),
        "modelId": model["model_id"],
        "modelRevision": model["model_revision"],
        "modelLoaderVersion": loader_version,
        "device": model["device"],
        "deviceName": model.get("device_name"),
        "dtype": model["dtype"],
        "generatedAt": response["generated_at"],
        "latencyMs": request_latency_ms / batch_size,
        "requestLatencyMs": request_latency_ms,
        "inputDigest": input_digest,
        "contextBars": MODEL_CONTEXTS[lane],
        "cadenceSeconds": 60,
        "executionOptimizationVersion": EXECUTION_OPTIMIZATION_VERSION,
        "inferenceBatchSize": batch_size,
        "prefetchWorkers": INFERENCE_PREFETCH_WORKERS,
        "featureCacheVersion": FEATURE_CACHE_VERSION,
        "horizons": horizons,
    }


def prepare_archives(
    run_dir: Path,
    candidates: Sequence[str],
    data_start: datetime,
    evaluation_end: datetime,
    data_end: datetime,
    state: dict[str, Any],
) -> tuple[list[str], dict[str, Any]]:
    raw = run_dir / "raw"
    archive_days = complete_archive_days(data_start, evaluation_end)
    if not archive_days:
        raise RuntimeError("no completely finalized UTC archive days are available")
    supplemental_start = utc_day_start(evaluation_end)
    market_symbols = tuple(dict.fromkeys((*CORE_SYMBOLS, *candidates)))
    jobs: list[tuple[Path, str, str, str, str]] = []

    def add(
        kind: str,
        symbol: str,
        day: date,
        *,
        interval: str | None = None,
    ) -> None:
        label = day.isoformat()
        if interval:
            filename = f"{symbol}-{interval}-{label}.zip"
            relative = f"{kind}/{symbol}/{interval}/{filename}"
            url = (
                f"{ARCHIVE_ROOT}/{kind}/{symbol}/{interval}/"
                f"{filename}"
            )
        else:
            filename = f"{symbol}-{kind}-{label}.zip"
            relative = f"{kind}/{symbol}/{filename}"
            url = f"{ARCHIVE_ROOT}/{kind}/{symbol}/{filename}"
        jobs.append((raw / relative, url, kind, symbol, label))

    for symbol in market_symbols:
        for day in archive_days:
            add("klines", symbol, day, interval="1m")
    for symbol in candidates:
        for day in archive_days:
            add("markPriceKlines", symbol, day, interval="1m")
            add("indexPriceKlines", symbol, day, interval="1m")
            add("premiumIndexKlines", symbol, day, interval="1m")
            add("metrics", symbol, day)
            add("bookDepth", symbol, day)

    errors: dict[str, list[str]] = {}

    def fetch(job: tuple[Path, str, str, str, str]) -> None:
        path, url, kind, symbol, label = job
        try:
            download_archive(path, url)
        except HTTPError as error:
            errors.setdefault(symbol, []).append(f"{kind}:{label}:HTTP_{error.code}")
        except Exception as error:
            errors.setdefault(symbol, []).append(
                f"{kind}:{label}:{type(error).__name__}"
            )

    with ThreadPoolExecutor(max_workers=8, thread_name_prefix="binance-data") as pool:
        list(pool.map(fetch, jobs))

    rest_archive_fallbacks = recover_missing_kline_archives(raw, jobs, errors)

    if data_end > supplemental_start:
        def fetch_supplemental(symbol: str) -> None:
            try:
                download_rest_klines(
                    rest_kline_cache_path(
                        raw,
                        symbol,
                        supplemental_start,
                        data_end,
                    ),
                    symbol,
                    supplemental_start,
                    data_end,
                )
            except Exception as error:
                errors.setdefault(symbol, []).append(
                    f"restKlines:{iso_ms(supplemental_start)}:"
                    f"{type(error).__name__}"
                )

        with ThreadPoolExecutor(
            max_workers=4,
            thread_name_prefix="binance-rest-tail",
        ) as pool:
            list(pool.map(fetch_supplemental, market_symbols))
    optional_errors: dict[str, list[str]] = {}
    book_ticker_coverage: dict[str, list[str]] = {}

    def book_ticker_job(symbol: str, day: date) -> tuple[Path, str, str]:
        label = day.isoformat()
        filename = f"{symbol}-bookTicker-{label}.zip"
        path = raw / "bookTicker" / symbol / filename
        url = f"{ARCHIVE_ROOT}/bookTicker/{symbol}/{filename}"
        return path, url, label

    def fetch_optional_book_ticker(symbol: str, day: date) -> bool:
        path, url, label = book_ticker_job(symbol, day)
        try:
            download_archive(path, url, attempts=1)
            book_ticker_coverage.setdefault(symbol, []).append(label)
            return True
        except HTTPError as error:
            optional_errors.setdefault(symbol, []).append(
                f"bookTicker:{label}:HTTP_{error.code}"
            )
        except Exception as error:
            optional_errors.setdefault(symbol, []).append(
                f"bookTicker:{label}:{type(error).__name__}"
            )
        return False

    # Binance has not published USD-M bookTicker consistently in recent years.
    # Probe both ends of the requested range. Download the complete range only
    # when at least one endpoint proves that the archive exists.
    for symbol in candidates:
        probe_days = tuple(dict.fromkeys((archive_days[0], archive_days[-1])))
        probe_results = [
            fetch_optional_book_ticker(symbol, day)
            for day in probe_days
        ]
        probe_available = any(probe_results)
        if not probe_available:
            continue
        remaining = [
            day
            for day in archive_days
            if day not in probe_days
        ]
        with ThreadPoolExecutor(
            max_workers=4,
            thread_name_prefix=f"book-ticker-{symbol.lower()}",
        ) as pool:
            list(pool.map(
                lambda day: fetch_optional_book_ticker(symbol, day),
                remaining,
            ))
    usable = [
        symbol
        for symbol in candidates
        if not any(
            value.startswith("klines:")
            or value.startswith("restKlines:")
            or value.startswith("bookDepth:")
            or value.startswith("markPriceKlines:")
            or value.startswith("indexPriceKlines:")
            or value.startswith("premiumIndexKlines:")
            for value in errors.get(symbol, ())
        )
    ]
    state["data"]["archiveJobs"] = len(jobs)
    state["data"]["archiveStart"] = archive_days[0].isoformat()
    state["data"]["archiveEndInclusive"] = archive_days[-1].isoformat()
    state["data"]["supplementalTruthRange"] = {
        "source": "Binance USD-M finalized REST 1m klines",
        "start": iso_ms(supplemental_start),
        "endExclusive": iso_ms(data_end),
    }
    state["data"]["usableCandidates"] = usable
    state["data"]["errors"] = errors
    state["data"]["restArchiveFallbacks"] = rest_archive_fallbacks
    state["data"]["optionalErrors"] = optional_errors
    state["data"]["bookTickerCoverage"] = {
        symbol: sorted(set(book_ticker_coverage.get(symbol, ())))
        for symbol in candidates
    }
    state["heartbeatAt"] = iso_ms(datetime.now(UTC))
    atomic_json(run_dir / "state.json", state)
    for core in CORE_SYMBOLS:
        if errors.get(core):
            detail = ", ".join(errors[core][:5])
            raise RuntimeError(
                f"core cross-asset data is incomplete: {core} ({detail})"
            )
    if len(usable) < 2:
        raise RuntimeError("fewer than two high-volatility candidates have complete data")

    exchange_path = raw / "exchange-info.json"
    download_json(exchange_path, f"{FAPI_ROOT}/exchangeInfo")
    start_ms = int(data_start.timestamp() * 1000)
    end_ms = int(data_end.timestamp() * 1000)
    for symbol in usable:
        funding_path = raw / "funding" / f"{symbol}.json"
        query = urlencode(
            {
                "symbol": symbol,
                "startTime": start_ms,
                "endTime": end_ms,
                "limit": 1000,
            }
        )
        download_json(funding_path, f"{FAPI_ROOT}/fundingRate?{query}")
    return usable, json.loads(exchange_path.read_text(encoding="utf-8"))


def load_repository(
    run_dir: Path,
    candidates: Sequence[str],
    data_start: datetime,
    evaluation_end: datetime,
    data_end: datetime,
    exchange: Mapping[str, Any],
) -> Repository:
    raw = run_dir / "raw"
    archive_days = complete_archive_days(data_start, evaluation_end)
    market_symbols = tuple(dict.fromkeys((*CORE_SYMBOLS, *candidates)))
    rules: dict[str, dict[str, Any]] = {}
    for item in exchange.get("symbols", ()):
        symbol = str(item.get("symbol", "")).upper()
        if symbol not in market_symbols:
            continue
        tick = next(
            (
                value.get("tickSize")
                for value in item.get("filters", ())
                if value.get("filterType") == "PRICE_FILTER"
            ),
            None,
        )
        rules[symbol] = {
            "listingAtMs": int(item.get("onboardDate", 0)),
            "tickSize": float(tick),
            "status": item.get("status"),
            "contractType": item.get("contractType"),
            "quoteAsset": item.get("quoteAsset"),
        }
    missing_rules = [symbol for symbol in market_symbols if symbol not in rules]
    if missing_rules:
        raise RuntimeError(f"exchange rules missing: {missing_rules}")

    bars: dict[str, list[dict[str, Any]]] = {}
    for symbol in market_symbols:
        values: list[dict[str, Any]] = []
        for day in archive_days:
            label = day.isoformat()
            path = (
                raw
                / "klines"
                / symbol
                / "1m"
                / f"{symbol}-1m-{label}.zip"
            )
            values.extend(kline_rows(path))
        rest_paths = sorted((raw / "rest-klines" / symbol).glob("*.json"))
        legacy_rest_path = raw / "rest-klines" / f"{symbol}.json"
        if legacy_rest_path.is_file():
            rest_paths.append(legacy_rest_path)
        for supplemental_path in rest_paths:
            values.extend(
                rest_kline_rows(
                    json.loads(supplemental_path.read_text(encoding="utf-8"))
                )
            )
        bars[symbol] = sorted(
            {
                int(item["closeTime"]): item
                for item in values
                if int(item["closeTime"]) < int(data_end.timestamp() * 1000)
            }.values(),
            key=lambda item: int(item["closeTime"]),
        )

    for symbol in candidates:
        references: dict[str, tuple[list[int], list[float]]] = {}
        for kind, field in (
            ("markPriceKlines", "markPrice"),
            ("indexPriceKlines", "indexPrice"),
            ("premiumIndexKlines", "premiumIndex"),
        ):
            pairs: list[tuple[int, float]] = []
            for day in archive_days:
                label = day.isoformat()
                path = (
                    raw
                    / kind
                    / symbol
                    / "1m"
                    / f"{symbol}-1m-{label}.zip"
                )
                pairs.extend(reference_closes(path))
            pairs.sort()
            references[field] = (
                [item[0] for item in pairs],
                [item[1] for item in pairs],
            )
        metric_pairs: list[tuple[int, dict[str, float]]] = []
        for day in archive_days:
            label = day.isoformat()
            metric_pairs.extend(
                metric_rows(
                    raw
                    / "metrics"
                    / symbol
                    / f"{symbol}-metrics-{label}.zip"
                )
            )
        metric_pairs.sort(key=lambda item: item[0])
        metric_times = [item[0] for item in metric_pairs]
        metric_values = [item[1] for item in metric_pairs]
        funding = json.loads(
            (raw / "funding" / f"{symbol}.json").read_text(encoding="utf-8")
        )
        funding_pairs = sorted(
            (
                int(item["fundingTime"]),
                float(item["fundingRate"]),
            )
            for item in funding
        )
        funding_times = [item[0] for item in funding_pairs]
        funding_values = [item[1] for item in funding_pairs]
        for bar in bars[symbol]:
            at = int(bar["closeTime"])
            for field, (times, values) in references.items():
                bar[field] = asof_value(times, values, at)
            metrics = asof_value(metric_times, metric_values, at)
            if metrics:
                bar.update(metrics)
            bar["fundingRate"] = asof_value(funding_times, funding_values, at)

    depths: dict[str, tuple[list[int], list[dict[str, float]]]] = {}
    for symbol in candidates:
        grouped: dict[int, dict[float, float]] = {}
        for day in archive_days:
            label = day.isoformat()
            for observed, percentage, notional in depth_rows(
                raw
                / "bookDepth"
                / symbol
                / f"{symbol}-bookDepth-{label}.zip"
            ):
                grouped.setdefault(observed, {})[percentage] = notional
        depth_values: list[tuple[int, dict[str, float]]] = []
        for observed, buckets in sorted(grouped.items()):
            bid = float(buckets.get(-0.2, 0))
            ask = float(buckets.get(0.2, 0))
            total = bid + ask
            depth_values.append(
                (
                    observed,
                    {
                        "observedAtMs": observed,
                        "bidNotional": bid,
                        "askNotional": ask,
                        "depthUsd": total,
                        "imbalance": (bid - ask) / total if total > 0 else 0,
                        "rangeBps": 20,
                    },
                )
            )
        depths[symbol] = (
            [item[0] for item in depth_values],
            [item[1] for item in depth_values],
        )

    book_tickers: dict[
        str,
        tuple[list[int], list[dict[str, float]]],
    ] = {}
    for symbol in candidates:
        pairs: list[tuple[int, dict[str, float]]] = []
        for day in archive_days:
            label = day.isoformat()
            path = (
                raw
                / "bookTicker"
                / symbol
                / f"{symbol}-bookTicker-{label}.zip"
            )
            if path.is_file():
                pairs.extend(book_ticker_rows(path))
        pairs.sort(key=lambda item: item[0])
        book_tickers[symbol] = (
            [item[0] for item in pairs],
            [item[1] for item in pairs],
        )

    prepared = run_dir / "prepared" / "bars"
    prepared.mkdir(parents=True, exist_ok=True)
    for symbol, values in bars.items():
        path = prepared / f"{symbol}.json.gz"
        with gzip.open(path, "wt", encoding="utf-8") as handle:
            json.dump(values, handle, separators=(",", ":"), allow_nan=False)
    atomic_json(run_dir / "prepared" / "rules.json", rules)
    return Repository(bars, depths, book_tickers, rules)


def candidate_observation(
    repository: Repository,
    symbol: str,
    origin_ms: int,
) -> dict[str, Any]:
    right = bisect_right(repository.bar_times[symbol], origin_ms)
    window = repository.bars[symbol][max(0, right - 24 * 60):right]
    if not window:
        raise ValueError(f"{symbol} scanner window is empty")
    continuous = sum(
        int(window[index]["openTime"]) - int(window[index - 1]["openTime"])
        == MINUTE_MS
        for index in range(1, len(window))
    )
    missing_rate = (
        1 - continuous / max(1, len(window) - 1)
        if len(window) > 1
        else 1
    )
    depth = repository.depth(symbol, origin_ms)
    if depth is None:
        depth = {
            "observedAtMs": 0,
            "bidNotional": 0,
            "askNotional": 0,
            "depthUsd": 0,
            "imbalance": 0,
            "rangeBps": 20,
        }
    spread_samples = []
    for offset in range(0, min(60, len(window)), 5):
        sample_origin = int(window[-1 - offset]["closeTime"])
        spread_samples.append(repository.spread(symbol, sample_origin))
    finite_spreads = [value for value in spread_samples if math.isfinite(value)]
    quote_volumes = [float(item["quoteVolume"]) for item in window[-61:]]
    current_amount = quote_volumes[-1]
    baseline = statistics.fmean(quote_volumes[:-1]) if len(quote_volumes) > 1 else 0
    relative_volume = current_amount / baseline if baseline > 0 else 0
    mark = window[-1].get("markPrice")
    index = window[-1].get("indexPrice")
    basis = (
        float(mark) / float(index) - 1
        if mark is not None and index is not None and float(index) > 0
        else None
    )
    amount = sum(float(item["quoteVolume"]) for item in window)
    median_spread = (
        statistics.median(finite_spreads) if finite_spreads else math.inf
    )
    liquidity = max(
        0,
        min(
            1,
            0.45 * min(1, math.log1p(amount) / math.log1p(500_000_000))
            + 0.25 * (1 - min(1, median_spread / 12))
            + 0.30 * min(1, float(depth["depthUsd"]) / 1_000_000),
        ),
    )
    return {
        "symbol": symbol,
        "observedAtMs": int(depth["observedAtMs"]),
        "listingAtMs": int(repository.rules[symbol]["listingAtMs"]),
        "missingRate": missing_rate,
        "tradingAmountUsd": amount,
        "tradeCount": sum(int(item["tradeCount"]) for item in window),
        "medianSpreadBps": median_spread,
        "p95SpreadBps": percentile(finite_spreads, 0.95),
        "depthUsd": float(depth["depthUsd"]),
        "depthRangeBps": float(depth["rangeBps"]),
        "orderbookImbalance": float(depth["imbalance"]),
        "abnormalGap": missing_rate > 0.02
        or any(
            abs(float(item["open"]) / float(window[index - 1]["close"]) - 1) > 0.08
            for index, item in enumerate(window[1:], start=1)
        ),
        "fundingRate": window[-1].get("fundingRate"),
        "basisRate": basis,
        "realizedVolatility": realized_volatility(window),
        "normalizedAtr": normalized_atr(window),
        "rollingRange": rolling_range(window),
        "bollingerWidthExpansion": bollinger_width_expansion(window),
        "relativeVolume": relative_volume,
        "liquidityQuality": liquidity,
    }


def origin_values(start: datetime, end: datetime, minutes: int) -> list[int]:
    current = int(start.timestamp() * 1000) + minutes * MINUTE_MS - 1
    end_ms = int(end.timestamp() * 1000)
    output = []
    while current < end_ms:
        output.append(current)
        current += minutes * MINUTE_MS
    return output


def build_schedule(
    run_dir: Path,
    repository: Repository,
    candidates: Sequence[str],
    calibration_start: datetime,
    evaluation_end: datetime,
    *,
    smoke: bool,
) -> list[dict[str, Any]]:
    scanner_origins = origin_values(
        calibration_start,
        evaluation_end,
        SCANNER_INTERVAL_MINUTES,
    )
    if smoke:
        scanner_origins = scanner_origins[-20:]
    snapshots: list[dict[str, Any]] = []
    for origin_ms in scanner_origins:
        observations = [
            candidate_observation(repository, symbol, origin_ms)
            for symbol in candidates
        ]
        snapshots.append(scan_candidates(observations, origin_ms))
    if not smoke:
        atomic_jsonl(run_dir / "scanner-snapshots.jsonl", snapshots)
    else:
        atomic_json(run_dir / "scanner-snapshots-smoke.json", snapshots)
    snapshot_times = [
        int(parse_instant(item["originAt"], "scanner.originAt").timestamp() * 1000)
        for item in snapshots
    ]
    origins = origin_values(
        calibration_start,
        evaluation_end,
        ORIGIN_INTERVAL_MINUTES,
    )
    if smoke:
        origins = origins[-40:]
    schedule: list[dict[str, Any]] = []
    for origin_ms in origins:
        index = bisect_right(snapshot_times, origin_ms) - 1
        snapshot = snapshots[index] if index >= 0 else None
        selected = (
            snapshot["selectedSymbols"][0]
            if snapshot and snapshot["selectedSymbols"]
            else None
        )
        selector_candidates = (
            [
                str(item["symbol"])
                for item in snapshot["topFive"][
                    :MODEL_SELECTOR_CANDIDATE_COUNT
                ]
            ]
            if snapshot
            else []
        )
        schedule.append(
            {
                "originAt": iso_ms(origin_ms),
                "originMs": origin_ms,
                "selectedSymbol": selected,
                "candidateSymbols": selector_candidates,
                "scannerOriginAt": snapshot["originAt"] if snapshot else None,
                "scannerTopFive": snapshot["topFive"] if snapshot else [],
                "scannerEligibleCount": (
                    snapshot["eligibleCandidateCount"] if snapshot else 0
                ),
            }
        )
    atomic_json(run_dir / "schedule.json", schedule)
    return schedule


def infer_lane(
    run_dir: Path,
    lane: str,
    repository: Repository,
    schedule: Sequence[Mapping[str, Any]],
    client: WorkerClient,
    state: dict[str, Any],
) -> list[dict[str, Any]]:
    output_path = run_dir / "predictions" / f"{lane}.jsonl"
    loaded = read_jsonl(output_path)
    by_key = {
        f"{item['symbol']}|{item['originAt']}": item
        for item in loaded
    }
    tasks = [
        {
            **item,
            "inferenceSymbol": symbol,
        }
        for item in schedule
        for symbol in (
            item.get("candidateSymbols")
            or ([item["selectedSymbol"]] if item.get("selectedSymbol") else [])
        )
        if f"{symbol}|{item['originAt']}" not in by_key
    ]
    batch_size = INFERENCE_TASK_BATCH_SIZES[lane]
    state["models"][lane]["completed"] = len(by_key)
    state["models"][lane]["total"] = len(by_key) + len(tasks)
    state["models"][lane]["inferenceBatchSize"] = batch_size
    state["models"][lane]["prefetchWorkers"] = INFERENCE_PREFETCH_WORKERS
    state["models"][lane][
        "executionOptimizationVersion"
    ] = EXECUTION_OPTIMIZATION_VERSION
    state["models"][lane]["featureCacheVersion"] = FEATURE_CACHE_VERSION
    state["heartbeatAt"] = iso_ms(datetime.now(UTC))
    atomic_json(run_dir / "state.json", state)
    pending_batches = [
        tasks[offset:offset + batch_size]
        for offset in range(0, len(tasks), batch_size)
    ]
    with ThreadPoolExecutor(
        max_workers=INFERENCE_PREFETCH_WORKERS,
        thread_name_prefix=f"{lane}-input-prefetch",
    ) as executor:
        prepared_futures: list[Future[PreparedInferenceTask]] = []
        if pending_batches:
            prepared_futures = [
                executor.submit(prepare_inference_task, repository, lane, item)
                for item in pending_batches[0]
            ]
        for batch_index, batch in enumerate(pending_batches):
            prepared_tasks = [future.result() for future in prepared_futures]
            if batch_index + 1 < len(pending_batches):
                prepared_futures = [
                    executor.submit(
                        prepare_inference_task,
                        repository,
                        lane,
                        item,
                    )
                    for item in pending_batches[batch_index + 1]
                ]
            else:
                prepared_futures = []

            prepared = [
                (item.symbol, item.origin_ms, item.bars)
                for item in prepared_tasks
            ]
            payload = request_payload(lane, prepared)
            response = None
            last_error: BaseException | None = None
            started = time.monotonic()
            for retry in range(3):
                try:
                    response = client.request(payload)
                    break
                except Exception as error:
                    last_error = error
                    state["models"][lane]["retries"] += 1
                    time.sleep(min(5, 2**retry))
            if response is None:
                raise RuntimeError(f"{lane} request failed: {last_error}")
            latency_ms = (time.monotonic() - started) * 1000
            produced = [
                normalize_worker_series(
                    lane,
                    item.symbol,
                    item.origin_ms,
                    response,
                    latency_ms,
                    len(prepared_tasks),
                    item.input_digest,
                )
                for item in prepared_tasks
            ]
            append_jsonl(output_path, produced)
            for item in produced:
                by_key[f"{item['symbol']}|{item['originAt']}"] = item
            offset = batch_index * batch_size
            state["models"][lane]["completed"] = len(by_key)
            state["models"][lane]["total"] = (
                len(by_key) + len(tasks) - offset - len(batch)
            )
            state["models"][lane]["currentOriginAt"] = produced[-1]["originAt"]
            state["heartbeatAt"] = iso_ms(datetime.now(UTC))
            atomic_json(run_dir / "state.json", state)
    state["models"][lane]["status"] = "completed"
    state["models"][lane]["currentOriginAt"] = None
    atomic_json(run_dir / "state.json", state)
    return sorted(
        by_key.values(),
        key=lambda item: (item["originAt"], item["symbol"]),
    )


def materialize_origins(
    run_dir: Path,
    repository: Repository,
    schedule: Sequence[Mapping[str, Any]],
    candidates: Sequence[str],
    predictions: Mapping[str, Sequence[Mapping[str, Any]]],
    evaluation_start: datetime,
) -> None:
    by_lane = {
        lane: {
            f"{item['symbol']}|{item['originAt']}": item
            for item in values
        }
        for lane, values in predictions.items()
    }
    values = []
    for scheduled in schedule:
        origin_ms = int(scheduled["originMs"])
        origin_at = str(scheduled["originAt"])
        symbol = scheduled.get("selectedSymbol")
        fill_at_ms = origin_ms + 1
        prices = {}
        for candidate in candidates:
            next_bar = repository.bar_by_time[candidate].get(
                origin_ms + MINUTE_MS
            )
            if next_bar:
                prices[candidate] = float(next_bar["open"])
        row: dict[str, Any] = {
            **scheduled,
            "phase": (
                "evaluation"
                if origin_ms >= int(evaluation_start.timestamp() * 1000)
                else "calibration"
            ),
            "fillAt": iso_ms(fill_at_ms),
            "pricesAtFill": prices,
            "models": {},
            "candidates": [],
        }

        def materialize_candidate(candidate_symbol: str) -> dict[str, Any]:
            key = f"{candidate_symbol}|{origin_at}"
            origin_close = repository.value(candidate_symbol, origin_ms)
            context = repository.slice(candidate_symbol, origin_ms, 24 * 60)
            depth = repository.depth(candidate_symbol, origin_ms)
            book_ticker = repository.book_ticker(candidate_symbol, origin_ms)
            spread, spread_method = repository.spread_with_provenance(
                candidate_symbol,
                origin_ms,
            )
            latest = context[-1]
            scanner_record = next(
                (
                    item
                    for item in scheduled.get("scannerTopFive", ())
                    if item.get("symbol") == candidate_symbol
                ),
                {},
            )
            microstructure = {
                "depth": depth,
                "bookTicker": book_ticker,
                "spreadBps": spread,
                "spreadMethod": spread_method,
                "directHistoricalBookTicker": book_ticker is not None,
                "depthMethod": "binance_bookDepth_plus_minus_20bps_30s",
                "buyVolume": latest.get("takerBuyVolume"),
                "sellVolume": (
                    float(latest["volume"])
                    - float(latest.get("takerBuyVolume") or 0)
                ),
                "fundingRate": latest.get("fundingRate"),
                "basisRate": (
                    float(latest["markPrice"]) / float(latest["indexPrice"]) - 1
                    if latest.get("markPrice") is not None
                    and latest.get("indexPrice") is not None
                    and float(latest["indexPrice"]) > 0
                    else None
                ),
                "openInterest": latest.get("openInterest"),
                "longShortRatio": latest.get("longShortRatio"),
                "realizedVolatility": realized_volatility(context),
                "referenceSpreadBps": statistics.median(
                    [
                        repository.spread(
                            candidate_symbol,
                            int(item["closeTime"]),
                        )
                        for item in context[-60::5]
                    ]
                ),
                "referenceDepth": (
                    float(depth["depthUsd"]) if depth else None
                ),
                "priceGapRate": abs(
                    float(latest["open"]) / float(context[-2]["close"]) - 1
                ),
            }
            return {
                "symbol": candidate_symbol,
                "scannerRank": scanner_record.get("rank"),
                "scannerScore": scanner_record.get("score"),
                "models": {
                    lane: by_lane[lane].get(key)
                    for lane in ("chronos2", "fincast")
                },
                "originClose": origin_close,
                "actualTargetReturns": {
                    str(horizon): (
                        repository.value(
                            candidate_symbol,
                            origin_ms + horizon * MINUTE_MS,
                        )
                        / origin_close
                        - 1
                    )
                    for horizon in HORIZONS
                },
                "microstructure": microstructure,
            }

        candidate_symbols = list(
            scheduled.get("candidateSymbols")
            or ([symbol] if symbol else [])
        )
        row["candidates"] = [
            materialize_candidate(candidate_symbol)
            for candidate_symbol in candidate_symbols
        ]
        if symbol:
            selected_candidate = next(
                (
                    item
                    for item in row["candidates"]
                    if item["symbol"] == symbol
                ),
                None,
            )
            if selected_candidate:
                row["models"] = selected_candidate["models"]
                row["originClose"] = selected_candidate["originClose"]
                row["actualTargetReturns"] = selected_candidate[
                    "actualTargetReturns"
                ]
                row["microstructure"] = selected_candidate["microstructure"]
        values.append(row)
    atomic_json(run_dir / "origins.json", values)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--from", dest="evaluation_start", default=DEFAULT_EVALUATION_START)
    parser.add_argument("--to", dest="evaluation_end", default=DEFAULT_EVALUATION_END)
    parser.add_argument("--chronos2-url", required=True)
    parser.add_argument("--chronos2-token-file", type=Path, required=True)
    parser.add_argument("--fincast-url", required=True)
    parser.add_argument("--fincast-token-file", type=Path, required=True)
    parser.add_argument("--symbols", default=",".join(DEFAULT_CANDIDATES))
    parser.add_argument(
        "--calibration-days",
        type=int,
        default=CALIBRATION_DAYS,
    )
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    run_dir = arguments.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    evaluation_start = parse_instant(arguments.evaluation_start, "--from")
    evaluation_end = parse_instant(arguments.evaluation_end, "--to")
    if evaluation_end <= evaluation_start:
        raise ValueError("--to must be after --from")
    if arguments.calibration_days < 7 or arguments.calibration_days > 56:
        raise ValueError("--calibration-days must be between 7 and 56")
    candidates = tuple(
        dict.fromkeys(
            value.strip().upper()
            for value in arguments.symbols.split(",")
            if value.strip()
        )
    )
    if arguments.smoke:
        candidates = candidates[:3]
    calibration_start = evaluation_start - timedelta(
        days=arguments.calibration_days
    )
    data_start = calibration_start - timedelta(days=CONTEXT_WARMUP_DAYS)
    data_end = evaluation_end + timedelta(minutes=60)
    input_contract = source_input_contract(
        evaluation_start=evaluation_start,
        evaluation_end=evaluation_end,
        calibration_days=arguments.calibration_days,
        candidates=candidates,
        smoke=arguments.smoke,
    )
    input_hash = sha256_json(input_contract)
    model_contract = source_model_contract()
    model_hash = sha256_json(model_contract)
    marker = run_dir / "SOURCE_COMPLETE"
    input_manifest_path = run_dir / "source-input-manifest.json"
    if marker.is_file() and arguments.resume:
        valid, reasons, archive_mismatches = completed_resume_is_valid(
            run_dir,
            input_hash=input_hash,
            model_hash=model_hash,
            smoke=arguments.smoke,
        )
        if valid:
            manifest = json.loads(
                (run_dir / "run-manifest.json").read_text(encoding="utf-8")
            )
            schedule = json.loads(
                (run_dir / "schedule.json").read_text(encoding="utf-8")
            )
            print(json.dumps({
                "status": "source_complete",
                "runDir": str(run_dir),
                "scheduleCount": len(schedule),
                "usableCandidates": manifest["candidateUniverse"],
                "resumed": True,
            }, separators=(",", ":")))
            return 0
        preserve_invalid_resume(
            run_dir,
            reasons,
            archive_mismatches=archive_mismatches,
        )
    elif marker.is_file():
        preserve_invalid_resume(run_dir, ["resume_not_requested"])
    elif arguments.resume:
        try:
            previous_input = json.loads(
                input_manifest_path.read_text(encoding="utf-8")
            )
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            previous_input = None
        has_partial_outputs = any(
            (run_dir / name).exists()
            for name in ("prepared", "predictions", "schedule.json", "origins.json")
        )
        partial_valid = (
            isinstance(previous_input, dict)
            and previous_input.get("inputHash") == input_hash
            and previous_input.get("modelHash") == model_hash
        )
        if has_partial_outputs and not partial_valid:
            preserve_invalid_resume(
                run_dir,
                ["partial_resume_input_or_model_hash_mismatch"],
            )
    atomic_json(input_manifest_path, {
        "schemaVersion": SOURCE_INPUT_MANIFEST_VERSION,
        "generatedAt": iso_ms(datetime.now(UTC)),
        "input": input_contract,
        "inputHash": input_hash,
        "model": model_contract,
        "modelHash": model_hash,
    })
    state: dict[str, Any] = {
        "schemaVersion": STATE_VERSION,
        "status": "running",
        "phase": "prepare",
        "pid": os.getpid(),
        "startedAt": iso_ms(datetime.now(UTC)),
        "heartbeatAt": iso_ms(datetime.now(UTC)),
        "evaluation": {
            "start": iso_ms(evaluation_start),
            "endExclusive": iso_ms(evaluation_end),
            "calibrationStart": iso_ms(calibration_start),
            "dataStart": iso_ms(data_start),
            "dataEnd": iso_ms(data_end),
        },
        "data": {
            "source": "Binance USD-M public archives",
            "requestedCandidates": list(candidates),
        },
        "models": {
            lane: {
                "status": "queued",
                "completed": 0,
                "total": 0,
                "retries": 0,
                "contextBars": MODEL_CONTEXTS[lane],
                "cadenceSeconds": 60,
                "inferenceBatchSize": INFERENCE_TASK_BATCH_SIZES[lane],
                "prefetchWorkers": INFERENCE_PREFETCH_WORKERS,
                "executionOptimizationVersion": (
                    EXECUTION_OPTIMIZATION_VERSION
                ),
                "featureCacheVersion": FEATURE_CACHE_VERSION,
            }
            for lane in ("chronos2", "fincast")
        },
        "smoke": arguments.smoke,
    }
    atomic_json(run_dir / "state.json", state)
    usable, exchange = prepare_archives(
        run_dir,
        candidates,
        data_start,
        evaluation_end,
        data_end,
        state,
    )
    state["phase"] = "load-data"
    atomic_json(run_dir / "state.json", state)
    repository = load_repository(
        run_dir,
        usable,
        data_start,
        evaluation_end,
        data_end,
        exchange,
    )
    state["phase"] = "scan"
    atomic_json(run_dir / "state.json", state)
    schedule = build_schedule(
        run_dir,
        repository,
        usable,
        calibration_start,
        evaluation_end,
        smoke=arguments.smoke,
    )
    if not any(item.get("selectedSymbol") for item in schedule):
        raise RuntimeError("point-in-time scanner selected no eligible symbol")

    clients = {
        "chronos2": WorkerClient(
            arguments.chronos2_url,
            arguments.chronos2_token_file,
        ),
        "fincast": WorkerClient(
            arguments.fincast_url,
            arguments.fincast_token_file,
        ),
    }
    predictions: dict[str, list[dict[str, Any]]] = {}
    try:
        for lane in ("chronos2", "fincast"):
            state["phase"] = f"infer-{lane}"
            state["models"][lane]["status"] = "running"
            atomic_json(run_dir / "state.json", state)
            predictions[lane] = infer_lane(
                run_dir,
                lane,
                repository,
                schedule,
                clients[lane],
                state,
            )
    finally:
        for client in clients.values():
            client.close()
    state["phase"] = "materialize"
    atomic_json(run_dir / "state.json", state)
    materialize_origins(
        run_dir,
        repository,
        schedule,
        usable,
        predictions,
        evaluation_start,
    )
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso_ms(datetime.now(UTC)),
        "evaluationStart": iso_ms(evaluation_start),
        "evaluationEndExclusive": iso_ms(evaluation_end),
        "calibrationStart": iso_ms(calibration_start),
        "dataStart": iso_ms(data_start),
        "dataEnd": iso_ms(data_end),
        "originIntervalMinutes": ORIGIN_INTERVAL_MINUTES,
        "scannerIntervalMinutes": SCANNER_INTERVAL_MINUTES,
        "calibrationDays": arguments.calibration_days,
        "candidateUniverse": list(usable),
        "candidateUniversePolicy": "predeclared_liquid_usdt_perpetual_research_universe_v1",
        "scannerRecordedTopCount": SCANNER_RECORDED_TOP_COUNT,
        "modelSelectorCandidateCount": MODEL_SELECTOR_CANDIDATE_COUNT,
        "executionSymbolCount": 1,
        "models": {
            lane: {
                "modelId": MODEL_IDS[lane],
                "modelRevision": MODEL_REVISIONS[lane],
                "contextBars": MODEL_CONTEXTS[lane],
                "cadenceSeconds": 60,
                "lookbackMinutes": MODEL_CONTEXTS[lane],
                "inferenceBatchSize": INFERENCE_TASK_BATCH_SIZES[lane],
                "prefetchWorkers": INFERENCE_PREFETCH_WORKERS,
            }
            for lane in ("chronos2", "fincast")
        },
        "executionOptimization": {
            "version": EXECUTION_OPTIMIZATION_VERSION,
            "prefetchWorkers": INFERENCE_PREFETCH_WORKERS,
            "taskBatchSizes": INFERENCE_TASK_BATCH_SIZES,
            "featureCacheVersion": FEATURE_CACHE_VERSION,
            "cudaGraph": {
                "chronos2": True,
                "fincast": False,
            },
        },
        "featureProfile": "compact_causal_v1",
        "crossLearning": False,
        "seed": SEED,
        "microstructure": {
            "depthSource": "Binance USD-M daily bookDepth ±20bps at 30s",
            "spreadSource": (
                "direct Binance historical bookTicker when present; "
                "otherwise causal Roll effective-spread estimator bounded by exchange tick"
            ),
            "spreadIsDirectBookTicker": any(
                state["data"]["bookTickerCoverage"].values()
            ),
            "bookTickerCoverage": state["data"]["bookTickerCoverage"],
            "tradeStrengthSource": "finalized 1m taker buy volume",
            "fundingSource": "Binance USD-M fundingRate REST history",
        },
        "credentialHandling": "worker-local token files; credentials excluded from artifacts",
        "sourceHashes": {
            "rules": sha256_file(run_dir / "prepared" / "rules.json"),
            "origins": sha256_file(run_dir / "origins.json"),
        },
        "smoke": arguments.smoke,
    }
    atomic_json(run_dir / "run-manifest.json", manifest)
    archive_hashes = hash_tree(run_dir / "raw")
    if not archive_hashes:
        raise RuntimeError("source archive tree is empty")
    resume_manifest = {
        "schemaVersion": RESUME_MANIFEST_VERSION,
        "generatedAt": iso_ms(datetime.now(UTC)),
        "inputHash": input_hash,
        "modelHash": model_hash,
        "archiveHashes": archive_hashes,
        "outputHashes": source_output_hashes(
            run_dir,
            smoke=arguments.smoke,
        ),
    }
    atomic_json(run_dir / "source-resume-manifest.json", resume_manifest)
    state["status"] = "source_complete"
    state["phase"] = "source-complete"
    state["completedAt"] = iso_ms(datetime.now(UTC))
    state["heartbeatAt"] = state["completedAt"]
    atomic_json(run_dir / "state.json", state)
    (run_dir / "SOURCE_COMPLETE").write_text(
        f"{state['completedAt']}\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "status": state["status"],
                "runDir": str(run_dir),
                "scheduleCount": len(schedule),
                "usableCandidates": usable,
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"high-vol-stack-source-error: {error}", flush=True)
        raise
