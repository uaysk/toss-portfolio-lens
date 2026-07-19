from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np
from numpy.typing import NDArray

MASK32 = 0xFFFFFFFF
UINT32_SCALE = 4_294_967_296.0
DEFAULT_SEED = 0xC0FFEE
OBJECTIVES = (
    "max_cagr",
    "max_total_return",
    "max_sharpe",
    "max_sortino",
    "max_calmar",
    "min_volatility",
    "min_cvar",
    "max_information_ratio",
    "robust_score",
)


class DeterministicRng:
    def __init__(self, seed: int) -> None:
        self.state = int(seed) & MASK32
        if self.state == 0:
            self.state = 0x6D2B79F5

    @staticmethod
    def _imul(left: int, right: int) -> int:
        return ((left & MASK32) * (right & MASK32)) & MASK32

    def next(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & MASK32
        value = self.state
        value = self._imul(value ^ (value >> 15), value | 1)
        value = (value ^ ((value + self._imul(value ^ (value >> 7), value | 61)) & MASK32)) & MASK32
        return ((value ^ (value >> 14)) & MASK32) / UINT32_SCALE

    def next_int(self, maximum: int) -> int:
        return math.floor(self.next() * maximum) if isinstance(maximum, int) and maximum > 0 else 0


@dataclass(slots=True)
class Constraints:
    min_weight: float
    max_weight: float
    required_assets: list[str]
    excluded_assets: list[str]
    max_assets: int
    min_weights: dict[str, float]
    max_weights: dict[str, float]
    max_drawdown: float
    target_return: float
    max_turnover: float
    current_weights: dict[str, float]


@dataclass(slots=True)
class Frame:
    ids: list[str]
    dates: list[str]
    returns: NDArray[np.float64]


def _positive_int(value: Any, fallback: int, minimum: int = 1, maximum: int = 2**53 - 1) -> int:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(numeric):
        return fallback
    return max(minimum, min(maximum, math.floor(numeric)))


def _decimal(value: Any, fallback: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(numeric):
        return fallback
    return max(minimum, min(maximum, numeric))


def _walk_forward_config(config: dict[str, Any] | None) -> dict[str, int]:
    value = config or {}
    train = _positive_int(value.get("trainWindow"), 126, 2, 10_000)
    test = _positive_int(value.get("testWindow"), 42, 1, 10_000)
    step = max(1, _positive_int(value.get("step"), max(1, test), 1, 10_000))
    return {
        "trainWindow": train,
        "testWindow": test,
        "step": step,
        "minimumTrainObservations": _positive_int(
            value.get("minimumTrainObservations"), max(2, math.floor(train * 0.5)), 1, train
        ),
        "minimumTestObservations": _positive_int(
            value.get("minimumTestObservations"), max(1, math.floor(test * 0.5)), 1, test
        ),
    }


def build_walk_forward_windows(total_length: int, config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    safe_length = _positive_int(total_length, 0, 0, 10_000_000)
    normalized = _walk_forward_config(config)
    windows: list[dict[str, Any]] = []
    if safe_length == 0:
        return windows
    train_start = 0
    while train_start + normalized["trainWindow"] + normalized["testWindow"] <= safe_length:
        train_end = train_start + normalized["trainWindow"] - 1
        test_start = train_end + 1
        test_end = test_start + normalized["testWindow"] - 1
        if test_end >= safe_length:
            break
        train_count = train_end - train_start + 1
        test_count = test_end - test_start + 1
        if (
            train_count >= normalized["minimumTrainObservations"]
            and test_count >= normalized["minimumTestObservations"]
        ):
            windows.append(
                {
                    "trainStartIndex": train_start,
                    "trainEndIndex": train_end,
                    "testStartIndex": test_start,
                    "testEndIndex": test_end,
                    "trainStart": f"index-{train_start}",
                    "trainEnd": f"index-{train_end}",
                    "testStart": f"index-{test_start}",
                    "testEnd": f"index-{test_end}",
                    "trainCount": train_count,
                    "testCount": test_count,
                }
            )
        train_start += normalized["step"]
    return windows


def _valid_date(value: Any) -> bool:
    if not isinstance(value, str) or len(value) != 10:
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _sanitize(points: list[dict[str, Any]], *, positive_only: bool) -> list[tuple[str, float]]:
    by_date: dict[str, float] = {}
    for point in points:
        point_date = point.get("date")
        value = point.get("value")
        if not _valid_date(point_date) or not isinstance(value, (int, float)) or not math.isfinite(value):
            continue
        numeric = float(value)
        if positive_only and numeric <= 0:
            continue
        by_date[point_date] = numeric
    return sorted(by_date.items())


def _aligned_frame(price_series: list[dict[str, Any]]) -> Frame:
    returns_by_id: list[tuple[str, dict[str, float]]] = []
    for series in price_series:
        points = _sanitize(list(series.get("points") or []), positive_only=True)
        returns = {
            points[index][0]: points[index][1] / points[index - 1][1] - 1
            for index in range(1, len(points))
            if math.isfinite(points[index][1] / points[index - 1][1] - 1)
        }
        returns_by_id.append((str(series.get("key", "")), returns))
    dates = (
        [point_date for point_date in returns_by_id[0][1] if all(point_date in values for _, values in returns_by_id)]
        if returns_by_id
        else []
    )
    matrix = np.ascontiguousarray(
        [[values[point_date] for _, values in returns_by_id] for point_date in dates], dtype=np.float64
    )
    if matrix.size == 0:
        matrix = np.empty((0, len(returns_by_id)), dtype=np.float64)
    return Frame(ids=[key for key, _ in returns_by_id], dates=dates, returns=matrix)


def _normalize_constraints(raw: dict[str, Any], asset_count: int) -> tuple[Constraints, list[str]]:
    warnings: list[str] = []
    required = list(dict.fromkeys(item for item in raw.get("requiredAssets", []) if isinstance(item, str) and item.strip()))
    excluded = list(dict.fromkeys(item for item in raw.get("excludedAssets", []) if isinstance(item, str) and item.strip()))
    max_assets = _positive_int(raw.get("maxAssets"), asset_count, 1, max(1, asset_count))
    min_weight = _decimal(raw.get("minWeight"), 0)
    max_weight = _decimal(raw.get("maxWeight"), 1)
    min_weights = {key: _decimal(value, min_weight) for key, value in (raw.get("minWeights") or {}).items()}
    max_weights = {key: _decimal(value, max_weight) for key, value in (raw.get("maxWeights") or {}).items()}
    max_drawdown_raw = raw.get("maxDrawdown")
    target_return_raw = raw.get("targetReturn")
    max_turnover_raw = raw.get("maxTurnover")
    constraints = Constraints(
        min_weight=min_weight,
        max_weight=max_weight,
        required_assets=required,
        excluded_assets=excluded,
        max_assets=max_assets,
        min_weights=min_weights,
        max_weights=max_weights,
        max_drawdown=abs(float(max_drawdown_raw))
        if isinstance(max_drawdown_raw, (int, float)) and math.isfinite(max_drawdown_raw)
        else 1,
        target_return=float(target_return_raw)
        if isinstance(target_return_raw, (int, float)) and math.isfinite(target_return_raw)
        else -math.inf,
        max_turnover=max(0, float(max_turnover_raw))
        if isinstance(max_turnover_raw, (int, float)) and math.isfinite(max_turnover_raw)
        else 1,
        current_weights=dict(raw.get("currentWeights") or {}),
    )
    if constraints.max_weight < constraints.min_weight:
        warnings.append("최대 비중이 최소 비중보다 작아 최소 비중을 최대 비중에 맞춥니다.")
        constraints.max_weight = constraints.min_weight
    if constraints.max_assets > asset_count:
        constraints.max_assets = max(1, asset_count)
        warnings.append("최대 자산 수가 전체 후보 수보다 커서 전체 수로 보정했습니다.")
    return constraints, warnings


def _candidate_weights(
    rng: DeterministicRng,
    eligible: list[str],
    required: list[str],
    constraints: Constraints,
) -> dict[str, float] | None:
    required_set = set(required)
    required_set.update(key for key, minimum in constraints.min_weights.items() if minimum > 0)
    available = [item for item in eligible if item not in constraints.excluded_assets and len(item) > 0]
    if not available:
        return None
    mandatory = [item for item in available if item in required_set]
    if len(mandatory) > constraints.max_assets:
        return None
    max_count = min(constraints.max_assets, len(available))
    min_count = max(len(mandatory), 1)
    chosen_count = min_count + rng.next_int(max_count - min_count + 1)
    candidate_ids = list(mandatory)
    shuffled = list(available)
    for index in range(len(shuffled) - 1, 0, -1):
        swap = rng.next_int(index + 1)
        shuffled[index], shuffled[swap] = shuffled[swap], shuffled[index]
    for item in shuffled:
        if item in candidate_ids:
            continue
        if len(candidate_ids) >= chosen_count:
            break
        candidate_ids.append(item)
    if not candidate_ids:
        return None
    minimums = {
        item: max(constraints.min_weight, float(constraints.min_weights.get(item, 0))) for item in candidate_ids
    }
    maximums = {
        item: min(constraints.max_weight, float(constraints.max_weights.get(item, 1))) for item in candidate_ids
    }
    if any(minimums[item] > maximums[item] for item in candidate_ids):
        return None
    minimum_total = sum(minimums[item] for item in candidate_ids)
    maximum_total = sum(maximums[item] for item in candidate_ids)
    if minimum_total > 1 + 1e-12 or maximum_total < 1 - 1e-12:
        return None
    candidate = {item: minimums[item] for item in candidate_ids}
    residual = 1 - minimum_total
    for _ in range(100):
        if residual <= 1e-12:
            break
        active = [item for item in candidate_ids if maximums[item] - candidate[item] > 1e-12]
        if not active:
            return None
        raw = [1 + rng.next() for _ in active]
        raw_total = sum(raw)
        distributed = 0.0
        for index, item in enumerate(active):
            capacity = maximums[item] - candidate[item]
            addition = min(capacity, residual * raw[index] / raw_total)
            candidate[item] += addition
            distributed += addition
        if distributed <= 1e-14:
            return None
        residual -= distributed
    return None if residual > 1e-9 else candidate


def _signature(weights: dict[str, float]) -> str:
    return "|".join(f"{key}:{weights[key]:.12f}" for key in sorted(weights))


def _sample_std(values: NDArray[np.float64], axis: int = 1) -> NDArray[np.float64]:
    if values.shape[axis] < 2:
        output_shape = values.shape[:axis] + values.shape[axis + 1 :]
        return np.zeros(output_shape, dtype=np.float64)
    return np.std(values, axis=axis, ddof=1)


def _metrics_batch(
    frame: Frame,
    weight_dicts: list[dict[str, float]],
    benchmark: dict[str, Any] | None,
    *,
    annualization: float,
    confidence: float,
    minimum_samples: int,
    risk_free_percent: float,
    windows: list[dict[str, Any]],
    constraints: Constraints,
    transaction_cost_bps: float,
) -> list[dict[str, Any]]:
    weights = np.zeros((len(weight_dicts), len(frame.ids)), dtype=np.float64)
    for row, candidate in enumerate(weight_dicts):
        for column, asset_id in enumerate(frame.ids):
            weights[row, column] = candidate.get(asset_id, 0.0)
    portfolio = np.ascontiguousarray(weights @ frame.returns.T)
    observations = portfolio.shape[1]
    risk_free_period = (1 + risk_free_percent / 100) ** (1 / annualization) - 1
    cumulative = np.prod(1 + portfolio, axis=1) - 1 if observations else np.full(len(weight_dicts), np.nan)
    if observations:
        first = date.fromisoformat(frame.dates[0])
        last = date.fromisoformat(frame.dates[-1])
        elapsed_years = max(1 / annualization, ((last - first).days + 365.25 / annualization) / 365.25)
    else:
        elapsed_years = 0
    cagr = np.where(
        (1 + cumulative > 0) & (elapsed_years > 0),
        np.power(1 + cumulative, 1 / elapsed_years) - 1,
        np.nan,
    )
    deviation = _sample_std(portfolio)
    volatility = deviation * math.sqrt(annualization) if observations >= 2 else np.full(len(weight_dicts), np.nan)
    excess_mean = np.mean(portfolio - risk_free_period, axis=1) if observations else np.zeros(len(weight_dicts))
    sharpe = np.divide(
        excess_mean * math.sqrt(annualization),
        deviation,
        out=np.full(len(weight_dicts), np.nan),
        where=deviation > 0,
    )
    downside = (
        np.sqrt(np.mean(np.minimum(portfolio - risk_free_period, 0) ** 2, axis=1))
        if observations
        else np.zeros(len(weight_dicts))
    )
    sortino = np.divide(
        excess_mean * math.sqrt(annualization),
        downside,
        out=np.full(len(weight_dicts), np.nan),
        where=downside > 0,
    )
    growth = np.cumprod(1 + portfolio, axis=1) if observations else np.empty_like(portfolio)
    peaks = np.maximum.accumulate(growth, axis=1) if observations else np.empty_like(portfolio)
    drawdowns = growth / peaks - 1 if observations else np.empty_like(portfolio)
    max_drawdown = np.min(drawdowns, axis=1) if observations else np.full(len(weight_dicts), np.nan)
    calmar = np.divide(
        cagr,
        np.abs(max_drawdown),
        out=np.full(len(weight_dicts), np.nan),
        where=max_drawdown < 0,
    )
    if observations:
        value_at_risk = np.quantile(portfolio, 1 - confidence, axis=1, method="linear")
        cvar = np.array(
            [np.mean(row[row <= value_at_risk[index]]) for index, row in enumerate(portfolio)], dtype=np.float64
        )
    else:
        cvar = np.full(len(weight_dicts), np.nan)

    information = np.full(len(weight_dicts), np.nan)
    if benchmark:
        clean_benchmark = dict(_sanitize(list(benchmark.get("points") or []), positive_only=False))
        indices = [index for index, point_date in enumerate(frame.dates) if point_date in clean_benchmark]
        if indices:
            portfolio_pair = portfolio[:, indices]
            benchmark_values = np.array([clean_benchmark[frame.dates[index]] for index in indices], dtype=np.float64)
            differences = portfolio_pair - benchmark_values
            tracking = _sample_std(differences) * math.sqrt(annualization)
            information = np.divide(
                np.mean(differences, axis=1) * annualization,
                tracking,
                out=np.full(len(weight_dicts), np.nan),
                where=tracking > 0,
            )

    wf_coverage = np.zeros(len(weight_dicts), dtype=np.float64)
    wf_average_sharpe = np.full(len(weight_dicts), np.nan)
    wf_worst_sharpe = np.full(len(weight_dicts), np.nan)
    wf_average_cvar = np.full(len(weight_dicts), np.nan)
    if windows:
        window_sharpes: list[NDArray[np.float64]] = []
        window_cvars: list[NDArray[np.float64]] = []
        total_test = 0
        for window in windows:
            test = portfolio[:, window["testStartIndex"] : window["testEndIndex"] + 1]
            count = test.shape[1]
            if count == 0:
                continue
            total_test += max(0, int(window["testCount"]))
            test_std = _sample_std(test)
            test_excess = np.mean(test - risk_free_period, axis=1)
            test_sharpe = np.divide(
                test_excess * math.sqrt(annualization),
                test_std,
                out=np.full(len(weight_dicts), np.nan),
                where=(test_std > 0) & (count >= minimum_samples),
            )
            quantiles = np.quantile(test, 1 - confidence, axis=1, method="linear")
            test_cvar = np.array(
                [np.mean(row[row <= quantiles[index]]) if count >= minimum_samples else np.nan for index, row in enumerate(test)]
            )
            window_sharpes.append(test_sharpe)
            window_cvars.append(test_cvar)
        if window_sharpes:
            sharpe_matrix = np.vstack(window_sharpes).T
            cvar_matrix = np.vstack(window_cvars).T
            with np.errstate(all="ignore"):
                wf_average_sharpe = np.nanmean(sharpe_matrix, axis=1)
                wf_worst_sharpe = np.nanmin(sharpe_matrix, axis=1)
                wf_average_cvar = np.nanmean(cvar_matrix, axis=1)
        wf_coverage[:] = total_test / max(1, observations)

    current = np.array([float(constraints.current_weights.get(asset_id, 0)) for asset_id in frame.ids])
    turnover = 0.5 * np.sum(np.abs(weights - current), axis=1)
    transaction_cost = turnover * transaction_cost_bps / 10_000

    def present(value: float) -> float | None:
        return float(value) if math.isfinite(float(value)) else None

    output: list[dict[str, Any]] = []
    for index, candidate_weights in enumerate(weight_dicts):
        metric = {
            "cagr": present(cagr[index]),
            "totalReturn": present(cumulative[index]),
            "sharpe": present(sharpe[index]),
            "sortino": present(sortino[index]),
            "calmar": present(calmar[index]),
            "volatility": present(volatility[index]),
            "cvar": present(cvar[index]),
            "informationRatio": present(information[index]),
            "robustScore": None,
            "return": present(cagr[index]),
            "maxDrawdown": present(max_drawdown[index]),
            "turnover": float(turnover[index]),
            "transactionCost": float(transaction_cost[index]),
            "period": {
                "from": frame.dates[0] if frame.dates else None,
                "to": frame.dates[-1] if frame.dates else None,
                "observationCount": observations,
                "role": "screening_train" if windows else "screening_full",
            },
        }
        robust_values = [
            metric["sharpe"],
            metric["sortino"],
            metric["calmar"],
            metric["volatility"],
            metric["cvar"],
            metric["informationRatio"],
            present(wf_average_sharpe[index]),
            present(wf_worst_sharpe[index]),
            present(wf_average_cvar[index]),
        ]
        if any(value is not None and math.isfinite(value) for value in robust_values):
            score = (
                0.16 * (0 if metric["sharpe"] is None else math.tanh(metric["sharpe"] / 2))
                + 0.14 * (0 if metric["sortino"] is None else math.tanh(metric["sortino"] / 2))
                + 0.12 * (0 if metric["calmar"] is None else math.tanh(metric["calmar"]))
                + 0.12 * (0 if metric["volatility"] is None else 1 / (1 + metric["volatility"]))
                + 0.12 * (0 if metric["cvar"] is None else 1 / (1 + abs(metric["cvar"])))
                + 0.08
                * (0 if metric["informationRatio"] is None else math.tanh(metric["informationRatio"] / 2))
                + 0.1 * (0 if not math.isfinite(wf_average_sharpe[index]) else math.tanh(wf_average_sharpe[index] / 2))
                + 0.1 * (0 if not math.isfinite(wf_worst_sharpe[index]) else math.tanh(wf_worst_sharpe[index] / 2))
                + 0.06 * (0 if not math.isfinite(wf_average_cvar[index]) else 1 / (1 + abs(wf_average_cvar[index])))
            )
            metric["robustScore"] = score if math.isfinite(score) else None
        output.append(
            {
                "weights": candidate_weights,
                "sampleCount": observations,
                "metrics": metric,
                "walkForwardTestCoverage": float(wf_coverage[index]),
                "walkForwardSignal": {
                    "averageSharpe": present(wf_average_sharpe[index]),
                    "worstSharpe": present(wf_worst_sharpe[index]),
                    "averageCvar": present(wf_average_cvar[index]),
                },
            }
        )
    return output


def _better(left: dict[str, Any], right: dict[str, Any], objective: str) -> bool:
    key = {
        "max_cagr": "cagr",
        "max_total_return": "totalReturn",
        "max_sharpe": "sharpe",
        "max_sortino": "sortino",
        "max_calmar": "calmar",
        "min_volatility": "volatility",
        "min_cvar": "cvar",
        "max_information_ratio": "informationRatio",
        "robust_score": "robustScore",
    }[objective]
    left_value = left[key]
    right_value = right[key]
    if left_value is None or right_value is None:
        return False
    if objective == "min_volatility":
        return left_value < right_value
    if objective == "min_cvar":
        return abs(left_value) < abs(right_value)
    return left_value > right_value


def build_pareto_frontier(
    candidates: list[dict[str, Any]],
    batch_size: int = 512,
    checkpoint: Callable[[], None] | None = None,
) -> list[dict[str, Any]]:
    if not candidates:
        return []
    values = np.array(
        [
            [
                item["metrics"]["return"],
                item["metrics"]["volatility"],
                abs(item["metrics"]["maxDrawdown"]) if item["metrics"]["maxDrawdown"] is not None else np.nan,
                abs(item["metrics"]["cvar"]) if item["metrics"]["cvar"] is not None else np.nan,
                item["metrics"]["turnover"],
                item["metrics"]["transactionCost"],
            ]
            for item in candidates
        ],
        dtype=np.float64,
    )
    directions = np.array([1, -1, -1, -1, -1, -1], dtype=np.float64)
    scores = values * directions
    dominated = np.zeros(len(candidates), dtype=bool)
    for start in range(0, len(candidates), max(16, batch_size)):
        if checkpoint:
            checkpoint()
        stop = min(len(candidates), start + max(16, batch_size))
        targets = scores[start:stop]
        left = scores[:, None, :]
        right = targets[None, :, :]
        comparable = np.isfinite(left) & np.isfinite(right)
        comparable_count = np.sum(comparable, axis=2)
        all_better = np.all(~comparable | (left >= right), axis=2)
        strictly_better = np.any(comparable & (left > right), axis=2)
        block_dominated = np.any((comparable_count > 0) & all_better & strictly_better, axis=0)
        dominated[start:stop] = block_dominated
    return [candidate for index, candidate in enumerate(candidates) if not dominated[index]]


def optimize_portfolio(
    input_value: dict[str, Any],
    *,
    batch_size: int = 512,
    checkpoint: Callable[[], None] | None = None,
    progress: Callable[[float, int, int], None] | None = None,
) -> dict[str, Any]:
    warnings: list[str] = []
    seed = _positive_int(input_value.get("seed"), DEFAULT_SEED, 0, 2**53 - 1)
    rng = DeterministicRng(seed)
    minimum_samples = _positive_int(input_value.get("minimumSamples"), 2, 2, 3650)
    annualization_raw = input_value.get("annualization")
    annualization = (
        float(annualization_raw)
        if isinstance(annualization_raw, (int, float)) and math.isfinite(annualization_raw) and annualization_raw > 0
        else 252.0
    )
    confidence = _decimal(input_value.get("confidence"), 0.95, 0.8, 0.999)
    risk_free = _decimal(input_value.get("riskFreeRatePercent"), 0, -100, 100)
    price_series = input_value.get("priceSeries")
    if not isinstance(price_series, list) or len(price_series) < 2:
        warnings.append("최소 2개 이상의 자산이 필요합니다.")
        price_series = price_series if isinstance(price_series, list) else []
    future_warning = None
    if not input_value.get("walkForwardConfig"):
        future_warning = "walk-forward 설정이 없어 전 구간 최적화입니다. 미래 누수(look-ahead) 위험이 존재합니다."
    frame = _aligned_frame(price_series)
    windows = (
        build_walk_forward_windows(len(frame.dates), input_value.get("walkForwardConfig"))
        if input_value.get("walkForwardConfig")
        else []
    )
    if not frame.dates:
        warnings.append("공통 기간 교집합 데이터가 없습니다.")
    constraints, constraint_warnings = _normalize_constraints(input_value.get("constraints") or {}, len(frame.ids))
    warnings.extend(constraint_warnings)
    available = [item for item in frame.ids if item not in constraints.excluded_assets]
    required = list(
        dict.fromkeys(
            constraints.required_assets
            + [item for item, minimum in constraints.min_weights.items() if minimum > 0]
        )
    )
    required_in_scope = [item for item in required if item in available]
    if len(required_in_scope) != len(required):
        raise ValueError("필수 자산이 후보군에 없거나 제외 자산과 충돌합니다.")
    if constraints.max_assets > len(available):
        warnings.append("maxAssets가 사용 가능한 자산 수보다 커서 조정했습니다.")
    candidate_budget = _positive_int(input_value.get("candidateBudget"), 500, 1, 10_000)
    max_attempts = candidate_budget * 40
    transaction_cost_bps = max(0, min(500, float(input_value.get("transactionCostBps") or 0)))
    benchmark = input_value.get("benchmark") if isinstance(input_value.get("benchmark"), dict) else None
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    best: dict[str, dict[str, Any] | None] = dict.fromkeys(OBJECTIVES)
    attempts = 0
    safe_batch = max(16, min(8_192, int(batch_size)))
    while attempts < max_attempts and len(candidates) < candidate_budget:
        if checkpoint:
            checkpoint()
        generated: list[dict[str, float]] = []
        while attempts < max_attempts and len(generated) < safe_batch:
            attempts += 1
            weights = _candidate_weights(rng, available, required_in_scope, constraints)
            if not weights:
                continue
            signature = _signature(weights)
            if signature in seen:
                continue
            seen.add(signature)
            generated.append(weights)
        if not generated:
            break
        evaluated = _metrics_batch(
            frame,
            generated,
            benchmark,
            annualization=annualization,
            confidence=confidence,
            minimum_samples=minimum_samples,
            risk_free_percent=risk_free,
            windows=windows,
            constraints=constraints,
            transaction_cost_bps=transaction_cost_bps,
        )
        for candidate in evaluated:
            per_asset_valid = all(
                weight >= constraints.min_weights.get(asset_id, constraints.min_weight)
                and weight <= constraints.max_weights.get(asset_id, constraints.max_weight)
                for asset_id, weight in candidate["weights"].items()
            ) and all(candidate["weights"].get(asset_id, 0) >= minimum for asset_id, minimum in constraints.min_weights.items())
            metric = candidate["metrics"]
            if (
                not per_asset_valid
                or (metric["maxDrawdown"] is not None and abs(metric["maxDrawdown"]) > constraints.max_drawdown)
                or (metric["return"] is not None and metric["return"] < constraints.target_return)
                or metric["turnover"] > constraints.max_turnover
            ):
                continue
            candidates.append(candidate)
            for objective in OBJECTIVES:
                current = best[objective]
                if current is None or _better(metric, current["metrics"], objective):
                    best[objective] = candidate
            if not windows and candidate["sampleCount"] < minimum_samples:
                warnings.append(f"샘플수가 부족한 조합이 생성되었습니다. ({candidate['sampleCount']}개) 경고 반영.")
            if len(candidates) >= candidate_budget:
                break
        if progress:
            progress(min(1, len(candidates) / candidate_budget), len(candidates), candidate_budget)
    if not candidates:
        warnings.append("조건을 만족하는 후보가 없습니다. 제약값/샘플수/예산을 완화하세요.")
    pareto = build_pareto_frontier(candidates, safe_batch, checkpoint)
    sorted_candidates = sorted(
        candidates,
        key=lambda item: (
            item["metrics"]["robustScore"] is None,
            -(item["metrics"]["robustScore"] or 0),
        ),
    )
    if not windows:
        required_train = _walk_forward_config(input_value.get("walkForwardConfig"))["minimumTrainObservations"]
        if 0 < len(frame.dates) < required_train:
            warnings.append("walk-forward가 없고 표본 수가 작아 신뢰도가 낮습니다.")
    result: dict[str, Any] = {
        "warnings": warnings,
        "seed": seed,
        "sampledAssets": available,
        "candidateCount": len(sorted_candidates),
        "candidates": sorted_candidates,
        "paretoFrontier": pareto,
        "bestByObjective": best,
    }
    if future_warning is not None:
        result["futureLeakageWarning"] = future_warning
    return result
