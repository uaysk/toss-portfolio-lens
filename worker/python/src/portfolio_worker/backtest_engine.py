from __future__ import annotations

import math
from datetime import date
from typing import Any

from .backtest_analytics import calculate_backtest_advanced_analytics


class BacktestValidationError(ValueError):
    pass


def js_round(value: float, digits: int = 4) -> float:
    scale = 10**digits
    rounded = math.floor(value * scale + 0.5) / scale
    return 0.0 if rounded == 0 else rounded


def date_days(start: str, end: str) -> int:
    return max(0, (date.fromisoformat(end) - date.fromisoformat(start)).days)


def _year_month(value: str) -> str:
    return value[:7]


def _cash_flow_due(
    previous_date: str,
    current_date: str,
    next_date: str | None,
    frequency: str,
    timing: str,
) -> bool:
    month = int(current_date[5:7])
    interval = 1 if frequency == "monthly" else 3 if frequency == "quarterly" else 12
    if timing == "period_start":
        if _year_month(previous_date) == _year_month(current_date):
            return False
        return (month - 1) % interval == 0
    at_observed_period_end = next_date is None or _year_month(current_date) != _year_month(next_date)
    return at_observed_period_end and month % interval == 0


def _should_rebalance(previous_date: str, current_date: str, frequency: str) -> bool:
    if frequency in {"none", "threshold"}:
        return False
    previous_year = int(previous_date[:4])
    current_year = int(current_date[:4])
    if frequency == "annually":
        return previous_year != current_year
    previous_month = int(previous_date[5:7])
    current_month = int(current_date[5:7])
    if frequency == "quarterly":
        return previous_year != current_year or (previous_month - 1) // 3 != (current_month - 1) // 3
    return previous_year != current_year or previous_month != current_month


def _common_observed_returns(series_by_asset: list[list[dict[str, Any]]]) -> tuple[list[list[float]], int]:
    if not series_by_asset:
        return [], 0
    maps = [{str(point["date"]): float(point["close"]) for point in series} for series in series_by_asset]
    common_dates = sorted(point["date"] for point in series_by_asset[0] if all(point["date"] in values for values in maps))
    returns: list[list[float]] = [[] for _ in series_by_asset]
    for index in range(1, len(common_dates)):
        previous_date = common_dates[index - 1]
        current_date = common_dates[index]
        for asset_index, values in enumerate(maps):
            previous = values.get(previous_date, 0)
            current = values.get(current_date, 0)
            if previous > 0 and current > 0:
                returns[asset_index].append(current / previous - 1)
    return returns, max(0, len(common_dates) - 1)


def _average(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _standard_deviation(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _average(values)
    return math.sqrt(sum((value - mean) ** 2 for value in values) / (len(values) - 1))


def _pearson(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right) or len(left) < 2:
        return None
    left_mean = _average(left)
    right_mean = _average(right)
    covariance = 0.0
    left_variance = 0.0
    right_variance = 0.0
    for index, left_value in enumerate(left):
        left_delta = left_value - left_mean
        right_delta = right[index] - right_mean
        covariance += left_delta * right_delta
        left_variance += left_delta**2
        right_variance += right_delta**2
    denominator = math.sqrt(left_variance * right_variance)
    return js_round(covariance / denominator) if denominator > 0 else None


def _summarize_growth_series(
    points: list[dict[str, Any]], daily_returns: list[float], risk_free_rate_percent: float
) -> dict[str, Any]:
    initial_value = float(points[0]["value"])
    final_value = float(points[-1]["value"])
    peak = initial_value
    peak_date = str(points[0]["date"])
    max_drawdown = 0.0
    max_drawdown_days = 0
    for point in points:
        if point["value"] >= peak:
            peak = point["value"]
            peak_date = point["date"]
        drawdown = point["value"] / peak - 1 if peak > 0 else 0
        if drawdown < max_drawdown:
            max_drawdown = drawdown
        if drawdown < 0:
            max_drawdown_days = max(max_drawdown_days, date_days(peak_date, point["date"]))

    year_end: dict[str, dict[str, Any]] = {}
    for point in points:
        year_end[point["date"][:4]] = point
    annual_returns = []
    previous_year_value = initial_value
    for year in sorted(year_end):
        point = year_end[year]
        annual_returns.append(
            {"year": int(year), "returnPercent": js_round((point["value"] / previous_year_value - 1) * 100)}
        )
        previous_year_value = point["value"]

    month_end: dict[str, dict[str, Any]] = {}
    for point in points:
        month_end[_year_month(point["date"])] = point
    previous_month_value = initial_value
    monthly_returns: list[float] = []
    for point in month_end.values():
        monthly_returns.append(point["value"] / previous_month_value - 1)
        previous_month_value = point["value"]

    elapsed_years = date_days(points[0]["date"], points[-1]["date"]) / 365.25
    total_return = final_value / initial_value - 1
    daily_volatility = _standard_deviation(daily_returns)
    daily_risk_free = (1 + risk_free_rate_percent / 100) ** (1 / 252) - 1
    excess_returns = [value - daily_risk_free for value in daily_returns]
    mean_daily_excess_return = _average(excess_returns)
    downside_deviation = (
        math.sqrt(sum(min(value, 0) ** 2 for value in excess_returns) / len(excess_returns)) if excess_returns else 0
    )
    cagr_percent = (
        js_round(((final_value / initial_value) ** (1 / elapsed_years) - 1) * 100)
        if elapsed_years > 0 and final_value > 0
        else None
    )
    max_drawdown_percent = js_round(max_drawdown * 100)
    metrics = {
        "totalReturnPercent": js_round(total_return * 100),
        "cagrPercent": cagr_percent,
        "annualizedVolatilityPercent": (
            js_round(daily_volatility * math.sqrt(252) * 100) if len(daily_returns) > 1 else None
        ),
        "maxDrawdownPercent": max_drawdown_percent,
        "maxDrawdownDays": max_drawdown_days,
        "sharpeRatio": (
            js_round((mean_daily_excess_return / daily_volatility) * math.sqrt(252))
            if daily_volatility > 0
            else None
        ),
        "sortinoRatio": (
            js_round((mean_daily_excess_return / downside_deviation) * math.sqrt(252))
            if downside_deviation > 0
            else None
        ),
        "calmarRatio": (
            js_round(cagr_percent / abs(max_drawdown_percent))
            if cagr_percent is not None and max_drawdown_percent < 0
            else None
        ),
        "bestDailyReturnPercent": js_round(max(daily_returns) * 100) if daily_returns else None,
        "worstDailyReturnPercent": js_round(min(daily_returns) * 100) if daily_returns else None,
        "positiveDaysPercent": (
            js_round(sum(value > 0 for value in daily_returns) / len(daily_returns) * 100) if daily_returns else None
        ),
        "bestYearPercent": max(item["returnPercent"] for item in annual_returns) if annual_returns else None,
        "worstYearPercent": min(item["returnPercent"] for item in annual_returns) if annual_returns else None,
        "positiveMonthsPercent": (
            js_round(sum(value > 0 for value in monthly_returns) / len(monthly_returns) * 100)
            if monthly_returns
            else None
        ),
    }
    return {"metrics": metrics, "annualReturns": annual_returns}


def _filtered_series(points: list[dict[str, Any]], start: str, end: str) -> list[dict[str, Any]]:
    return sorted(
        (
            dict(point)
            for point in points
            if start <= str(point.get("date", "")) <= end and float(point.get("close", 0)) > 0
        ),
        key=lambda point: point["date"],
    )


def simulate_backtest(input_value: dict[str, Any]) -> dict[str, Any]:
    assets = list(input_value.get("assets") or [])
    if not 1 <= len(assets) <= 20:
        raise BacktestValidationError("백테스트 종목은 1~20개까지 구성할 수 있습니다.")
    initial_amount = float(input_value.get("initialAmount", 0))
    if not math.isfinite(initial_amount) or initial_amount <= 0:
        raise BacktestValidationError("초기 투자금은 0보다 커야 합니다.")
    risk_free_rate_percent = float(input_value.get("riskFreeRatePercent") or 0)
    transaction_cost_bps = float(input_value.get("transactionCostBps") or 0)
    rebalance_threshold_percent = float(input_value.get("rebalanceThresholdPercent") or 5)
    cash_flow_frequency = str(input_value.get("cashFlowFrequency") or "monthly")
    cash_flow_timing = str(input_value.get("cashFlowTiming") or "period_start")
    rebalance_frequency = str(input_value.get("rebalanceFrequency"))
    if not math.isfinite(risk_free_rate_percent) or not -10 <= risk_free_rate_percent <= 50:
        raise BacktestValidationError("무위험수익률은 -10% 이상 50% 이하로 입력해 주세요.")
    if not math.isfinite(transaction_cost_bps) or not 0 <= transaction_cost_bps <= 500:
        raise BacktestValidationError("거래비용은 0bp 이상 500bp 이하로 입력해 주세요.")
    if rebalance_frequency == "threshold" and (
        not math.isfinite(rebalance_threshold_percent) or not 0.1 <= rebalance_threshold_percent <= 50
    ):
        raise BacktestValidationError("threshold 리밸런싱 기준은 0.1% 이상 50% 이하로 입력해 주세요.")
    weight_total = sum(float(asset["weight"]) for asset in assets)
    if any(not math.isfinite(float(asset["weight"])) or float(asset["weight"]) <= 0 for asset in assets) or abs(
        weight_total - 100
    ) > 0.01:
        raise BacktestValidationError("종목 비중 합계는 100%여야 합니다.")

    requested_start = str(input_value["requestedStartDate"])
    requested_end = str(input_value["endDate"])
    prices = input_value.get("prices") or {}
    series_by_asset: list[list[dict[str, Any]]] = []
    for asset in assets:
        key = f"{asset['currency']}:{asset['symbol']}"
        series = _filtered_series(list(prices.get(key) or []), requested_start, requested_end)
        if not series:
            raise BacktestValidationError(f"{asset['name']}의 선택 기간 일봉이 없습니다.")
        series_by_asset.append(series)
    benchmark_definition = input_value.get("benchmark")
    benchmark_series = (
        _filtered_series(list(benchmark_definition.get("prices") or []), requested_start, requested_end)
        if benchmark_definition
        else []
    )
    if benchmark_definition and not benchmark_series:
        raise BacktestValidationError(f"{benchmark_definition['name']}의 선택 기간 일봉이 없습니다.")

    all_dates = sorted(
        {point["date"] for series in series_by_asset for point in series}
        | {point["date"] for point in benchmark_series}
    )
    asset_cursors = [0] * len(assets)
    asset_points: list[dict[str, Any] | None] = [None] * len(assets)
    asset_last_observed_dates = [""] * len(assets)
    asset_carry_forward_counts = [0] * len(assets)
    benchmark_cursor = 0
    benchmark_point: dict[str, Any] | None = None
    benchmark_last_observed_date = ""
    benchmark_carry_forward_count = 0
    aligned: list[dict[str, Any]] = []
    for current_date in all_dates:
        for asset_index, series in enumerate(series_by_asset):
            while asset_cursors[asset_index] < len(series) and series[asset_cursors[asset_index]]["date"] <= current_date:
                asset_points[asset_index] = series[asset_cursors[asset_index]]
                asset_last_observed_dates[asset_index] = series[asset_cursors[asset_index]]["date"]
                asset_cursors[asset_index] += 1
        while benchmark_cursor < len(benchmark_series) and benchmark_series[benchmark_cursor]["date"] <= current_date:
            benchmark_point = benchmark_series[benchmark_cursor]
            benchmark_last_observed_date = benchmark_series[benchmark_cursor]["date"]
            benchmark_cursor += 1
        if all(point is not None and float(point.get("close", 0)) > 0 for point in asset_points) and (
            not benchmark_definition or (benchmark_point is not None and float(benchmark_point.get("close", 0)) > 0)
        ):
            for asset_index, observed_date in enumerate(asset_last_observed_dates):
                if observed_date != current_date:
                    asset_carry_forward_counts[asset_index] += 1
            if benchmark_definition and benchmark_last_observed_date != current_date:
                benchmark_carry_forward_count += 1
            concrete_points = [point for point in asset_points if point is not None]
            aligned.append(
                {
                    "date": current_date,
                    "closes": [float(point["close"]) for point in concrete_points],
                    "localCloses": [float(point.get("localClose", point["close"])) for point in concrete_points],
                    "fxRates": [float(point.get("fxRate", 1)) for point in concrete_points],
                    **({"benchmarkClose": float(benchmark_point["close"])} if benchmark_definition and benchmark_point else {}),
                }
            )
    if len(aligned) < 2:
        raise BacktestValidationError("모든 종목에 공통으로 존재하는 일봉이 2개 이상 필요합니다.")

    weights = [float(asset["weight"]) / 100 for asset in assets]
    position_values = [initial_amount * weight for weight in weights]
    market_profit_by_asset = [0.0] * len(assets)
    linked_contribution_by_asset = [0.0] * len(assets)
    linked_local_contribution_by_asset = [0.0] * len(assets)
    linked_fx_contribution_by_asset = [0.0] * len(assets)
    linked_up_regime_contribution_by_asset = [0.0] * len(assets)
    linked_down_regime_contribution_by_asset = [0.0] * len(assets)
    weight_sums = [0.0] * len(assets)
    weight_observation_count = 0
    total_contributions = initial_amount
    total_withdrawals = 0.0
    growth = initial_amount
    peak = growth
    portfolio_returns: list[float] = []
    benchmark_returns: list[float] = []
    asset_returns: list[list[float]] = [[] for _ in assets]
    trades = [
        {
            "date": aligned[0]["date"],
            "assetIndex": index,
            "side": "BUY",
            "amount": position_values[index],
            "quantity": position_values[index] / aligned[0]["closes"][index],
            "price": aligned[0]["closes"][index],
            "reason": "initial",
        }
        for index in range(len(assets))
    ]
    portfolio_growth_series = [{"date": aligned[0]["date"], "value": growth}]
    benchmark_growth_series = (
        [{"date": aligned[0]["date"], "value": initial_amount}] if benchmark_definition else []
    )
    initial_point: dict[str, Any] = {
        "date": aligned[0]["date"],
        "balance": js_round(initial_amount, 2),
        "growth": js_round(growth, 2),
    }
    if benchmark_definition:
        initial_point["benchmarkGrowth"] = js_round(initial_amount, 2)
    initial_point["drawdownPercent"] = 0
    full_points = [initial_point]
    benchmark_base = float(aligned[0].get("benchmarkClose", 0))

    monthly_cash_flow = float(input_value.get("monthlyCashFlow", 0))
    for date_index in range(1, len(aligned)):
        previous = aligned[date_index - 1]
        current = aligned[date_index]
        before_market = sum(position_values)
        for asset_index in range(len(assets)):
            weight_sums[asset_index] += position_values[asset_index] / before_market if before_market > 0 else 0
        weight_observation_count += 1
        daily_contributions = [0.0] * len(assets)
        daily_local_contributions = [0.0] * len(assets)
        daily_fx_contributions = [0.0] * len(assets)
        for asset_index in range(len(assets)):
            asset_return = current["closes"][asset_index] / previous["closes"][asset_index] - 1
            local_return = current["localCloses"][asset_index] / previous["localCloses"][asset_index] - 1
            fx_return = current["fxRates"][asset_index] / previous["fxRates"][asset_index] - 1
            position_weight = position_values[asset_index] / before_market if before_market > 0 else 0
            asset_returns[asset_index].append(asset_return)
            daily_contributions[asset_index] = position_weight * asset_return
            daily_local_contributions[asset_index] = position_weight * local_return
            daily_fx_contributions[asset_index] = position_weight * (1 + local_return) * fx_return
            market_profit_by_asset[asset_index] += position_values[asset_index] * asset_return
            position_values[asset_index] *= 1 + asset_return
        after_market = sum(position_values)
        portfolio_return = after_market / before_market - 1 if before_market > 0 else 0
        portfolio_returns.append(portfolio_return)
        growth *= 1 + portfolio_return
        for asset_index in range(len(assets)):
            linked_contribution_by_asset[asset_index] = (
                linked_contribution_by_asset[asset_index] * (1 + portfolio_return)
                + daily_contributions[asset_index] * 100
            )
            linked_local_contribution_by_asset[asset_index] = (
                linked_local_contribution_by_asset[asset_index] * (1 + portfolio_return)
                + daily_local_contributions[asset_index] * 100
            )
            linked_fx_contribution_by_asset[asset_index] = (
                linked_fx_contribution_by_asset[asset_index] * (1 + portfolio_return)
                + daily_fx_contributions[asset_index] * 100
            )
            linked_up_regime_contribution_by_asset[asset_index] = (
                linked_up_regime_contribution_by_asset[asset_index] * (1 + portfolio_return)
                + (daily_contributions[asset_index] * 100 if portfolio_return >= 0 else 0)
            )
            linked_down_regime_contribution_by_asset[asset_index] = (
                linked_down_regime_contribution_by_asset[asset_index] * (1 + portfolio_return)
                + (daily_contributions[asset_index] * 100 if portfolio_return < 0 else 0)
            )
        if benchmark_definition:
            benchmark_returns.append(
                float(current.get("benchmarkClose", benchmark_base))
                / float(previous.get("benchmarkClose", benchmark_base))
                - 1
            )

        if monthly_cash_flow != 0 and _cash_flow_due(
            previous["date"],
            current["date"],
            aligned[date_index + 1]["date"] if date_index + 1 < len(aligned) else None,
            cash_flow_frequency,
            cash_flow_timing,
        ):
            flow = monthly_cash_flow
            if after_market + flow <= 0:
                raise BacktestValidationError("정기 인출금이 포트폴리오 잔액보다 큽니다.")
            if flow > 0:
                for asset_index in range(len(position_values)):
                    allocation = flow * weights[asset_index]
                    trades.append(
                        {
                            "date": current["date"],
                            "assetIndex": asset_index,
                            "side": "BUY",
                            "amount": allocation,
                            "quantity": allocation / current["closes"][asset_index],
                            "price": current["closes"][asset_index],
                            "reason": "cash-flow",
                        }
                    )
                    position_values[asset_index] += allocation
                total_contributions += flow
            else:
                withdrawal = abs(flow)
                for asset_index in range(len(position_values)):
                    allocation = withdrawal * (position_values[asset_index] / after_market)
                    trades.append(
                        {
                            "date": current["date"],
                            "assetIndex": asset_index,
                            "side": "SELL",
                            "amount": allocation,
                            "quantity": allocation / current["closes"][asset_index],
                            "price": current["closes"][asset_index],
                            "reason": "cash-flow",
                        }
                    )
                    position_values[asset_index] -= allocation
                total_withdrawals += withdrawal

        current_total = sum(position_values)
        threshold_triggered = (
            rebalance_frequency == "threshold"
            and current_total > 0
            and any(
                abs(value / current_total - weights[index]) >= rebalance_threshold_percent / 100
                for index, value in enumerate(position_values)
            )
        )
        if _should_rebalance(previous["date"], current["date"], rebalance_frequency) or threshold_triggered:
            total = sum(position_values)
            targets = [total * weight for weight in weights]
            for asset_index in range(len(position_values)):
                difference = targets[asset_index] - position_values[asset_index]
                if abs(difference) <= 0.000001:
                    continue
                trades.append(
                    {
                        "date": current["date"],
                        "assetIndex": asset_index,
                        "side": "BUY" if difference > 0 else "SELL",
                        "amount": abs(difference),
                        "quantity": abs(difference) / current["closes"][asset_index],
                        "price": current["closes"][asset_index],
                        "reason": "rebalance",
                    }
                )
            position_values = targets

        if growth >= peak:
            peak = growth
        drawdown = growth / peak - 1 if peak > 0 else 0
        balance = sum(position_values)
        benchmark_growth = (
            initial_amount * (float(current.get("benchmarkClose", benchmark_base)) / benchmark_base)
            if benchmark_definition and benchmark_base > 0
            else None
        )
        portfolio_growth_series.append({"date": current["date"], "value": growth})
        if benchmark_growth is not None:
            benchmark_growth_series.append({"date": current["date"], "value": benchmark_growth})
        point = {
            "date": current["date"],
            "balance": js_round(balance, 2),
            "growth": js_round(growth, 2),
        }
        if benchmark_growth is not None:
            point["benchmarkGrowth"] = js_round(benchmark_growth, 2)
        point["drawdownPercent"] = js_round(drawdown * 100)
        full_points.append(point)

    portfolio_summary = _summarize_growth_series(portfolio_growth_series, portfolio_returns, risk_free_rate_percent)
    benchmark_summary = (
        _summarize_growth_series(benchmark_growth_series, benchmark_returns, risk_free_rate_percent)
        if benchmark_definition
        else None
    )
    contributions = []
    for index, asset in enumerate(assets):
        profit_loss = market_profit_by_asset[index]
        first_price = aligned[0]["closes"][index]
        last_price = aligned[-1]["closes"][index]
        contributions.append(
            {
                "symbol": asset["symbol"],
                "name": asset["name"],
                "market": asset["market"],
                "currency": asset["currency"],
                "weight": js_round(float(asset["weight"])),
                "endingValue": js_round(position_values[index], 2),
                "profitLoss": js_round(profit_loss, 2),
                "contributionPercent": js_round(profit_loss / initial_amount * 100),
                "timeLinkedContributionPercent": js_round(linked_contribution_by_asset[index]),
                "localPriceContributionPercent": js_round(linked_local_contribution_by_asset[index]),
                "fxContributionPercent": js_round(linked_fx_contribution_by_asset[index]),
                "upRegimeContributionPercent": js_round(linked_up_regime_contribution_by_asset[index]),
                "downRegimeContributionPercent": js_round(linked_down_regime_contribution_by_asset[index]),
                "assetReturnPercent": js_round((last_price / first_price - 1) * 100),
            }
        )
    contributions.sort(key=lambda item: -item["contributionPercent"])

    common_returns, common_observations = _common_observed_returns(series_by_asset)
    correlations = [
        [1 if left == right else _pearson(common_returns[left], common_returns[right]) for right in range(len(assets))]
        for left in range(len(assets))
    ]
    final_balance = sum(position_values)
    ending_weights = [value / final_balance if final_balance > 0 else 0 for value in position_values]
    average_weights = [value / weight_observation_count if weight_observation_count > 0 else 0 for value in weight_sums]
    effective_start_date = aligned[0]["date"]
    effective_end_date = aligned[-1]["date"]
    advanced = calculate_backtest_advanced_analytics(
        assets=assets,
        base_date=effective_start_date,
        effective_end_date=effective_end_date,
        requested_start_date=requested_start,
        returns=[{"date": aligned[index + 1]["date"], "value": value} for index, value in enumerate(portfolio_returns)],
        asset_returns=asset_returns,
        benchmark=(
            {
                "key": benchmark_definition["key"],
                "name": benchmark_definition["name"],
                "returns": benchmark_returns,
                "observations": sum(
                    effective_start_date <= point["date"] <= effective_end_date for point in benchmark_series
                ),
            }
            if benchmark_definition
            else None
        ),
        average_weights=average_weights,
        ending_weights=ending_weights,
        trades=trades,
        balances=[{"date": point["date"], "value": point["balance"]} for point in full_points],
        transaction_cost_bps=transaction_cost_bps,
        risk_free_rate_percent=risk_free_rate_percent,
        gross_return_percent=portfolio_summary["metrics"]["totalReturnPercent"],
        price_coverage=[
            {
                "observations": len(
                    [point for point in series if effective_start_date <= point["date"] <= effective_end_date]
                ),
                "alignedDays": len(aligned),
                "firstDate": next(
                    (point["date"] for point in series if effective_start_date <= point["date"] <= effective_end_date),
                    effective_start_date,
                ),
                "lastDate": next(
                    (
                        point["date"]
                        for point in reversed(series)
                        if effective_start_date <= point["date"] <= effective_end_date
                    ),
                    effective_end_date,
                ),
            }
            for series in series_by_asset
        ],
    )

    result: dict[str, Any] = {
        "requestedStartDate": requested_start,
        "effectiveStartDate": effective_start_date,
        "endDate": effective_end_date,
        "points": full_points,
        "metrics": {
            "finalBalance": js_round(final_balance, 2),
            "totalContributions": js_round(total_contributions, 2),
            "totalWithdrawals": js_round(total_withdrawals, 2),
            **portfolio_summary["metrics"],
        },
    }
    if benchmark_summary:
        result["benchmarkMetrics"] = benchmark_summary["metrics"]
    result.update(
        {
            "annualReturns": portfolio_summary["annualReturns"],
            "contributions": contributions,
            "correlations": {
                "assets": [{"symbol": asset["symbol"], "name": asset["name"]} for asset in assets],
                "values": correlations,
            },
            "trades": [
                {
                    "date": trade["date"],
                    "symbol": assets[trade["assetIndex"]]["symbol"],
                    "side": trade["side"],
                    "amount": js_round(trade["amount"], 2),
                    "quantity": js_round(trade["quantity"], 8),
                    "price": js_round(trade["price"], 6),
                    "reason": trade["reason"],
                }
                for trade in trades
            ],
            "dataQuality": {
                "alignmentPolicy": "carry_forward_for_valuation",
                "commonReturnPolicy": "inner_join",
                "alignedValuationDays": len(aligned),
                "commonReturnObservations": common_observations,
                "carryForwardByAsset": [
                    {"symbol": asset["symbol"], "count": asset_carry_forward_counts[index]}
                    for index, asset in enumerate(assets)
                ],
                "benchmarkCarryForwardCount": benchmark_carry_forward_count,
            },
            "advanced": advanced,
        }
    )
    return result
