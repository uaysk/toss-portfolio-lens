#!/usr/bin/env python3
"""Resumable FinCast/Chronos-2 cadence-context benchmark pipeline.

The runner intentionally talks to the pinned production WebSocket lanes. It
does not download models, fabricate market observations, or tune policy
thresholds from holdout results.
"""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor
import csv
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterator, Mapping, NamedTuple, Sequence
from urllib.request import Request, urlopen
import zipfile

import numpy as np
from websockets.sync.client import ClientConnection, connect

from portfolio_ai_worker.cadence_benchmark import (
    CandleArrays,
    EVALUATION_HORIZONS_MINUTES,
    FIXED_QUANTILES,
    SUPPORTED_CADENCES,
    Trade,
    aggregate_trades,
    asof_indices,
    chronos2_direct_prediction_supported,
    contiguous_origin_times,
    context_slice,
    fold_candles,
    pinball_loss,
    prediction_steps,
    quantile_cdf,
    summarize_prediction_records,
    weighted_interval_score,
)
from portfolio_ai_worker.chronos2 import (
    CHRONOS2_MODEL_REVISION,
    CHRONOS2_PACKAGE_VERSION,
)

UTC = timezone.utc
STATE_SCHEMA = "ai-p40-qualification-state/v1"
EVENT_SCHEMA = "ai-p40-qualification-event/v1"
SOURCE_URL = (
    "https://data.binance.vision/data/futures/um/daily/aggTrades/"
    "{symbol}/{symbol}-aggTrades-{day}.zip"
)
SYMBOLS = ("BTCUSDT", "ETHUSDT")
CADENCES = (60, 30, 15, 5)
CHRONOS_CONTEXTS = (1024, 2048, 4096, 8192)
EVALUATION_DAYS = 21
SCREENING_POOL_DAYS = 14
ORIGIN_INTERVAL_MINUTES = 15
SCREENING_ORIGIN_INTERVAL_MINUTES = 30
SEED = 17
MAX_REQUEST_RETRIES = 2
CHRONOS2_TASK_BATCH_SIZE = 4
CHRONOS2_PREFETCH_WORKERS = 4
STATUS_UPDATE_INTERVAL_SECONDS = 5.0
EXECUTION_OPTIMIZATION_VERSION = "chronos2-fixed-batch-prefetch-v1"
PIPELINE_PHASES = (
    "prepare",
    "validate-data",
    "smoke-test",
    "screen",
    "decide",
    "build-final-plan",
    "full-test",
    "aggregate",
    "finalize",
)
MODEL_IDS = {
    "fincast": "Vincent05R/FinCast",
    "chronos-2": "amazon/chronos-2",
}
FINCAST_REVISION = "2d7d90b159db8961d27c2cf165d51195902ef92b"
SCREENING_POLICY_VERSION = "cadence-context-screening-policy/v2"
SELECTED_PLAN_SCHEMA = "cadence-context-selected-test-plan/v2"
DEFAULT_FINAL_COMBINATION_IDS = (
    "fincast-c512-s60",
    "fincast-c512-s30",
    "fincast-c512-s15",
    "chronos2-c1024-s60",
    "chronos2-c1024-s30",
    "chronos2-c1024-s15",
    "chronos2-c2048-s60",
    "chronos2-c2048-s30",
    "chronos2-c4096-s60",
    "chronos2-c4096-s15",
)
MATCHED_LOOKBACK_COMBINATION_IDS = (
    "chronos2-c1024-s60",
    "chronos2-c2048-s30",
    "chronos2-c4096-s15",
)
CONDITIONAL_COMBINATION_IDS = (
    "chronos2-c2048-s5",
    "chronos2-c4096-s5",
    "chronos2-c2048-s15",
    "chronos2-c4096-s30",
    "chronos2-c8192-s60",
    "chronos2-c8192-s30",
    "chronos2-c8192-s15",
)
STATIC_PLAN_DECISIONS: dict[str, dict[str, Any]] = {
    "fincast-c512-s5": {
        "planRole": "excluded",
        "status": "excluded",
        "screeningDecision": "excluded",
        "screeningStatus": "not_required",
        "reason": (
            "512×5초 lookback은 42분 40초뿐이라 60분·720-step 예측 실험에서 기본 제외"
        ),
    },
    "chronos2-c1024-s5": {
        "planRole": "excluded",
        "status": "excluded",
        "screeningDecision": "excluded",
        "screeningStatus": "not_required",
        "reason": (
            "5초 cadence 대표 조합으로는 context가 짧아 2048/4096 context 경로만 평가"
        ),
    },
    "chronos2-c8192-s5": {
        "planRole": "followup_only",
        "status": "followup_only",
        "screeningDecision": "followup_only",
        "screeningStatus": "followup_only",
        "reason": (
            "8192×5초는 이번 자동 pipeline에서 실행하지 않으며 "
            "4096×5초 강한 통과 시 후속 후보로만 기록"
        ),
    },
}
CONDITIONAL_DEPENDENCIES: dict[str, tuple[str, ...]] = {
    "chronos2-c2048-s5": (),
    "chronos2-c4096-s5": ("chronos2-c2048-s5",),
    "chronos2-c2048-s15": (),
    "chronos2-c4096-s30": (),
    "chronos2-c8192-s60": ("chronos2-c4096-s60",),
    "chronos2-c8192-s30": ("chronos2-c4096-s30",),
    "chronos2-c8192-s15": ("chronos2-c4096-s30",),
}
CONDITIONAL_COMPARATORS: dict[str, tuple[str, ...]] = {
    "chronos2-c2048-s5": (
        "chronos2-c1024-s15",
        "chronos2-c4096-s15",
    ),
    "chronos2-c4096-s5": (
        "chronos2-c2048-s5",
        "chronos2-c4096-s15",
    ),
    "chronos2-c2048-s15": ("chronos2-c1024-s30",),
    "chronos2-c4096-s30": (
        "chronos2-c2048-s60",
        "chronos2-c2048-s30",
    ),
    "chronos2-c8192-s60": ("chronos2-c4096-s60",),
    "chronos2-c8192-s30": (
        "chronos2-c4096-s60",
        "chronos2-c4096-s30",
    ),
    "chronos2-c8192-s15": (
        "chronos2-c4096-s30",
        "chronos2-c2048-s60",
    ),
}
SMOKE_COMBINATION_IDS = tuple(
    combination_id
    for combination_id in (
        "fincast-c512-s60",
        "fincast-c512-s30",
        "fincast-c512-s15",
        "fincast-c512-s5",
        *(
            f"chronos2-c{context}-s{cadence}"
            for context in CHRONOS_CONTEXTS
            for cadence in CADENCES
        ),
    )
    if combination_id != "chronos2-c8192-s5"
)


def iso(value: datetime) -> str:
    return (
        value.astimezone(UTC)
        .isoformat(timespec="milliseconds")
        .replace(
            "+00:00",
            "Z",
        )
    )


def from_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a UTC offset")
    return parsed.astimezone(UTC)


def iso_ms(timestamp_ms: int) -> str:
    return iso(datetime.fromtimestamp(timestamp_ms / 1_000, UTC))


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
                separators=(",", ":"),
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_npz(path: Path, candles: CandleArrays) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            np.savez_compressed(handle, **asdict(candles))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_npz(path: Path) -> CandleArrays:
    with np.load(path, allow_pickle=False) as source:
        return CandleArrays(
            **{
                field: np.asarray(source[field])
                for field in CandleArrays.__dataclass_fields__
            }
        )


def combinations() -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for cadence in CADENCES:
        values.append(combination("fincast", 512, cadence))
    for context in CHRONOS_CONTEXTS:
        for cadence in CADENCES:
            values.append(combination("chronos-2", context, cadence))
    return values


def combination(model: str, context: int, cadence: int) -> dict[str, Any]:
    prefix = "fincast" if model == "fincast" else "chronos2"
    combination_id = f"{prefix}-c{context}-s{cadence}"
    static = STATIC_PLAN_DECISIONS.get(combination_id)
    plan_role = (
        "default"
        if combination_id in DEFAULT_FINAL_COMBINATION_IDS
        else "conditional"
        if combination_id in CONDITIONAL_COMBINATION_IDS
        else str(static["planRole"])
    )
    return {
        "id": combination_id,
        "model": model,
        "contextBars": context,
        "cadenceSeconds": cadence,
        "lookbackSeconds": context * cadence,
        "predictionLengthSteps": prediction_steps(cadence),
        "planRole": plan_role,
        "dependencyIds": list(CONDITIONAL_DEPENDENCIES.get(combination_id, ())),
        "screeningComparatorIds": list(CONDITIONAL_COMPARATORS.get(combination_id, ())),
        "status": static["status"] if static else "queued",
        "screeningDecision": (static["screeningDecision"] if static else "pending"),
        "screeningStatus": (static["screeningStatus"] if static else "not_started"),
        "smokeStatus": (
            "not_run" if combination_id == "chronos2-c8192-s5" else "not_started"
        ),
        "screeningReason": static["reason"] if static else None,
        "screeningTriggerReason": None,
        "selectedForFinal": False,
        "completedOrigins": 0,
        "totalOrigins": 0,
        "progressPercent": 0,
        "attempt": 0,
        "currentSymbol": None,
        "currentOrigin": None,
        "elapsedMs": 0,
        "etaMs": None,
        "latencyP50Ms": None,
        "latencyP95Ms": None,
        "throughputOriginsPerSecond": None,
        "peakVramMiB": None,
        "peakRamMiB": None,
        "retryCount": 0,
        "failureReason": None,
        "partialPrediction": None,
        "partialTrading": None,
    }


def phase_steps() -> list[dict[str, Any]]:
    labels = {
        "prepare": ("실행·모델 사전점검", "manifest · lock · pinned revisions"),
        "validate-data": ("동일 1초 체결 원천 생성·검증", "aggTrades → 1/5/15/30/60초"),
        "smoke-test": (
            "실행 후보 smoke",
            "19개 실제 P40 inference · 8192×5초 후속 전용",
        ),
        "screen": (
            "기본·조건부 screening",
            "10개 기본 + dependency gate · low/medium/high",
        ),
        "decide": (
            "screening gate 결정",
            "v2 예측/거래 경로 · 기술 실패·비용 threshold",
        ),
        "build-final-plan": ("3주 최종 matrix 고정", "selected_test_plan.json gate"),
        "full-test": ("21일 최종 평가", "15분 origin · BTC/ETH"),
        "aggregate": ("예측·트레이딩 결과 집계", "horizon/symbol/model 비교"),
        "finalize": ("재현성 artifact 확정", "COMPLETE marker"),
    }
    estimates = (5, 90, 120, 720, 5, 2, 8_000, 10, 2)
    output = (
        "run-manifest.json",
        "data/data-manifest.json",
        "smoke/smoke-summary.json",
        "screening_metrics.json",
        "screening_decisions.json",
        "selected_test_plan.json",
        "results/full-test-summary.json",
        "qualification-summary.json",
        "COMPLETE",
    )
    steps: list[dict[str, Any]] = []
    for order, phase in enumerate(PIPELINE_PHASES, start=1):
        label, variant = labels[phase]
        steps.append(
            {
                "id": phase,
                "order": order,
                "label": label,
                "description": label,
                "model": (
                    "comparison"
                    if phase in {"screen", "decide", "full-test", "aggregate"}
                    else "system"
                ),
                "variant": variant,
                "status": "pending",
                "estimatedDurationMs": estimates[order - 1] * 60_000,
                "outputFile": output[order - 1],
                "logFile": f"logs/{phase}.log",
            }
        )
    return steps


class PipelineState:
    def __init__(
        self,
        run_dir: Path,
        *,
        run_id: str,
        evaluation_start: datetime,
        evaluation_end: datetime,
    ) -> None:
        self.run_dir = run_dir
        self.path = run_dir / "state.json"
        self.events_path = run_dir / "events.jsonl"
        self.log_path = run_dir / "logs" / "pipeline.log"
        self.lock_path = run_dir / ".state.lock"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "logs").mkdir(exist_ok=True)
        self._event_sequence = 0
        if self.path.exists():
            self.value = json.loads(self.path.read_text(encoding="utf-8"))
            if self.value["runId"] != run_id:
                raise ValueError("resume run ID does not match state")
            experiment = self.value.get("experiment")
            if isinstance(experiment, dict) and experiment.get("kind") == (
                "cadence-context-3week-benchmark"
            ):
                defaults = {item["id"]: item for item in combinations()}
                for item in experiment.get("combinations", []):
                    current = defaults.get(str(item.get("id")))
                    if current is None:
                        continue
                    for key in (
                        "planRole",
                        "dependencyIds",
                        "screeningComparatorIds",
                        "screeningStatus",
                        "screeningTriggerReason",
                        "smokeStatus",
                    ):
                        item.setdefault(key, current[key])
                experiment.setdefault(
                    "screeningPolicyVersion",
                    SCREENING_POLICY_VERSION,
                )
                experiment.setdefault(
                    "defaultFinalCombinationIds",
                    list(DEFAULT_FINAL_COMBINATION_IDS),
                )
                experiment.setdefault(
                    "conditionalCombinationIds",
                    list(CONDITIONAL_COMBINATION_IDS),
                )
                experiment.setdefault("followupCandidateIds", [])
                experiment.setdefault("failedFinalCombinationIds", [])
            if self.events_path.exists():
                for line in self.events_path.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        self._event_sequence = max(
                            self._event_sequence,
                            int(json.loads(line)["sequence"]),
                        )
            return
        now = datetime.now(UTC)
        deadline = now + timedelta(hours=504)
        self.value: dict[str, Any] = {
            "schemaVersion": STATE_SCHEMA,
            "runId": run_id,
            "status": "planned",
            "createdAt": iso(now),
            "updatedAt": iso(now),
            "deadlineAt": iso(deadline),
            "activeStepId": None,
            "config": {
                "budgetHours": 504,
                "durationHours": EVALUATION_DAYS * 24,
                "endExclusive": iso(evaluation_end),
                "symbols": list(SYMBOLS),
                "gpu": "Tesla P40",
                "cudaCapability": "6.1",
                "workerMode": "external",
                "dockerBuild": False,
            },
            "progress": {
                "completedSteps": 0,
                "failedSteps": 0,
                "skippedSteps": 0,
                "totalSteps": len(PIPELINE_PHASES),
                "percent": 0,
                "activeStepPercent": None,
                "elapsedMs": 0,
                "remainingBudgetMs": 504 * 3_600_000,
            },
            "steps": phase_steps(),
            "artifacts": {
                "summaryJson": "qualification-summary.json",
                "reportMarkdown": "qualification-report.md",
                "handoffPrompt": "handoff.md",
            },
            "experiment": {
                "kind": "cadence-context-3week-benchmark",
                "phase": "prepare",
                "evaluationDays": 21,
                "evaluationStart": iso(evaluation_start),
                "evaluationEndExclusive": iso(evaluation_end),
                "originIntervalMinutes": 15,
                "screeningOriginIntervalMinutes": 30,
                "horizonsMinutes": list(EVALUATION_HORIZONS_MINUTES),
                "featureProfile": "compact_causal_v1",
                "crossLearning": False,
                "selectedPlanReady": False,
                "selectedCombinationCount": 0,
                "totalCombinationCount": 20,
                "screeningPolicyVersion": SCREENING_POLICY_VERSION,
                "defaultFinalCombinationIds": list(DEFAULT_FINAL_COMBINATION_IDS),
                "conditionalCombinationIds": list(CONDITIONAL_COMBINATION_IDS),
                "followupCandidateIds": [],
                "failedFinalCombinationIds": [],
                "currentCombinationId": None,
                "currentSymbol": None,
                "currentOrigin": None,
                "screeningWindows": [],
                "combinations": combinations(),
                "matchedLookbackCombinationIds": list(MATCHED_LOOKBACK_COMBINATION_IDS),
                "fiveSecondLookbackNote": (
                    "8192×5초의 실제 lookback은 11시간 22분 40초로 "
                    "약 17시간 matched-lookback anchor와 동일하지 않습니다."
                ),
                "dataRowsProcessed": 0,
                "inferenceOriginsProcessed": 0,
                "dataThroughputRowsPerSecond": None,
                "inferenceThroughputOriginsPerSecond": None,
                "recentLogLines": [],
            },
        }
        self.save()
        self.event("run_created", "3주 cadence/context benchmark 실행을 생성했습니다.")

    def save(self) -> None:
        now = datetime.now(UTC)
        self.value["updatedAt"] = iso(now)
        started = from_iso(self.value.get("startedAt", self.value["createdAt"]))
        elapsed = max(0, int((now - started).total_seconds() * 1_000))
        deadline = from_iso(self.value["deadlineAt"])
        self.value["progress"]["elapsedMs"] = elapsed
        self.value["progress"]["remainingBudgetMs"] = max(
            0,
            int((deadline - now).total_seconds() * 1_000),
        )
        completed = sum(step["status"] == "completed" for step in self.value["steps"])
        failed = sum(step["status"] == "failed" for step in self.value["steps"])
        skipped = sum(step["status"] == "skipped" for step in self.value["steps"])
        active_percent = self.value["progress"]["activeStepPercent"] or 0
        self.value["progress"].update(
            {
                "completedSteps": completed,
                "failedSteps": failed,
                "skippedSteps": skipped,
                "percent": min(
                    100,
                    (completed + skipped + active_percent / 100)
                    / len(self.value["steps"])
                    * 100,
                ),
            }
        )
        atomic_json(self.path, self.value)

    def event(
        self,
        event_type: str,
        message: str,
        *,
        step_id: str | None = None,
        progress: float | None = None,
    ) -> None:
        self._event_sequence += 1
        value: dict[str, Any] = {
            "schemaVersion": EVENT_SCHEMA,
            "sequence": self._event_sequence,
            "runId": self.value["runId"],
            "at": iso(datetime.now(UTC)),
            "type": event_type,
            "message": message[:2_000],
        }
        if step_id:
            value["stepId"] = step_id
        if progress is not None:
            value["progressPercent"] = min(100, max(0, progress))
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
            )
            handle.flush()
            os.fsync(handle.fileno())

    def log(self, message: str) -> None:
        rendered = f"{iso(datetime.now(UTC))} {message}"
        print(rendered, flush=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(rendered + "\n")
        lines = self.value["experiment"]["recentLogLines"]
        lines.append(rendered[-500:])
        self.value["experiment"]["recentLogLines"] = lines[-40:]

    def start(self) -> None:
        previous_status = self.value["status"]
        if previous_status == "planned":
            self.value["startedAt"] = iso(datetime.now(UTC))
        elif previous_status == "failed":
            failure_marker = self.run_dir / "FAILED"
            if failure_marker.exists():
                failure_history = self.run_dir / "failures"
                failure_history.mkdir(mode=0o700, exist_ok=True)
                timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
                os.replace(
                    failure_marker,
                    failure_history / f"FAILED-{timestamp}.json",
                )
            self.value["resumeCount"] = int(self.value.get("resumeCount", 0)) + 1
        self.value.pop("finishedAt", None)
        self.value["status"] = "running"
        self.save()
        self.event(
            "run_resumed" if previous_status == "failed" else "run_started",
            (
                "실패 이력을 보존하고 benchmark pipeline을 재개했습니다."
                if previous_status == "failed"
                else "benchmark pipeline이 실행 중입니다."
            ),
        )

    def begin_phase(self, phase: str) -> bool:
        step = next(item for item in self.value["steps"] if item["id"] == phase)
        if step["status"] == "completed":
            self.log(f"{phase}: completed checkpoint를 재사용합니다.")
            return False
        now = iso(datetime.now(UTC))
        step.update({"status": "running", "startedAt": now})
        step.pop("error", None)
        self.value["activeStepId"] = phase
        self.value["progress"]["activeStepPercent"] = 0
        self.value["experiment"]["phase"] = phase
        self.save()
        self.event("step_started", f"{phase} 단계를 시작했습니다.", step_id=phase)
        return True

    def phase_progress(self, percent: float, message: str | None = None) -> None:
        self.value["progress"]["activeStepPercent"] = min(
            100,
            max(0, percent),
        )
        self.save()
        if message:
            self.event(
                "step_output",
                message,
                step_id=self.value["activeStepId"],
                progress=percent,
            )

    def complete_phase(self, phase: str, summary: str) -> None:
        step = next(item for item in self.value["steps"] if item["id"] == phase)
        now = datetime.now(UTC)
        started = from_iso(step.get("startedAt", iso(now)))
        step.update(
            {
                "status": "completed",
                "finishedAt": iso(now),
                "durationMs": max(0, int((now - started).total_seconds() * 1_000)),
                "summary": summary[:1_000],
            }
        )
        self.value["activeStepId"] = None
        self.value["progress"]["activeStepPercent"] = None
        self.save()
        self.event("step_completed", summary, step_id=phase)

    def fail(self, error: BaseException) -> None:
        phase = self.value.get("activeStepId")
        rendered_error = f"{type(error).__name__}: {error}"[:2_000]
        if phase:
            step = next(item for item in self.value["steps"] if item["id"] == phase)
            step["status"] = "failed"
            step["finishedAt"] = iso(datetime.now(UTC))
            step["error"] = rendered_error
        combination_id = self.value["experiment"].get("currentCombinationId")
        if combination_id:
            combination_value = self.combination(str(combination_id))
            if combination_value["status"] in {"running", "retrying"}:
                combination_value["status"] = "failed"
                combination_value["failureReason"] = rendered_error
        self.value["status"] = "failed"
        self.value["finishedAt"] = iso(datetime.now(UTC))
        self.value["activeStepId"] = None
        self.value["progress"]["activeStepPercent"] = None
        self.save()
        self.event(
            "step_failed",
            f"{type(error).__name__}: {error}",
            step_id=phase,
        )
        atomic_text(
            self.run_dir / "FAILED",
            json.dumps(
                {
                    "at": iso(datetime.now(UTC)),
                    "phase": phase,
                    "error": rendered_error,
                },
                ensure_ascii=False,
            )
            + "\n",
        )

    def combination(self, combination_id: str) -> dict[str, Any]:
        return next(
            item
            for item in self.value["experiment"]["combinations"]
            if item["id"] == combination_id
        )


def telemetry() -> dict[str, Any] | None:
    try:
        query = (
            subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=utilization.gpu,memory.used,memory.total,"
                    "temperature.gpu,power.draw,power.limit",
                    "--format=csv,noheader,nounits",
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            .stdout.strip()
            .splitlines()[0]
        )
        gpu, used, total, temperature, draw, limit = (
            float(value.strip()) for value in query.split(",")
        )
        memory = {}
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, raw = line.split(":", 1)
            memory[key] = float(raw.strip().split()[0]) / 1024
        cpu = os.getloadavg()[0] / max(1, os.cpu_count() or 1) * 100
        return {
            "polledAt": iso(datetime.now(UTC)),
            "gpuUtilizationPercent": min(100, max(0, gpu)),
            "memoryUsedMiB": used,
            "memoryTotalMiB": total,
            "temperatureC": temperature,
            "powerDrawW": max(0, draw),
            "powerLimitW": max(1, limit),
            "memoryHeadroomMiB": max(0, total - used),
            "cpuUtilizationPercent": min(100, max(0, cpu)),
            "ramUsedMiB": max(
                0,
                memory.get("MemTotal", 0) - memory.get("MemAvailable", 0),
            ),
            "ramTotalMiB": max(1, memory.get("MemTotal", 1)),
        }
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def source_period(
    evaluation_end: datetime,
    *,
    smoke: bool,
) -> tuple[date, date]:
    # The technical smoke needs enough history to locate a genuinely observed
    # 8192 × 60-second context and, independently, an 8192 × 5-second context
    # shared by BTC and ETH.  No missing trade interval is synthesized.
    days = 14 if smoke else EVALUATION_DAYS + SCREENING_POOL_DAYS + 6
    return (
        (evaluation_end - timedelta(days=days)).date(),
        evaluation_end.date(),
    )


def day_range(start: date, end_inclusive: date) -> Iterator[date]:
    current = start
    while current <= end_inclusive:
        yield current
        current += timedelta(days=1)


def download(path: Path, url: str) -> None:
    if path.is_file() and path.stat().st_size > 0:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        try:
            request = Request(url, headers={"User-Agent": "toss-portfolio-lens/1"})
            with (
                urlopen(request, timeout=120) as response,
                temporary.open("wb") as output,
            ):
                shutil.copyfileobj(response, output, length=1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            if temporary.stat().st_size <= 0:
                raise ValueError("downloaded archive is empty")
            os.replace(temporary, path)
            return
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt >= 2:
                raise
            time.sleep(2**attempt)


def trades_from_zip(path: Path) -> Iterator[Trade]:
    with zipfile.ZipFile(path) as archive:
        members = [
            item
            for item in archive.infolist()
            if not item.is_dir() and item.filename.endswith(".csv")
        ]
        if len(members) != 1 or "/" in members[0].filename:
            raise ValueError("aggTrades archive has an unexpected layout")
        with archive.open(members[0]) as binary:
            rows = csv.reader(
                (line.decode("utf-8") for line in binary),
            )
            for row in rows:
                if not row or row[0] in {"agg_trade_id", "a"}:
                    continue
                if len(row) < 7:
                    raise ValueError("aggTrades row has too few columns")
                yield Trade(
                    timestamp_ms=int(row[5]),
                    price=float(row[1]),
                    quantity=float(row[2]),
                    first_trade_id=int(row[3]),
                    last_trade_id=int(row[4]),
                    buyer_is_maker=row[6].strip().lower() == "true",
                )


def concatenate_candles(values: Sequence[CandleArrays]) -> CandleArrays:
    if not values:
        raise ValueError("cannot concatenate an empty candle list")
    return CandleArrays(
        **{
            field: np.concatenate(
                [getattr(value, field) for value in values],
            )
            for field in CandleArrays.__dataclass_fields__
        }
    )


def prepare_market_data(
    cache_root: Path,
    source_dir: Path,
    evaluation_end: datetime,
    state: PipelineState,
    *,
    smoke: bool,
) -> Path:
    start_day, end_day = source_period(evaluation_end, smoke=smoke)
    mode = "smoke" if smoke else "full"
    prepared = cache_root / f"prepared-{mode}"
    manifest_path = prepared / "data-manifest.json"
    coverage = {
        "startDay": start_day.isoformat(),
        "endDayInclusive": end_day.isoformat(),
        "symbols": list(SYMBOLS),
        "cadences": list(SUPPORTED_CADENCES),
        "emptyIntervalPolicy": "unavailable_no_interpolation_v1",
    }
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("coverage") == coverage:
            state.log(f"{mode} data cache manifest를 재사용합니다.")
            return prepared
    raw_root = cache_root / "raw"
    all_days = list(day_range(start_day, end_day))
    total_units = len(SYMBOLS) * len(all_days)
    processed = 0
    started = time.monotonic()
    day_files: dict[tuple[str, int], list[Path]] = {
        (symbol, cadence): [] for symbol in SYMBOLS for cadence in SUPPORTED_CADENCES
    }
    source_files: list[dict[str, Any]] = []
    for symbol in SYMBOLS:
        for day in all_days:
            if (state.run_dir / "STOP").exists():
                raise KeyboardInterrupt("graceful stop marker detected")
            label = day.isoformat()
            archive = raw_root / "aggTrades" / symbol / f"{symbol}-{label}.zip"
            download(archive, SOURCE_URL.format(symbol=symbol, day=label))
            second_path = raw_root / "seconds" / symbol / f"{label}.npz"
            if not second_path.exists():
                seconds = aggregate_trades(trades_from_zip(archive), 1)
                write_npz(second_path, seconds)
            else:
                seconds = read_npz(second_path).validate(1)
            for cadence in SUPPORTED_CADENCES:
                cadence_path = (
                    raw_root / "cadence" / str(cadence) / symbol / f"{label}.npz"
                )
                if not cadence_path.exists():
                    write_npz(cadence_path, fold_candles(seconds, cadence))
                day_files[(symbol, cadence)].append(cadence_path)
            source_files.append(
                {
                    "symbol": symbol,
                    "day": label,
                    "archive": str(archive.relative_to(cache_root)),
                    "archiveSha256": sha256_file(archive),
                    "seconds": str(second_path.relative_to(cache_root)),
                    "secondsSha256": sha256_file(second_path),
                }
            )
            processed += 1
            elapsed = max(0.001, time.monotonic() - started)
            state.value["experiment"]["dataRowsProcessed"] = processed
            state.value["experiment"]["dataThroughputRowsPerSecond"] = (
                processed / elapsed
            )
            observed = telemetry()
            if observed is not None:
                state.value["telemetry"] = observed
            state.phase_progress(
                processed / total_units * 80,
                f"{symbol} {label} 실제 aggTrades 집계 완료",
            )
    prepared.mkdir(parents=True, exist_ok=True)
    outputs: list[dict[str, Any]] = []
    total_rows = 0
    for symbol in SYMBOLS:
        for cadence in SUPPORTED_CADENCES:
            target = prepared / f"{symbol}-{cadence}s.npz"
            values = concatenate_candles(
                [read_npz(path) for path in day_files[(symbol, cadence)]]
            ).validate(cadence)
            write_npz(target, values)
            total_rows += len(values)
            outputs.append(
                {
                    "symbol": symbol,
                    "cadenceSeconds": cadence,
                    "rows": len(values),
                    "path": target.name,
                    "sha256": sha256_file(target),
                }
            )
    elapsed = max(0.001, time.monotonic() - started)
    state.value["experiment"]["dataRowsProcessed"] = total_rows
    state.value["experiment"]["dataThroughputRowsPerSecond"] = total_rows / elapsed
    source_manifest = source_dir / "source-manifest.json"
    market_bars = source_dir / "market-bars.jsonl"
    if not source_manifest.is_file() or not market_bars.is_file():
        raise ValueError("existing five-week derivative source is unavailable")
    manifest = {
        "schemaVersion": "cadence-context-market-data/v1",
        "generatedAt": iso(datetime.now(UTC)),
        "source": "Binance USD-M public daily aggTrades",
        "coverage": coverage,
        "aggregation": {
            "rootCadenceSeconds": 1,
            "utcAligned": True,
            "onlyFinalizedTrades": True,
            "emptyIntervals": "omitted_and_origin_unavailable",
            "tradeCount": "last_trade_id-first_trade_id+1",
            "takerBuy": "buyer_is_maker=false",
        },
        "derivativeAsOfPolicy": "observation_close_time_lte_candle_close_v1",
        "sourceManifestSha256": sha256_file(source_manifest),
        "marketBarsSha256": sha256_file(market_bars),
        "sourceFiles": source_files,
        "outputs": outputs,
    }
    atomic_json(manifest_path, manifest)
    state.phase_progress(100, "동일 1초 원천에서 네 cadence dataset을 확정했습니다.")
    return prepared


class DataRepository:
    def __init__(self, prepared: Path, source_dir: Path) -> None:
        self.prepared = prepared
        self.source_dir = source_dir
        self._candles: dict[tuple[str, int], CandleArrays] = {}
        self._features: dict[tuple[str, int], tuple[np.ndarray, np.ndarray]] = {}
        self.derivatives = self._load_derivatives()

    def candles(self, symbol: str, cadence: int) -> CandleArrays:
        key = (symbol, cadence)
        if key not in self._candles:
            self._candles[key] = read_npz(
                self.prepared / f"{symbol}-{cadence}s.npz"
            ).validate(cadence)
        return self._candles[key]

    def _load_derivatives(self) -> dict[str, dict[str, np.ndarray]]:
        rows: dict[str, dict[str, list[float | int]]] = {
            symbol: {
                "time": [],
                "mark_price": [],
                "index_price": [],
                "premium_index": [],
                "funding_rate": [],
            }
            for symbol in SYMBOLS
        }
        with (self.source_dir / "market-bars.jsonl").open(encoding="utf-8") as handle:
            for line in handle:
                value = json.loads(line)
                symbol = value.get("symbol")
                if symbol not in rows or value.get("final") is not True:
                    continue
                rows[symbol]["time"].append(int(value["close_time"]))
                for field in (
                    "mark_price",
                    "index_price",
                    "premium_index",
                    "funding_rate",
                ):
                    raw = value.get(field)
                    rows[symbol][field].append(
                        float(raw) if raw is not None else math.nan
                    )
        return {
            symbol: {
                field: np.asarray(
                    values,
                    dtype=np.int64 if field == "time" else np.float64,
                )
                for field, values in fields.items()
            }
            for symbol, fields in rows.items()
        }

    def return_features(
        self,
        symbol: str,
        cadence: int,
    ) -> tuple[np.ndarray, np.ndarray]:
        key = (symbol, cadence)
        if key in self._features:
            return self._features[key]
        candles = self.candles(symbol, cadence)
        times = candles.close_time_ms
        log_close = np.log(candles.close)
        short = np.full(len(candles), np.nan)
        prior_time = times - 5 * 60_000
        indices = np.searchsorted(times, prior_time)
        valid = (indices < len(times)) & (
            times[np.minimum(indices, len(times) - 1)] == prior_time
        )
        positions = np.flatnonzero(valid)
        short[positions] = log_close[positions] - log_close[indices[positions]]
        returns = np.diff(log_close, prepend=np.nan)
        window = 60 * 60 // cadence
        squared = np.nan_to_num(returns * returns, nan=0.0)
        cumulative = np.r_[0.0, np.cumsum(squared)]
        rv = np.full(len(candles), np.nan)
        if len(candles) >= window:
            values = np.sqrt(
                np.maximum(
                    0,
                    (cumulative[window:] - cumulative[:-window]) / window,
                )
            )
            contiguous = np.r_[True, np.diff(times) == cadence * 1_000]
            breaks = np.r_[0, np.cumsum(~contiguous)]
            ok = breaks[window:] - breaks[:-window] == 0
            target = np.arange(window - 1, len(candles))
            rv[target[ok]] = values[ok]
        self._features[key] = (short, rv)
        return short, rv

    def value_at(self, symbol: str, cadence: int, timestamp_ms: int) -> float:
        candles = self.candles(symbol, cadence)
        index = int(np.searchsorted(candles.close_time_ms, timestamp_ms))
        if index >= len(candles) or int(candles.close_time_ms[index]) != timestamp_ms:
            raise ValueError("realized target candle is unavailable")
        return float(candles.close[index])

    def bars(
        self,
        symbol: str,
        cadence: int,
        origin_ms: int,
        context_bars: int,
    ) -> tuple[list[dict[str, Any]], float, float | None]:
        candles = self.candles(symbol, cadence)
        section = context_slice(
            candles.close_time_ms,
            origin_ms,
            context_bars,
            cadence,
        )
        times = candles.close_time_ms[section]
        derivative = self.derivatives[symbol]
        derivative_indices = asof_indices(derivative["time"], times)
        btc = self.candles("BTCUSDT", cadence)
        eth = self.candles("ETHUSDT", cadence)
        btc_short, btc_rv = self.return_features("BTCUSDT", cadence)
        eth_short, eth_rv = self.return_features("ETHUSDT", cadence)
        btc_indices = np.searchsorted(btc.close_time_ms, times)
        eth_indices = np.searchsorted(eth.close_time_ms, times)

        def finite_or_none(value: float) -> float | None:
            return float(value) if math.isfinite(float(value)) else None

        output: list[dict[str, Any]] = []
        for offset, timestamp in enumerate(times):
            source_index = section.start + offset
            derivative_index = int(derivative_indices[offset])
            btc_index = int(btc_indices[offset])
            eth_index = int(eth_indices[offset])
            btc_aligned = btc_index < len(btc) and int(
                btc.close_time_ms[btc_index]
            ) == int(timestamp)
            eth_aligned = eth_index < len(eth) and int(
                eth.close_time_ms[eth_index]
            ) == int(timestamp)
            b_short = finite_or_none(btc_short[btc_index]) if btc_aligned else None
            e_short = finite_or_none(eth_short[eth_index]) if eth_aligned else None
            own_short = b_short if symbol == "BTCUSDT" else e_short
            output.append(
                {
                    "timestamp": iso_ms(int(timestamp)),
                    "open": float(candles.open[source_index]),
                    "high": float(candles.high[source_index]),
                    "low": float(candles.low[source_index]),
                    "close": float(candles.close[source_index]),
                    "volume": float(candles.volume[source_index]),
                    "amount": float(candles.amount[source_index]),
                    "trade_count": int(candles.trade_count[source_index]),
                    "taker_buy_volume": float(candles.taker_buy_volume[source_index]),
                    "taker_buy_amount": float(candles.taker_buy_amount[source_index]),
                    "mark_price": (
                        finite_or_none(derivative["mark_price"][derivative_index])
                        if derivative_index >= 0
                        else None
                    ),
                    "index_price": (
                        finite_or_none(derivative["index_price"][derivative_index])
                        if derivative_index >= 0
                        else None
                    ),
                    "premium_index": (
                        finite_or_none(derivative["premium_index"][derivative_index])
                        if derivative_index >= 0
                        else None
                    ),
                    "funding_rate": (
                        finite_or_none(derivative["funding_rate"][derivative_index])
                        if derivative_index >= 0
                        else None
                    ),
                    "btc_short_return": b_short,
                    "btc_realized_volatility": (
                        finite_or_none(btc_rv[btc_index]) if btc_aligned else None
                    ),
                    "eth_short_return": e_short,
                    "eth_realized_volatility": (
                        finite_or_none(eth_rv[eth_index]) if eth_aligned else None
                    ),
                    "benchmark_return": b_short,
                    "relative_strength": (
                        own_short - b_short
                        if own_short is not None and b_short is not None
                        else None
                    ),
                    "complete": True,
                }
            )
        origin_funding = output[-1]["funding_rate"]
        return output, float(candles.close[section.stop - 1]), origin_funding


class WorkerClient:
    def __init__(self, url: str, token_file: Path) -> None:
        self.url = url
        token = token_file.read_text(encoding="utf-8").strip()
        if len(token.encode()) < 32 or any(value.isspace() for value in token):
            raise ValueError("AI worker token file is invalid")
        self.token = token
        self.connection: ClientConnection | None = None

    def _connect(self) -> ClientConnection:
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
        connection = self.connection or self._connect()
        request_id = str(payload["request_id"])
        envelope = {
            "transport_version": "scalping-ai-ws/v1",
            "type": "request",
            "request_id": request_id,
            "payload": payload,
        }
        try:
            connection.send(
                json.dumps(
                    envelope,
                    allow_nan=False,
                    separators=(",", ":"),
                )
            )
            while True:
                message = json.loads(connection.recv(timeout=1_800))
                if (
                    message.get("type") == "response"
                    and message.get("request_id") == request_id
                ):
                    return dict(message["payload"])
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


def origins(
    start: datetime,
    end_exclusive: datetime,
    interval_minutes: int,
) -> list[int]:
    current = int(start.timestamp() * 1_000) + interval_minutes * 60_000 - 1
    end_ms = int(end_exclusive.timestamp() * 1_000)
    output: list[int] = []
    while current < end_ms:
        output.append(current)
        current += interval_minutes * 60_000
    return output


def daily_volatility(
    repository: DataRepository,
    start: datetime,
    end: datetime,
) -> list[tuple[date, float]]:
    output: list[tuple[date, float]] = []
    current = start
    while current < end:
        next_day = current + timedelta(days=1)
        values: list[float] = []
        for symbol in SYMBOLS:
            candles = repository.candles(symbol, 60)
            left = np.searchsorted(
                candles.close_time_ms,
                int(current.timestamp() * 1_000),
            )
            right = np.searchsorted(
                candles.close_time_ms,
                int(next_day.timestamp() * 1_000),
            )
            close = candles.close[left:right]
            if len(close) > 1:
                values.extend(np.diff(np.log(close)).tolist())
        if not values:
            raise ValueError("screening pool day has no realized returns")
        output.append(
            (
                current.date(),
                float(math.sqrt(sum(item * item for item in values))),
            )
        )
        current = next_day
    return output


def select_screening_windows(
    repository: DataRepository,
    anchor: datetime,
    *,
    pool_days: int = SCREENING_POOL_DAYS,
) -> list[dict[str, Any]]:
    pool_start = anchor - timedelta(days=pool_days)
    ranked = sorted(
        daily_volatility(repository, pool_start, anchor),
        key=lambda item: item[1],
    )
    candidates = (ranked[0], ranked[len(ranked) // 2], ranked[-1])
    windows = []
    for regime, (day, volatility) in zip(
        ("low", "medium", "high"),
        candidates,
        strict=True,
    ):
        start = datetime(day.year, day.month, day.day, tzinfo=UTC)
        windows.append(
            {
                "regime": regime,
                "start": iso(start),
                "endExclusive": iso(start + timedelta(days=1)),
                "realizedVolatility": volatility,
            }
        )
    if len({item["start"] for item in windows}) != 3:
        raise ValueError("screening volatility windows are not distinct")
    return windows


class PreparedForecastTask(NamedTuple):
    symbol: str
    origin_ms: int
    screening_window: str | None
    bars: list[dict[str, Any]] | None
    origin_close: float | None
    funding: float | None
    unavailable_reason: str | None

    @property
    def key(self) -> str:
        return f"{self.symbol}|{self.origin_ms}"

    @property
    def instrument_key(self) -> str:
        # ForecastRequest requires unique instrument keys. Appending the causal
        # origin lets one fixed CUDA graph batch contain adjacent BTC/ETH
        # origins without changing any model feature.
        return f"BINANCE_USDM:{self.symbol}:{self.origin_ms}"


def request_payload_batch(
    combination_value: Mapping[str, Any],
    tasks: Sequence[PreparedForecastTask],
) -> dict[str, Any]:
    if not tasks or any(task.bars is None for task in tasks):
        raise ValueError("forecast batch must contain prepared available tasks")
    request_id = (
        f"cc3w-{combination_value['id']}-b{len(tasks)}-"
        f"{tasks[0].origin_ms}"
    )
    return {
        "schema_version": "scalping-ai/v1",
        "request_id": request_id,
        "mode": "forecast",
        "forecast_profile": "full",
        "horizons_minutes": list(EVALUATION_HORIZONS_MINUTES),
        "quantiles": list(FIXED_QUANTILES),
        "seed": SEED,
        "series": [
            {
                "instrument_key": task.instrument_key,
                "timezone": "UTC",
                "input_end_at": iso_ms(task.origin_ms),
                "future_timestamps": [
                    iso_ms(task.origin_ms + minute * 60_000)
                    for minute in range(1, 61)
                ],
                "bars": task.bars,
                "input_cadence": {
                    "candle_seconds": combination_value["cadenceSeconds"],
                    "gap_policy": "continuous",
                },
            }
            for task in tasks
        ],
    }


def request_payload(
    combination_value: Mapping[str, Any],
    symbol: str,
    origin_ms: int,
    bars: list[dict[str, Any]],
) -> dict[str, Any]:
    """Backward-compatible one-task request helper used by focused tests."""

    return request_payload_batch(
        combination_value,
        (
            PreparedForecastTask(
                symbol=symbol,
                origin_ms=origin_ms,
                screening_window=None,
                bars=bars,
                origin_close=None,
                funding=None,
                unavailable_reason=None,
            ),
        ),
    )


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    output = []
    raw = path.read_text(encoding="utf-8")
    lines = raw.splitlines()
    if raw and not raw.endswith("\n"):
        lines = lines[:-1]
    for line in lines:
        if line.strip():
            output.append(json.loads(line))
    return output


def append_jsonl(path: Path, values: Sequence[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for value in values:
            handle.write(
                json.dumps(
                    value,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
                + "\n"
            )
        handle.flush()
        os.fsync(handle.fileno())


def percentile(values: Sequence[float], quantile: float) -> float | None:
    if not values:
        return None
    return float(np.quantile(np.asarray(values), quantile))


class PredictionAccumulator:
    def __init__(self) -> None:
        self.count = 0
        self.absolute_error = 0.0
        self.squared_error = 0.0
        self.pinball = 0.0
        self.pinball_count = 0
        self.wis = 0.0
        self.interval_hits = 0
        self.direction_hits = 0
        self.quantile_hits = {quantile: 0 for quantile in FIXED_QUANTILES}

    def add(self, record: Mapping[str, Any]) -> None:
        if record.get("status") != "available":
            return
        actual = float(record["actualReturn"])
        quantiles = {
            float(key): float(value)
            for key, value in dict(record["returnQuantiles"]).items()
        }
        error = float(quantiles[0.5]) - actual
        self.count += 1
        self.absolute_error += abs(error)
        self.squared_error += error * error
        self.direction_hits += int((quantiles[0.5] > 0) == (actual > 0))
        self.interval_hits += int(quantiles[0.1] <= actual <= quantiles[0.9])
        self.wis += weighted_interval_score(actual, quantiles)
        for quantile in FIXED_QUANTILES:
            self.quantile_hits[quantile] += int(actual <= quantiles[quantile])
            self.pinball += pinball_loss(
                actual,
                quantiles[quantile],
                quantile,
            )
            self.pinball_count += 1

    def summary(self) -> dict[str, Any]:
        if self.count == 0:
            return summarize_prediction_records(())
        return {
            "count": self.count,
            "mae": self.absolute_error / self.count,
            "rmse": math.sqrt(self.squared_error / self.count),
            "meanPinballLoss": self.pinball / self.pinball_count,
            "wis": self.wis / self.count,
            "coverage": self.interval_hits / self.count,
            "calibrationError": sum(
                abs(self.quantile_hits[quantile] / self.count - quantile)
                for quantile in FIXED_QUANTILES
            )
            / len(FIXED_QUANTILES),
            "directionAccuracy": self.direction_hits / self.count,
        }


class OnlineTradingAccumulator:
    def __init__(self, cost_scale: float) -> None:
        self.cost_scale = cost_scale
        self.next_available = {symbol: -1 for symbol in SYMBOLS}
        self.returns: list[float] = []
        self.gross_returns: list[float] = []
        self.holding: list[int] = []
        self.turnover = 0.0
        self.equity = 1.0
        self.gross_equity = 1.0
        self.peak = 1.0
        self.drawdown = 0.0
        self.wins = 0

    def add_task(self, candidates: Sequence[Mapping[str, Any]]) -> None:
        available = [
            item
            for item in candidates
            if item.get("status") == "available"
            and item.get("executionStatus", "available") == "available"
            and item.get("nextBarClose") is not None
            and item.get("targetClose") is not None
        ]
        if not available:
            return
        symbol = str(available[0]["symbol"])
        origin = str(available[0]["origin"])
        origin_ms = int(from_iso(origin).timestamp() * 1_000)
        if origin_ms < self.next_available[symbol]:
            return
        base_cost = (
            (4 * 2 + 2 + 1 * 2 + 2) / 10_000 * self.cost_scale
        )
        best: tuple[float, int, int, float] | None = None
        for record in available:
            quantiles = {
                float(key): float(value)
                for key, value in dict(record["returnQuantiles"]).items()
            }
            q50 = quantiles[0.5]
            horizon = int(record["horizonMinutes"])
            funding = (
                abs(float(record.get("fundingRate") or 0)) * horizon / 480
            )
            threshold = base_cost + funding
            long_probability = 1 - quantile_cdf(quantiles, threshold)
            short_probability = quantile_cdf(quantiles, -threshold)
            side = 1 if long_probability >= short_probability else -1
            probability = max(long_probability, short_probability)
            expected_net = abs(q50) - threshold
            tail = (
                max(1e-9, -quantiles[0.1])
                if side > 0
                else max(1e-9, quantiles[0.9])
            )
            score = expected_net / tail * probability
            if (
                probability >= 0.62
                and expected_net > 0
                and (best is None or score > best[0])
            ):
                best = (score, horizon, side, threshold)
        if best is None:
            return
        _, horizon, side, threshold = best
        selected = next(
            value
            for value in available
            if int(value["horizonMinutes"]) == horizon
        )
        entry = float(selected["nextBarClose"])
        exit_price = float(selected["targetClose"])
        gross = (
            exit_price / entry - 1
            if side > 0
            else entry / exit_price - 1
        )
        net = gross - threshold
        self.gross_returns.append(gross)
        self.returns.append(net)
        self.holding.append(horizon)
        self.turnover += 2
        self.next_available[symbol] = origin_ms + horizon * 60_000
        self.gross_equity *= 1 + gross
        self.equity *= 1 + net
        self.peak = max(self.peak, self.equity)
        self.drawdown = max(
            self.drawdown,
            (self.peak - self.equity) / self.peak,
        )
        self.wins += int(net > 0)

    def summary(self) -> dict[str, Any]:
        standard_deviation = (
            statistics.stdev(self.returns) if len(self.returns) > 1 else 0
        )
        sharpe = (
            statistics.mean(self.returns)
            / standard_deviation
            * math.sqrt(365 * 24 * 4)
            if standard_deviation > 0
            else None
        )
        return {
            "grossReturn": self.gross_equity - 1,
            "netReturn": self.equity - 1,
            "sharpe": sharpe,
            "maxDrawdown": self.drawdown,
            "winRate": (
                self.wins / len(self.returns) if self.returns else None
            ),
            "tradeCount": len(self.returns),
            "turnover": self.turnover,
            "averageHoldingMinutes": (
                statistics.mean(self.holding) if self.holding else None
            ),
            "costDrag": max(0, self.gross_equity - self.equity),
        }


class PartialMetricsAccumulator:
    def __init__(self, records: Sequence[Mapping[str, Any]] = ()) -> None:
        self.prediction = PredictionAccumulator()
        self.trading = {
            scale: OnlineTradingAccumulator(scale)
            for scale in (1.0, 1.5, 2.0)
        }
        self.add(records)

    def add(self, records: Sequence[Mapping[str, Any]]) -> None:
        grouped: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
        for record in records:
            self.prediction.add(record)
            grouped.setdefault(
                (str(record.get("symbol")), str(record.get("origin"))),
                [],
            ).append(record)
        for candidates in grouped.values():
            for accumulator in self.trading.values():
                accumulator.add_task(candidates)

    def summary(self) -> dict[str, Any]:
        return {
            "prediction": self.prediction.summary(),
            "trading": self.trading[1.0].summary(),
            "costStress": {
                "base": self.trading[1.0].summary(),
                "spreadSlippage1_5x": self.trading[1.5].summary(),
                "spreadSlippage2x": self.trading[2.0].summary(),
            },
        }


def trading_metrics(
    records: Sequence[Mapping[str, Any]],
    *,
    cost_scale: float = 1.0,
) -> dict[str, Any]:
    available = [
        item
        for item in records
        if item.get("status") == "available"
        and item.get("executionStatus", "available") == "available"
        and item.get("nextBarClose") is not None
        and item.get("targetClose") is not None
    ]
    grouped: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for record in available:
        grouped.setdefault(
            (str(record["symbol"]), str(record["origin"])),
            [],
        ).append(record)
    next_available: dict[str, int] = {symbol: -1 for symbol in SYMBOLS}
    returns: list[float] = []
    gross_returns: list[float] = []
    holding: list[int] = []
    turnover = 0.0
    base_cost = (4 * 2 + 2 + 1 * 2 + 2) / 10_000 * cost_scale
    for (symbol, origin), candidates in sorted(
        grouped.items(), key=lambda item: item[0][1]
    ):
        origin_ms = int(from_iso(origin).timestamp() * 1_000)
        if origin_ms < next_available[symbol]:
            continue
        best: tuple[float, int, int, float] | None = None
        for record in candidates:
            quantiles = {
                float(key): float(value)
                for key, value in dict(record["returnQuantiles"]).items()
            }
            q50 = quantiles[0.5]
            horizon = int(record["horizonMinutes"])
            funding = abs(float(record.get("fundingRate") or 0)) * horizon / 480
            threshold = base_cost + funding
            long_probability = 1 - quantile_cdf(quantiles, threshold)
            short_probability = quantile_cdf(quantiles, -threshold)
            side = 1 if long_probability >= short_probability else -1
            probability = max(long_probability, short_probability)
            expected_net = abs(q50) - threshold
            tail = max(1e-9, -quantiles[0.1]) if side > 0 else max(1e-9, quantiles[0.9])
            score = expected_net / tail * probability
            if (
                probability >= 0.62
                and expected_net > 0
                and (best is None or score > best[0])
            ):
                best = (score, horizon, side, threshold)
        if best is None:
            continue
        _, horizon, side, threshold = best
        record = next(
            value for value in candidates if int(value["horizonMinutes"]) == horizon
        )
        entry = float(record["nextBarClose"])
        exit_price = float(record["targetClose"])
        gross = exit_price / entry - 1 if side > 0 else entry / exit_price - 1
        net = gross - threshold
        gross_returns.append(gross)
        returns.append(net)
        holding.append(horizon)
        turnover += 2
        next_available[symbol] = origin_ms + horizon * 60_000
    equity = 1.0
    gross_equity = 1.0
    peak = 1.0
    drawdown = 0.0
    for gross, net in zip(gross_returns, returns, strict=True):
        gross_equity *= 1 + gross
        equity *= 1 + net
        peak = max(peak, equity)
        drawdown = max(drawdown, (peak - equity) / peak)
    standard_deviation = statistics.stdev(returns) if len(returns) > 1 else 0
    sharpe = (
        statistics.mean(returns) / standard_deviation * math.sqrt(365 * 24 * 4)
        if standard_deviation > 0
        else None
    )
    wins = sum(value > 0 for value in returns)
    return {
        "grossReturn": gross_equity - 1,
        "netReturn": equity - 1,
        "sharpe": sharpe,
        "maxDrawdown": drawdown,
        "winRate": wins / len(returns) if returns else None,
        "tradeCount": len(returns),
        "turnover": turnover,
        "averageHoldingMinutes": statistics.mean(holding) if holding else None,
        "costDrag": max(0, gross_equity - equity),
    }


def summarize_records(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    prediction = summarize_prediction_records(records)
    by_horizon = {
        str(horizon): summarize_prediction_records(
            [item for item in records if item.get("horizonMinutes") == horizon]
        )
        for horizon in EVALUATION_HORIZONS_MINUTES
    }
    by_symbol = {
        symbol: summarize_prediction_records(
            [item for item in records if item.get("symbol") == symbol]
        )
        for symbol in SYMBOLS
    }
    return {
        "prediction": prediction,
        "predictionByHorizon": by_horizon,
        "predictionBySymbol": by_symbol,
        "trading": trading_metrics(records),
        "costStress": {
            "base": trading_metrics(records, cost_scale=1),
            "spreadSlippage1_5x": trading_metrics(records, cost_scale=1.5),
            "spreadSlippage2x": trading_metrics(records, cost_scale=2),
        },
    }


def update_combination_metrics(
    state: PipelineState,
    combination_value: dict[str, Any],
    metrics: PartialMetricsAccumulator,
    latencies: Sequence[float],
    started: float,
    processed_since_update: int,
) -> None:
    elapsed_ms = int((time.monotonic() - started) * 1_000)
    completed = combination_value["completedOrigins"]
    total = combination_value["totalOrigins"]
    rate = completed / max(0.001, elapsed_ms / 1_000)
    summary = metrics.summary()
    combination_value.update(
        {
            "elapsedMs": elapsed_ms,
            "progressPercent": completed / max(1, total) * 100,
            "etaMs": (int((total - completed) / rate * 1_000) if rate > 0 else None),
            "latencyP50Ms": percentile(latencies, 0.5),
            "latencyP95Ms": percentile(latencies, 0.95),
            "throughputOriginsPerSecond": rate,
            "partialPrediction": summary["prediction"],
            "partialTrading": summary["trading"],
        }
    )
    observed = telemetry()
    if observed:
        combination_value["peakVramMiB"] = max(
            combination_value.get("peakVramMiB") or 0,
            observed["memoryUsedMiB"],
        )
        combination_value["peakRamMiB"] = max(
            combination_value.get("peakRamMiB") or 0,
            observed["ramUsedMiB"],
        )
        observed["inferenceOriginsPerSecond"] = rate
        state.value["telemetry"] = observed
    state.value["experiment"]["inferenceOriginsProcessed"] += processed_since_update
    state.value["experiment"]["inferenceThroughputOriginsPerSecond"] = rate
    state.save()


def _task_key(task: tuple[str, int, str | None]) -> str:
    return f"{task[0]}|{task[1]}"


def _completed_task_digest(
    tasks: Sequence[tuple[str, int, str | None]],
    completed_count: int,
) -> str:
    payload = "\n".join(_task_key(task) for task in tasks[:completed_count])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _checkpoint_completed_count(
    checkpoint_path: Path,
    tasks: Sequence[tuple[str, int, str | None]],
    combination_id: str,
) -> int:
    if not checkpoint_path.exists():
        return 0
    checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    if checkpoint.get("combinationId") != combination_id:
        raise ValueError("combination checkpoint identity is inconsistent")
    if checkpoint.get("schemaVersion") == "cadence-context-checkpoint/v2":
        completed_count = int(checkpoint.get("completedTaskCount", -1))
        if not 0 <= completed_count <= len(tasks):
            raise ValueError("combination checkpoint cursor is out of range")
        expected_digest = _completed_task_digest(tasks, completed_count)
        if checkpoint.get("completedTasksDigest") != expected_digest:
            raise ValueError("combination checkpoint task prefix digest is invalid")
        expected_last = (
            _task_key(tasks[completed_count - 1]) if completed_count else None
        )
        if checkpoint.get("lastCompletedTaskKey") != expected_last:
            raise ValueError("combination checkpoint last task is inconsistent")
        return completed_count

    # v1 stored every completed task. Normalize it to a compact, deterministic
    # prefix cursor without invalidating already-running benchmark artifacts.
    completed_keys = {
        str(value) for value in checkpoint.get("completedTasks", ())
    }
    completed_count = 0
    while (
        completed_count < len(tasks)
        and _task_key(tasks[completed_count]) in completed_keys
    ):
        completed_count += 1
    unexpected = completed_keys - {
        _task_key(task) for task in tasks[:completed_count]
    }
    if unexpected:
        raise ValueError("legacy checkpoint completed tasks are not a prefix")
    return completed_count


def _write_combination_checkpoint(
    checkpoint_path: Path,
    combination_id: str,
    tasks: Sequence[tuple[str, int, str | None]],
    completed_count: int,
) -> None:
    atomic_json(
        checkpoint_path,
        {
            "schemaVersion": "cadence-context-checkpoint/v2",
            "combinationId": combination_id,
            "completedTaskCount": completed_count,
            "lastCompletedTaskKey": (
                _task_key(tasks[completed_count - 1])
                if completed_count
                else None
            ),
            "completedTasksDigest": _completed_task_digest(
                tasks,
                completed_count,
            ),
            "executionOptimizationVersion": (
                EXECUTION_OPTIMIZATION_VERSION
            ),
            "updatedAt": iso(datetime.now(UTC)),
        },
    )


def _completed_task_count_from_records(
    records: Sequence[Mapping[str, Any]],
    tasks: Sequence[tuple[str, int, str | None]],
) -> int:
    horizon_count = len(EVALUATION_HORIZONS_MINUTES)
    if len(records) % horizon_count:
        raise ValueError("prediction artifact ends inside a task record group")
    completed_count = len(records) // horizon_count
    if completed_count > len(tasks):
        raise ValueError("prediction artifact contains more tasks than planned")
    for index in range(completed_count):
        task_records = records[
            index * horizon_count : (index + 1) * horizon_count
        ]
        expected_key = _task_key(tasks[index])
        observed_keys = {
            f"{record.get('symbol')}|"
            f"{int(from_iso(str(record.get('origin'))).timestamp() * 1_000)}"
            for record in task_records
        }
        if observed_keys != {expected_key}:
            raise ValueError(
                "prediction artifact task order differs from the plan"
            )
        observed_horizons = tuple(
            int(record.get("horizonMinutes", -1))
            for record in task_records
        )
        if observed_horizons != EVALUATION_HORIZONS_MINUTES:
            raise ValueError(
                "prediction artifact horizon order differs from the contract"
            )
    return completed_count


def _prepare_forecast_task(
    repository: DataRepository,
    combination_value: Mapping[str, Any],
    task: tuple[str, int, str | None],
) -> PreparedForecastTask:
    symbol, origin_ms, window = task
    try:
        bars, origin_close, funding = repository.bars(
            symbol,
            int(combination_value["cadenceSeconds"]),
            origin_ms,
            int(combination_value["contextBars"]),
        )
    except ValueError as error:
        return PreparedForecastTask(
            symbol=symbol,
            origin_ms=origin_ms,
            screening_window=window,
            bars=None,
            origin_close=None,
            funding=None,
            unavailable_reason=str(error),
        )
    return PreparedForecastTask(
        symbol=symbol,
        origin_ms=origin_ms,
        screening_window=window,
        bars=bars,
        origin_close=origin_close,
        funding=funding,
        unavailable_reason=None,
    )


def _task_batches(
    tasks: Sequence[tuple[str, int, str | None]],
    batch_size: int,
) -> list[tuple[tuple[str, int, str | None], ...]]:
    return [
        tuple(tasks[offset : offset + batch_size])
        for offset in range(0, len(tasks), batch_size)
    ]


def _unavailable_task_records(
    combination_value: Mapping[str, Any],
    task: PreparedForecastTask,
) -> list[dict[str, Any]]:
    return [
        {
            "status": "unavailable",
            "combinationId": combination_value["id"],
            "model": combination_value["model"],
            "contextBars": combination_value["contextBars"],
            "cadenceSeconds": combination_value["cadenceSeconds"],
            "predictionLengthSteps": combination_value[
                "predictionLengthSteps"
            ],
            "symbol": task.symbol,
            "origin": iso_ms(task.origin_ms),
            "horizonMinutes": horizon,
            "reason": task.unavailable_reason,
            "screeningWindow": task.screening_window,
            "executionOptimizationVersion": (
                EXECUTION_OPTIMIZATION_VERSION
            ),
        }
        for horizon in EVALUATION_HORIZONS_MINUTES
    ]


def _available_task_records(
    repository: DataRepository,
    combination_value: Mapping[str, Any],
    task: PreparedForecastTask,
    series: Mapping[str, Any],
    model: Mapping[str, Any],
    *,
    request_latency_ms: float,
    inference_batch_size: int,
) -> list[dict[str, Any]]:
    if task.origin_close is None:
        raise RuntimeError("prepared forecast task is missing its origin close")
    cadence = int(combination_value["cadenceSeconds"])
    context = int(combination_value["contextBars"])
    returned_horizons = tuple(
        int(item["horizon_minutes"]) for item in series["horizons"]
    )
    if returned_horizons != EVALUATION_HORIZONS_MINUTES:
        raise RuntimeError(
            "worker silently truncated or reordered the requested horizon"
        )
    try:
        next_close = repository.value_at(
            task.symbol,
            cadence,
            task.origin_ms + cadence * 1_000,
        )
        execution_unavailable_reason = None
    except ValueError:
        next_close = None
        execution_unavailable_reason = (
            "strict next-cadence fill candle is unavailable; "
            "no interpolation applied"
        )
    amortized_latency_ms = request_latency_ms / inference_batch_size
    produced: list[dict[str, Any]] = []
    for horizon in series["horizons"]:
        minutes = int(horizon["horizon_minutes"])
        expected_target_ms = task.origin_ms + minutes * 60_000
        returned_target_ms = int(
            from_iso(str(horizon["target_timestamp"])).timestamp() * 1_000
        )
        if returned_target_ms != expected_target_ms:
            raise RuntimeError(
                "worker returned a mismatched horizon target timestamp"
            )
        fixed = {
            str(value["quantile"]): float(value["value"])
            for value in horizon["return_quantiles"]
        }
        native = {
            str(value["quantile"]): float(value["value"])
            for value in horizon.get("native_return_quantiles", [])
        }
        common = {
            "combinationId": combination_value["id"],
            "model": combination_value["model"],
            "modelId": model["model_id"],
            "modelRevision": model["model_revision"],
            "contextBars": context,
            "cadenceSeconds": cadence,
            "predictionLengthSteps": prediction_steps(cadence),
            "symbol": task.symbol,
            "origin": iso_ms(task.origin_ms),
            "horizonMinutes": minutes,
            "targetTimestamp": iso_ms(expected_target_ms),
            "returnQuantiles": fixed,
            "nativeReturnQuantiles": native,
            "originClose": task.origin_close,
            "nextBarClose": next_close,
            "fundingRate": task.funding,
            "latencyMs": amortized_latency_ms,
            "requestLatencyMs": request_latency_ms,
            "inferenceBatchSize": inference_batch_size,
            "screeningWindow": task.screening_window,
            "executionOptimizationVersion": (
                EXECUTION_OPTIMIZATION_VERSION
            ),
        }
        try:
            target_close = repository.value_at(
                task.symbol,
                cadence,
                expected_target_ms,
            )
        except ValueError:
            produced.append(
                {
                    **common,
                    "status": "unavailable",
                    "reason": (
                        "realized target candle is unavailable; "
                        "no interpolation applied"
                    ),
                    "actualReturn": None,
                    "targetClose": None,
                    "executionStatus": "unavailable",
                    "executionUnavailableReason": (
                        "realized target candle is unavailable; "
                        "no interpolation applied"
                    ),
                }
            )
            continue
        produced.append(
            {
                **common,
                "status": "available",
                "actualReturn": target_close / task.origin_close - 1,
                "targetClose": target_close,
                "executionStatus": (
                    "available" if next_close is not None else "unavailable"
                ),
                "executionUnavailableReason": execution_unavailable_reason,
            }
        )
    return produced


def run_combination(
    state: PipelineState,
    repository: DataRepository,
    client: WorkerClient,
    combination_value: dict[str, Any],
    origin_values: Sequence[tuple[int, str | None]],
    output_dir: Path,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    prediction_path = output_dir / "predictions.jsonl"
    checkpoint_path = output_dir / "checkpoint.json"
    summary_path = output_dir / "summary.json"
    tasks = [
        (symbol, origin_ms, window)
        for origin_ms, window in origin_values
        for symbol in SYMBOLS
    ]
    completed_count = _checkpoint_completed_count(
        checkpoint_path,
        tasks,
        str(combination_value["id"]),
    )
    if completed_count == len(tasks) and summary_path.is_file():
        # Completed matrix cells are immutable artifacts. A later runner
        # optimization must skip them rather than relabel old batch-1 results
        # with the active batch-4 execution provenance.
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        combination_value.update(
            {
                "status": "completed",
                "totalOrigins": len(tasks),
                "completedOrigins": len(tasks),
                "progressPercent": 100,
                "currentSymbol": None,
                "currentOrigin": None,
                "etaMs": 0,
                "partialPrediction": summary.get("prediction"),
                "partialTrading": summary.get("trading"),
            }
        )
        state.save()
        return summary
    records = read_jsonl(prediction_path)
    artifact_completed_count = _completed_task_count_from_records(
        records,
        tasks,
    )
    if artifact_completed_count < completed_count:
        raise ValueError(
            "prediction artifact is behind the durable checkpoint cursor"
        )
    if artifact_completed_count > completed_count:
        # A process may exit after fsync(predictions.jsonl) and before the
        # atomic checkpoint replacement. The task order/horizons above prove
        # that this is a complete causal batch, so advance rather than repeat.
        completed_count = artifact_completed_count
        _write_combination_checkpoint(
            checkpoint_path,
            str(combination_value["id"]),
            tasks,
            completed_count,
        )
    latencies = [
        float(item.get("latencyMs") or 0)
        for item in records
        if item.get("latencyMs") is not None
    ][:: len(EVALUATION_HORIZONS_MINUTES)]
    partial_metrics = PartialMetricsAccumulator(records)
    task_batch_size = (
        CHRONOS2_TASK_BATCH_SIZE
        if combination_value["model"] == "chronos-2"
        else 1
    )
    # Warm immutable NumPy arrays before prefetch threads begin. This avoids
    # duplicate first-use cache construction without changing causal slices.
    cadence = int(combination_value["cadenceSeconds"])
    if hasattr(repository, "candles") and hasattr(repository, "return_features"):
        for symbol in SYMBOLS:
            repository.candles(symbol, cadence)
            repository.return_features(symbol, cadence)
    combination_value.update(
        {
            "status": "running",
            "attempt": min(3, int(combination_value["attempt"]) + 1),
            "totalOrigins": len(tasks),
            "completedOrigins": completed_count,
            "failureReason": None,
            "executionOptimizationVersion": (
                EXECUTION_OPTIMIZATION_VERSION
            ),
            "inferenceBatchSize": task_batch_size,
        }
    )
    state.value["experiment"]["currentCombinationId"] = combination_value["id"]
    started = time.monotonic()
    next_status_at = started
    processed_since_update = 0
    state.save()
    pending_batches = _task_batches(tasks[completed_count:], task_batch_size)
    with ThreadPoolExecutor(
        max_workers=CHRONOS2_PREFETCH_WORKERS,
        thread_name_prefix="chronos2-prefetch",
    ) as executor:
        prepared_futures: list[Future[PreparedForecastTask]] = []
        if pending_batches:
            prepared_futures = [
                executor.submit(
                    _prepare_forecast_task,
                    repository,
                    combination_value,
                    task,
                )
                for task in pending_batches[0]
            ]
        for batch_index, raw_batch in enumerate(pending_batches):
            if (state.run_dir / "STOP").exists():
                raise KeyboardInterrupt("graceful stop marker detected")
            prepared = [future.result() for future in prepared_futures]
            # Fill the following model batch while the current WebSocket call
            # occupies the GPU. Only finalized, causal slices are prefetched.
            if batch_index + 1 < len(pending_batches):
                prepared_futures = [
                    executor.submit(
                        _prepare_forecast_task,
                        repository,
                        combination_value,
                        task,
                    )
                    for task in pending_batches[batch_index + 1]
                ]
            else:
                prepared_futures = []

            first = prepared[0]
            combination_value["currentSymbol"] = first.symbol
            combination_value["currentOrigin"] = iso_ms(first.origin_ms)
            state.value["experiment"]["currentSymbol"] = first.symbol
            state.value["experiment"]["currentOrigin"] = iso_ms(first.origin_ms)
            produced_by_task: dict[str, list[dict[str, Any]]] = {}
            available_tasks = [
                task for task in prepared if task.bars is not None
            ]
            for task in prepared:
                if task.bars is None:
                    produced_by_task[task.key] = (
                        _unavailable_task_records(
                            combination_value, task
                        )
                    )
            if available_tasks:
                payload = request_payload_batch(
                    combination_value,
                    available_tasks,
                )
                response: dict[str, Any] | None = None
                request_latency_ms = 0.0
                last_error: BaseException | None = None
                for retry in range(MAX_REQUEST_RETRIES + 1):
                    try:
                        request_started = time.monotonic()
                        response = client.request(payload)
                        request_latency_ms = (
                            time.monotonic() - request_started
                        ) * 1_000
                        break
                    except Exception as error:
                        last_error = error
                        combination_value["retryCount"] += 1
                        combination_value["status"] = "retrying"
                        state.save()
                        time.sleep(min(5, 2**retry))
                if response is None:
                    raise RuntimeError(
                        "worker request failed after retries: "
                        f"{last_error}"
                    )
                combination_value["status"] = "running"
                if response.get("status") == "unavailable":
                    detail = response.get("error") or {}
                    raise RuntimeError(
                        "worker returned unavailable: "
                        f"{detail.get('code', 'UNKNOWN')} "
                        f"{detail.get('message', '')}"
                    )
                model = response["model"]
                expected_model_id = MODEL_IDS[
                    str(combination_value["model"])
                ]
                if model.get("model_id") != expected_model_id:
                    raise RuntimeError("worker returned the wrong model lane")
                expected_revision = (
                    FINCAST_REVISION
                    if combination_value["model"] == "fincast"
                    else CHRONOS2_MODEL_REVISION
                )
                if model.get("model_revision") != expected_revision:
                    raise RuntimeError(
                        "worker returned an unpinned model revision"
                    )
                response_series = list(response.get("series", ()))
                if len(response_series) != len(available_tasks):
                    raise RuntimeError(
                        "worker returned a mismatched series batch size"
                    )
                by_instrument = {
                    str(item.get("instrument_key")): item
                    for item in response_series
                    if item.get("instrument_key") is not None
                }
                if len(by_instrument) != len(response_series):
                    # Kept only for focused legacy fake clients; production
                    # SeriesForecastResult always includes instrument_key.
                    by_instrument = {
                        task.instrument_key: series
                        for task, series in zip(
                            available_tasks,
                            response_series,
                            strict=True,
                        )
                    }
                for task in available_tasks:
                    series = by_instrument.get(task.instrument_key)
                    if series is None:
                        raise RuntimeError(
                            "worker returned misaligned batch instrument keys"
                        )
                    if series.get("status") != "available":
                        detail = series.get("unavailable") or {}
                        raise RuntimeError(
                            "series unavailable: "
                            f"{detail.get('code', 'UNKNOWN')} "
                            f"{detail.get('message', '')}"
                        )
                    produced_by_task[task.key] = (
                        _available_task_records(
                            repository,
                            combination_value,
                            task,
                            series,
                            model,
                            request_latency_ms=request_latency_ms,
                            inference_batch_size=len(available_tasks),
                        )
                    )
                latencies.extend(
                    request_latency_ms / len(available_tasks)
                    for _task in available_tasks
                )

            produced = [
                record
                for task in prepared
                for record in produced_by_task[task.key]
            ]
            append_jsonl(prediction_path, produced)
            records.extend(produced)
            partial_metrics.add(produced)
            completed_count += len(raw_batch)
            processed_since_update += len(raw_batch)
            combination_value["completedOrigins"] = completed_count
            _write_combination_checkpoint(
                checkpoint_path,
                str(combination_value["id"]),
                tasks,
                completed_count,
            )
            now = time.monotonic()
            if (
                now >= next_status_at
                or completed_count == len(tasks)
            ):
                update_combination_metrics(
                    state,
                    combination_value,
                    partial_metrics,
                    latencies,
                    started,
                    processed_since_update,
                )
                processed_since_update = 0
                next_status_at = now + STATUS_UPDATE_INTERVAL_SECONDS
    summary = summarize_records(records)
    summary.update(
        {
            "schemaVersion": "cadence-context-combination-summary/v1",
            "combination": {
                key: combination_value[key]
                for key in (
                    "id",
                    "model",
                    "contextBars",
                    "cadenceSeconds",
                    "lookbackSeconds",
                    "predictionLengthSteps",
                )
            },
            "recordCount": len(records),
            "availableRatio": (
                sum(item.get("status") == "available" for item in records)
                / max(1, len(records))
            ),
            "execution": {
                "wallClockMs": combination_value["elapsedMs"],
                "latencyP50Ms": combination_value["latencyP50Ms"],
                "latencyP95Ms": combination_value["latencyP95Ms"],
                "throughputOriginsPerSecond": combination_value[
                    "throughputOriginsPerSecond"
                ],
                "peakVramMiB": combination_value["peakVramMiB"],
                "peakRamMiB": combination_value["peakRamMiB"],
                "retryCount": combination_value["retryCount"],
                "optimizationVersion": (
                    EXECUTION_OPTIMIZATION_VERSION
                ),
                "taskBatchSize": task_batch_size,
                "prefetchWorkers": CHRONOS2_PREFETCH_WORKERS,
                "checkpointSchemaVersion": (
                    "cadence-context-checkpoint/v2"
                ),
            },
        }
    )
    windows = sorted(
        {
            str(item["screeningWindow"])
            for item in records
            if item.get("screeningWindow")
        }
    )
    if windows:
        summary["byScreeningWindow"] = {
            window: summarize_records(
                [item for item in records if item.get("screeningWindow") == window]
            )
            for window in windows
        }
    atomic_json(summary_path, summary)
    combination_value.update(
        {
            "status": "completed",
            "progressPercent": 100,
            "currentSymbol": None,
            "currentOrigin": None,
            "etaMs": 0,
            "partialPrediction": summary["prediction"],
            "partialTrading": summary["trading"],
        }
    )
    state.save()
    return summary


def run_combination_resilient(
    state: PipelineState,
    repository: DataRepository,
    client: WorkerClient,
    combination_value: dict[str, Any],
    origin_values: Sequence[tuple[int, str | None]],
    output_dir: Path,
) -> dict[str, Any]:
    """Run one matrix cell with one bounded combination-level retry.

    Individual WebSocket requests already retry twice. This outer retry is
    only for transient connection/runtime failures and resumes from the
    atomic combination checkpoint. Deterministic contract, OOM, non-finite,
    and alignment failures fail closed without a repeated expensive attempt.
    """

    deterministic_markers = (
        "out of memory",
        "oom",
        "unsupported",
        "not support",
        "nan",
        "non-finite",
        "timestamp",
        "horizon",
        "lookahead",
        "future",
        "wrong model",
        "unpinned",
        "silently truncated",
    )
    last_error: BaseException | None = None
    for combination_attempt in range(2):
        try:
            return run_combination(
                state,
                repository,
                client,
                combination_value,
                origin_values,
                output_dir,
            )
        except KeyboardInterrupt:
            raise
        except BaseException as error:
            last_error = error
            rendered = f"{type(error).__name__}: {error}"
            lower = rendered.lower()
            client.close()
            if combination_attempt == 0 and not any(
                marker in lower for marker in deterministic_markers
            ):
                combination_value["status"] = "retrying"
                combination_value["failureReason"] = rendered[:2_000]
                state.log(
                    f"{combination_value['id']} transient combination failure; "
                    "checkpoint retry 1/1"
                )
                state.save()
                time.sleep(2)
                continue
            break
    assert last_error is not None
    rendered = f"{type(last_error).__name__}: {last_error}"
    summary = {
        "schemaVersion": "cadence-context-combination-summary/v1",
        "combination": {
            key: combination_value[key]
            for key in (
                "id",
                "model",
                "contextBars",
                "cadenceSeconds",
                "lookbackSeconds",
                "predictionLengthSteps",
            )
        },
        "recordCount": 0,
        "availableRatio": 0,
        "prediction": summarize_prediction_records([]),
        "predictionByHorizon": {
            str(horizon): summarize_prediction_records([])
            for horizon in EVALUATION_HORIZONS_MINUTES
        },
        "predictionBySymbol": {
            symbol: summarize_prediction_records([]) for symbol in SYMBOLS
        },
        "trading": trading_metrics([]),
        "byScreeningWindow": {},
        "technicalFailure": {
            "type": type(last_error).__name__,
            "message": str(last_error)[:2_000],
        },
        "execution": {
            "wallClockMs": combination_value.get("elapsedMs", 0),
            "latencyP50Ms": combination_value.get("latencyP50Ms"),
            "latencyP95Ms": combination_value.get("latencyP95Ms"),
            "throughputOriginsPerSecond": combination_value.get(
                "throughputOriginsPerSecond"
            ),
            "peakVramMiB": combination_value.get("peakVramMiB"),
            "peakRamMiB": combination_value.get("peakRamMiB"),
            "retryCount": combination_value.get("retryCount", 0),
        },
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    atomic_json(output_dir / "summary.json", summary)
    combination_value.update(
        {
            "status": "failed",
            "failureReason": rendered[:2_000],
            "currentSymbol": None,
            "currentOrigin": None,
            "etaMs": None,
        }
    )
    state.value["experiment"]["currentSymbol"] = None
    state.value["experiment"]["currentOrigin"] = None
    state.log(f"{combination_value['id']} failed closed: {rendered}")
    state.save()
    return summary


def smoke_origins(
    repository: DataRepository,
    evaluation_end: datetime,
) -> list[tuple[int, str | None]]:
    common: np.ndarray | None = None
    for cadence in SUPPORTED_CADENCES:
        for symbol in SYMBOLS:
            values = contiguous_origin_times(
                repository.candles(symbol, cadence).close_time_ms,
                8192,
                cadence,
            )
            common = (
                values
                if common is None
                else np.intersect1d(common, values, assume_unique=True)
            )
    if common is None:
        raise ValueError("smoke origin search did not inspect any cadence")
    latest_target_ms = int(evaluation_end.timestamp() * 1_000) - 1
    candidates = common[(common + 60 * 60_000 <= latest_target_ms)]
    for raw_candidate in reversed(candidates.tolist()):
        candidate = int(raw_candidate)
        try:
            for cadence in SUPPORTED_CADENCES:
                for symbol in SYMBOLS:
                    repository.value_at(
                        symbol,
                        cadence,
                        candidate + cadence * 1_000,
                    )
                    repository.value_at(
                        symbol,
                        cadence,
                        candidate + 60 * 60_000,
                    )
        except ValueError:
            continue
        return [(candidate, None)]
    raise ValueError(
        "no common fully observed 8192-bar smoke origin exists before evaluation end"
    )


def screening_origins(
    windows: Sequence[Mapping[str, Any]],
) -> list[tuple[int, str | None]]:
    output: list[tuple[int, str | None]] = []
    for window in windows:
        start = from_iso(str(window["start"]))
        end = from_iso(str(window["endExclusive"]))
        output.extend(
            (value, str(window["regime"]))
            for value in origins(
                start,
                end,
                SCREENING_ORIGIN_INTERVAL_MINUTES,
            )
        )
    return output


def finite_number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    rendered = float(value)
    return rendered if math.isfinite(rendered) else None


def nested_metric(
    summary: Mapping[str, Any],
    section: str,
    metric: str,
) -> float | None:
    value = summary.get(section)
    if not isinstance(value, Mapping):
        return None
    return finite_number(value.get(metric))


def lower_is_better_improvement(
    candidate: float | None,
    comparator: float | None,
) -> float | None:
    if candidate is None or comparator is None or comparator <= 0:
        return None
    return (comparator - candidate) / comparator


def higher_is_better_delta(
    candidate: float | None,
    comparator: float | None,
) -> float | None:
    if candidate is None or comparator is None:
        return None
    return candidate - comparator


def technical_execution_ok(summary: Mapping[str, Any] | None) -> bool:
    if not summary or summary.get("technicalFailure"):
        return False
    available_ratio = finite_number(summary.get("availableRatio"))
    prediction_count = nested_metric(summary, "prediction", "count")
    if available_ratio is None or available_ratio <= 0:
        return False
    if prediction_count is None or prediction_count <= 0:
        return False
    for section, names in (
        (
            "prediction",
            (
                "meanPinballLoss",
                "wis",
                "directionAccuracy",
            ),
        ),
        ("trading", ("netReturn", "sharpe", "maxDrawdown")),
    ):
        raw_section = summary.get(section)
        if not isinstance(raw_section, Mapping):
            return False
        for name in names:
            raw = raw_section.get(name)
            if raw is not None and finite_number(raw) is None:
                return False
    return True


def best_comparator_id(
    metrics: Mapping[str, Mapping[str, Any]],
    candidates: Sequence[str],
) -> str | None:
    available = [
        combination_id
        for combination_id in candidates
        if technical_execution_ok(metrics.get(combination_id))
    ]
    if not available:
        return None

    def score(combination_id: str) -> tuple[float, float, str]:
        summary = metrics[combination_id]
        wis = nested_metric(summary, "prediction", "wis")
        pinball = nested_metric(summary, "prediction", "meanPinballLoss")
        return (
            wis if wis is not None else 1e100,
            pinball if pinball is not None else 1e100,
            combination_id,
        )

    return min(available, key=score)


def compare_summaries(
    candidate: Mapping[str, Any],
    comparator: Mapping[str, Any],
) -> dict[str, Any]:
    candidate_wis = nested_metric(candidate, "prediction", "wis")
    comparator_wis = nested_metric(comparator, "prediction", "wis")
    candidate_pinball = nested_metric(
        candidate,
        "prediction",
        "meanPinballLoss",
    )
    comparator_pinball = nested_metric(
        comparator,
        "prediction",
        "meanPinballLoss",
    )
    candidate_direction = nested_metric(
        candidate,
        "prediction",
        "directionAccuracy",
    )
    comparator_direction = nested_metric(
        comparator,
        "prediction",
        "directionAccuracy",
    )
    candidate_net = nested_metric(candidate, "trading", "netReturn")
    comparator_net = nested_metric(comparator, "trading", "netReturn")
    candidate_sharpe = nested_metric(candidate, "trading", "sharpe")
    comparator_sharpe = nested_metric(comparator, "trading", "sharpe")
    candidate_mdd = nested_metric(candidate, "trading", "maxDrawdown")
    comparator_mdd = nested_metric(comparator, "trading", "maxDrawdown")
    wis_improvement = lower_is_better_improvement(
        candidate_wis,
        comparator_wis,
    )
    pinball_improvement = lower_is_better_improvement(
        candidate_pinball,
        comparator_pinball,
    )
    direction_delta = higher_is_better_delta(
        candidate_direction,
        comparator_direction,
    )
    net_delta = higher_is_better_delta(candidate_net, comparator_net)
    sharpe_delta = higher_is_better_delta(
        candidate_sharpe,
        comparator_sharpe,
    )
    prediction_window_improvements = 0
    trading_window_improvements = 0
    three_percent_worse_windows = 0
    comparable_windows = 0
    per_window: dict[str, Any] = {}
    for regime in ("low", "medium", "high"):
        candidate_window = candidate.get("byScreeningWindow", {}).get(regime)
        comparator_window = comparator.get("byScreeningWindow", {}).get(regime)
        if not isinstance(candidate_window, Mapping) or not isinstance(
            comparator_window,
            Mapping,
        ):
            continue
        comparable_windows += 1
        window_wis = lower_is_better_improvement(
            nested_metric(candidate_window, "prediction", "wis"),
            nested_metric(comparator_window, "prediction", "wis"),
        )
        window_pinball = lower_is_better_improvement(
            nested_metric(
                candidate_window,
                "prediction",
                "meanPinballLoss",
            ),
            nested_metric(
                comparator_window,
                "prediction",
                "meanPinballLoss",
            ),
        )
        window_net = higher_is_better_delta(
            nested_metric(candidate_window, "trading", "netReturn"),
            nested_metric(comparator_window, "trading", "netReturn"),
        )
        window_sharpe = higher_is_better_delta(
            nested_metric(candidate_window, "trading", "sharpe"),
            nested_metric(comparator_window, "trading", "sharpe"),
        )
        prediction_improved = any(
            value is not None and value >= 0.01
            for value in (window_wis, window_pinball)
        )
        trading_improved = (
            window_net is not None
            and window_net > 0
            and window_sharpe is not None
            and window_sharpe >= 0.1
        )
        worse_three_percent = any(
            value is not None and value <= -0.03
            for value in (window_wis, window_pinball)
        )
        prediction_window_improvements += int(prediction_improved)
        trading_window_improvements += int(trading_improved)
        three_percent_worse_windows += int(worse_three_percent)
        per_window[regime] = {
            "wisImprovementRatio": window_wis,
            "meanPinballImprovementRatio": window_pinball,
            "netReturnDelta": window_net,
            "sharpeDelta": window_sharpe,
            "predictionImproved": prediction_improved,
            "tradingImproved": trading_improved,
            "threePercentWorse": worse_three_percent,
        }
    horizon_improvements = 0
    per_horizon: dict[str, Any] = {}
    for horizon in EVALUATION_HORIZONS_MINUTES:
        key = str(horizon)
        candidate_horizon = candidate.get("predictionByHorizon", {}).get(key)
        comparator_horizon = comparator.get("predictionByHorizon", {}).get(key)
        if not isinstance(candidate_horizon, Mapping) or not isinstance(
            comparator_horizon,
            Mapping,
        ):
            continue
        horizon_wis = lower_is_better_improvement(
            finite_number(candidate_horizon.get("wis")),
            finite_number(comparator_horizon.get("wis")),
        )
        horizon_pinball = lower_is_better_improvement(
            finite_number(candidate_horizon.get("meanPinballLoss")),
            finite_number(comparator_horizon.get("meanPinballLoss")),
        )
        improved = any(
            value is not None and value >= 0.01
            for value in (horizon_wis, horizon_pinball)
        )
        horizon_improvements += int(improved)
        per_horizon[key] = {
            "wisImprovementRatio": horizon_wis,
            "meanPinballImprovementRatio": horizon_pinball,
            "improved": improved,
        }
    candidate_latency = nested_metric(candidate, "execution", "latencyP95Ms")
    comparator_latency = nested_metric(
        comparator,
        "execution",
        "latencyP95Ms",
    )
    latency_ratio = (
        candidate_latency / comparator_latency
        if candidate_latency is not None
        and comparator_latency is not None
        and comparator_latency > 0
        else None
    )
    mdd_within_ten_percent = (
        True
        if candidate_mdd is None or comparator_mdd is None
        else candidate_mdd <= max(comparator_mdd * 1.1, comparator_mdd + 1e-9)
    )
    prediction_not_worse_one_percent = all(
        value is None or value >= -0.01
        for value in (wis_improvement, pinball_improvement)
    )
    return {
        "wisImprovementRatio": wis_improvement,
        "meanPinballImprovementRatio": pinball_improvement,
        "directionAccuracyDelta": direction_delta,
        "netReturnDelta": net_delta,
        "sharpeDelta": sharpe_delta,
        "maxDrawdownWithinTenPercent": mdd_within_ten_percent,
        "predictionNotWorseOnePercent": prediction_not_worse_one_percent,
        "predictionImprovedWindows": prediction_window_improvements,
        "tradingImprovedWindows": trading_window_improvements,
        "threePercentWorseWindows": three_percent_worse_windows,
        "comparableWindows": comparable_windows,
        "predictionImprovedHorizons": horizon_improvements,
        "latencyRatio": latency_ratio,
        "byWindow": per_window,
        "byHorizon": per_horizon,
    }


def common_screening_gate(
    candidate: Mapping[str, Any] | None,
    comparator: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if not technical_execution_ok(candidate):
        return {
            "decision": "excluded",
            "include": False,
            "reason": "기술적 실행 실패 또는 유효 예측 0건",
            "thresholdEvidence": {"technicalExecution": False},
        }
    if not technical_execution_ok(comparator):
        return {
            "decision": "excluded",
            "include": False,
            "reason": "필수 비교 조합의 screening 결과가 유효하지 않음",
            "thresholdEvidence": {"comparatorTechnicalExecution": False},
        }
    assert candidate is not None and comparator is not None
    evidence = compare_summaries(candidate, comparator)
    prediction_improvement = max(
        (
            value
            for value in (
                evidence["wisImprovementRatio"],
                evidence["meanPinballImprovementRatio"],
            )
            if value is not None
        ),
        default=-1e100,
    )
    direction_delta = evidence["directionAccuracyDelta"]
    net_delta = evidence["netReturnDelta"]
    sharpe_delta = evidence["sharpeDelta"]
    prediction_path = (
        prediction_improvement >= 0.01
        and direction_delta is not None
        and direction_delta >= -0.003
        and not (
            net_delta is not None
            and net_delta < 0
            and sharpe_delta is not None
            and sharpe_delta < 0
        )
        and evidence["predictionImprovedWindows"] >= 2
        and evidence["predictionImprovedHorizons"] >= 2
    )
    trading_path = (
        net_delta is not None
        and net_delta > 0
        and sharpe_delta is not None
        and sharpe_delta >= 0.1
        and evidence["maxDrawdownWithinTenPercent"]
        and evidence["predictionNotWorseOnePercent"]
        and evidence["tradingImprovedWindows"] >= 2
    )
    evidence["predictionPathPassed"] = prediction_path
    evidence["tradingPathPassed"] = trading_path
    no_direction_net_sharpe_improvement = all(
        value is None or value <= 0
        for value in (direction_delta, net_delta, sharpe_delta)
    )
    all_three_worse = (
        evidence["comparableWindows"] == 3
        and evidence["threePercentWorseWindows"] == 3
        and no_direction_net_sharpe_improvement
    )
    excessive_cost_without_gain = (
        evidence["latencyRatio"] is not None
        and evidence["latencyRatio"] >= 2
        and prediction_improvement < 0.01
    )
    one_window_only = max(
        evidence["predictionImprovedWindows"],
        evidence["tradingImprovedWindows"],
    ) == 1 and any(
        value is not None and value > 0
        for value in (
            evidence["wisImprovementRatio"],
            evidence["meanPinballImprovementRatio"],
            direction_delta,
            net_delta,
            sharpe_delta,
        )
    )
    no_performance_improvement = (
        prediction_improvement <= 0 and no_direction_net_sharpe_improvement
    )
    evidence.update(
        {
            "allThreeWindowsThreePercentWorse": all_three_worse,
            "excessiveCostWithoutOnePercentGain": excessive_cost_without_gain,
            "oneWindowOnlyDependence": one_window_only,
            "noPerformanceImprovement": no_performance_improvement,
        }
    )
    if prediction_path or trading_path:
        return {
            "decision": "passed",
            "include": True,
            "reason": (
                "공통 screening의 "
                f"{'예측' if prediction_path else '거래'} 성능 경로를 통과"
            ),
            "thresholdEvidence": evidence,
        }
    if all_three_worse:
        reason = "세 구간 모두 WIS/pinball≥3% 악화 및 방향·순수익·Sharpe 무개선"
    elif excessive_cost_without_gain:
        reason = "p95 latency가 비교 조합의 2배 이상이고 주요 개선이 1% 미만"
    elif one_window_only:
        reason = "개선이 screening 구간 하나의 움직임에만 의존"
    elif no_performance_improvement:
        reason = "방향 정확도·net return·Sharpe와 확률 지표가 모두 개선되지 않음"
    else:
        return {
            "decision": "borderline",
            "include": True,
            "reason": "명확한 기술 실패·자동 제외 기준이 없어 보수적으로 포함",
            "thresholdEvidence": evidence,
        }
    return {
        "decision": "excluded",
        "include": False,
        "reason": reason,
        "thresholdEvidence": evidence,
    }


def five_second_screening_gate(
    candidate: Mapping[str, Any] | None,
    comparator: Mapping[str, Any] | None,
) -> dict[str, Any]:
    common = common_screening_gate(candidate, comparator)
    if common["decision"] == "excluded":
        return common
    evidence = dict(common["thresholdEvidence"])
    best_prediction = max(
        (
            value
            for value in (
                evidence.get("wisImprovementRatio"),
                evidence.get("meanPinballImprovementRatio"),
            )
            if value is not None
        ),
        default=-1e100,
    )
    direction_path = (
        evidence.get("directionAccuracyDelta") is not None
        and evidence["directionAccuracyDelta"] >= 0.005
        and evidence["predictionNotWorseOnePercent"]
    )
    trading_path = (
        evidence.get("netReturnDelta") is not None
        and evidence["netReturnDelta"] > 0
        and evidence.get("sharpeDelta") is not None
        and evidence["sharpeDelta"] >= 0.1
        and evidence["maxDrawdownWithinTenPercent"]
    )
    consistent = (
        max(
            evidence["predictionImprovedWindows"],
            evidence["tradingImprovedWindows"],
        )
        >= 2
        and evidence["predictionImprovedHorizons"] >= 2
    )
    signal = best_prediction >= 0.01 or direction_path or trading_path
    evidence.update(
        {
            "fiveSecondSignalPassed": signal,
            "fiveSecondConsistencyPassed": consistent,
        }
    )
    if signal and consistent:
        return {
            "decision": "passed",
            "include": True,
            "reason": "5초 cadence 전용 성능·일관성 gate를 통과",
            "thresholdEvidence": evidence,
        }
    return {
        "decision": "excluded",
        "include": False,
        "reason": "5초 cadence 전용 개선·2/3 구간·2개 horizon gate를 충족하지 못함",
        "thresholdEvidence": evidence,
    }


def context_8192_screening_gate(
    candidate: Mapping[str, Any] | None,
    comparator: Mapping[str, Any] | None,
) -> dict[str, Any]:
    common = common_screening_gate(candidate, comparator)
    if common["decision"] == "excluded":
        return common
    evidence = dict(common["thresholdEvidence"])
    prediction_improvement = max(
        (
            value
            for value in (
                evidence.get("wisImprovementRatio"),
                evidence.get("meanPinballImprovementRatio"),
            )
            if value is not None
        ),
        default=-1e100,
    )
    direction_delta = evidence.get("directionAccuracyDelta")
    trading_signal = (
        evidence.get("netReturnDelta") is not None
        and evidence["netReturnDelta"] > 0
        and evidence.get("sharpeDelta") is not None
        and evidence["sharpeDelta"] > 0
        and evidence["predictionNotWorseOnePercent"]
    )
    strong_signal = (
        prediction_improvement >= 0.015
        or (direction_delta is not None and direction_delta >= 0.0075)
        or trading_signal
    )
    evidence["strong8192SignalPassed"] = strong_signal
    if common["decision"] == "passed" and strong_signal:
        return {
            "decision": "passed",
            "include": True,
            "reason": "8192 context의 강화된 성능·비용 gate를 통과",
            "thresholdEvidence": evidence,
        }
    return {
        "decision": "excluded",
        "include": False,
        "reason": "8192 context 강화 gate의 1.5% WIS/pinball·0.75%p 방향·거래 경로를 충족하지 못함",
        "thresholdEvidence": evidence,
    }


def candidate_gate(
    combination_id: str,
    metrics: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    comparator_candidates = CONDITIONAL_COMPARATORS[combination_id]
    if combination_id == "chronos2-c2048-s5":
        comparator_id = best_comparator_id(metrics, comparator_candidates)
    else:
        comparator_id = next(
            (
                item
                for item in comparator_candidates
                if technical_execution_ok(metrics.get(item))
            ),
            None,
        )
    if comparator_id is None:
        return {
            "decision": "excluded",
            "include": False,
            "reason": "유효한 필수 비교 조합이 없음",
            "comparatorId": None,
            "thresholdEvidence": {},
        }
    candidate = metrics.get(combination_id)
    comparator = metrics.get(comparator_id)
    if combination_id in {"chronos2-c2048-s5", "chronos2-c4096-s5"}:
        result = five_second_screening_gate(candidate, comparator)
        if combination_id == "chronos2-c4096-s5" and result["decision"] == "passed":
            best_15 = best_comparator_id(
                metrics,
                ("chronos2-c1024-s15", "chronos2-c4096-s15"),
            )
            if best_15 is not None:
                against_15 = five_second_screening_gate(
                    candidate,
                    metrics[best_15],
                )
                result["thresholdEvidence"]["best15ComparatorId"] = best_15
                result["thresholdEvidence"]["againstBest15"] = against_15[
                    "thresholdEvidence"
                ]
                if against_15["decision"] != "passed":
                    result = {
                        "decision": "excluded",
                        "include": False,
                        "reason": (
                            "4096×5초가 2048×5초보다 개선했지만 "
                            "최선 15초 조합 대비 전용 gate를 통과하지 못함"
                        ),
                        "thresholdEvidence": result["thresholdEvidence"],
                    }
    elif combination_id.startswith("chronos2-c8192-"):
        result = context_8192_screening_gate(candidate, comparator)
    else:
        result = common_screening_gate(candidate, comparator)
    return {"comparatorId": comparator_id, **result}


def materially_better(
    candidate: Mapping[str, Any] | None,
    comparator: Mapping[str, Any] | None,
) -> tuple[bool, dict[str, Any]]:
    if not technical_execution_ok(candidate) or not technical_execution_ok(comparator):
        return False, {"technicalComparison": False}
    assert candidate is not None and comparator is not None
    evidence = compare_summaries(candidate, comparator)
    prediction = max(
        (
            value
            for value in (
                evidence["wisImprovementRatio"],
                evidence["meanPinballImprovementRatio"],
            )
            if value is not None
        ),
        default=-1e100,
    )
    signal = (
        prediction >= 0.01
        or (
            evidence["directionAccuracyDelta"] is not None
            and evidence["directionAccuracyDelta"] >= 0.005
        )
        or (
            evidence["netReturnDelta"] is not None
            and evidence["netReturnDelta"] > 0
            and evidence["sharpeDelta"] is not None
            and evidence["sharpeDelta"] >= 0.1
        )
    )
    return signal, evidence


def within_one_percent_of_best(
    combination_id: str,
    metrics: Mapping[str, Mapping[str, Any]],
    candidate_ids: Sequence[str],
) -> tuple[bool, str | None]:
    best_id = best_comparator_id(metrics, candidate_ids)
    candidate = metrics.get(combination_id)
    best = metrics.get(best_id) if best_id is not None else None
    if not technical_execution_ok(candidate) or not technical_execution_ok(best):
        return False, best_id
    assert candidate is not None and best is not None
    candidate_wis = nested_metric(candidate, "prediction", "wis")
    best_wis = nested_metric(best, "prediction", "wis")
    candidate_pinball = nested_metric(
        candidate,
        "prediction",
        "meanPinballLoss",
    )
    best_pinball = nested_metric(best, "prediction", "meanPinballLoss")
    close = (
        candidate_wis is not None
        and best_wis is not None
        and candidate_wis <= best_wis * 1.01
    ) or (
        candidate_pinball is not None
        and best_pinball is not None
        and candidate_pinball <= best_pinball * 1.01
    )
    return close, best_id


def conditional_trigger(
    combination_id: str,
    metrics: Mapping[str, Mapping[str, Any]],
    gate_results: Mapping[str, Mapping[str, Any]],
) -> tuple[bool, str, dict[str, Any]]:
    if combination_id == "chronos2-c2048-s5":
        return (
            chronos2_direct_prediction_supported(5),
            "5초 데이터와 direct 720-step 지원 시 항상 screening",
            {"directPredictionSteps": 720},
        )
    if combination_id == "chronos2-c4096-s5":
        dependency = gate_results.get("chronos2-c2048-s5", {})
        passed = dependency.get("decision") == "passed"
        return (
            passed,
            (
                "2048×5초가 전용 gate를 통과"
                if passed
                else "2048×5초 gate 실패로 dependency_failed"
            ),
            {"dependencyDecision": dependency.get("decision")},
        )
    if combination_id == "chronos2-c2048-s15":
        first, first_evidence = materially_better(
            metrics.get("chronos2-c1024-s15"),
            metrics.get("chronos2-c1024-s30"),
        )
        default_chronos = [
            item
            for item in DEFAULT_FINAL_COMBINATION_IDS
            if item.startswith("chronos2-")
        ]
        candidate_rank_signal, best = within_one_percent_of_best(
            "chronos2-c4096-s15",
            metrics,
            default_chronos,
        )
        anchor, anchor_evidence = materially_better(
            metrics.get("chronos2-c4096-s15"),
            metrics.get("chronos2-c2048-s30"),
        )
        triggered = first or candidate_rank_signal or anchor
        return (
            triggered,
            (
                "15초 cadence 개선 신호 또는 8시간 32분 matched-lookback 보완 필요"
                if triggered
                else "기본 조합에서 15초 cadence/context 보완 필요성이 확인되지 않음"
            ),
            {
                "1024s15Vs1024s30": first_evidence,
                "bestDefaultChronosId": best,
                "matchedAnchorSignal": anchor_evidence,
            },
        )
    if combination_id == "chronos2-c4096-s30":
        first, first_evidence = materially_better(
            metrics.get("chronos2-c2048-s30"),
            metrics.get("chronos2-c2048-s60"),
        )
        thirty_ids = (
            "chronos2-c1024-s30",
            "chronos2-c2048-s30",
        )
        top_30, best_30 = within_one_percent_of_best(
            "chronos2-c2048-s30",
            metrics,
            thirty_ids,
        )
        anchor, anchor_evidence = materially_better(
            metrics.get("chronos2-c2048-s30"),
            metrics.get("chronos2-c1024-s60"),
        )
        triggered = first or top_30 or anchor
        return (
            triggered,
            (
                "30초 cadence 개선 신호 또는 34시간 8분 matched-lookback 보완 필요"
                if triggered
                else "기본 조합에서 4096×30초 보완 필요성이 확인되지 않음"
            ),
            {
                "2048s30Vs2048s60": first_evidence,
                "bestDefault30SecondId": best_30,
                "matchedAnchorSignal": anchor_evidence,
            },
        )
    if combination_id == "chronos2-c8192-s60":
        trend, evidence = materially_better(
            metrics.get("chronos2-c4096-s60"),
            metrics.get("chronos2-c2048-s60"),
        )
        horizons = int(evidence.get("predictionImprovedHorizons", 0))
        triggered = trend and horizons >= 2
        return (
            triggered,
            (
                "4096×60초가 2048×60초보다 최소 2개 horizon에서 개선"
                if triggered
                else "장기 60초 context의 미포화 개선 추세가 확인되지 않음"
            ),
            evidence,
        )
    if combination_id == "chronos2-c8192-s30":
        dependency = gate_results.get("chronos2-c4096-s30", {})
        trend, evidence = materially_better(
            metrics.get("chronos2-c4096-s30"),
            metrics.get("chronos2-c2048-s30"),
        )
        long_value, long_evidence = materially_better(
            metrics.get("chronos2-c4096-s60"),
            metrics.get("chronos2-c2048-s60"),
        )
        triggered = dependency.get("decision") == "passed" and trend and long_value
        return (
            triggered,
            (
                "4096×30초 통과·30초 context 추세·긴 lookback 가치 확인"
                if triggered
                else "8192×30초 dependency 또는 장기 context 추세 미충족"
            ),
            {
                "dependencyDecision": dependency.get("decision"),
                "4096s30Vs2048s30": evidence,
                "4096s60Vs2048s60": long_evidence,
            },
        )
    if combination_id == "chronos2-c8192-s15":
        dependency = gate_results.get("chronos2-c4096-s30", {})
        trend, trend_evidence = materially_better(
            metrics.get("chronos2-c4096-s15"),
            metrics.get("chronos2-c1024-s15"),
        )
        default_chronos = [
            item
            for item in DEFAULT_FINAL_COMBINATION_IDS
            if item.startswith("chronos2-")
        ]
        top_15, best = within_one_percent_of_best(
            "chronos2-c4096-s15",
            metrics,
            default_chronos,
        )
        triggered = dependency.get("decision") == "passed" and trend and top_15
        return (
            triggered,
            (
                "4096×30초 통과·15초 최상위·context 증가 추세 확인"
                if triggered
                else "8192×15초 dependency·15초 상위권·context 추세 조건 미충족"
            ),
            {
                "dependencyDecision": dependency.get("decision"),
                "4096s15Vs1024s15": trend_evidence,
                "bestDefaultChronosId": best,
            },
        )
    raise KeyError(combination_id)


def strong_followup_8192x5(
    metrics: Mapping[str, Mapping[str, Any]],
) -> tuple[bool, dict[str, Any]]:
    candidate = metrics.get("chronos2-c4096-s5")
    best_15_id = best_comparator_id(
        metrics,
        ("chronos2-c1024-s15", "chronos2-c4096-s15"),
    )
    if best_15_id is None or not technical_execution_ok(candidate):
        return False, {"best15ComparatorId": best_15_id}
    assert candidate is not None
    evidence = compare_summaries(candidate, metrics[best_15_id])
    prediction_improvement = max(
        (
            value
            for value in (
                evidence["wisImprovementRatio"],
                evidence["meanPinballImprovementRatio"],
            )
            if value is not None
        ),
        default=-1e100,
    )
    strong = (
        prediction_improvement >= 0.02
        and evidence["directionAccuracyDelta"] is not None
        and evidence["directionAccuracyDelta"] > 0
        and evidence["netReturnDelta"] is not None
        and evidence["netReturnDelta"] > 0
        and evidence["sharpeDelta"] is not None
        and evidence["sharpeDelta"] > 0
        and evidence["maxDrawdownWithinTenPercent"]
        and max(
            evidence["predictionImprovedWindows"],
            evidence["tradingImprovedWindows"],
        )
        >= 2
    )
    return strong, {"best15ComparatorId": best_15_id, **evidence}


def build_screening_decisions(
    state: PipelineState,
    metrics: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, Any]]]:
    decisions_by_id: dict[str, dict[str, Any]] = {}
    selected: list[str] = []
    gate_results: dict[str, Mapping[str, Any]] = {}

    def apply_decision(
        combination_id: str,
        *,
        decision: str,
        include: bool,
        reason: str,
        threshold: Mapping[str, Any],
        comparator_id: str | None = None,
    ) -> None:
        value = state.combination(combination_id)
        value["screeningDecision"] = decision
        value["screeningReason"] = reason
        value["selectedForFinal"] = include
        if include:
            value["status"] = "queued"
            selected.append(combination_id)
        elif decision == "followup_only":
            value["status"] = "followup_only"
        elif value.get("screeningStatus") == "dependency_failed":
            value["status"] = "dependency_failed"
        else:
            value["status"] = "excluded"
        decisions_by_id[combination_id] = {
            "combinationId": combination_id,
            "planRole": value["planRole"],
            "decision": (
                "include"
                if include
                else "followup_only"
                if decision == "followup_only"
                else "exclude"
            ),
            "screeningDecision": decision,
            "screeningStatus": value["screeningStatus"],
            "reason": reason,
            "dependencyIds": value["dependencyIds"],
            "comparatorIds": value["screeningComparatorIds"],
            "appliedComparatorId": comparator_id,
            "thresholdEvidence": dict(threshold),
        }

    for combination_id, static in STATIC_PLAN_DECISIONS.items():
        apply_decision(
            combination_id,
            decision=str(static["screeningDecision"]),
            include=False,
            reason=str(static["reason"]),
            threshold={"automaticPipelineExecution": False},
        )

    for combination_id in DEFAULT_FINAL_COMBINATION_IDS:
        summary = metrics.get(combination_id)
        if technical_execution_ok(summary):
            apply_decision(
                combination_id,
                decision="included",
                include=True,
                reason="기본 10개 matrix이며 기술적 실행 실패가 없음",
                threshold={"technicalExecution": True, "defaultMatrix": True},
            )
        else:
            apply_decision(
                combination_id,
                decision="excluded",
                include=False,
                reason="기본 조합이지만 기술적 실행 실패로 fail-closed",
                threshold={
                    "technicalExecution": False,
                    "technicalFailure": (
                        summary.get("technicalFailure") if summary else None
                    ),
                },
            )

    for combination_id in CONDITIONAL_COMBINATION_IDS:
        value = state.combination(combination_id)
        if value.get("screeningStatus") in {
            "not_triggered",
            "dependency_failed",
        }:
            result = {
                "decision": "excluded",
                "include": False,
                "reason": value.get("screeningReason")
                or "조건부 screening trigger 미충족",
                "comparatorId": None,
                "thresholdEvidence": {
                    "triggerReason": value.get("screeningTriggerReason")
                },
            }
        else:
            result = candidate_gate(combination_id, metrics)
        gate_results[combination_id] = result
        apply_decision(
            combination_id,
            decision=str(result["decision"]),
            include=bool(result["include"]),
            reason=str(result["reason"]),
            threshold=result.get("thresholdEvidence", {}),
            comparator_id=result.get("comparatorId"),
        )

    followup_strong, followup_evidence = strong_followup_8192x5(metrics)
    followups: list[dict[str, Any]] = []
    if followup_strong:
        followups.append(
            {
                "combinationId": "chronos2-c8192-s5",
                "status": "followup_only",
                "reason": (
                    "4096×5초가 최선 15초 대비 WIS/pinball≥2%, 방향, "
                    "net return, Sharpe, MDD, 2/3 구간 강한 gate를 충족"
                ),
                "thresholdEvidence": followup_evidence,
            }
        )
    state.value["experiment"]["followupCandidateIds"] = [
        item["combinationId"] for item in followups
    ]
    state.save()
    ordered = [
        decisions_by_id[item["id"]]
        for item in state.value["experiment"]["combinations"]
    ]
    return ordered, selected, followups


def not_run_screening_metric(
    combination_value: Mapping[str, Any],
    *,
    status: str,
    reason: str,
    trigger_evidence: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": "cadence-context-screening-not-run/v1",
        "combination": {
            key: combination_value[key]
            for key in (
                "id",
                "model",
                "contextBars",
                "cadenceSeconds",
                "lookbackSeconds",
                "predictionLengthSteps",
            )
        },
        "screeningStatus": status,
        "reason": reason,
        "triggerEvidence": dict(trigger_evidence or {}),
        "recordCount": 0,
        "availableRatio": 0,
    }


def runtime_manifest(args: argparse.Namespace, state: PipelineState) -> dict[str, Any]:
    source_manifest = json.loads(
        (args.source_dir / "source-manifest.json").read_text(encoding="utf-8")
    )
    return {
        "schemaVersion": "cadence-context-3week-run-manifest/v1",
        "runId": state.value["runId"],
        "createdAt": state.value["createdAt"],
        "evaluationStart": state.value["experiment"]["evaluationStart"],
        "evaluationEndExclusive": state.value["experiment"]["evaluationEndExclusive"],
        "evaluationDays": EVALUATION_DAYS,
        "screeningPoolStart": iso(
            from_iso(state.value["experiment"]["evaluationStart"])
            - timedelta(days=SCREENING_POOL_DAYS)
        ),
        "symbols": list(SYMBOLS),
        "models": {
            "fincast": {
                "id": MODEL_IDS["fincast"],
                "revision": FINCAST_REVISION,
                "contexts": [512],
            },
            "chronos-2": {
                "id": MODEL_IDS["chronos-2"],
                "revision": CHRONOS2_MODEL_REVISION,
                "packageVersion": CHRONOS2_PACKAGE_VERSION,
                "contexts": list(CHRONOS_CONTEXTS),
                "maximumDirectPredictionSteps": 1024,
            },
        },
        "cadencesSeconds": list(SUPPORTED_CADENCES),
        "predictionLengthSteps": {
            str(cadence): prediction_steps(cadence) for cadence in SUPPORTED_CADENCES
        },
        "originIntervalMinutes": ORIGIN_INTERVAL_MINUTES,
        "horizonsMinutes": list(EVALUATION_HORIZONS_MINUTES),
        "featureProfile": "compact_causal_v1",
        "crossLearning": False,
        "seed": SEED,
        "costPolicy": {
            "version": "cadence-context-cost-policy/v1",
            "commissionBpsPerSide": 4,
            "spreadBpsRoundTrip": 2,
            "slippageBpsPerSide": 1,
            "safetyMarginBps": 2,
            "funding": "origin_rate_abs_prorated_by_horizon",
        },
        "tradingPolicy": {
            "version": "cadence-context-common-policy/v1",
            "pNetThreshold": 0.62,
            "strictLaterFill": True,
            "overlap": False,
        },
        "screeningPolicy": {
            "version": SCREENING_POLICY_VERSION,
            "defaultCombinationIds": list(DEFAULT_FINAL_COMBINATION_IDS),
            "conditionalCombinationIds": list(CONDITIONAL_COMBINATION_IDS),
            "staticDecisions": STATIC_PLAN_DECISIONS,
            "matchedLookbackCombinationIds": list(MATCHED_LOOKBACK_COMBINATION_IDS),
            "screeningWindows": 3,
            "screeningOriginIntervalMinutes": (SCREENING_ORIGIN_INTERVAL_MINUTES),
            "borderlineDecision": "include",
        },
        "gitCommit": args.git_sha,
        "workingTreeDigest": args.working_tree_digest,
        "python": sys.version,
        "platform": platform.platform(),
        "numpy": np.__version__,
        "sourceManifest": source_manifest,
        "sourceManifestSha256": sha256_file(args.source_dir / "source-manifest.json"),
        "executionCommand": [item for item in sys.argv if "token" not in item.lower()],
    }


def run_pipeline(args: argparse.Namespace) -> None:
    source = json.loads(
        (args.source_dir / "source-manifest.json").read_text(encoding="utf-8")
    )
    evaluation_end = from_iso(source["end_exclusive_at"])
    evaluation_start = evaluation_end - timedelta(days=EVALUATION_DAYS)
    state = PipelineState(
        args.run_dir,
        run_id=args.run_id,
        evaluation_start=evaluation_start,
        evaluation_end=evaluation_end,
    )
    lock_descriptor = os.open(
        args.run_dir / ".pipeline.lock",
        os.O_CREAT | os.O_RDWR,
        0o600,
    )
    try:
        fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(lock_descriptor)
        raise RuntimeError("another pipeline process owns the run lock") from error
    try:
        atomic_text(args.run_dir / "PID", f"{os.getpid()}\n")
        atomic_json(
            args.run_dir.parent / "latest.json",
            {"runId": args.run_id, "updatedAt": iso(datetime.now(UTC))},
        )
        (args.run_dir / "STOP").unlink(missing_ok=True)
        state.start()
        prepared: Path | None = None
        repository: DataRepository | None = None

        if state.begin_phase("prepare"):
            for value in state.value["experiment"]["combinations"]:
                if value[
                    "model"
                ] == "chronos-2" and not chronos2_direct_prediction_supported(
                    value["cadenceSeconds"]
                ):
                    raise ValueError(
                        f"{value['id']} cannot produce the exact 60-minute horizon"
                    )
            atomic_json(
                args.run_dir / "run-manifest.json",
                runtime_manifest(args, state),
            )
            state.complete_phase(
                "prepare",
                (
                    "20개 matrix 정의, 기본 10개·조건부 7개·명시 제외/후속 "
                    "3개와 60/120/240/720 direct step 지원을 검증했습니다."
                ),
            )

        if state.begin_phase("validate-data"):
            prepared = prepare_market_data(
                args.cache_dir,
                args.source_dir,
                evaluation_end,
                state,
                smoke=args.smoke_only,
            )
            repository = DataRepository(prepared, args.source_dir)
            windows = select_screening_windows(
                repository,
                evaluation_end if args.smoke_only else evaluation_start,
                pool_days=6 if args.smoke_only else SCREENING_POOL_DAYS,
            )
            state.value["experiment"]["screeningWindows"] = windows
            atomic_json(args.run_dir / "data" / "screening-windows.json", windows)
            data_manifest = json.loads(
                (prepared / "data-manifest.json").read_text(encoding="utf-8")
            )
            atomic_json(
                args.run_dir / "data" / "data-manifest.json",
                data_manifest,
            )
            for cadence in SUPPORTED_CADENCES:
                expected_steps = {60: 60, 30: 120, 15: 240, 5: 720}[cadence]
                if prediction_steps(cadence) != expected_steps:
                    raise AssertionError("horizon step conversion drifted")
            state.complete_phase(
                "validate-data",
                "실제 aggTrades 1초 원천과 네 cadence, UTC/as-of/no-fill 규칙을 검증했습니다.",
            )
        if prepared is None:
            prepared = args.cache_dir / (
                "prepared-smoke" if args.smoke_only else "prepared-full"
            )
        if repository is None:
            repository = DataRepository(prepared, args.source_dir)

        clients = {
            "fincast": WorkerClient(args.fincast_url, args.fincast_token_file),
            "chronos-2": WorkerClient(
                args.chronos2_url,
                args.chronos2_token_file,
            ),
        }
        try:
            if state.begin_phase("smoke-test"):
                smoke_values = smoke_origins(repository, evaluation_end)
                smoke_summaries: dict[str, Any] = {}
                smoke_path = args.run_dir / "smoke" / "smoke-summary.json"
                if smoke_path.is_file():
                    smoke_summaries.update(
                        json.loads(smoke_path.read_text(encoding="utf-8"))
                    )
                for index, combination_id in enumerate(SMOKE_COMBINATION_IDS):
                    value = state.combination(combination_id)
                    summary = run_combination_resilient(
                        state,
                        repository,
                        clients[value["model"]],
                        value,
                        smoke_values,
                        args.run_dir / "smoke" / value["id"],
                    )
                    smoke_summaries[value["id"]] = summary
                    expected_records = (
                        len(smoke_values)
                        * len(SYMBOLS)
                        * len(EVALUATION_HORIZONS_MINUTES)
                    )
                    smoke_failed = (
                        summary.get("recordCount") != expected_records
                        or summary.get("availableRatio") != 1
                        or summary.get("prediction", {}).get("count")
                        != expected_records
                    )
                    if smoke_failed:
                        value["smokeStatus"] = "failed"
                        value["failureReason"] = (
                            value.get("failureReason")
                            or "smoke가 모든 실제 worker forecast를 반환하지 못함"
                        )
                    else:
                        value["smokeStatus"] = "completed"
                    static = STATIC_PLAN_DECISIONS.get(value["id"])
                    if static:
                        value["status"] = static["status"]
                    elif value["smokeStatus"] == "completed":
                        value["status"] = "queued"
                    state.phase_progress(
                        (index + 1) / len(SMOKE_COMBINATION_IDS) * 100,
                        f"{value['id']} actual worker smoke 완료",
                    )
                    atomic_json(smoke_path, smoke_summaries)
                followup = state.combination("chronos2-c8192-s5")
                followup["smokeStatus"] = "not_run"
                followup["status"] = "followup_only"
                state.save()
                state.complete_phase(
                    "smoke-test",
                    (
                        "19개 실행 후보의 exact horizon smoke를 수행했고 "
                        "8192×5초는 지시대로 자동 실행하지 않았습니다."
                    ),
                )

            if args.smoke_only:
                for phase in PIPELINE_PHASES[3:-1]:
                    step = next(
                        item for item in state.value["steps"] if item["id"] == phase
                    )
                    step["status"] = "skipped"
                    step["summary"] = "smoke-only 검증에서 의도적으로 생략"
                state.begin_phase("finalize")
                atomic_text(
                    args.run_dir / "qualification-report.md",
                    (
                        "# Smoke validation\n\n실제 P40의 실행 후보 19개 "
                        "smoke가 완료되었습니다. 8192×5초는 후속 전용입니다.\n"
                    ),
                )
                atomic_text(
                    args.run_dir / "handoff.md",
                    "smoke-only run; 최종 benchmark 결과가 아닙니다.\n",
                )
                atomic_json(
                    args.run_dir / "qualification-summary.json",
                    {"status": "smoke_completed", "benchmarkResult": False},
                )
                atomic_text(args.run_dir / "COMPLETE", "SMOKE_COMPLETE\n")
                state.complete_phase("finalize", "smoke-only 실행을 완료했습니다.")
                state.value["status"] = "completed"
                state.value["finishedAt"] = iso(datetime.now(UTC))
                state.value["experiment"]["currentCombinationId"] = None
                state.value["experiment"]["currentSymbol"] = None
                state.value["experiment"]["currentOrigin"] = None
                state.save()
                return

            screening_metrics: dict[str, Any] = {}
            if state.begin_phase("screen"):
                window_values = state.value["experiment"]["screeningWindows"]
                screen_values = screening_origins(window_values)
                metrics_path = args.run_dir / "screening_metrics.json"
                if metrics_path.is_file():
                    screening_metrics.update(
                        json.loads(metrics_path.read_text(encoding="utf-8"))
                    )
                for combination_id, static in STATIC_PLAN_DECISIONS.items():
                    value = state.combination(combination_id)
                    screening_metrics[combination_id] = not_run_screening_metric(
                        value,
                        status=str(static["screeningStatus"]),
                        reason=str(static["reason"]),
                    )
                atomic_json(metrics_path, screening_metrics)
                processed_screening = 0
                potential_screening = len(DEFAULT_FINAL_COMBINATION_IDS) + len(
                    CONDITIONAL_COMBINATION_IDS
                )
                gate_results: dict[str, Mapping[str, Any]] = {}

                def update_screen_progress(
                    combination_id: str,
                    message: str,
                ) -> None:
                    nonlocal processed_screening
                    processed_screening += 1
                    state.phase_progress(
                        processed_screening / potential_screening * 100,
                        f"{combination_id} {message}",
                    )

                def screen_one(
                    combination_id: str,
                    *,
                    trigger_reason: str,
                    trigger_evidence: Mapping[str, Any],
                ) -> dict[str, Any]:
                    value = state.combination(combination_id)
                    value["screeningStatus"] = "running"
                    value["screeningTriggerReason"] = trigger_reason
                    value["status"] = "running"
                    state.save()
                    summary = run_combination_resilient(
                        state,
                        repository,
                        clients[value["model"]],
                        value,
                        screen_values,
                        args.run_dir / "screening" / value["id"],
                    )
                    summary["screeningTrigger"] = {
                        "reason": trigger_reason,
                        "evidence": dict(trigger_evidence),
                    }
                    screening_metrics[combination_id] = summary
                    if technical_execution_ok(summary):
                        value["screeningStatus"] = "completed"
                        value["status"] = "queued"
                    else:
                        value["screeningStatus"] = "failed"
                        value["status"] = "failed"
                    atomic_json(metrics_path, screening_metrics)
                    update_screen_progress(
                        combination_id,
                        "세 regime screening 완료",
                    )
                    return summary

                def skip_screen(
                    combination_id: str,
                    *,
                    trigger_reason: str,
                    trigger_evidence: Mapping[str, Any],
                ) -> None:
                    value = state.combination(combination_id)
                    dependency_decision = trigger_evidence.get("dependencyDecision")
                    dependency_failed = (
                        dependency_decision is not None
                        and dependency_decision != "passed"
                    )
                    status = (
                        "dependency_failed" if dependency_failed else "not_triggered"
                    )
                    value["screeningStatus"] = status
                    value["screeningDecision"] = "excluded"
                    value["screeningTriggerReason"] = trigger_reason
                    value["screeningReason"] = trigger_reason
                    value["status"] = (
                        "dependency_failed" if dependency_failed else "excluded"
                    )
                    screening_metrics[combination_id] = not_run_screening_metric(
                        value,
                        status=status,
                        reason=trigger_reason,
                        trigger_evidence=trigger_evidence,
                    )
                    atomic_json(metrics_path, screening_metrics)
                    update_screen_progress(
                        combination_id,
                        (
                            "dependency 실패로 생략"
                            if dependency_failed
                            else "trigger 미충족으로 생략"
                        ),
                    )

                for combination_id in DEFAULT_FINAL_COMBINATION_IDS:
                    screen_one(
                        combination_id,
                        trigger_reason="기본 10개 조합은 기술 실패가 없으면 정식 포함",
                        trigger_evidence={"defaultMatrix": True},
                    )

                trigger, reason, evidence = conditional_trigger(
                    "chronos2-c2048-s5",
                    screening_metrics,
                    gate_results,
                )
                if trigger:
                    screen_one(
                        "chronos2-c2048-s5",
                        trigger_reason=reason,
                        trigger_evidence=evidence,
                    )
                    gate_results["chronos2-c2048-s5"] = candidate_gate(
                        "chronos2-c2048-s5",
                        screening_metrics,
                    )
                else:
                    skip_screen(
                        "chronos2-c2048-s5",
                        trigger_reason=reason,
                        trigger_evidence=evidence,
                    )
                    gate_results["chronos2-c2048-s5"] = {"decision": "excluded"}

                trigger, reason, evidence = conditional_trigger(
                    "chronos2-c4096-s5",
                    screening_metrics,
                    gate_results,
                )
                if trigger:
                    screen_one(
                        "chronos2-c4096-s5",
                        trigger_reason=reason,
                        trigger_evidence=evidence,
                    )
                    gate_results["chronos2-c4096-s5"] = candidate_gate(
                        "chronos2-c4096-s5",
                        screening_metrics,
                    )
                else:
                    skip_screen(
                        "chronos2-c4096-s5",
                        trigger_reason=reason,
                        trigger_evidence=evidence,
                    )
                    gate_results["chronos2-c4096-s5"] = {"decision": "excluded"}

                for combination_id in (
                    "chronos2-c2048-s15",
                    "chronos2-c4096-s30",
                    "chronos2-c8192-s60",
                ):
                    trigger, reason, evidence = conditional_trigger(
                        combination_id,
                        screening_metrics,
                        gate_results,
                    )
                    if trigger:
                        screen_one(
                            combination_id,
                            trigger_reason=reason,
                            trigger_evidence=evidence,
                        )
                        gate_results[combination_id] = candidate_gate(
                            combination_id,
                            screening_metrics,
                        )
                    else:
                        skip_screen(
                            combination_id,
                            trigger_reason=reason,
                            trigger_evidence=evidence,
                        )
                        gate_results[combination_id] = {"decision": "excluded"}

                for combination_id in (
                    "chronos2-c8192-s30",
                    "chronos2-c8192-s15",
                ):
                    trigger, reason, evidence = conditional_trigger(
                        combination_id,
                        screening_metrics,
                        gate_results,
                    )
                    if trigger:
                        screen_one(
                            combination_id,
                            trigger_reason=reason,
                            trigger_evidence=evidence,
                        )
                        gate_results[combination_id] = candidate_gate(
                            combination_id,
                            screening_metrics,
                        )
                    else:
                        skip_screen(
                            combination_id,
                            trigger_reason=reason,
                            trigger_evidence=evidence,
                        )
                        gate_results[combination_id] = {"decision": "excluded"}

                if set(screening_metrics) != {
                    item["id"] for item in state.value["experiment"]["combinations"]
                }:
                    raise RuntimeError(
                        "screening_metrics.json does not cover the full matrix"
                    )
                state.complete_phase(
                    "screen",
                    (
                        "세 비중복 24시간 구간에서 기본 10개와 dependency를 "
                        "충족한 조건부 조합만 screening했습니다."
                    ),
                )
            else:
                screening_metrics = json.loads(
                    (args.run_dir / "screening_metrics.json").read_text(
                        encoding="utf-8"
                    )
                )

            selected: list[str] = []
            followups: list[dict[str, Any]] = []
            decisions: list[dict[str, Any]] = []
            if state.begin_phase("decide"):
                decisions, selected, followups = build_screening_decisions(
                    state,
                    screening_metrics,
                )
                atomic_json(
                    args.run_dir / "screening_decisions.json",
                    {
                        "schemaVersion": "cadence-context-screening-decisions/v2",
                        "policyVersion": SCREENING_POLICY_VERSION,
                        "generatedAt": iso(datetime.now(UTC)),
                        "thresholds": {
                            "latencyRatio": 2,
                            "predictionImprovementRatio": 0.01,
                            "directionDegradationPoints": 0.003,
                            "directionImprovementPoints": 0.005,
                            "sharpeImprovement": 0.1,
                            "maxDrawdownWorseRatio": 1.1,
                            "wisWorseRatio": 1.03,
                            "improvedWindowsRequired": 2,
                            "improvedHorizonsRequired": 2,
                            "strong8192PredictionImprovementRatio": 0.015,
                            "strong8192DirectionImprovementPoints": 0.0075,
                            "borderlineDecision": "include",
                        },
                        "decisions": decisions,
                    },
                )
                atomic_json(
                    args.run_dir / "followup_candidates.json",
                    {
                        "schemaVersion": "cadence-context-followup-candidates/v1",
                        "generatedAt": iso(datetime.now(UTC)),
                        "candidates": followups,
                        "automaticExecution": False,
                    },
                )
                state.value["experiment"]["selectedCombinationCount"] = len(selected)
                state.complete_phase(
                    "decide",
                    f"{len(selected)}개 조합을 최종 평가에 포함했습니다.",
                )
            else:
                decisions_payload = json.loads(
                    (args.run_dir / "screening_decisions.json").read_text(
                        encoding="utf-8"
                    )
                )
                decisions = list(decisions_payload["decisions"])
                selected = [
                    item["id"]
                    for item in state.value["experiment"]["combinations"]
                    if item["selectedForFinal"]
                ]
                followup_path = args.run_dir / "followup_candidates.json"
                if followup_path.is_file():
                    followups = list(
                        json.loads(followup_path.read_text(encoding="utf-8"))[
                            "candidates"
                        ]
                    )

            if state.begin_phase("build-final-plan"):
                decisions_by_id = {item["combinationId"]: item for item in decisions}
                matched_comparisons: list[dict[str, Any]] = [
                    {
                        "name": "17h04m cadence anchor",
                        "combinationIds": list(MATCHED_LOOKBACK_COMBINATION_IDS),
                        "lookbackSeconds": 61_440,
                    }
                ]
                if "chronos2-c2048-s15" in selected:
                    matched_comparisons.append(
                        {
                            "name": "8h32m matched lookback",
                            "combinationIds": [
                                "chronos2-c1024-s30",
                                "chronos2-c2048-s15",
                            ],
                            "lookbackSeconds": 30_720,
                        }
                    )
                if "chronos2-c4096-s30" in selected:
                    matched_comparisons.append(
                        {
                            "name": "34h08m matched lookback",
                            "combinationIds": [
                                "chronos2-c2048-s60",
                                "chronos2-c4096-s30",
                            ],
                            "lookbackSeconds": 122_880,
                        }
                    )
                if "chronos2-c8192-s30" in selected:
                    matched_comparisons.append(
                        {
                            "name": "68h16m matched lookback",
                            "combinationIds": [
                                "chronos2-c4096-s60",
                                "chronos2-c8192-s30",
                            ],
                            "lookbackSeconds": 245_760,
                        }
                    )
                if "chronos2-c8192-s15" in selected:
                    matched_comparisons.append(
                        {
                            "name": "34h08m expanded matched lookback",
                            "combinationIds": [
                                "chronos2-c2048-s60",
                                "chronos2-c4096-s30",
                                "chronos2-c8192-s15",
                            ],
                            "lookbackSeconds": 122_880,
                        }
                    )
                plan = {
                    "schemaVersion": SELECTED_PLAN_SCHEMA,
                    "screeningPolicyVersion": SCREENING_POLICY_VERSION,
                    "generatedAt": iso(datetime.now(UTC)),
                    "evaluationStart": iso(evaluation_start),
                    "evaluationEndExclusive": iso(evaluation_end),
                    "evaluationDays": 21,
                    "originIntervalMinutes": 15,
                    "symbols": list(SYMBOLS),
                    "defaultCombinationIds": list(DEFAULT_FINAL_COMBINATION_IDS),
                    "selectedCombinationIds": selected,
                    "selectedConditionalCombinationIds": [
                        item for item in selected if item in CONDITIONAL_COMBINATION_IDS
                    ],
                    "excludedCombinations": [
                        decisions_by_id[item["id"]]
                        for item in state.value["experiment"]["combinations"]
                        if item["id"] not in selected
                    ],
                    "followupCandidates": followups,
                    "matchedLookbackComparisons": matched_comparisons,
                    "screeningMetricsSha256": sha256_file(
                        args.run_dir / "screening_metrics.json"
                    ),
                    "screeningDecisionsSha256": sha256_file(
                        args.run_dir / "screening_decisions.json"
                    ),
                }
                if not selected:
                    raise ValueError("screening selected no valid final combination")
                if any(item in selected for item in STATIC_PLAN_DECISIONS):
                    raise ValueError(
                        "static excluded/followup combination entered final plan"
                    )
                atomic_json(args.run_dir / "selected_test_plan.json", plan)
                validated = json.loads(
                    (args.run_dir / "selected_test_plan.json").read_text(
                        encoding="utf-8"
                    )
                )
                if validated.get("selectedCombinationIds") != selected:
                    raise ValueError("selected_test_plan.json validation failed")
                state.value["experiment"]["selectedPlanReady"] = True
                state.complete_phase(
                    "build-final-plan",
                    "selected_test_plan.json을 원자적으로 생성·재검증했습니다.",
                )

            full_summaries: dict[str, Any] = {}
            if state.begin_phase("full-test"):
                plan_path = args.run_dir / "selected_test_plan.json"
                if not plan_path.is_file():
                    raise ValueError(
                        "selected_test_plan.json is required before full-test"
                    )
                plan = json.loads(plan_path.read_text(encoding="utf-8"))
                selected = list(plan["selectedCombinationIds"])
                final_origins = [
                    (value, None)
                    for value in origins(
                        evaluation_start,
                        evaluation_end,
                        ORIGIN_INTERVAL_MINUTES,
                    )
                ]
                for index, combination_id in enumerate(selected):
                    value = state.combination(combination_id)
                    full_summaries[combination_id] = run_combination_resilient(
                        state,
                        repository,
                        clients[value["model"]],
                        value,
                        final_origins,
                        args.run_dir / "results" / combination_id,
                    )
                    state.phase_progress(
                        (index + 1) / len(selected) * 100,
                        f"{combination_id} 21일 평가 완료",
                    )
                atomic_json(
                    args.run_dir / "results" / "full-test-summary.json",
                    full_summaries,
                )
                state.complete_phase(
                    "full-test",
                    "선정된 모든 조합의 정확히 21일 평가를 완료했습니다.",
                )
            else:
                full_summaries = json.loads(
                    (args.run_dir / "results" / "full-test-summary.json").read_text(
                        encoding="utf-8"
                    )
                )

            if state.begin_phase("aggregate"):
                aggregate = {
                    "schemaVersion": "cadence-context-3week-summary/v1",
                    "runId": state.value["runId"],
                    "evaluationStart": iso(evaluation_start),
                    "evaluationEndExclusive": iso(evaluation_end),
                    "evaluationDays": 21,
                    "results": full_summaries,
                    "matchedLookback": [
                        full_summaries.get(combination_id)
                        for combination_id in state.value["experiment"][
                            "matchedLookbackCombinationIds"
                        ]
                    ],
                    "fiveSecondLookbackNote": state.value["experiment"][
                        "fiveSecondLookbackNote"
                    ],
                    "matchedLookbackComparisons": json.loads(
                        (args.run_dir / "selected_test_plan.json").read_text(
                            encoding="utf-8"
                        )
                    ).get("matchedLookbackComparisons", []),
                }
                atomic_json(
                    args.run_dir / "qualification-summary.json",
                    aggregate,
                )
                state.complete_phase(
                    "aggregate",
                    "horizon·symbol·matched-lookback·비용 stress 결과를 집계했습니다.",
                )

            if state.begin_phase("finalize"):
                atomic_text(
                    args.run_dir / "qualification-report.md",
                    "# Cadence/context 3-week benchmark\n\n"
                    "정량 결과는 `qualification-summary.json`에 저장되어 있습니다.\n",
                )
                atomic_text(
                    args.run_dir / "handoff.md",
                    "COMPLETE 이후 저장된 결과만 분석하고 benchmark를 재실행하지 마세요.\n",
                )
                complete = {
                    "runId": state.value["runId"],
                    "completedAt": iso(datetime.now(UTC)),
                    "summarySha256": sha256_file(
                        args.run_dir / "qualification-summary.json"
                    ),
                    "selectedPlanSha256": sha256_file(
                        args.run_dir / "selected_test_plan.json"
                    ),
                }
                atomic_json(args.run_dir / "COMPLETE", complete)
                state.complete_phase(
                    "finalize", "재현성 digest와 COMPLETE를 확정했습니다."
                )
            failed_final = [
                combination_id
                for combination_id, summary in full_summaries.items()
                if summary.get("technicalFailure")
            ]
            state.value["status"] = (
                "completed_with_failures" if failed_final else "completed"
            )
            state.value["experiment"]["failedFinalCombinationIds"] = failed_final
            state.value["finishedAt"] = iso(datetime.now(UTC))
            state.value["experiment"]["currentCombinationId"] = None
            state.value["experiment"]["currentSymbol"] = None
            state.value["experiment"]["currentOrigin"] = None
            state.save()
            state.event(
                "run_completed", "3주 cadence/context benchmark가 완료되었습니다."
            )
        finally:
            for client in clients.values():
                client.close()
    except KeyboardInterrupt:
        state.value["status"] = "cancelled"
        state.value["finishedAt"] = iso(datetime.now(UTC))
        state.save()
        state.event("warning", "STOP marker로 pipeline을 graceful stop했습니다.")
    except BaseException as error:
        state.log(f"FAILED {type(error).__name__}: {error}")
        state.fail(error)
        raise
    finally:
        fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
        os.close(lock_descriptor)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--run-dir", type=Path, required=True)
    value.add_argument("--run-id", required=True)
    value.add_argument("--cache-dir", type=Path, required=True)
    value.add_argument("--source-dir", type=Path, required=True)
    value.add_argument("--fincast-url", required=True)
    value.add_argument("--chronos2-url", required=True)
    value.add_argument("--fincast-token-file", type=Path, required=True)
    value.add_argument("--chronos2-token-file", type=Path, required=True)
    value.add_argument("--git-sha", default="uncommitted")
    value.add_argument("--working-tree-digest", default="unavailable")
    value.add_argument("--smoke-only", action="store_true")
    return value


def main() -> None:
    args = parser().parse_args()
    for field in (
        "run_dir",
        "cache_dir",
        "source_dir",
        "fincast_token_file",
        "chronos2_token_file",
    ):
        path = getattr(args, field)
        if not path.is_absolute():
            raise SystemExit(f"--{field.replace('_', '-')} must be absolute")
    args.run_dir.mkdir(parents=True, exist_ok=True)
    run_pipeline(args)


if __name__ == "__main__":
    main()
