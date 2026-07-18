from __future__ import annotations

from datetime import date, timedelta

from portfolio_worker.backtest_analytics import calculate_backtest_advanced_analytics


def _asset(symbol: str = "AAA", currency: str = "KRW") -> dict[str, str]:
    return {
        "symbol": symbol,
        "name": f"Asset {symbol}",
        "market": "KOSPI" if currency == "KRW" else "NASDAQ",
        "currency": currency,
    }


def test_flat_series_preserves_nulls_optional_fields_and_cost_semantics() -> None:
    result = calculate_backtest_advanced_analytics(
        assets=[_asset()],
        base_date="2024-01-01",
        effective_end_date="2024-01-02",
        requested_start_date="2024-01-01",
        returns=[{"date": "2024-01-02", "value": 0.0}],
        asset_returns=[[0.0]],
        benchmark=None,
        average_weights=[1.0],
        ending_weights=[1.0],
        trades=[
            {
                "date": "2024-01-01",
                "assetIndex": 0,
                "side": "BUY",
                "amount": 100.0,
                "quantity": 1.0,
                "price": 100.0,
                "reason": "initial",
            }
        ],
        balances=[{"date": "2024-01-01", "value": 100.0}, {"date": "2024-01-02", "value": 100.0}],
        transaction_cost_bps=100.0,
        risk_free_rate_percent=0.0,
        gross_return_percent=0.0,
        price_coverage=[
            {
                "observations": 2,
                "alignedDays": 2,
                "firstDate": "2024-01-01",
                "lastDate": "2024-01-02",
            }
        ],
    )

    assert "benchmarkComparison" not in result
    assert result["rolling"][0] == {
        "date": "2024-01-02",
        "return20d": None,
        "return60d": None,
        "return120d": None,
        "return252d": None,
        "volatility60d": None,
        "sharpe60d": None,
        "benchmarkExcess60d": None,
        "benchmarkBeta60d": None,
        "benchmarkCorrelation60d": None,
    }
    assert result["drawdowns"]["episodes"] == []
    assert result["tailRisk"] == {
        "historicalVar95Percent": 0.0,
        "expectedShortfall95Percent": 0.0,
        "lossDaysPercent": 0.0,
        "averageGainPercent": None,
        "averageLossPercent": None,
        "gainLossRatio": None,
        "skewness": None,
        "excessKurtosis": None,
        "maxConsecutiveGainDays": 0,
        "maxConsecutiveLossDays": 0,
    }
    assert result["riskContributions"][0]["riskContributionPercent"] is None
    assert result["riskContributions"][0]["correlationToPortfolio"] is None
    assert result["exposure"] == {
        "krwWeightPercent": 100.0,
        "usdWeightPercent": 0.0,
        "domesticWeightPercent": 100.0,
        "overseasWeightPercent": 0.0,
        "top1WeightPercent": 100.0,
        "top5WeightPercent": 100.0,
        "top10WeightPercent": 100.0,
        "hhi": 1.0,
        "effectivePositions": 1.0,
        "diversificationBenefitPercent": None,
    }
    assert result["costEfficiency"]["turnoverPercent"] == 0.0
    assert result["costEfficiency"]["estimatedTotalCost"] == 1.0
    assert result["costEfficiency"]["costDragPercent"] == 1.0
    assert result["costEfficiency"]["netEstimatedReturnPercent"] == -1.0
    assert result["costEfficiency"]["monthly"][0]["turnoverPercent"] == 50.0
    assert result["tradeBehavior"]["estimatedWinRatePercent"] is None
    assert result["dataQuality"]["confidence"] == "limited"
    assert result["dataQuality"]["notes"][0].startswith("서로 다른 시장")


def test_benchmark_drawdown_and_fifo_trade_behavior_match_source_edge_cases() -> None:
    trades = [
        {
            "date": "2024-01-01",
            "assetIndex": 0,
            "side": "BUY",
            "amount": 10.0,
            "quantity": 1.0,
            "price": 10.0,
            "reason": "initial",
        },
        {
            "date": "2024-01-02",
            "assetIndex": 0,
            "side": "BUY",
            "amount": 12.0,
            "quantity": 1.0,
            "price": 12.0,
            "reason": "cash-flow",
        },
        {
            "date": "2024-01-03",
            "assetIndex": 0,
            "side": "SELL",
            "amount": 15.0,
            "quantity": 1.0,
            "price": 15.0,
            "reason": "rebalance",
        },
        {
            "date": "2024-01-04",
            "assetIndex": 0,
            "side": "SELL",
            "amount": 6.0,
            "quantity": 0.5,
            "price": 12.0,
            "reason": "cash-flow",
        },
        {
            "date": "2024-01-05",
            "assetIndex": 0,
            "side": "SELL",
            "amount": 12.0,
            "quantity": 2.0,
            "price": 6.0,
            "reason": "rebalance",
        },
    ]
    returns = [
        {"date": "2024-01-02", "value": 0.10},
        {"date": "2024-01-03", "value": -0.05},
        {"date": "2024-01-04", "value": 0.02},
    ]
    result = calculate_backtest_advanced_analytics(
        assets=[_asset()],
        base_date="2024-01-01",
        effective_end_date="2024-01-04",
        requested_start_date="2023-12-20",
        returns=returns,
        asset_returns=[[0.10, -0.05, 0.02]],
        benchmark={"key": "TEST", "name": "Benchmark", "returns": [0.05, -0.10, 0.0], "observations": 4},
        average_weights=[1.0],
        ending_weights=[1.0],
        trades=trades,
        balances=[
            {"date": "2024-01-01", "value": 100.0},
            {"date": "2024-01-02", "value": 110.0},
            {"date": "2024-01-03", "value": 104.5},
            {"date": "2024-01-04", "value": 106.59},
        ],
        transaction_cost_bps=0.0,
        risk_free_rate_percent=0.0,
        gross_return_percent=6.59,
        price_coverage=[
            {
                "observations": 4,
                "alignedDays": 4,
                "firstDate": "2024-01-01",
                "lastDate": "2024-01-04",
            }
        ],
    )

    comparison = result["benchmarkComparison"]
    assert comparison["upsideCapturePercent"] == 200.0
    assert comparison["downsideCapturePercent"] == 50.0
    assert comparison["dailyWinRatePercent"] == 100.0
    assert comparison["monthlyWinRatePercent"] == 100.0
    assert len(result["drawdowns"]["episodes"]) == 1
    assert "recoveryDate" not in result["drawdowns"]["episodes"][0]
    assert "recoveryDays" not in result["drawdowns"]["episodes"][0]
    behavior = result["tradeBehavior"]
    assert behavior["estimatedRealizedProfitLoss"] == 5.0
    assert behavior["estimatedWinRatePercent"] == 50.0
    assert behavior["estimatedProfitFactor"] is None
    assert behavior["estimatedAverageHoldingDays"] == 2.0
    assert behavior["matchedSellCount"] == 2
    assert behavior["unmatchedSellCount"] == 1
    assert result["dataQuality"]["notes"][0] == "공통 일봉이 시작되는 2024-01-01부터 계산했습니다."


def test_rolling_metrics_start_at_exact_window_boundaries() -> None:
    start = date(2024, 1, 1)
    return_points = [
        {"date": (start + timedelta(days=index + 1)).isoformat(), "value": 0.01 if index % 2 == 0 else -0.005}
        for index in range(60)
    ]
    values = [float(item["value"]) for item in return_points]
    result = calculate_backtest_advanced_analytics(
        assets=[_asset()],
        base_date=start.isoformat(),
        effective_end_date=(start + timedelta(days=60)).isoformat(),
        requested_start_date=start.isoformat(),
        returns=return_points,
        asset_returns=[values],
        benchmark={"key": "TEST", "name": "Benchmark", "returns": [value / 2 for value in values], "observations": 61},
        average_weights=[1.0],
        ending_weights=[1.0],
        trades=[],
        balances=[
            {"date": (start + timedelta(days=index)).isoformat(), "value": 100.0}
            for index in range(61)
        ],
        transaction_cost_bps=0.0,
        risk_free_rate_percent=0.0,
        gross_return_percent=0.0,
        price_coverage=[
            {
                "observations": 61,
                "alignedDays": 61,
                "firstDate": start.isoformat(),
                "lastDate": (start + timedelta(days=60)).isoformat(),
            }
        ],
    )

    assert result["rolling"][18]["return20d"] is None
    assert result["rolling"][19]["return20d"] is not None
    assert result["rolling"][58]["return60d"] is None
    assert result["rolling"][59]["return60d"] is not None
    assert result["rolling"][59]["volatility60d"] is not None
    assert result["rolling"][59]["benchmarkBeta60d"] is not None
    assert result["dataQuality"]["confidence"] == "high"
