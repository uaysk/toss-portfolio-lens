from __future__ import annotations

import math
from datetime import date
from typing import Any, Callable


TRADING_DAYS_PER_YEAR = 252


def _js_round(value: float, digits: int = 4) -> float:
    """Match Math.round(value * scale) / scale as it is serialized by JSON."""
    scale = 10**digits
    rounded = math.floor(value * scale + 0.5) / scale
    return 0.0 if rounded == 0 else rounded


def _sum(values: list[float]) -> float:
    """Keep JavaScript's left-to-right Number addition order."""
    result = 0.0
    for value in values:
        result += value
    return result


def _average(values: list[float]) -> float:
    return _sum(values) / len(values) if values else 0.0


def _standard_deviation(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _average(values)
    squared_differences: list[float] = []
    for value in values:
        squared_differences.append((value - mean) ** 2)
    return math.sqrt(_sum(squared_differences) / (len(values) - 1))


def _covariance(left: list[float], right: list[float]) -> float:
    length = min(len(left), len(right))
    if length < 2:
        return 0.0
    left_values = left[:length]
    right_values = right[:length]
    left_mean = _average(left_values)
    right_mean = _average(right_values)
    value = 0.0
    for index, left_value in enumerate(left_values):
        value += (left_value - left_mean) * (right_values[index] - right_mean)
    return value / (length - 1)


def _correlation(left: list[float], right: list[float]) -> float | None:
    denominator = _standard_deviation(left) * _standard_deviation(right)
    return _js_round(_covariance(left, right) / denominator, 6) if denominator > 0 else None


def _compounded_return(values: list[float]) -> float | None:
    if not values:
        return None
    result = 1.0
    for value in values:
        result *= 1 + value
    return result - 1


def _rolling_return(values: list[float], end_index: int, window: int) -> float | None:
    if end_index + 1 < window:
        return None
    return _compounded_return(values[end_index + 1 - window : end_index + 1])


def _days_between(start: str, end: str) -> int:
    return max(0, (date.fromisoformat(end) - date.fromisoformat(start)).days)


def _percentile(values: list[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * probability) - 1)]


def _longest_streak(values: list[float], predicate: Callable[[float], bool]) -> int:
    current = 0
    maximum = 0
    for value in values:
        current = current + 1 if predicate(value) else 0
        maximum = max(maximum, current)
    return maximum


def _monthly_returns(returns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_month: dict[str, list[float]] = {}
    for item in returns:
        month = str(item["date"])[:7]
        values = by_month.get(month, [])
        values.append(float(item["value"]))
        by_month[month] = values
    result = []
    for month, values in by_month.items():
        compounded = _compounded_return(values)
        result.append(
            {
                "month": month,
                "returnPercent": _js_round((compounded if compounded is not None else 0.0) * 100),
            }
        )
    result.sort(key=lambda item: item["month"])
    return result


def _relative_max_drawdown(portfolio: list[float], benchmark: list[float]) -> float | None:
    if not portfolio or len(portfolio) != len(benchmark):
        return None
    value = 1.0
    peak = 1.0
    maximum = 0.0
    for index, portfolio_return in enumerate(portfolio):
        if benchmark[index] <= -1:
            continue
        value *= (1 + portfolio_return) / (1 + benchmark[index])
        peak = max(peak, value)
        maximum = min(maximum, value / peak - 1)
    return _js_round(maximum * 100)


def _benchmark_comparison(
    *,
    key: str,
    name: str,
    portfolio: list[float],
    benchmark: list[float],
    dates: list[str],
    risk_free_rate_percent: float,
) -> dict[str, Any]:
    active = [value - benchmark[index] for index, value in enumerate(portfolio)]
    tracking_error = _standard_deviation(active)
    benchmark_variance = _standard_deviation(benchmark) ** 2
    beta = _covariance(portfolio, benchmark) / benchmark_variance if benchmark_variance > 0 else None
    daily_risk_free = (1 + risk_free_rate_percent / 100) ** (1 / TRADING_DAYS_PER_YEAR) - 1
    alpha = (
        (_average(portfolio) - daily_risk_free - beta * (_average(benchmark) - daily_risk_free))
        * TRADING_DAYS_PER_YEAR
        if beta is not None
        else None
    )
    upside: list[tuple[float, float]] = []
    downside: list[tuple[float, float]] = []
    for index, benchmark_return in enumerate(benchmark):
        item = (portfolio[index], benchmark_return)
        if benchmark_return > 0:
            upside.append(item)
        elif benchmark_return < 0:
            downside.append(item)

    def capture(values: list[tuple[float, float]]) -> float | None:
        benchmark_mean = _average([item[1] for item in values])
        return (
            _js_round(_average([item[0] for item in values]) / benchmark_mean * 100)
            if values and benchmark_mean != 0
            else None
        )

    months: dict[str, list[int]] = {}
    for index, item_date in enumerate(dates):
        month = item_date[:7]
        indices = months.get(month, [])
        indices.append(index)
        months[month] = indices
    monthly_wins = 0
    for indices in months.values():
        portfolio_month_value = _compounded_return([portfolio[index] for index in indices])
        benchmark_month_value = _compounded_return([benchmark[index] for index in indices])
        portfolio_month = portfolio_month_value if portfolio_month_value is not None else 0.0
        benchmark_month = benchmark_month_value if benchmark_month_value is not None else 0.0
        if portfolio_month > benchmark_month:
            monthly_wins += 1
    portfolio_return = _compounded_return(portfolio)
    benchmark_return = _compounded_return(benchmark)
    return {
        "key": key,
        "name": name,
        "observations": len(portfolio),
        "returnPercent": None if benchmark_return is None else _js_round(benchmark_return * 100),
        "excessReturnPercent": (
            None
            if portfolio_return is None or benchmark_return is None
            else _js_round((portfolio_return - benchmark_return) * 100)
        ),
        "trackingErrorPercent": (
            _js_round(tracking_error * math.sqrt(TRADING_DAYS_PER_YEAR) * 100)
            if len(portfolio) > 1
            else None
        ),
        "informationRatio": (
            _js_round(_average(active) / tracking_error * math.sqrt(TRADING_DAYS_PER_YEAR))
            if tracking_error > 0
            else None
        ),
        "beta": None if beta is None else _js_round(beta),
        "alphaPercent": None if alpha is None else _js_round(alpha * 100),
        "correlation": _correlation(portfolio, benchmark),
        "upsideCapturePercent": capture(upside),
        "downsideCapturePercent": capture(downside),
        "dailyWinRatePercent": (
            _js_round(
                len([value for index, value in enumerate(portfolio) if value > benchmark[index]])
                / len(portfolio)
                * 100
            )
            if portfolio
            else None
        ),
        "monthlyWinRatePercent": _js_round(monthly_wins / len(months) * 100) if months else None,
        "relativeMaxDrawdownPercent": _relative_max_drawdown(portfolio, benchmark),
    }


def _rolling_analytics(
    returns: list[dict[str, Any]],
    benchmark_returns: list[float] | None,
    risk_free_rate_percent: float,
) -> list[dict[str, Any]]:
    values = [float(item["value"]) for item in returns]
    daily_risk_free = (1 + risk_free_rate_percent / 100) ** (1 / TRADING_DAYS_PER_YEAR) - 1
    result = []
    for index, item in enumerate(returns):
        sixty = values[index - 59 : index + 1] if index + 1 >= 60 else []
        benchmark_sixty = (
            benchmark_returns[index - 59 : index + 1]
            if benchmark_returns is not None and index + 1 >= 60
            else []
        )
        volatility = _standard_deviation(sixty)
        benchmark_variance = _standard_deviation(benchmark_sixty) ** 2
        portfolio_sixty_return = _compounded_return(sixty)
        benchmark_sixty_return = _compounded_return(benchmark_sixty)

        def percent(value: float | None) -> float | None:
            return None if value is None else _js_round(value * 100)

        result.append(
            {
                "date": item["date"],
                "return20d": percent(_rolling_return(values, index, 20)),
                "return60d": percent(_rolling_return(values, index, 60)),
                "return120d": percent(_rolling_return(values, index, 120)),
                "return252d": percent(_rolling_return(values, index, 252)),
                "volatility60d": (
                    _js_round(volatility * math.sqrt(TRADING_DAYS_PER_YEAR) * 100)
                    if len(sixty) == 60
                    else None
                ),
                "sharpe60d": (
                    _js_round((_average(sixty) - daily_risk_free) / volatility * math.sqrt(TRADING_DAYS_PER_YEAR))
                    if len(sixty) == 60 and volatility > 0
                    else None
                ),
                "benchmarkExcess60d": (
                    _js_round((portfolio_sixty_return - benchmark_sixty_return) * 100)
                    if portfolio_sixty_return is not None and benchmark_sixty_return is not None
                    else None
                ),
                "benchmarkBeta60d": (
                    _js_round(_covariance(sixty, benchmark_sixty) / benchmark_variance)
                    if len(sixty) == 60 and benchmark_variance > 0
                    else None
                ),
                "benchmarkCorrelation60d": _correlation(sixty, benchmark_sixty) if len(sixty) == 60 else None,
            }
        )
    return result


def _drawdown_analytics(returns: list[dict[str, Any]], base_date: str) -> dict[str, Any]:
    value = 1.0
    peak = 1.0
    peak_date = base_date
    current: dict[str, Any] | None = None
    points = [{"date": base_date, "drawdownPercent": 0}]
    episodes: list[dict[str, Any]] = []
    for item in returns:
        item_date = str(item["date"])
        value *= 1 + float(item["value"])
        if value >= peak:
            if current is not None:
                current["recoveryDate"] = item_date
                current["durationDays"] = _days_between(str(current["startDate"]), item_date)
                current["recoveryDays"] = _days_between(str(current["troughDate"]), item_date)
                episodes.append(current)
                current = None
            peak = value
            peak_date = item_date
        else:
            drawdown = value / peak - 1
            if current is None:
                current = {
                    "startDate": peak_date,
                    "troughDate": item_date,
                    "depthPercent": _js_round(drawdown * 100),
                    "durationDays": _days_between(peak_date, item_date),
                }
            else:
                current["durationDays"] = _days_between(str(current["startDate"]), item_date)
                if drawdown < float(current["depthPercent"]) / 100:
                    current["depthPercent"] = _js_round(drawdown * 100)
                    current["troughDate"] = item_date
        points.append({"date": item_date, "drawdownPercent": _js_round((value / peak - 1) * 100)})
    if current is not None:
        episodes.append(current)
    negative = [float(point["drawdownPercent"]) for point in points if float(point["drawdownPercent"]) < 0]
    values = [float(item["value"]) for item in returns]

    def worst_window(window: int) -> float | None:
        candidates = []
        for index in range(len(values)):
            candidate = _rolling_return(values, index, window)
            if candidate is not None:
                candidates.append(candidate)
        return _js_round(min(candidates) * 100) if candidates else None

    return {
        "points": points,
        "episodes": sorted(episodes, key=lambda item: item["depthPercent"])[:5],
        "currentUnderwaterDays": (
            _days_between(str(current["startDate"]), str(returns[-1]["date"]) if returns else base_date)
            if current is not None
            else 0
        ),
        "averageDrawdownPercent": _js_round(_average(negative)) if negative else None,
        "ulcerIndex": (
            _js_round(math.sqrt(_average([drawdown**2 for drawdown in negative]))) if negative else None
        ),
        "worst20DayReturnPercent": worst_window(20),
        "worst60DayReturnPercent": worst_window(60),
    }


def _tail_risk_analytics(returns: list[float]) -> dict[str, Any]:
    gains = [value for value in returns if value > 0]
    losses = [value for value in returns if value < 0]
    value_at_risk = _percentile(returns, 0.05)
    tail = [] if value_at_risk is None else [value for value in returns if value <= value_at_risk]
    mean = _average(returns)
    deviation = _standard_deviation(returns)
    average_gain = _average(gains) if gains else None
    average_loss = _average(losses) if losses else None
    return {
        "historicalVar95Percent": None if value_at_risk is None else _js_round(value_at_risk * 100),
        "expectedShortfall95Percent": _js_round(_average(tail) * 100) if tail else None,
        "lossDaysPercent": _js_round(len(losses) / len(returns) * 100) if returns else None,
        "averageGainPercent": None if average_gain is None else _js_round(average_gain * 100),
        "averageLossPercent": None if average_loss is None else _js_round(average_loss * 100),
        "gainLossRatio": (
            _js_round(average_gain / abs(average_loss))
            if average_gain is not None and average_loss is not None and average_loss != 0
            else None
        ),
        "skewness": (
            _js_round(_average([((value - mean) / deviation) ** 3 for value in returns]))
            if len(returns) >= 3 and deviation > 0
            else None
        ),
        "excessKurtosis": (
            _js_round(_average([((value - mean) / deviation) ** 4 for value in returns]) - 3)
            if len(returns) >= 4 and deviation > 0
            else None
        ),
        "maxConsecutiveGainDays": _longest_streak(returns, lambda value: value > 0),
        "maxConsecutiveLossDays": _longest_streak(returns, lambda value: value < 0),
    }


def _risk_analytics(
    *,
    assets: list[dict[str, Any]],
    asset_returns: list[list[float]],
    portfolio_returns: list[float],
    average_weights: list[float],
    ending_weights: list[float],
) -> dict[str, Any]:
    portfolio_variance = 0.0
    for left in range(len(assets)):
        for right in range(len(assets)):
            portfolio_variance += (
                average_weights[left]
                * average_weights[right]
                * _covariance(asset_returns[left], asset_returns[right])
            )
    risk_contributions = []
    for index, asset in enumerate(assets):
        marginal_variance = 0.0
        for other_index in range(len(assets)):
            marginal_variance += average_weights[other_index] * _covariance(
                asset_returns[index], asset_returns[other_index]
            )
        volatility = _standard_deviation(asset_returns[index])
        risk_contributions.append(
            {
                "key": f"{asset['currency']}:{asset['symbol']}",
                "symbol": asset["symbol"],
                "name": asset["name"],
                "averageWeightPercent": _js_round(average_weights[index] * 100),
                "endingWeightPercent": _js_round(ending_weights[index] * 100),
                "annualizedVolatilityPercent": (
                    _js_round(volatility * math.sqrt(TRADING_DAYS_PER_YEAR) * 100)
                    if len(asset_returns[index]) > 1
                    else None
                ),
                "riskContributionPercent": (
                    _js_round(average_weights[index] * marginal_variance / portfolio_variance * 100)
                    if portfolio_variance > 0
                    else None
                ),
                "correlationToPortfolio": _correlation(asset_returns[index], portfolio_returns),
            }
        )
    risk_contributions.sort(
        key=lambda item: -(
            item["riskContributionPercent"] if item["riskContributionPercent"] is not None else -math.inf
        )
    )
    sorted_weights = sorted(ending_weights, reverse=True)

    def sum_top(count: int) -> float:
        return _js_round(_sum(sorted_weights[:count]) * 100)

    krw_weight = 0.0
    for index, asset in enumerate(assets):
        if asset["currency"] == "KRW":
            krw_weight += ending_weights[index]
    hhi = _sum([weight**2 for weight in ending_weights])
    weighted_individual_volatility = 0.0
    for index in range(len(assets)):
        weighted_individual_volatility += average_weights[index] * _standard_deviation(asset_returns[index])
    portfolio_volatility = math.sqrt(max(0.0, portfolio_variance))
    return {
        "riskContributions": risk_contributions,
        "exposure": {
            "krwWeightPercent": _js_round(krw_weight * 100),
            "usdWeightPercent": _js_round((1 - krw_weight) * 100),
            "domesticWeightPercent": _js_round(krw_weight * 100),
            "overseasWeightPercent": _js_round((1 - krw_weight) * 100),
            "top1WeightPercent": sum_top(1),
            "top5WeightPercent": sum_top(5),
            "top10WeightPercent": sum_top(10),
            "hhi": _js_round(hhi, 6),
            "effectivePositions": _js_round(1 / hhi, 2) if hhi > 0 else None,
            "diversificationBenefitPercent": (
                _js_round((1 - portfolio_volatility / weighted_individual_volatility) * 100)
                if weighted_individual_volatility > 0 and portfolio_variance > 0
                else None
            ),
        },
    }


def _cost_analytics(
    *,
    trades: list[dict[str, Any]],
    balances: list[dict[str, Any]],
    transaction_cost_bps: float,
    gross_return_percent: float,
) -> dict[str, Any]:
    total_traded_amount = _sum([float(trade["amount"]) for trade in trades])
    ongoing_trades = [trade for trade in trades if trade["reason"] != "initial"]
    ongoing_traded_amount = _sum([float(trade["amount"]) for trade in ongoing_trades])
    total_buy_amount = _sum([float(trade["amount"]) for trade in trades if trade["side"] == "BUY"])
    total_sell_amount = _sum([float(trade["amount"]) for trade in trades if trade["side"] == "SELL"])
    average_value = _average([float(point["value"]) for point in balances])
    estimated_total_cost = total_traded_amount * transaction_cost_bps / 10_000
    cost_drag_percent = estimated_total_cost / average_value * 100 if average_value > 0 else None
    values_by_month: dict[str, list[float]] = {}
    for point in balances:
        month = str(point["date"])[:7]
        values = values_by_month.get(month, [])
        values.append(float(point["value"]))
        values_by_month[month] = values
    trades_by_month: dict[str, list[dict[str, Any]]] = {}
    for trade in trades:
        month = str(trade["date"])[:7]
        values = trades_by_month.get(month, [])
        values.append(trade)
        trades_by_month[month] = values
    monthly = []
    for month in sorted(set(values_by_month) | set(trades_by_month)):
        month_trades = trades_by_month.get(month, [])
        traded_amount = _sum([float(trade["amount"]) for trade in month_trades])
        average_month_value = _average(values_by_month.get(month, []))
        monthly.append(
            {
                "month": month,
                "turnoverPercent": (
                    _js_round(traded_amount / (2 * average_month_value) * 100) if average_month_value > 0 else 0
                ),
                "tradeCount": len(month_trades),
                "tradedAmount": _js_round(traded_amount, 2),
                "estimatedCost": _js_round(traded_amount * transaction_cost_bps / 10_000, 2),
            }
        )
    return {
        "transactionCostBps": _js_round(transaction_cost_bps, 2),
        "turnoverPercent": (
            _js_round(ongoing_traded_amount / (2 * average_value) * 100) if average_value > 0 else None
        ),
        "totalTradedAmount": _js_round(total_traded_amount, 2),
        "ongoingTradedAmount": _js_round(ongoing_traded_amount, 2),
        "estimatedTotalCost": _js_round(estimated_total_cost, 2),
        "costDragPercent": None if cost_drag_percent is None else _js_round(cost_drag_percent),
        "grossReturnPercent": _js_round(gross_return_percent),
        "netEstimatedReturnPercent": (
            None if cost_drag_percent is None else _js_round(gross_return_percent - cost_drag_percent)
        ),
        "averageTradeAmount": _js_round(total_traded_amount / len(trades), 2) if trades else None,
        "buySellAmountRatio": _js_round(total_buy_amount / total_sell_amount) if total_sell_amount > 0 else None,
        "tradeCount": len(trades),
        "monthly": monthly,
    }


def _trade_behavior_analytics(trades: list[dict[str, Any]]) -> dict[str, Any]:
    lots: dict[int, list[dict[str, Any]]] = {}
    realized: list[dict[str, float]] = []
    matched_sell_count = 0
    unmatched_sell_count = 0
    for trade in trades:
        asset_index = int(trade["assetIndex"])
        asset_lots = lots.get(asset_index, [])
        quantity_value = float(trade["quantity"])
        if trade["side"] == "BUY":
            if quantity_value > 0:
                asset_lots.append(
                    {
                        "quantity": quantity_value,
                        "unitCost": float(trade["amount"]) / quantity_value,
                        "date": str(trade["date"]),
                    }
                )
            lots[asset_index] = asset_lots
            continue
        remaining = quantity_value
        matched_quantity = 0.0
        cost_basis = 0.0
        weighted_holding_days = 0.0
        while remaining > 0.0000001 and asset_lots:
            lot = asset_lots[0]
            quantity = min(remaining, float(lot["quantity"]))
            matched_quantity += quantity
            cost_basis += quantity * float(lot["unitCost"])
            weighted_holding_days += quantity * _days_between(str(lot["date"]), str(trade["date"]))
            remaining -= quantity
            lot["quantity"] = float(lot["quantity"]) - quantity
            if float(lot["quantity"]) <= 0.0000001:
                asset_lots.pop(0)
        lots[asset_index] = asset_lots
        if matched_quantity <= 0 or remaining > 0.0000001:
            unmatched_sell_count += 1
            continue
        realized.append(
            {
                "profitLoss": float(trade["amount"]) * (matched_quantity / quantity_value) - cost_basis,
                "quantity": matched_quantity,
                "holdingDays": weighted_holding_days / matched_quantity,
            }
        )
        matched_sell_count += 1
    profits = _sum([item["profitLoss"] for item in realized if item["profitLoss"] > 0])
    losses = _sum([item["profitLoss"] for item in realized if item["profitLoss"] < 0])
    total_quantity = _sum([item["quantity"] for item in realized])
    return {
        "estimatedRealizedProfitLoss": _js_round(_sum([item["profitLoss"] for item in realized]), 2),
        "estimatedWinRatePercent": (
            _js_round(len([item for item in realized if item["profitLoss"] > 0]) / len(realized) * 100)
            if realized
            else None
        ),
        "estimatedProfitFactor": _js_round(profits / abs(losses)) if losses < 0 else None,
        "estimatedAverageHoldingDays": (
            _js_round(
                _sum([item["holdingDays"] * item["quantity"] for item in realized]) / total_quantity,
                1,
            )
            if total_quantity > 0
            else None
        ),
        "matchedSellCount": matched_sell_count,
        "unmatchedSellCount": unmatched_sell_count,
        "buyCount": len([trade for trade in trades if trade["side"] == "BUY"]),
        "sellCount": len([trade for trade in trades if trade["side"] == "SELL"]),
    }


def calculate_backtest_advanced_analytics(
    *,
    assets: list[dict[str, Any]],
    base_date: str,
    effective_end_date: str,
    requested_start_date: str,
    returns: list[dict[str, Any]],
    asset_returns: list[list[float]],
    benchmark: dict[str, Any] | None,
    average_weights: list[float],
    ending_weights: list[float],
    trades: list[dict[str, Any]],
    balances: list[dict[str, Any]],
    transaction_cost_bps: float,
    risk_free_rate_percent: float,
    gross_return_percent: float,
    price_coverage: list[dict[str, Any]],
) -> dict[str, Any]:
    return_values = [float(item["value"]) for item in returns]
    risk = _risk_analytics(
        assets=assets,
        asset_returns=asset_returns,
        portfolio_returns=return_values,
        average_weights=average_weights,
        ending_weights=ending_weights,
    )
    asset_quality = []
    for index, asset in enumerate(assets):
        coverage = price_coverage[index]
        aligned_days = int(coverage["alignedDays"])
        observations = int(coverage["observations"])
        asset_quality.append(
            {
                "key": f"{asset['currency']}:{asset['symbol']}",
                "symbol": asset["symbol"],
                "name": asset["name"],
                "observations": observations,
                "alignedDays": aligned_days,
                "coveragePercent": _js_round(observations / aligned_days * 100) if aligned_days > 0 else 0,
                "firstDate": coverage["firstDate"],
                "lastDate": coverage["lastDate"],
            }
        )
    carried_forward_observations = 0
    for item in asset_quality:
        carried_forward_observations += max(0, int(item["alignedDays"]) - int(item["observations"]))
    common_coverage_percent = (
        _js_round(min(float(item["coveragePercent"]) for item in asset_quality)) if asset_quality else 0
    )
    confidence = (
        "high"
        if len(returns) >= 60 and common_coverage_percent >= 85
        else "medium"
        if len(returns) >= 20 and common_coverage_percent >= 65
        else "limited"
    )
    notes = [
        "서로 다른 시장의 휴장일은 직전 수정주가를 이월해 공통 일자에 정렬했습니다.",
        "해외 종목은 현지 통화 수정주가 수익률을 사용하며 과거 환율 변화는 포함하지 않습니다.",
    ]
    if base_date > requested_start_date:
        notes.insert(0, f"공통 일봉이 시작되는 {base_date}부터 계산했습니다.")
    result: dict[str, Any] = {}
    if benchmark is not None:
        result["benchmarkComparison"] = _benchmark_comparison(
            key=str(benchmark["key"]),
            name=str(benchmark["name"]),
            portfolio=return_values,
            benchmark=[float(value) for value in benchmark["returns"]],
            dates=[str(item["date"]) for item in returns],
            risk_free_rate_percent=risk_free_rate_percent,
        )
    benchmark_returns = [float(value) for value in benchmark["returns"]] if benchmark is not None else None
    result.update(
        {
            "rolling": _rolling_analytics(returns, benchmark_returns, risk_free_rate_percent),
            "drawdowns": _drawdown_analytics(returns, base_date),
            "tailRisk": _tail_risk_analytics(return_values),
            "monthlyReturns": _monthly_returns(returns),
            "riskContributions": risk["riskContributions"],
            "exposure": risk["exposure"],
            "costEfficiency": _cost_analytics(
                trades=trades,
                balances=balances,
                transaction_cost_bps=transaction_cost_bps,
                gross_return_percent=gross_return_percent,
            ),
            "tradeBehavior": _trade_behavior_analytics(trades),
            "dataQuality": {
                "confidence": confidence,
                "observationDays": len(returns) + 1,
                "returnObservationDays": len(returns),
                "requestedCalendarDays": _days_between(requested_start_date, effective_end_date) + 1,
                "effectiveStartDate": base_date,
                "effectiveEndDate": effective_end_date,
                "commonCoveragePercent": common_coverage_percent,
                "carriedForwardObservations": carried_forward_observations,
                "benchmarkObservations": int(benchmark["observations"]) if benchmark is not None else 0,
                "assets": asset_quality,
                "notes": notes,
            },
        }
    )
    return result
