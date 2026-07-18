from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from .backtest_engine import simulate_backtest
from .contracts import JobKind, OutputArtifact, SUPPORTED_ENGINE_VERSION, WorkerInput, WorkerOutput
from .optimization import optimize_portfolio


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _backtest_artifacts(result: dict[str, Any]) -> list[OutputArtifact]:
    points = result["points"]
    contributions = result["contributions"]
    final_balance = result["metrics"]["finalBalance"]
    return [
        OutputArtifact(type="equity", content=points, row_count=len(points)),
        OutputArtifact(
            type="drawdown",
            content=[{"date": point["date"], "drawdownPercent": point["drawdownPercent"]} for point in points],
            row_count=len(points),
        ),
        OutputArtifact(
            type="holdings",
            content=[
                {
                    "date": result["endDate"],
                    "symbol": item["symbol"],
                    "name": item["name"],
                    "currency": item["currency"],
                    "ending_value": item["endingValue"],
                    "ending_weight": item["endingValue"] / final_balance if final_balance > 0 else 0,
                }
                for item in contributions
            ],
            row_count=len(contributions),
        ),
        OutputArtifact(type="trades", content=result["trades"], row_count=len(result["trades"])),
        OutputArtifact(
            type="rolling", content=result["advanced"]["rolling"], row_count=len(result["advanced"]["rolling"])
        ),
        OutputArtifact(
            type="correlation", content=result["correlations"], row_count=len(result["correlations"]["assets"])
        ),
        OutputArtifact(
            type="risk-contribution",
            content=result["advanced"]["riskContributions"],
            row_count=len(result["advanced"]["riskContributions"]),
        ),
        OutputArtifact(
            type="monthly-returns",
            content=result["advanced"]["monthlyReturns"],
            row_count=len(result["advanced"]["monthlyReturns"]),
        ),
    ]


def _finalize_backtest(simulation: dict[str, Any], context: dict[str, Any] | None) -> tuple[dict[str, Any], list[str]]:
    if context is None:
        return simulation, []
    warnings = list(context.get("warnings") or [])
    effective_requested_start = str(context["effective_requested_start"])
    if simulation["effectiveStartDate"] > effective_requested_start:
        warnings.insert(
            0,
            f"모든 종목과 비교 지수의 공통 일봉이 시작되는 {simulation['effectiveStartDate']}부터 계산했습니다.",
        )
    result: dict[str, Any] = {
        "generatedAt": _iso_now(),
        "baseCurrency": "KRW",
        "currencyMethod": context["currency_method"],
        "config": {
            **dict(context["config"]),
            "effectiveStartDate": simulation["effectiveStartDate"],
            "effectiveEndDate": simulation["endDate"],
        },
        "assets": context["assets"],
    }
    if context.get("benchmark") is not None:
        result["benchmark"] = context["benchmark"]
    result["warnings"] = warnings
    result.update(simulation)
    return result, warnings


def compute_worker_input(
    worker_input: WorkerInput,
    *,
    candidate_batch_size: int,
    checkpoint: Callable[[], None] | None = None,
    progress: Callable[[float, int, int], None] | None = None,
) -> WorkerOutput:
    if worker_input.engine_version != SUPPORTED_ENGINE_VERSION:
        raise ValueError(
            f"unsupported engine version: {worker_input.engine_version}; expected {SUPPORTED_ENGINE_VERSION}"
        )
    payload = worker_input.payload
    if worker_input.job_kind == JobKind.BACKTEST:
        simulation_input = payload.get("simulation")
        if not isinstance(simulation_input, dict):
            raise ValueError("backtest payload.simulation must be an object")
        if checkpoint:
            checkpoint()
        simulation = simulate_backtest(simulation_input)
        result, warnings = _finalize_backtest(
            simulation,
            payload.get("response_context") if isinstance(payload.get("response_context"), dict) else None,
        )
        return WorkerOutput(
            schema_version="1.0",
            engine_version=worker_input.engine_version,
            run_id=worker_input.run_id,
            job_kind=worker_input.job_kind,
            status="completed",
            summary=result["metrics"],
            result=result,
            warnings=warnings,
            artifacts=_backtest_artifacts(result),
        )
    if worker_input.job_kind == JobKind.OPTIMIZATION:
        optimization_input = payload.get("optimization")
        if not isinstance(optimization_input, dict):
            raise ValueError("optimization payload.optimization must be an object")
        output = optimize_portfolio(
            optimization_input,
            batch_size=candidate_batch_size,
            checkpoint=checkpoint,
            progress=progress,
        )
        objective = str(payload.get("objective") or "robust_score")
        if objective not in output["bestByObjective"]:
            raise ValueError("optimization objective is invalid")
        warnings = list(dict.fromkeys([*(payload.get("market_warnings") or []), *output["warnings"]]))
        result = {
            **output,
            "candidates": output["candidates"][:20],
            "paretoFrontier": output["paretoFrontier"][:100],
        }
        return WorkerOutput(
            schema_version="1.0",
            engine_version=worker_input.engine_version,
            run_id=worker_input.run_id,
            job_kind=worker_input.job_kind,
            status="completed",
            summary={
                "best": output["bestByObjective"][objective],
                "candidate_count": output["candidateCount"],
                "pareto_count": len(output["paretoFrontier"]),
            },
            result=result,
            warnings=warnings,
            artifacts=[
                OutputArtifact(type="candidates", content=output["candidates"], row_count=len(output["candidates"])),
                OutputArtifact(
                    type="worker-pareto-frontier",
                    content=output["paretoFrontier"],
                    row_count=len(output["paretoFrontier"]),
                ),
            ],
        )
    raise ValueError(f"unsupported worker job kind: {worker_input.job_kind.value}")
