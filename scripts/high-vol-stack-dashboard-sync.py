#!/usr/bin/env python3
"""Project a high-volatility profitability run into the existing dashboard.

The qualification API intentionally accepts one bounded, validated state
contract.  This process keeps the raw source/backtest artifacts unchanged and
writes a small contract-compatible projection into the configured
AI_QUALIFICATION_RUN_ROOT.  It never copies credentials or model inputs.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from typing import Any, Mapping, Sequence


UTC = timezone.utc
STATE_SCHEMA = "ai-p40-qualification-state/v1"
EVENT_SCHEMA = "ai-p40-qualification-event/v1"
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PHASE_ORDER = (
    "prepare-data",
    "scan-universe",
    "infer-chronos2",
    "infer-fincast",
    "materialize",
    "rust-evidence",
    "policy-backtest",
)
PHASE_PROGRESS = {
    "prepare": 2.0,
    "load-data": 10.0,
    "scan": 15.0,
    "infer-chronos2": 18.0,
    "infer-fincast": 48.0,
    "materialize": 76.0,
    "source-complete": 78.0,
    "rust-evidence": 80.0,
    "selector": 93.0,
    "policy-backtest": 96.0,
    "aggregate": 99.0,
    "complete": 100.0,
    "failed": 100.0,
    "cancelled": 100.0,
}


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )


def parse_instant(value: object, fallback: datetime) -> datetime:
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                return parsed.astimezone(UTC)
        except ValueError:
            pass
    return fallback


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


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


def atomic_json(path: Path, value: object) -> None:
    atomic_text(
        path,
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n",
    )


def bounded_lines(path: Path, limit: int = 20) -> list[str]:
    if not path.is_file() or path.is_symlink():
        return []
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [
        line[-500:]
        for line in source.splitlines()
        if line.strip()
    ][-limit:]


def finite_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def telemetry() -> dict[str, Any] | None:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total,"
                "temperature.gpu,power.draw,power.limit",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        first = completed.stdout.splitlines()[0]
        values = [finite_number(item.strip()) for item in first.split(",")]
        if len(values) != 6 or any(value is None for value in values):
            return None
        result: dict[str, Any] = {
            "polledAt": now_iso(),
            "gpuUtilizationPercent": values[0],
            "memoryUsedMiB": values[1],
            "memoryTotalMiB": values[2],
            "temperatureC": values[3],
            "powerDrawW": values[4],
            "powerLimitW": values[5],
            "memoryHeadroomMiB": max(0.0, values[2] - values[1]),
        }
        memory = {}
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            name, raw = line.split(":", 1)
            memory[name] = float(raw.strip().split()[0]) / 1024
        if "MemTotal" in memory and "MemAvailable" in memory:
            result["ramTotalMiB"] = memory["MemTotal"]
            result["ramUsedMiB"] = max(
                0.0,
                memory["MemTotal"] - memory["MemAvailable"],
            )
        return result
    except (OSError, subprocess.SubprocessError, IndexError, ValueError):
        return None


def model_lane(
    source: Mapping[str, Any],
    manifest: Mapping[str, Any],
    lane: str,
    role: str,
) -> dict[str, Any]:
    raw = source.get("models")
    raw_lane = raw.get(lane) if isinstance(raw, Mapping) else {}
    raw_lane = raw_lane if isinstance(raw_lane, Mapping) else {}
    raw_models = manifest.get("models")
    manifest_lane = (
        raw_models.get(lane)
        if isinstance(raw_models, Mapping)
        else {}
    )
    manifest_lane = (
        manifest_lane
        if isinstance(manifest_lane, Mapping)
        else {}
    )
    return {
        "role": role,
        "modelId": str(
            manifest_lane.get("modelId")
            or ("amazon/chronos-2" if lane == "chronos2" else "Vincent05R/FinCast")
        )[:120],
        "modelRevision": (
            str(manifest_lane["modelRevision"])[:120]
            if manifest_lane.get("modelRevision")
            else None
        ),
        "contextBars": int(
            raw_lane.get("contextBars")
            or manifest_lane.get("contextBars")
            or (2048 if lane == "chronos2" else 512)
        ),
        "cadenceSeconds": int(
            raw_lane.get("cadenceSeconds")
            or manifest_lane.get("cadenceSeconds")
            or 60
        ),
        "status": str(raw_lane.get("status") or "queued"),
        "completed": max(0, int(raw_lane.get("completed") or 0)),
        "total": max(0, int(raw_lane.get("total") or 0)),
        "retries": max(0, int(raw_lane.get("retries") or 0)),
    }


def normalized_phase(
    run_dir: Path,
    source: Mapping[str, Any],
    progress: Mapping[str, Any],
) -> str:
    if (run_dir / "COMPLETE").is_file():
        return "complete"
    if (run_dir / "FAILED").is_file():
        return "failed"
    if (run_dir / "STOP").is_file():
        return "cancelled"
    backtest_status = str(progress.get("status") or "")
    if backtest_status == "rust_evidence":
        return "rust-evidence"
    if backtest_status in {
        "selector",
        "policy-backtest",
        "aggregate",
        "complete",
    }:
        return backtest_status
    return str(source.get("phase") or "prepare")


def progress_percent(
    phase: str,
    source: Mapping[str, Any],
    backtest: Mapping[str, Any],
) -> float:
    if phase == "infer-chronos2" or phase == "infer-fincast":
        models = source.get("models")
        lane_name = "chronos2" if phase == "infer-chronos2" else "fincast"
        lane = models.get(lane_name) if isinstance(models, Mapping) else {}
        lane = lane if isinstance(lane, Mapping) else {}
        completed = max(0, int(lane.get("completed") or 0))
        total = max(0, int(lane.get("total") or 0))
        ratio = completed / total if total else 0.0
        base = 18.0 if lane_name == "chronos2" else 48.0
        return min(base + 30.0 * ratio, base + 30.0)
    if phase == "rust-evidence":
        completed = max(0, int(backtest.get("completedOrigins") or 0))
        total = max(0, int(backtest.get("totalOrigins") or 0))
        return min(80.0 + 12.0 * (completed / total if total else 0.0), 92.0)
    return PHASE_PROGRESS.get(phase, 0.0)


def step_states(
    phase: str,
    status: str,
    started_at: str,
    updated_at: str,
) -> tuple[list[dict[str, Any]], str | None]:
    active_by_phase = {
        "prepare": "prepare-data",
        "load-data": "prepare-data",
        "scan": "scan-universe",
        "infer-chronos2": "infer-chronos2",
        "infer-fincast": "infer-fincast",
        "materialize": "materialize",
        "source-complete": "rust-evidence",
        "rust-evidence": "rust-evidence",
        "selector": "policy-backtest",
        "policy-backtest": "policy-backtest",
        "aggregate": "policy-backtest",
    }
    active = active_by_phase.get(phase)
    if status in {"completed", "failed", "cancelled"}:
        active = None
    active_index = PHASE_ORDER.index(active) if active in PHASE_ORDER else len(PHASE_ORDER)
    definitions = (
        ("prepare-data", "시장 데이터 준비", "완료 UTC archive와 finalized REST tail을 검증합니다.", "system", "binance-usdm-causal"),
        ("scan-universe", "고변동성 universe 스캔", "hard gate 후 top-5 후보를 기록합니다.", "system", "point-in-time-top5"),
        ("infer-chronos2", "Chronos-2 primary 추론", "top-3 후보의 비용 차감 분포를 계산합니다.", "chronos-2", "c2048-s60-primary"),
        ("infer-fincast", "FinCast veto 추론", "동일 origin의 tail-risk veto evidence를 계산합니다.", "fincast", "c512-s60-veto"),
        ("materialize", "Causal origin materialize", "모델·시장·실현 수익률을 origin별로 결합합니다.", "system", "no-lookahead-v2"),
        ("rust-evidence", "Rust 지표·유동성 evidence", "동일 origin에서 비방향성 quality evidence를 계산합니다.", "comparison", "rust-market-evidence-v2"),
        ("policy-backtest", "통합 정책 수익성 비교", "Chronos-2+Rust와 FinCast veto 추가 variant를 비교합니다.", "comparison", "high-vol-stack-policy-v2"),
    )
    steps: list[dict[str, Any]] = []
    failed_index = max(0, active_index - (1 if active is None else 0))
    for index, (step_id, label, description, model, variant) in enumerate(definitions):
        if status == "completed":
            step_status = "completed"
        elif status in {"failed", "cancelled"} and index == failed_index:
            step_status = status
        elif index < active_index:
            step_status = "completed"
        elif index == active_index and active is not None:
            step_status = "running"
        else:
            step_status = "pending"
        step: dict[str, Any] = {
            "id": step_id,
            "order": index + 1,
            "label": label,
            "description": description,
            "model": model,
            "variant": variant,
            "status": step_status,
            "estimatedDurationMs": 60_000,
            "logFile": "pipeline-tail.log",
        }
        if step_status != "pending":
            step["startedAt"] = started_at
        if step_status in {"completed", "failed", "cancelled"}:
            step["finishedAt"] = updated_at
        steps.append(step)
    return steps, active


def result_metrics(summary: Mapping[str, Any], lane: str) -> dict[str, Any] | None:
    variants = summary.get("variants")
    variant = variants.get(lane) if isinstance(variants, Mapping) else {}
    metrics = variant.get("metrics") if isinstance(variant, Mapping) else {}
    if not isinstance(metrics, Mapping):
        return None
    output = {}
    for source_key, target_key in (
        ("grossReturn", "grossReturn"),
        ("netReturn", "netReturn"),
        ("maximumDrawdown", "maxDrawdown"),
        ("sharpe", "sharpe"),
        ("turnover", "turnover"),
        ("tradeCount", "tradeCount"),
        ("vetoCount", "vetoCount"),
    ):
        value = finite_number(metrics.get(source_key))
        if value is not None:
            output[target_key] = int(value) if target_key in {"tradeCount", "vetoCount"} else value
    return output or None


def build_projection(
    run_dir: Path,
    run_id: str,
    *,
    observed_at: datetime | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    observed_at = observed_at or datetime.now(UTC)
    observed_iso = observed_at.isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )
    source = read_json(run_dir / "state.json")
    backtest = read_json(run_dir / "backtest-progress.json")
    manifest = read_json(run_dir / "run-manifest.json")
    summary = read_json(run_dir / "comparison-summary.json")
    lines = bounded_lines(run_dir / "pipeline.log")
    started = parse_instant(
        source.get("startedAt"),
        datetime.fromtimestamp(run_dir.stat().st_mtime, UTC),
    )
    evaluation = source.get("evaluation")
    evaluation = evaluation if isinstance(evaluation, Mapping) else {}
    evaluation_start = str(
        evaluation.get("start")
        or manifest.get("evaluationStart")
        or started.isoformat()
    )
    evaluation_end = str(
        evaluation.get("endExclusive")
        or manifest.get("evaluationEndExclusive")
        or observed_iso
    )
    calibration_start = str(
        evaluation.get("calibrationStart")
        or manifest.get("calibrationStart")
        or evaluation_start
    )
    phase = normalized_phase(run_dir, source, backtest)
    status = (
        "completed"
        if phase == "complete"
        else "failed"
        if phase == "failed"
        else "cancelled"
        if phase == "cancelled"
        else "running"
    )
    percent = progress_percent(phase, source, backtest)
    steps, active_step = step_states(
        phase,
        status,
        started.isoformat().replace("+00:00", "Z"),
        observed_iso,
    )
    elapsed_ms = max(0, int((observed_at - started).total_seconds() * 1000))
    deadline = started + timedelta(hours=72)
    data = source.get("data")
    data = data if isinstance(data, Mapping) else {}
    candidates = [
        str(value)
        for value in data.get("requestedCandidates", ())
        if isinstance(value, str)
    ][:20]
    usable = [
        str(value)
        for value in data.get("usableCandidates", ())
        if isinstance(value, str)
    ][:20]
    errors = data.get("errors")
    data_error_count = sum(
        len(value)
        for value in errors.values()
        if isinstance(value, Sequence) and not isinstance(value, str)
    ) if isinstance(errors, Mapping) else 0
    chronos2 = model_lane(source, manifest, "chronos2", "primary")
    fincast = model_lane(source, manifest, "fincast", "veto")
    current = backtest if backtest else {}
    if not current:
        current_model = (
            chronos2
            if chronos2["status"] == "running"
            else fincast
            if fincast["status"] == "running"
            else {}
        )
        current = {
            "completedOrigins": current_model.get("completed", 0),
            "totalOrigins": current_model.get("total", 0),
            "currentOriginAt": source.get("models", {}).get(
                "chronos2"
                if chronos2["status"] == "running"
                else "fincast",
                {},
            ).get("currentOriginAt")
            if isinstance(source.get("models"), Mapping)
            else None,
        }
    failure_reason = None
    if status == "failed":
        failure_reason = next(
            (
                line[-1_000:]
                for line in reversed(lines)
                if "error" in line.lower() or "runtimeerror" in line.lower()
            ),
            "pipeline exited with a failure marker",
        )
    complete_origins = max(0, int(current.get("completedOrigins") or 0))
    total_origins = max(0, int(current.get("totalOrigins") or 0))
    duration_hours = max(
        1,
        math.ceil(
            (
                parse_instant(evaluation_end, observed_at)
                - parse_instant(evaluation_start, started)
            ).total_seconds()
            / 3600
        ),
    )
    state: dict[str, Any] = {
        "schemaVersion": STATE_SCHEMA,
        "runId": run_id,
        "status": status,
        "createdAt": started.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "startedAt": started.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "updatedAt": observed_iso,
        "deadlineAt": deadline.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "activeStepId": active_step,
        "config": {
            "budgetHours": 72,
            "durationHours": duration_hours,
            "endExclusive": evaluation_end,
            "symbols": candidates[:10] or ["BTCUSDT", "ETHUSDT"],
            "gpu": "Tesla P40",
            "cudaCapability": "6.1",
            "workerMode": "docker-source",
            "dockerBuild": False,
        },
        "progress": {
            "completedSteps": sum(step["status"] == "completed" for step in steps),
            "failedSteps": sum(step["status"] == "failed" for step in steps),
            "skippedSteps": 0,
            "totalSteps": len(steps),
            "percent": percent,
            "activeStepPercent": (
                None
                if active_step is None
                else min(100.0, percent % 14.0 / 14.0 * 100.0)
            ),
            "elapsedMs": elapsed_ms,
            "remainingBudgetMs": max(
                0,
                int((deadline - observed_at).total_seconds() * 1000),
            ),
        },
        "steps": steps,
        "artifacts": {
            "summaryJson": "monitor-summary.json",
            "reportMarkdown": "monitor-report.md",
            "handoffPrompt": "monitor-handoff.md",
        },
        "experiment": {
            "kind": "high-volatility-profitability-backtest",
            "phase": phase,
            "evaluationStart": evaluation_start,
            "evaluationEndExclusive": evaluation_end,
            "calibrationStart": calibration_start,
            "originIntervalMinutes": 15,
            "horizonsMinutes": [5, 15, 30, 60],
            "candidateUniverse": candidates,
            "usableCandidates": usable,
            "scannerTopCount": 5,
            "modelSelectorCandidateCount": 3,
            "models": {
                "chronos2": chronos2,
                "fincast": fincast,
            },
            "completedOrigins": complete_origins,
            "totalOrigins": total_origins,
            "currentSymbol": (
                str(current["currentSymbol"])
                if current.get("currentSymbol")
                else None
            ),
            "currentOrigin": (
                str(current["currentOriginAt"])
                if current.get("currentOriginAt")
                else None
            ),
            "policyVersions": {
                "selector": "high-volatility-stack-policy/v2",
                "vetoCalibration": "fincast-veto-probability-calibration/v1",
            },
            "dataErrorCount": data_error_count,
            "failureReason": failure_reason,
            "recentLogLines": lines,
            "results": {
                "chronos2Rust": result_metrics(summary, "chronos2_rust"),
                "chronos2FincastVetoRust": result_metrics(
                    summary,
                    "chronos2_fincast_veto_rust",
                ),
            } if summary else None,
        },
    }
    if status != "running":
        state["finishedAt"] = observed_iso
    gpu = telemetry()
    if gpu:
        processed = chronos2["completed"] + fincast["completed"]
        seconds = max(1.0, elapsed_ms / 1000)
        gpu["inferenceOriginsPerSecond"] = processed / seconds
        state["telemetry"] = gpu

    events: list[dict[str, Any]] = [
        {
            "schemaVersion": EVENT_SCHEMA,
            "sequence": 1,
            "runId": run_id,
            "at": state["createdAt"],
            "type": "run_started",
            "message": "고변동성 모델 스택 수익성 검증을 시작했습니다.",
            "status": "running",
            "progressPercent": 0,
        }
    ]
    for step in steps:
        if step["status"] == "pending":
            continue
        events.append({
            "schemaVersion": EVENT_SCHEMA,
            "sequence": len(events) + 1,
            "runId": run_id,
            "at": observed_iso,
            "type": (
                "step_completed"
                if step["status"] == "completed"
                else "step_failed"
                if step["status"] == "failed"
                else "warning"
                if step["status"] == "cancelled"
                else "step_started"
            ),
            "message": (
                f"{step['label']} 단계가 완료됐습니다."
                if step["status"] == "completed"
                else f"{step['label']} 단계가 실패했습니다."
                if step["status"] == "failed"
                else f"{step['label']} 단계를 실행 중입니다."
            ),
            "stepId": step["id"],
            "progressPercent": percent,
        })
    if status == "completed":
        events.append({
            "schemaVersion": EVENT_SCHEMA,
            "sequence": len(events) + 1,
            "runId": run_id,
            "at": observed_iso,
            "type": "run_completed",
            "message": "고변동성 수익성 검증이 완료됐습니다.",
            "status": "completed",
            "progressPercent": 100,
        })
    return state, events


def publish(run_dir: Path, dashboard_root: Path, run_id: str) -> str:
    state, events = build_projection(run_dir, run_id)
    dashboard_run = dashboard_root / run_id
    if dashboard_run.resolve() == run_dir.resolve():
        raise RuntimeError(
            "dashboard projection directory must differ from the source run"
        )
    dashboard_run.mkdir(parents=True, exist_ok=True)
    if dashboard_run.is_symlink():
        raise RuntimeError("dashboard run directory must not be a symlink")
    atomic_json(dashboard_run / "state.json", state)
    atomic_text(
        dashboard_run / "events.jsonl",
        "".join(
            json.dumps(
                event,
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
            for event in events
        ),
    )
    lines = state["experiment"]["recentLogLines"]
    atomic_text(dashboard_run / "pipeline-tail.log", "\n".join(lines) + "\n")
    summary_source = run_dir / "comparison-summary.json"
    if summary_source.is_file() and not summary_source.is_symlink():
        temporary = dashboard_run / ".monitor-summary.json.tmp"
        shutil.copyfile(summary_source, temporary)
        os.replace(temporary, dashboard_run / "monitor-summary.json")
    else:
        atomic_json(
            dashboard_run / "monitor-summary.json",
            {
                "status": state["status"],
                "phase": state["experiment"]["phase"],
                "sourceRunDirectory": str(run_dir),
            },
        )
    atomic_text(
        dashboard_run / "monitor-report.md",
        "# High-volatility profitability monitor\n\n"
        f"- Status: {state['status']}\n"
        f"- Phase: {state['experiment']['phase']}\n"
        f"- Updated: {state['updatedAt']}\n",
    )
    atomic_text(
        dashboard_run / "monitor-handoff.md",
        f"Inspect source artifacts in `{run_dir}` after terminal status.\n",
    )
    atomic_json(
        dashboard_root / "latest.json",
        {"runId": run_id, "updatedAt": state["updatedAt"]},
    )
    return str(state["status"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--dashboard-root", type=Path, required=True)
    parser.add_argument("--run-id")
    parser.add_argument("--poll-seconds", type=float, default=1.0)
    parser.add_argument("--once", action="store_true")
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    run_dir = arguments.run_dir.resolve()
    dashboard_root = arguments.dashboard_root.resolve()
    run_id = arguments.run_id or run_dir.name
    if not RUN_ID.fullmatch(run_id):
        raise ValueError("dashboard run ID is invalid")
    if not run_dir.is_dir() or run_dir.is_symlink():
        raise ValueError("source run directory must be a real directory")
    if arguments.poll_seconds < 0.25 or arguments.poll_seconds > 10:
        raise ValueError("--poll-seconds must be in 0.25..=10")
    dashboard_root.mkdir(parents=True, exist_ok=True)
    while True:
        status = publish(run_dir, dashboard_root, run_id)
        if arguments.once or status in {"completed", "failed", "cancelled"}:
            return 0
        time.sleep(arguments.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
