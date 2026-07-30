#!/usr/bin/env python3
"""Atomically maintain the dashboard state for Chronos-2 qualification runs."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import tempfile
from typing import Any


STATE_SCHEMA = "ai-p40-qualification-state/v1"
EVENT_SCHEMA = "ai-p40-qualification-event/v1"
LOCK_NAME = ".state.lock"


def absolute_directory(value: str) -> Path:
    path = Path(value)
    if (
        not path.is_absolute()
        or path.is_symlink()
        or path.resolve(strict=True) != path
        or not path.is_dir()
    ):
        raise argparse.ArgumentTypeError("run directory must be absolute and normalized")
    return path


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )


def parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def atomic_json(path: Path, value: object) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def state_lock(run: Path):
    descriptor = os.open(run / LOCK_NAME, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def step(
    step_id: str,
    order: int,
    label: str,
    description: str,
    model: str,
    variant: str,
    estimate_minutes: int,
    output: str,
) -> dict[str, Any]:
    return {
        "id": step_id,
        "order": order,
        "label": label,
        "description": description,
        "model": model,
        "variant": variant,
        "status": "pending",
        "estimatedDurationMs": estimate_minutes * 60_000,
        "outputFile": output,
        "logFile": f"logs/{step_id}.log",
    }


def context_window_steps() -> list[dict[str, Any]]:
    definitions = [
        (
            "preflight", "P40·기준선 사전점검",
            "고정 image/cache, 512 기준선, 복구 대상과 디스크를 확인합니다.",
            "system", "read-only baseline · Tesla P40 · 160W", 2, "preflight.json",
        ),
        (
            "runtime", "고정 Chronos-2 runtime 검증",
            "기존 image와 model cache의 revision 및 SHA-256을 읽기 전용으로 검증합니다.",
            "chronos-2", "no build · no pull · offline cache", 2, "runtime.json",
        ),
        (
            "prepare-source", "8192봉 pre-roll 수집",
            "기존 5주 scored origin은 유지하고 필요한 과거 1분봉만 추가 수집합니다.",
            "chronos-2", "840h scored · 8192 full history", 20, "source/source-manifest.json",
        ),
        (
            "origin-parity", "Scored-origin exact parity",
            "기준선 6,720행과 새 source의 origin identity를 비교하고 192행 pilot을 고정합니다.",
            "comparison", "6,720 full · 192 pilot", 1, "origin-parity.json",
        ),
        (
            "pilot-artifacts", "24시간 5-context artifact",
            "padding 없이 close-only v2 artifact 다섯 개를 생성하고 digest를 검증합니다.",
            "chronos-2", "512/1024/2048/4096/8192", 10, "pilot/inputs/8192/manifest.json",
        ),
        (
            "pilot-benchmark", "24시간 batch/backend pilot",
            "각 후보를 독립 프로세스 1×(2 warmup+5 timed)로 측정합니다.",
            "chronos-2", "10 batches · 4 backends", 45, "pilot/selection.json",
        ),
        (
            "pilot-gate", "자동 5주 진입 gate",
            "수치·origin·VRAM·ETA·disk gate를 모두 확인합니다.",
            "comparison", "2GiB · 8h · 30GiB", 2, "pilot/gate.json",
        ),
        (
            "full-artifacts", "5주 5-context artifact",
            "동일 6,720 origin의 close-only v2 artifact를 생성합니다.",
            "chronos-2", "no clobber · exact parity", 20, "full/inputs/8192/manifest.json",
        ),
        (
            "full-benchmark", "5주 batch/backend sweep",
            "각 후보를 독립 프로세스 3×(10 warmup+30 timed)로 측정합니다.",
            "chronos-2", "10 batches · 4 backends", 180, "full/selection.json",
        ),
        (
            "full-generation", "5주 raw forecast 생성",
            "context별 선택 backend로 6,720행 raw forecast를 한 번 생성합니다.",
            "chronos-2", "5 contexts · resumable chunks", 120, "full/outputs/8192/manifest.json",
        ),
        (
            "accuracy-analysis", "정확도·bootstrap 분석",
            "Pinball/WIS/calibration과 분해, paired bootstrap 및 Holm 결과를 계산합니다.",
            "comparison", "3h blocks · 5000 · seed 17", 10, "qualification-summary.json",
        ),
        (
            "finalize", "Development context 선택",
            "정확도 우선 규칙으로 context를 고르고 holdout pending 상태를 기록합니다.",
            "comparison", "no promotion · no default change", 1, "qualification-summary.json",
        ),
    ]
    return [
        step(step_id, order, label, description, model, variant, estimate, output)
        for order, (
            step_id,
            label,
            description,
            model,
            variant,
            estimate,
            output,
        ) in enumerate(definitions, start=1)
    ]


def steps(
    mode: str,
    duration_hours: int,
    experiment: str = "model-comparison",
) -> list[dict[str, Any]]:
    if experiment == "context-window":
        return context_window_steps()
    if mode == "pilot":
        return [
            step(
                "preflight",
                1,
                "P40·운영 상태 사전점검",
                "P40, 160W, host CUDA toolkit/cuDNN header, 운영 복구 대상을 기록합니다.",
                "system",
                "host nvcc 12.2 · host header 8.9.7",
                1,
                "preflight.json",
            ),
            step(
                "runtime",
                2,
                "Chronos-2 고정 runtime·가중치",
                "실제 PyTorch CUDA/cuDNN runtime과 패키지·revision·SHA를 검증합니다.",
                "chronos-2",
                "FP32 · torch cu124 · exact revision",
                20,
                "runtime.json",
            ),
            step(
                "prepare-input",
                3,
                f"{duration_hours}시간 정렬 입력·추가 covariate",
                "BTC/ETH 1분봉, 거래 미세구조, mark/index/premium/funding을 causal하게 수집합니다.",
                "comparison",
                f"c60 · {duration_hours}h · four profiles",
                10,
                "input/source-manifest.json",
            ),
            step(
                "chronos-artifacts",
                4,
                "Chronos-2 4개 입력 profile",
                "close-only부터 derivatives까지 같은 origin 순서로 고정 artifact를 만듭니다.",
                "chronos-2",
                "close · OHLCV · microstructure · derivatives",
                10,
                "inputs/derivatives_calendar/manifest.json",
            ),
            step(
                "pilot-inference",
                5,
                "짧은 범위 최적화·모델 추론",
                "FinCast CUDA Graph와 Chronos-2 backend를 같은 origin에서 실행합니다.",
                "comparison",
                "measured ETA pilot",
                40,
                "pilot-timing.json",
            ),
            step(
                "pilot-comparison",
                6,
                "짧은 범위 정확도·수익률",
                "동일 정책, 확률 임계값, 실현 가격으로 끝까지 비교합니다.",
                "comparison",
                "policy + realized outcomes",
                10,
                "comparisons/derivatives_calendar.json",
            ),
            step(
                "eta",
                7,
                "5주 소요시간 추정",
                "실측 고정비와 row 처리비를 분리해 기준·보수적 ETA를 계산합니다.",
                "comparison",
                "840h extrapolation",
                1,
                "eta.json",
            ),
        ]
    return [
        step(
            "preflight",
            1,
            "P40·운영 상태 사전점검",
            "P40, 160W, host toolkit/header와 운영 복구 대상을 기록합니다.",
            "system",
            "Tesla P40 · 160W · host CUDA 12.2",
            1,
            "preflight.json",
        ),
        step(
            "runtime",
            2,
            "Chronos-2 runtime 재검증",
            "PyTorch CUDA/cuDNN runtime, 이미지, 가중치 digest를 재검증합니다.",
            "chronos-2",
            "torch 2.6.0+cu124 · cuDNN 9.1 · offline cache",
            2,
            "runtime.json",
        ),
        step(
            "prepare-input",
            3,
            "5주 정렬 입력·추가 covariate",
            "BTC/ETH 840시간 데이터와 네 입력 profile의 공통 source를 수집합니다.",
            "comparison",
            "c60 · 840h · 6,720 rows",
            15,
            "input/source-manifest.json",
        ),
        step(
            "chronos-artifacts",
            4,
            "Chronos-2 4개 입력 profile",
            "동일 origin 순서의 fixed-shape binary artifact를 생성·검증합니다.",
            "chronos-2",
            "1 / 11 / 14 / 18 variates",
            20,
            "inputs/derivatives_calendar/manifest.json",
        ),
        step(
            "batch-sweep",
            5,
            "Batch 16/24/32/48/50 sweep",
            "chronos-2",
            "four profiles · 20 candidates",
            90,
            "selection.json",
        ),
        step(
            "optimization-waterfall",
            6,
            "Chronos-2 누적 최적화 waterfall",
            "pipeline, worker-local, patch-aligned, GPU gather, CUDA Graph를 측정합니다.",
            "chronos-2",
            "five stages · exact/numeric gates",
            90,
            "optimization-summary.json",
        ),
        step(
            "fincast-reference",
            7,
            "FinCast CUDA Graph FP32 기준",
            "현재 운영 기본 backend를 같은 5주 origin에서 실행합니다.",
            "fincast",
            "cuda_graph · c60/B48",
            10,
            "outputs/fincast/manifest.json",
        ),
        step(
            "chronos-profiles",
            8,
            "Chronos-2 4개 profile OOS",
            "각 profile의 가장 빠른 합격 FP32 backend로 5주 raw prediction을 생성합니다.",
            "chronos-2",
            "four input ablations",
            120,
            "outputs/chronos2/derivatives_calendar/manifest.json",
        ),
        step(
            "model-comparison",
            9,
            "정확도·수익률·reason 비교",
            "실현 오차, 확률, 정책 threshold margin, P&L/MDD를 profile별로 기록합니다.",
            "comparison",
            "FinCast vs Chronos-2",
            20,
            "comparisons/derivatives_calendar.json",
        ),
        step(
            "final-summary",
            10,
            "입력 profile·backend 판정",
            "추가 정보의 holdout 개선 여부와 최적화별 속도 향상을 집계합니다.",
            "comparison",
            "no live auto-promotion",
            2,
            "qualification-summary.json",
        ),
    ]


def progress(state: dict[str, Any]) -> None:
    all_steps = state["steps"]
    completed = sum(item["status"] == "completed" for item in all_steps)
    failed = sum(item["status"] == "failed" for item in all_steps)
    skipped = sum(item["status"] == "skipped" for item in all_steps)
    total = len(all_steps)
    started_at = parse_iso(state.get("startedAt", state["createdAt"]))
    elapsed = max(
        0,
        int((datetime.now(timezone.utc) - started_at).total_seconds() * 1_000),
    )
    deadline = parse_iso(state["deadlineAt"])
    state["progress"] = {
        "completedSteps": completed,
        "failedSteps": failed,
        "skippedSteps": skipped,
        "totalSteps": total,
        "percent": min(100, (completed + failed + skipped) / total * 100),
        "activeStepPercent": 0 if state["activeStepId"] else None,
        "elapsedMs": elapsed,
        "remainingBudgetMs": max(
            0,
            int((deadline - datetime.now(timezone.utc)).total_seconds() * 1_000),
        ),
    }
    state["updatedAt"] = iso_now()


def read_state(run: Path) -> dict[str, Any]:
    value = json.loads((run / "state.json").read_bytes())
    if not isinstance(value, dict) or value.get("schemaVersion") != STATE_SCHEMA:
        raise ValueError("qualification state is invalid")
    return value


def append_event(
    run: Path,
    state: dict[str, Any],
    event_type: str,
    message: str,
    *,
    step_id: str | None = None,
) -> None:
    event_path = run / "events.jsonl"
    sequence = 1
    if event_path.is_file():
        with event_path.open("rb") as handle:
            sequence += sum(1 for _line in handle)
    event = {
        "schemaVersion": EVENT_SCHEMA,
        "sequence": sequence,
        "runId": state["runId"],
        "at": iso_now(),
        "type": event_type,
        "message": message[:2_000],
        "progressPercent": state["progress"]["percent"],
    }
    if step_id is not None:
        event["stepId"] = step_id
    if event_type == "run_completed":
        event["status"] = state["status"]
    with event_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def command_init(args: argparse.Namespace) -> None:
    run = args.run_dir
    if any(entry.name != LOCK_NAME for entry in run.iterdir()):
        raise ValueError("new qualification run directory must be empty")
    now = datetime.now(timezone.utc)
    state = {
        "schemaVersion": STATE_SCHEMA,
        "runId": args.run_id,
        "status": "running",
        "createdAt": iso_now(),
        "startedAt": iso_now(),
        "updatedAt": iso_now(),
        "deadlineAt": (
            now + timedelta(hours=args.budget_hours)
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "activeStepId": None,
        "config": {
            "budgetHours": args.budget_hours,
            "durationHours": args.duration_hours,
            "endExclusive": parse_iso(args.end_exclusive)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "symbols": ["BTCUSDT", "ETHUSDT"],
            "gpu": "Tesla P40",
            "cudaCapability": "6.1",
            "workerMode": "docker-source",
            "dockerBuild": True,
        },
        "progress": {},
        "steps": steps(args.mode, args.duration_hours, args.experiment),
        "artifacts": {
            "summaryJson": "qualification-summary.json",
            "reportMarkdown": "qualification-report.md",
            "handoffPrompt": "codex-handoff-prompt.md",
        },
        "experiment": {
            "kind": "chronos2-fincast-model-comparison",
            "mode": args.mode,
            "durationWeeks": args.duration_hours / 168,
            "cadenceSeconds": 60,
            "profiles": [
                "close_only",
                "ohlcv_calendar",
                "microstructure_calendar",
                "derivatives_calendar",
            ],
            "referenceModel": "fincast",
            "candidateModel": "chronos-2",
            "referenceBackend": "cuda_graph",
            "candidateBackend": None,
            "automaticLivePromotion": False,
            "metrics": {},
        },
    }
    if args.experiment == "context-window":
        state["config"]["dockerBuild"] = False
        state["experiment"] = {
            "kind": "chronos2-context-window-comparison",
            "phase": "pilot",
            "durationWeeks": 5,
            "cadenceSeconds": 60,
            "profile": "close_only",
            "crossLearning": False,
            "contexts": [512, 1024, 2048, 4096, 8192],
            "batchCandidates": [1, 2, 4, 8, 12, 16, 24, 32, 48, 50],
            "backendCandidates": [
                "pipeline_eager",
                "worker_local",
                "no_padding",
                "gpu_gather",
            ],
            "automaticLivePromotion": False,
            "resultStatus": None,
            "metrics": {},
        }
    progress(state)
    atomic_json(run / "state.json", state)
    atomic_json(run.parent / "latest.json", {"runId": args.run_id})
    append_event(run, state, "run_created", f"Chronos-2 {args.mode} run created")
    append_event(run, state, "run_started", "qualification automation started")


def resolve_step(state: dict[str, Any], step_id: str) -> dict[str, Any]:
    for item in state["steps"]:
        if item["id"] == step_id:
            return item
    raise ValueError(f"unknown step: {step_id}")


def command_step(
    args: argparse.Namespace,
    action: str,
) -> None:
    state = read_state(args.run_dir)
    current = resolve_step(state, args.step_id)
    now = iso_now()
    if action == "start":
        if current["status"] not in {"pending", "running", "failed"}:
            raise ValueError("only pending, running, or failed steps can start")
        restarting = current["status"] == "failed"
        other_running = [
            item["id"]
            for item in state["steps"]
            if item["status"] == "running" and item["id"] != args.step_id
        ]
        if other_running:
            raise ValueError(
                f"another qualification step is already running: {other_running[0]}"
            )
        current["status"] = "running"
        current.pop("finishedAt", None)
        current.pop("durationMs", None)
        current.pop("error", None)
        if restarting:
            current["startedAt"] = now
        else:
            current.setdefault("startedAt", now)
        state["status"] = "running"
        state.pop("finishedAt", None)
        state["activeStepId"] = args.step_id
        event_type = "step_started"
        message = args.message or f"{current['label']} started"
    else:
        if current["status"] != "running":
            raise ValueError("only running steps can finish")
        current["status"] = "completed" if action == "complete" else "failed"
        current["finishedAt"] = now
        started = parse_iso(current["startedAt"])
        current["durationMs"] = max(
            0,
            int((parse_iso(now) - started).total_seconds() * 1_000),
        )
        if action == "complete":
            current["summary"] = (args.message or f"{current['label']} completed")[:1_000]
            event_type = "step_completed"
        else:
            current["error"] = (args.message or f"{current['label']} failed")[:2_000]
            event_type = "step_failed"
        state["activeStepId"] = None
        message = args.message or f"{current['label']} {action}d"
    progress(state)
    atomic_json(args.run_dir / "state.json", state)
    append_event(
        args.run_dir,
        state,
        event_type,
        message,
        step_id=args.step_id,
    )


def command_telemetry(args: argparse.Namespace) -> None:
    state = read_state(args.run_dir)
    values = [value.strip() for value in args.csv.split(",")]
    if len(values) != 7:
        raise ValueError("telemetry CSV must contain seven values")
    total, used, utilization, temperature, power_draw, power_limit, free = map(
        float,
        values,
    )
    state["telemetry"] = {
        "polledAt": iso_now(),
        "gpuUtilizationPercent": utilization,
        "memoryUsedMiB": used,
        "memoryTotalMiB": total,
        "temperatureC": temperature,
        "powerDrawW": power_draw,
        "powerLimitW": power_limit,
        "memoryHeadroomMiB": free,
    }
    progress(state)
    atomic_json(args.run_dir / "state.json", state)


def command_finish(args: argparse.Namespace) -> None:
    state = read_state(args.run_dir)
    state["status"] = args.status
    state["activeStepId"] = None
    state["finishedAt"] = iso_now()
    progress(state)
    atomic_json(args.run_dir / "state.json", state)
    append_event(
        args.run_dir,
        state,
        "run_completed",
        args.message or f"qualification finished with {args.status}",
    )


def command_metrics(args: argparse.Namespace) -> None:
    state = read_state(args.run_dir)
    value = json.loads(args.json_file.read_bytes())
    if not isinstance(value, dict):
        raise ValueError("experiment metrics must be a JSON object")
    result_status = value.pop("resultStatus", None)
    experiment = state.get("experiment")
    if not isinstance(experiment, dict):
        raise ValueError("qualification state has no experiment")
    experiment["metrics"] = {
        **(
            experiment.get("metrics")
            if isinstance(experiment.get("metrics"), dict)
            else {}
        ),
        **value,
    }
    if isinstance(value.get("selectedBackend"), str):
        experiment["candidateBackend"] = value["selectedBackend"]
    if result_status == "development_context_selected_holdout_pending":
        experiment["resultStatus"] = result_status
    progress(state)
    atomic_json(args.run_dir / "state.json", state)


def command_phase(args: argparse.Namespace) -> None:
    state = read_state(args.run_dir)
    experiment = state.get("experiment")
    if (
        not isinstance(experiment, dict)
        or experiment.get("kind") != "chronos2-context-window-comparison"
    ):
        raise ValueError("qualification state is not a context-window experiment")
    experiment["phase"] = args.phase
    progress(state)
    atomic_json(args.run_dir / "state.json", state)


def command_context_result(args: argparse.Namespace) -> None:
    state = read_state(args.run_dir)
    experiment = state.get("experiment")
    if (
        not isinstance(experiment, dict)
        or experiment.get("kind") != "chronos2-context-window-comparison"
    ):
        raise ValueError("qualification state is not a context-window experiment")
    metrics = experiment.setdefault("metrics", {})
    existing = metrics.get("contextResults", [])
    if not isinstance(existing, list):
        existing = []
    result = next(
        (
            value
            for value in existing
            if isinstance(value, dict) and value.get("contextBars") == args.context_bars
        ),
        None,
    )
    if result is None:
        result = {"contextBars": args.context_bars}
        existing.append(result)
    result.update(
        {
            "status": args.status,
            "progressPercent": args.progress_percent,
        }
    )
    for field, value in (
        ("batchSize", args.batch_size),
        ("backend", args.backend),
        ("latencyP95Ms", args.latency_p95_ms),
        ("tasksPerSecond", args.tasks_per_second),
        ("minimumFreeVramBytes", args.minimum_free_vram_bytes),
        ("artifactDigest", args.artifact_digest),
        ("failureCount", args.failure_count),
    ):
        if value is not None:
            result[field] = value
    metrics["contextResults"] = sorted(
        existing,
        key=lambda value: int(value["contextBars"]),
    )
    progress(state)
    if state["activeStepId"] is not None:
        state["progress"]["activeStepPercent"] = args.progress_percent
    atomic_json(args.run_dir / "state.json", state)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    commands = value.add_subparsers(dest="command", required=True)
    initialize = commands.add_parser("init")
    initialize.add_argument("--run-dir", type=absolute_directory, required=True)
    initialize.add_argument("--run-id", required=True)
    initialize.add_argument("--mode", choices=("pilot", "full"), required=True)
    initialize.add_argument("--duration-hours", type=int, required=True)
    initialize.add_argument("--end-exclusive", required=True)
    initialize.add_argument("--budget-hours", type=float, required=True)
    initialize.add_argument(
        "--experiment",
        choices=("model-comparison", "context-window"),
        default="model-comparison",
    )
    for name in ("step-start", "step-complete", "step-fail"):
        step_command = commands.add_parser(name)
        step_command.add_argument("--run-dir", type=absolute_directory, required=True)
        step_command.add_argument("--step-id", required=True)
        step_command.add_argument("--message")
    telemetry = commands.add_parser("telemetry")
    telemetry.add_argument("--run-dir", type=absolute_directory, required=True)
    telemetry.add_argument("--csv", required=True)
    finish = commands.add_parser("finish")
    finish.add_argument("--run-dir", type=absolute_directory, required=True)
    finish.add_argument(
        "--status",
        choices=(
            "completed",
            "completed_with_failures",
            "failed",
            "cancelled",
            "budget_exhausted",
        ),
        required=True,
    )
    finish.add_argument("--message")
    metrics = commands.add_parser("experiment-metrics")
    metrics.add_argument("--run-dir", type=absolute_directory, required=True)
    metrics.add_argument("--json-file", type=Path, required=True)
    phase = commands.add_parser("phase")
    phase.add_argument("--run-dir", type=absolute_directory, required=True)
    phase.add_argument("--phase", choices=("pilot", "full"), required=True)
    context_result = commands.add_parser("context-result")
    context_result.add_argument("--run-dir", type=absolute_directory, required=True)
    context_result.add_argument(
        "--context-bars",
        type=int,
        choices=(512, 1024, 2048, 4096, 8192),
        required=True,
    )
    context_result.add_argument(
        "--status",
        choices=("pending", "running", "passed", "rejected", "failed", "completed"),
        required=True,
    )
    context_result.add_argument("--progress-percent", type=float, required=True)
    context_result.add_argument("--batch-size", type=int)
    context_result.add_argument(
        "--backend",
        choices=("pipeline_eager", "worker_local", "no_padding", "gpu_gather"),
    )
    context_result.add_argument("--latency-p95-ms", type=float)
    context_result.add_argument("--tasks-per-second", type=float)
    context_result.add_argument("--minimum-free-vram-bytes", type=int)
    context_result.add_argument("--artifact-digest")
    context_result.add_argument("--failure-count", type=int)
    return value


def main() -> int:
    args = parser().parse_args()
    with state_lock(args.run_dir):
        if args.command == "init":
            command_init(args)
        elif args.command == "step-start":
            command_step(args, "start")
        elif args.command == "step-complete":
            command_step(args, "complete")
        elif args.command == "step-fail":
            command_step(args, "fail")
        elif args.command == "telemetry":
            command_telemetry(args)
        elif args.command == "finish":
            command_finish(args)
        elif args.command == "experiment-metrics":
            command_metrics(args)
        elif args.command == "phase":
            command_phase(args)
        elif args.command == "context-result":
            command_context_result(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
