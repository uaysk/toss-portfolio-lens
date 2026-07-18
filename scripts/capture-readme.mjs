import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "docs", "presentation", "generated");
const appUrl = (process.env.PRESENTATION_APP_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const captureApp = process.env.PRESENTATION_SKIP_APP !== "1";
const captureArchitecture = process.env.PRESENTATION_SKIP_ARCHITECTURE !== "1";
const verifyOnly = process.env.PRESENTATION_VERIFY_ONLY === "1";

const portfolioAssets = [
  { symbol: "069500", name: "KODEX 200", market: "KOSPI", currency: "KRW", listDate: "2002-10-14", weight: 20 },
  { symbol: "091160", name: "KODEX 반도체", market: "KOSPI", currency: "KRW", listDate: "2006-06-27", weight: 20 },
  { symbol: "390390", name: "KODEX 미국반도체", market: "KOSPI", currency: "KRW", listDate: "2021-06-30", weight: 15 },
  { symbol: "440340", name: "TIGER 글로벌멀티에셋TIF액티브", market: "KOSPI", currency: "KRW", listDate: "2022-08-30", weight: 15 },
  { symbol: "379810", name: "KODEX 미국나스닥100", market: "KOSPI", currency: "KRW", listDate: "2021-04-09", weight: 10 },
  { symbol: "426030", name: "TIME 미국나스닥100액티브", market: "KOSPI", currency: "KRW", listDate: "2022-05-11", weight: 20 },
];

const INITIAL_VALUE = 10_000_000;
const CURRENT_VALUE = 11_840_000;
const AS_OF = "2026-07-16T15:30:00+09:00";
const ACCOUNT_ID = "presentation-account";

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function dateStrings(from, to, stepDays = 1, weekdaysOnly = true) {
  const values = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (!weekdaysOnly || (day !== 0 && day !== 6)) values.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + stepDays);
  }
  return values;
}

function syntheticGrowth(index, length, start = INITIAL_VALUE, finish = CURRENT_VALUE, wave = 0.008) {
  if (length <= 1) return finish;
  const progress = index / (length - 1);
  const trend = start + (finish - start) * progress;
  const oscillation = Math.sin(progress * Math.PI * 5) * start * wave * Math.sin(progress * Math.PI);
  return round(trend + oscillation, 0);
}

function normalizedWeights(index, length) {
  const raw = portfolioAssets.map((asset, assetIndex) => (
    asset.weight + Math.sin(index * 0.31 + assetIndex * 1.17) * (assetIndex % 2 === 0 ? 1.2 : 0.85)
  ));
  const sum = raw.reduce((total, value) => total + value, 0);
  return raw.map((value) => round((value / sum) * 100, 4));
}

function portfolioFixture() {
  const quantities = [58, 61, 153, 147, 50, 142];
  const evaluations = portfolioAssets.map((asset) => CURRENT_VALUE * asset.weight / 100);
  const purchases = portfolioAssets.map((asset) => INITIAL_VALUE * asset.weight / 100);
  const dailyRates = [0.62, 1.08, 1.31, 0.18, 0.84, 0.93];
  const account = { id: ACCOUNT_ID, name: "프레젠테이션 포트폴리오", label: "ETF 자산배분 계좌", type: "STOCK" };
  return {
    asOf: AS_OF,
    accounts: [account],
    selectedAccountId: ACCOUNT_ID,
    account,
    summary: {
      evaluationAmount: { KRW: CURRENT_VALUE, USD: 0 },
      purchaseAmount: { KRW: INITIAL_VALUE, USD: 0 },
      profitLoss: { KRW: CURRENT_VALUE - INITIAL_VALUE, USD: 0 },
      dailyProfitLoss: { KRW: 82_400, USD: 0 },
      profitRate: 18.4,
      dailyProfitRate: 0.7,
      positionCount: portfolioAssets.length,
    },
    holdings: portfolioAssets.map((asset, index) => ({
      symbol: asset.symbol,
      name: asset.name,
      market: asset.market,
      currency: asset.currency,
      quantity: quantities[index],
      availableQuantity: quantities[index],
      averagePrice: round(purchases[index] / quantities[index], 2),
      currentPrice: round(evaluations[index] / quantities[index], 2),
      purchaseAmount: purchases[index],
      evaluationAmount: evaluations[index],
      profitLoss: evaluations[index] - purchases[index],
      profitRate: 18.4,
      dailyProfitLoss: round(evaluations[index] * dailyRates[index] / 100, 0),
      dailyProfitRate: dailyRates[index],
    })),
  };
}

function historyFixture() {
  const dates = dateStrings("2026-06-17", "2026-07-16");
  const series = portfolioAssets.map((asset) => ({
    key: `${asset.market}:${asset.symbol}`,
    symbol: asset.symbol,
    name: asset.name,
    market: asset.market,
    currency: "KRW",
    averageWeight: asset.weight,
  }));
  return {
    accountId: ACCOUNT_ID,
    currency: "KRW",
    includesCurrencies: ["KRW"],
    range: "30d",
    generatedAt: AS_OF,
    firstSnapshotDate: "2022-08-30",
    fromDate: dates[0],
    toDate: dates.at(-1),
    series,
    points: dates.map((date, index) => ({
      date,
      capturedAt: `${date}T15:30:00+09:00`,
      origin: index === dates.length - 1 ? "LIVE" : "HISTORICAL",
      totalValue: syntheticGrowth(index, dates.length),
      values: Object.fromEntries(series.map((item, assetIndex) => [item.key, normalizedWeights(index, dates.length)[assetIndex]])),
    })),
  };
}

function benchmarkSeries(dates, annualizedDrift, phase) {
  return dates.map((date, index) => {
    const progress = dates.length <= 1 ? 1 : index / (dates.length - 1);
    return {
      date,
      close: round(1_000 * (1 + annualizedDrift * progress + Math.sin(index * 0.46 + phase) * 0.006 * Math.sin(progress * Math.PI)), 4),
    };
  });
}

function analysisFixture() {
  const history = historyFixture();
  const dates = history.points.map((point) => point.date);
  const candles = history.points.map((point, index) => {
    const close = point.totalValue;
    const open = round(close * (index % 5 === 2 ? 1.004 : 0.997), 0);
    return {
      date: point.date,
      open,
      high: round(Math.max(open, close) * (1.004 + (index % 4) * 0.001), 0),
      low: round(Math.min(open, close) * (0.996 - (index % 3) * 0.001), 0),
      close,
    };
  });
  const benchmarkValues = { KOSPI: 6.4, KOSDAQ: 4.8, NASDAQ100: 10.2, SP500: 7.6 };
  const correlations = portfolioAssets.map((_, row) => portfolioAssets.map((__, column) => (
    row === column ? 1 : round(0.18 + (((row + 2) * (column + 3)) % 7) * 0.08, 2)
  )));
  const contributions = portfolioAssets.map((asset, index) => ({
    key: `${asset.market}:${asset.symbol}`,
    symbol: asset.symbol,
    name: asset.name,
    market: asset.market,
    currency: "KRW",
    estimatedProfitLoss: round((CURRENT_VALUE - INITIAL_VALUE) * asset.weight / 100, 0),
    contributionPercent: round(18.4 * asset.weight / 100, 2),
    timeLinkedContributionPercent: round(17.8 * asset.weight / 100 + (index - 2) * 0.08, 2),
    localPriceContributionPercent: round(17.8 * asset.weight / 100 + (index - 2) * 0.08, 2),
    fxContributionPercent: 0,
  })).sort((left, right) => right.timeLinkedContributionPercent - left.timeLinkedContributionPercent);
  const attributionByKey = Object.fromEntries(contributions.map((item) => [item.key, {
    timeLinkedContributionPercent: item.timeLinkedContributionPercent,
    localPriceContributionPercent: item.localPriceContributionPercent,
    fxContributionPercent: item.fxContributionPercent,
  }]));
  const rolling = dates.map((date, index) => ({
    date,
    return20d: index < 8 ? null : round(1.7 + index * 0.16 + Math.sin(index * 0.7) * 0.8, 2),
    return60d: null,
    return120d: null,
    return252d: null,
    volatility60d: index < 8 ? null : round(11.7 + Math.sin(index * 0.4) * 1.2, 2),
    sharpe60d: index < 8 ? null : round(1.15 + Math.sin(index * 0.3) * 0.2, 2),
    benchmarkExcess60d: { KOSPI: round(2.4 + index * 0.08, 2), NASDAQ100: round(0.8 + index * 0.04, 2) },
    benchmarkBeta60d: { KOSPI: 0.82, NASDAQ100: 0.61 },
    benchmarkCorrelation60d: { KOSPI: 0.74, NASDAQ100: 0.67 },
  }));
  const benchmarkComparisons = Object.entries(benchmarkValues).map(([key, value], index) => ({
    key,
    observations: dates.length - 1,
    returnPercent: value,
    excessReturnPercent: round(17.8 - value, 2),
    trackingErrorPercent: 8.1 + index * 0.7,
    informationRatio: round((17.8 - value) / (8.1 + index * 0.7), 2),
    beta: round(0.82 - index * 0.07, 2),
    alphaPercent: round(8.6 - index * 0.9, 2),
    correlation: round(0.74 - index * 0.03, 2),
    upsideCapturePercent: 112 - index * 3,
    downsideCapturePercent: 78 + index * 2,
    dailyWinRatePercent: 61 - index,
    monthlyWinRatePercent: 67,
    relativeMaxDrawdownPercent: -1.4 - index * 0.3,
  }));
  return {
    accountId: ACCOUNT_ID,
    currency: "KRW",
    baseCurrency: "KRW",
    includesCurrencies: ["KRW", "USD"],
    range: "30d",
    generatedAt: AS_OF,
    fromDate: dates[0],
    toDate: dates.at(-1),
    estimatedOhlc: true,
    ohlcBackfillComplete: true,
    fxBackfillComplete: true,
    candles,
    benchmarks: [
      { key: "KOSPI", name: "KOSPI", baseCurrency: "KRW", currencyAdjusted: false, points: benchmarkSeries(dates, 0.064, 0.2) },
      { key: "KOSDAQ", name: "KOSDAQ", baseCurrency: "KRW", currencyAdjusted: false, points: benchmarkSeries(dates, 0.048, 1.1) },
      { key: "NASDAQ100", name: "나스닥 100", proxySymbol: "QQQ", baseCurrency: "KRW", currencyAdjusted: true, points: benchmarkSeries(dates, 0.102, 2.2) },
      { key: "SP500", name: "S&P 500", proxySymbol: "SPY", baseCurrency: "KRW", currencyAdjusted: true, points: benchmarkSeries(dates, 0.076, 2.8) },
    ],
    benchmarkErrors: [],
    metrics: {
      valuationChangePercent: 18.4,
      estimatedReturnPercent: 17.8,
      timeWeightedReturnPercent: 17.8,
      moneyWeightedReturnPercent: 18.1,
      annualizedReturnPercent: 24.8,
      annualizedVolatilityPercent: 13.4,
      maxDrawdownPercent: -3.8,
      currentDrawdownPercent: -0.7,
      maxDrawdownDays: 9,
      sharpeRatio: 1.71,
      sortinoRatio: 2.36,
      calmarRatio: 6.53,
      top3WeightPercent: 60,
      hhi: 0.175,
      effectivePositions: 5.71,
      benchmarkReturns: benchmarkValues,
      excessReturns: Object.fromEntries(Object.entries(benchmarkValues).map(([key, value]) => [key, round(17.8 - value, 2)])),
      totalBuyAmount: 10_000_000,
      totalSellAmount: 0,
      commission: 14_820,
      tax: 0,
      turnoverPercent: 5.6,
      tradeCount: 6,
      netInvestedAmount: 10_000_000,
      estimatedProfitLoss: 1_840_000,
      bestDailyReturnPercent: 2.14,
      worstDailyReturnPercent: -1.72,
      positiveDaysPercent: 63.6,
      riskFreeRatePercent: 0,
    },
    contributions,
    benchmarkComparisons,
    rolling,
    drawdowns: {
      points: dates.map((date, index) => ({ date, drawdownPercent: round(-Math.abs(Math.sin(index * 0.43)) * (index % 9 === 0 ? 3.8 : 1.8), 2) })),
      episodes: [{ startDate: "2026-06-29", troughDate: "2026-07-03", recoveryDate: "2026-07-08", depthPercent: -3.8, durationDays: 9, recoveryDays: 5 }],
      currentUnderwaterDays: 2,
      averageDrawdownPercent: -1.12,
      ulcerIndex: 1.43,
      worst20DayReturnPercent: -1.9,
      worst60DayReturnPercent: null,
    },
    tailRisk: {
      historicalVar95Percent: -1.48,
      expectedShortfall95Percent: -1.69,
      lossDaysPercent: 36.4,
      averageGainPercent: 0.93,
      averageLossPercent: -0.67,
      gainLossRatio: 1.39,
      skewness: 0.22,
      excessKurtosis: -0.31,
      maxConsecutiveGainDays: 5,
      maxConsecutiveLossDays: 3,
    },
    monthlyReturns: [{ month: "2026-06", returnPercent: 7.1 }, { month: "2026-07", returnPercent: 9.99 }],
    attributionByKey,
    riskContributions: portfolioAssets.map((asset, index) => ({
      key: `${asset.market}:${asset.symbol}`,
      symbol: asset.symbol,
      name: asset.name,
      weightPercent: asset.weight,
      annualizedVolatilityPercent: 12.1 + index * 1.1,
      riskContributionPercent: round(asset.weight + (index - 2.5) * 0.7, 2),
      correlationToPortfolio: round(0.62 + index * 0.04, 2),
    })),
    correlations: {
      assets: portfolioAssets.map((asset) => ({ key: `${asset.market}:${asset.symbol}`, symbol: asset.symbol, name: asset.name })),
      values: correlations,
    },
    exposure: {
      krwWeightPercent: 100,
      usdWeightPercent: 0,
      domesticWeightPercent: 100,
      overseasWeightPercent: 0,
      top1WeightPercent: 20,
      top5WeightPercent: 85,
      top10WeightPercent: 100,
      diversificationBenefitPercent: 29.4,
    },
    costEfficiency: {
      costDragPercent: 0.15,
      grossEstimatedReturnPercent: 17.95,
      costPerTradedAmountBps: 14.82,
      averageTradeAmount: 1_666_667,
      buySellAmountRatio: null,
      monthly: [{ month: "2022-08", turnoverPercent: 100, tradeCount: 6, cost: 14_820 }],
    },
    tradeBehavior: {
      estimatedRealizedProfitLoss: 0,
      estimatedWinRatePercent: null,
      estimatedProfitFactor: null,
      estimatedAverageHoldingDays: 1_416,
      matchedSellCount: 0,
      unmatchedSellCount: 0,
    },
    dataQuality: {
      confidence: "high",
      historyDays: dates.length,
      returnObservationDays: dates.length - 1,
      expectedReturnObservationDays: dates.length - 1,
      returnCoveragePercent: 100,
      requiredPriceObservations: dates.length * portfolioAssets.length,
      missingPriceObservations: 0,
      priceCoveragePercent: 100,
      requiredFxObservations: 0,
      missingFxObservations: 0,
      fxCoveragePercent: 100,
      liveSnapshotDays: 1,
      reconstructedSnapshotDays: dates.length - 1,
      backfillStatus: "complete",
      failedSymbols: 0,
      notes: ["README 프레젠테이션을 위한 결정적 합성 데이터입니다."],
    },
  };
}

function currentBacktestFixture() {
  return {
    accountId: ACCOUNT_ID,
    assets: portfolioAssets.map((asset) => ({ ...asset, securityType: "ETF", status: "ACTIVE", currentValueKrw: CURRENT_VALUE * asset.weight / 100 })),
    defaultStartDate: "2022-08-30",
    defaultEndDate: "2026-07-16",
    initialAmount: INITIAL_VALUE,
  };
}

function backtestFixture() {
  const dates = dateStrings("2022-08-30", "2026-07-16", 7, false);
  const points = dates.map((date, index) => {
    const progress = index / Math.max(dates.length - 1, 1);
    const growth = round(INITIAL_VALUE * (1 + 0.58 * progress + Math.sin(index * 0.21) * 0.018 * Math.sin(progress * Math.PI)), 0);
    const benchmarkGrowth = round(INITIAL_VALUE * (1 + 0.43 * progress + Math.sin(index * 0.18 + 0.4) * 0.015 * Math.sin(progress * Math.PI)), 0);
    const drawdownPercent = round(-Math.abs(Math.sin(index * 0.29)) * (index % 13 === 0 ? 7.2 : 3.1), 2);
    const cashBalance = round(500_000 + Math.sin(index * 0.17) * 80_000, 0);
    return { date, balance: growth, growth, benchmarkGrowth, drawdownPercent, cashBalance, investedBalance: growth - cashBalance, unitPrice: growth / INITIAL_VALUE * 100 };
  });
  const comparable = {
    totalReturnPercent: 58,
    cagrPercent: 12.4,
    annualizedVolatilityPercent: 14.7,
    maxDrawdownPercent: -12.8,
    maxDrawdownDays: 74,
    sharpeRatio: 0.84,
    sortinoRatio: 1.21,
    calmarRatio: 0.97,
    bestDailyReturnPercent: 3.8,
    worstDailyReturnPercent: -4.1,
    positiveDaysPercent: 55.6,
    bestYearPercent: 19.8,
    worstYearPercent: -6.4,
    positiveMonthsPercent: 64.6,
  };
  const contributions = portfolioAssets.map((asset, index) => ({
    symbol: asset.symbol,
    name: asset.name,
    market: asset.market,
    currency: "KRW",
    weight: asset.weight,
    endingValue: 15_800_000 * asset.weight / 100,
    profitLoss: 5_800_000 * asset.weight / 100,
    contributionPercent: round(58 * asset.weight / 100 + (index - 2.5) * 0.15, 2),
    timeLinkedContributionPercent: round(58 * asset.weight / 100 + (index - 2.5) * 0.15, 2),
    localPriceContributionPercent: round(58 * asset.weight / 100 + (index - 2.5) * 0.15, 2),
    fxContributionPercent: 0,
    assetReturnPercent: 48 + index * 4.1,
  }));
  const correlations = portfolioAssets.map((_, row) => portfolioAssets.map((__, column) => row === column ? 1 : round(0.2 + ((row + column) % 6) * 0.09, 2)));
  return {
    runId: "10000000-0000-4000-8000-000000000001",
    reused: false,
    generatedAt: AS_OF,
    baseCurrency: "KRW",
    currencyMethod: "KRW_FX_CONVERTED",
    requestedStartDate: "2022-08-30",
    effectiveStartDate: "2022-08-30",
    endDate: "2026-07-16",
    config: {
      assets: portfolioAssets.map(({ symbol, weight }) => ({ symbol, weight, lotSize: 1 })),
      startDate: "2022-08-30",
      endDate: "2026-07-16",
      initialAmount: INITIAL_VALUE,
      monthlyCashFlow: 0,
      cashFlowFrequency: "monthly",
      cashFlowTiming: "period_start",
      rebalanceFrequency: "annually",
      riskFreeRatePercent: 0,
      transactionCostBps: 0,
      currencyMode: "KRW",
      baseCurrency: "KRW",
      cashFlows: [],
      execution: { cashTargetPercent: 5, quantityMode: "whole", cashFlowRebalanceMode: "drift_reduction", tradeDatePolicy: "next_common_observation", cashAnnualYieldPercent: 2 },
      benchmark: "KOSPI",
      requestedStartDate: "2022-08-30",
      latestListDate: "2022-08-30",
      effectiveStartDate: "2022-08-30",
      effectiveEndDate: "2026-07-16",
    },
    assets: portfolioAssets.map((asset) => ({ ...asset, securityType: "ETF", status: "ACTIVE" })),
    benchmark: { key: "KOSPI", name: "KOSPI", symbol: "KOSPI" },
    warnings: [],
    points,
    metrics: { ...comparable, finalBalance: 15_800_000, totalContributions: 0, totalWithdrawals: 0, endingCashBalance: 500_000, endingCashWeightPercent: 3.16, investedBalance: 15_300_000, totalTransactionCosts: 41_200, netProfitLoss: 5_800_000, moneyWeightedReturnPercent: 12.7 },
    benchmarkMetrics: { ...comparable, totalReturnPercent: 43, cagrPercent: 9.6, annualizedVolatilityPercent: 16.1, maxDrawdownPercent: -17.2, maxDrawdownDays: 112, sharpeRatio: 0.6, sortinoRatio: 0.82, calmarRatio: 0.56 },
    annualReturns: [
      { year: 2022, returnPercent: 3.9 },
      { year: 2023, returnPercent: 16.8 },
      { year: 2024, returnPercent: 13.6 },
      { year: 2025, returnPercent: 12.1 },
      { year: 2026, returnPercent: 5.8 },
    ],
    contributions,
    correlations: { assets: portfolioAssets.map(({ symbol, name }) => ({ symbol, name })), values: correlations },
    trades: [{ date: "2026-07-16", symbol: "069500", side: "BUY", amount: 240_000, quantity: 8, price: 30_000, reason: "cash_flow", transactionCost: 240, netCashImpact: -240_240, trigger: "drift_reduction", lotSize: 1 }],
    cashFlows: [{ scheduledDate: "2026-07-15", effectiveDate: "2026-07-16", amount: 500_000, source: "custom", memo: "추가 납입" }],
    execution: { cashTargetPercent: 5, quantityMode: "whole", cashFlowRebalanceMode: "drift_reduction", tradeDatePolicy: "next_common_observation", cashAnnualYieldPercent: 2 },
    dataQuality: { alignmentPolicy: "carry_forward_for_valuation", commonReturnPolicy: "inner_join", alignedValuationDays: points.length, commonReturnObservations: points.length - 1, carryForwardByAsset: [], benchmarkCarryForwardCount: 0 },
    advanced: {
      benchmarkComparison: {
        key: "KOSPI", name: "KOSPI", observations: points.length, returnPercent: 43, excessReturnPercent: 15,
        trackingErrorPercent: 8.9, informationRatio: 0.71, beta: 0.78, alphaPercent: 5.6, correlation: 0.73,
        upsideCapturePercent: 108, downsideCapturePercent: 76, dailyWinRatePercent: 55.4, monthlyWinRatePercent: 62.5,
        relativeMaxDrawdownPercent: 4.4,
      },
      rolling: points.map((point, index) => ({
        date: point.date,
        return20d: index < 8 ? null : round(1.2 + Math.sin(index * 0.31) * 2.1, 2),
        return60d: index < 16 ? null : round(3.8 + Math.sin(index * 0.19) * 3.4, 2),
        return120d: index < 28 ? null : round(7.1 + Math.sin(index * 0.13) * 4.2, 2),
        return252d: index < 54 ? null : round(12.4 + Math.sin(index * 0.09) * 5.1, 2),
        volatility60d: index < 16 ? null : round(14.7 + Math.sin(index * 0.15) * 2.1, 2),
        sharpe60d: index < 16 ? null : round(0.84 + Math.sin(index * 0.11) * 0.25, 2),
        benchmarkExcess60d: index < 16 ? null : round(1.7 + Math.sin(index * 0.12), 2),
        benchmarkBeta60d: index < 16 ? null : round(0.78 + Math.sin(index * 0.08) * 0.08, 2),
        benchmarkCorrelation60d: index < 16 ? null : round(0.73 + Math.sin(index * 0.07) * 0.09, 2),
      })),
      drawdowns: {
        points: points.map(({ date, drawdownPercent }) => ({ date, drawdownPercent })),
        episodes: [{ startDate: "2024-07-11", troughDate: "2024-08-05", recoveryDate: "2024-09-23", depthPercent: -12.8, durationDays: 74, recoveryDays: 49 }],
        currentUnderwaterDays: 0,
        averageDrawdownPercent: -3.1,
        ulcerIndex: 4.4,
        worst20DayReturnPercent: -7.6,
        worst60DayReturnPercent: -10.2,
      },
      tailRisk: {
        historicalVar95Percent: -1.51, expectedShortfall95Percent: -2.18, lossDaysPercent: 44.4,
        averageGainPercent: 0.77, averageLossPercent: -0.63, gainLossRatio: 1.22, skewness: -0.17,
        excessKurtosis: 1.42, maxConsecutiveGainDays: 8, maxConsecutiveLossDays: 6,
      },
      monthlyReturns: [
        { month: "2025-09", returnPercent: 2.8 }, { month: "2025-10", returnPercent: -1.4 },
        { month: "2025-11", returnPercent: 3.6 }, { month: "2025-12", returnPercent: 1.9 },
        { month: "2026-01", returnPercent: 2.2 }, { month: "2026-02", returnPercent: -0.8 },
        { month: "2026-03", returnPercent: 1.7 }, { month: "2026-04", returnPercent: 2.9 },
        { month: "2026-05", returnPercent: -1.1 }, { month: "2026-06", returnPercent: 3.2 },
      ],
      riskContributions: portfolioAssets.map((asset, index) => ({
        key: `${asset.market}:${asset.symbol}`, symbol: asset.symbol, name: asset.name,
        averageWeightPercent: asset.weight, endingWeightPercent: asset.weight + (index - 2) * 0.3,
        annualizedVolatilityPercent: 12.6 + index * 1.2, riskContributionPercent: asset.weight + (index - 2) * 0.8,
        correlationToPortfolio: 0.61 + index * 0.04,
      })),
      exposure: {
        krwWeightPercent: 100, usdWeightPercent: 0, domesticWeightPercent: 100, overseasWeightPercent: 0,
        top1WeightPercent: 20, top5WeightPercent: 85, top10WeightPercent: 100, hhi: 0.175,
        effectivePositions: 5.71, diversificationBenefitPercent: 31.2,
      },
      costEfficiency: {
        transactionCostBps: 0, turnoverPercent: 297.2, totalTradedAmount: 29_720_000, ongoingTradedAmount: 19_720_000,
        estimatedTotalCost: 0, costDragPercent: 0, grossReturnPercent: 58, netEstimatedReturnPercent: 58,
        averageTradeAmount: 1_100_741, buySellAmountRatio: 1.08, tradeCount: 27,
        monthly: [{ month: "2023-08", turnoverPercent: 71.4, tradeCount: 6, tradedAmount: 7_140_000, estimatedCost: 0 }],
      },
      tradeBehavior: {
        estimatedRealizedProfitLoss: 0, estimatedWinRatePercent: null, estimatedProfitFactor: null,
        estimatedAverageHoldingDays: 1_416, matchedSellCount: 0, unmatchedSellCount: 0, buyCount: 27, sellCount: 21,
      },
      dataQuality: {
        confidence: "high", observationDays: points.length, returnObservationDays: points.length - 1,
        requestedCalendarDays: 1_416, effectiveStartDate: "2022-08-30", effectiveEndDate: "2026-07-16",
        commonCoveragePercent: 100, carriedForwardObservations: 0, benchmarkObservations: points.length,
        assets: portfolioAssets.map((asset) => ({
          key: `${asset.market}:${asset.symbol}`, symbol: asset.symbol, name: asset.name, observations: points.length,
          alignedDays: points.length, coveragePercent: 100, firstDate: "2022-08-30", lastDate: "2026-07-16",
        })),
        notes: ["README 프레젠테이션을 위한 결정적 합성 데이터입니다."],
      },
    },
  };
}

const fixtures = {
  portfolio: portfolioFixture(),
  history: historyFixture(),
  analysis: analysisFixture(),
  currentBacktest: currentBacktestFixture(),
  backtest: backtestFixture(),
  backfill: {
    accountId: ACCOUNT_ID,
    status: "complete",
    phase: "complete",
    startedAt: "2026-07-16T12:00:00+09:00",
    completedAt: "2026-07-16T12:03:00+09:00",
    updatedAt: AS_OF,
    firstTradeDate: "2022-08-30",
    lastBackfilledDate: "2026-07-16",
    ordersImported: 6,
    symbolsTotal: 6,
    symbolsProcessed: 6,
    pricesImported: 5_226,
    snapshotsCreated: 947,
    reconciledSymbols: 6,
    discrepancySymbols: 0,
    failedSymbols: 0,
    message: "합성 프레젠테이션 데이터 동기화 완료",
  },
};

const monteCarloRunId = "20000000-0000-4000-8000-000000000001";
const optimizationRunId = "30000000-0000-4000-8000-000000000001";
const walkForwardRunId = "40000000-0000-4000-8000-000000000001";
const marketResourceHash = "b".repeat(64);
const monteCarloFixture = {
  method: "correlated_moving_block_bootstrap",
  seed: 12345,
  pathCount: 10000,
  horizonDays: 252,
  distributions: {
    terminalBalance: { count: 10000, min: 6_100_000, max: 21_400_000, mean: 12_900_000, standardDeviation: 2_100_000, percentiles: [{ quantile: 0.05, value: 9_100_000 }, { quantile: 0.5, value: 12_700_000 }, { quantile: 0.95, value: 16_800_000 }] },
  },
  probabilities: { terminalLossProbabilityPercent: 8.4, everDepletedProbabilityPercent: 0, terminalGoalProbabilityPercent: 35.2 },
  percentilePaths: [0.05, 0.5, 0.95].map((quantile, pathIndex) => ({ quantile, points: Array.from({ length: 13 }, (_, index) => ({ step: index * 21, balance: INITIAL_VALUE * (1 + index * (0.006 + pathIndex * 0.008)) })) })),
  samplePaths: [],
  warnings: [],
};

const optimizationFixture = {
  candidateCount: 500,
  seed: 12345,
  bestByObjective: {
    robust_score: {
      weights: Object.fromEntries(portfolioAssets.map((asset) => [asset.symbol, asset.weight / 100])),
      metrics: { return: 0.124, volatility: 0.147, maxDrawdown: -0.128, sharpe: 0.84, cvar: -0.022, robustScore: 0.91 },
    },
  },
  paretoFrontier: [{ weights: { "069500": 0.5, "379810": 0.5 }, metrics: { return: 0.13, volatility: 0.15, maxDrawdown: -0.12 } }],
};

const walkForwardFixture = {
  folds: [{ trainStart: "2022-08-30", trainEnd: "2024-12-31", testStart: "2025-01-02", testEnd: "2025-03-31", oos: { return: 0.031, maxDrawdown: -0.021, turnover: 0.14 } }],
  oosSummary: { foldCount: 1, averageReturn: 0.031, worstReturn: 0.031, bestReturn: 0.031 },
};

function scenarioFixture(name) {
  return { scenarios: [{ id: name, name, config: { rebalanceFrequency: "quarterly" }, metrics: { totalReturnPercent: 12.4, cagrPercent: 8.1, annualizedVolatilityPercent: 10.2, maxDrawdownPercent: -5.3, sharpeRatio: 0.79, moneyWeightedReturnPercent: 8.2, totalTransactionCosts: 1200 } }] };
}

const researchFixtures = {
  "diversifying-assets": { base_portfolio_metrics: {}, candidates: [{ symbol: "GLD", correlation: 0.18, down_market_correlation: 0.12, beta: 0.2, expected_variance_effect: { volatility_reduction: 0.03 }, mixed_portfolio_metrics: { cagr: 0.118, max_drawdown: -0.105 } }], universe: "explicit", universe_size: 1 },
  "market-regimes": { thresholds: { return_median: 0.001, volatility_median: 0.012 }, regimes: [{ regime: "up_low_vol", observations: 320, average_return: 0.0012, annualized_volatility: 0.11 }], observations: [], observations_resource: { uri: `market://series/${marketResourceHash}`, row_count: 1, byte_count: 120 } },
  "return-contribution": { contributions: fixtures.backtest.contributions, risk_contributions: fixtures.backtest.advanced.riskContributions },
  "pareto-frontier": { candidates: [{ id: "candidate-1", rank: 1, score: 0.91, weights: { "069500": 0.5, "379810": 0.5 }, metrics: { return: 0.13, volatility: 0.15, maxDrawdown: -0.12 }, pareto: true }] },
  "redundant-assets": { redundant_pairs: [{ left: "379810", right: "426030", correlation: 0.96 }], pair_details: [{ left: "379810", right: "426030", correlation: 0.96, beta: 1.03, drawdown_path_correlation: 0.92, observations: 700, redundant: true }], removal_impact_by_asset: {} },
  "rebalance-plan": { changes: [{ symbol: "069500", current: 0.2, target: 0.25, change: 0.05, action: "buy", notional_change: 500000 }], turnover: 0.05, estimated_cost_rate: 0.00005, estimated_cost: 500, risk_change: { sharpe_ratio: 0.08 }, order_generated: false },
};

async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 다음 후보를 확인한다.
    }
  }
  return undefined;
}

async function launchBrowser() {
  const executablePath = await firstExecutable([
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
  ]);
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
}

export async function routeApplicationApi(page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = async (value, status = 200) => route.fulfill({
      status,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(value),
    });
    if (url.pathname === "/api/auth/session") return json({ authenticated: true });
    if (url.pathname === "/api/auth/logout") return json({ ok: true });
    if (url.pathname === "/api/portfolio") return json(fixtures.portfolio);
    if (url.pathname === "/api/portfolio/history/status") return json(fixtures.backfill);
    if (url.pathname === "/api/portfolio/history") return json(fixtures.history);
    if (url.pathname === "/api/portfolio/history/backfill") return json({ status: fixtures.backfill });
    if (url.pathname === "/api/portfolio/analysis") return json(fixtures.analysis);
    if (url.pathname === "/api/portfolio/backtest/current") return json(fixtures.currentBacktest);
    if (url.pathname === "/api/portfolio/backtest" && request.method() === "POST") return json(fixtures.backtest);
    if (url.pathname === "/api/portfolio/backtest/instruments") return json({ instruments: [] });
    if (url.pathname === "/api/portfolio/advanced/monte-carlo" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (!body.fromDate || !body.toDate) return json({ error: { code: "invalid-fixture-request", message: "Monte Carlo 요청에는 fromDate와 toDate가 모두 필요합니다." } }, 400);
      return json({ warnings: [], result: { run_id: monteCarloRunId, kind: "monte_carlo", status: "completed", progress: 1, completed_candidates: 10000, total_candidates: 10000 } }, 200);
    }
    if (url.pathname === `/api/portfolio/advanced/runs/${monteCarloRunId}/result`) return json({ runId: monteCarloRunId, kind: "monte_carlo", status: "completed", progress: 1, completedCandidates: 10000, totalCandidates: 10000, summary: { distributions: monteCarloFixture.distributions, probabilities: monteCarloFixture.probabilities }, resultExternalized: true, warnings: [], artifacts: [{ type: "monte-carlo-distribution", rowCount: 1, byteCount: 200 }, { type: "monte-carlo-percentile-paths", rowCount: 3, byteCount: 300000 }, { type: "monte-carlo-sample-paths", rowCount: 0, byteCount: 2 }] });
    if (url.pathname === `/api/portfolio/advanced/runs/${monteCarloRunId}/artifacts/monte-carlo-distribution`) return json({ content: monteCarloFixture.distributions });
    if (url.pathname === `/api/portfolio/advanced/runs/${monteCarloRunId}/artifacts/monte-carlo-percentile-paths`) return json({ content: monteCarloFixture.percentilePaths });
    if (url.pathname === `/api/portfolio/advanced/resources/market/${marketResourceHash}`) return json({ data: [{ date: "2026-07-16", return: 0.0012, volatility: 0.011, regime: "up_low_vol" }] });
    if (url.pathname === "/api/portfolio/advanced/optimization" && request.method() === "POST") return json({ warnings: [], result: { run_id: optimizationRunId, kind: "optimization", status: "completed", progress: 1, completed_candidates: 500, total_candidates: 500 } }, 200);
    if (url.pathname === `/api/portfolio/advanced/runs/${optimizationRunId}/result`) return json({ runId: optimizationRunId, kind: "optimization", status: "completed", progress: 1, completedCandidates: 500, totalCandidates: 500, result: optimizationFixture, warnings: [], artifacts: [] });
    if (url.pathname === "/api/portfolio/advanced/walk-forward" && request.method() === "POST") return json({ warnings: [], result: { run_id: walkForwardRunId, kind: "walk_forward", status: "completed", progress: 1, completed_candidates: 500, total_candidates: 500 } }, 200);
    if (url.pathname === `/api/portfolio/advanced/runs/${walkForwardRunId}/result`) return json({ runId: walkForwardRunId, kind: "walk_forward", status: "completed", progress: 1, completedCandidates: 500, totalCandidates: 500, summary: { fold_count: 1 }, resultExternalized: true, warnings: [], artifacts: [{ type: "walk-forward", rowCount: 1, byteCount: 300000 }] });
    if (url.pathname === `/api/portfolio/advanced/runs/${walkForwardRunId}/artifacts/walk-forward`) return json({ content: walkForwardFixture });
    if (url.pathname === "/api/portfolio/advanced/stress-test" && request.method() === "POST") return json({ warnings: [], result: scenarioFixture("스트레스 합성 결과") });
    const sensitivityOperation = url.pathname.match(/^\/api\/portfolio\/advanced\/(sensitivity-weight|sensitivity-start-date|sensitivity-rebalance|sensitivity-cash-flow)$/)?.[1];
    if (sensitivityOperation && request.method() === "POST") return json({ warnings: [], result: scenarioFixture(`민감도 ${sensitivityOperation}`) });
    const researchOperation = url.pathname.match(/^\/api\/portfolio\/advanced\/(diversifying-assets|market-regimes|return-contribution|pareto-frontier|redundant-assets|rebalance-plan)$/)?.[1];
    if (researchOperation && request.method() === "POST") return json({ warnings: [], result: researchFixtures[researchOperation] });
    return json({ error: { code: "presentation-route-missing", message: `합성 fixture가 없는 경로입니다: ${url.pathname}` } }, 404);
  });
}

async function prepareAppPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
  await context.addInitScript(() => {
    window.localStorage.setItem("portfolio-theme", "dark");
    window.localStorage.removeItem("portfolio-hidden-stocks");
  });
  const page = await context.newPage();
  await routeApplicationApi(page);
  await page.goto(`${appUrl}/#overview`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: `
    *, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }
    html { scroll-behavior: auto !important; }
  ` });
  await page.getByText("보유 주식 평가액", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "종목별 포트폴리오 비중" }).waitFor();
  return { context, page };
}

async function screenshotViewport(page, filename) {
  if (verifyOnly) return;
  await page.mouse.move(1410, 18);
  await page.waitForTimeout(240);
  await page.screenshot({
    path: path.join(outputDirectory, filename),
    type: "png",
    animations: "disabled",
  });
}

async function captureApplication(browser) {
  const { context, page } = await prepareAppPage(browser);
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshotViewport(page, "app-overview.png");

    await page.locator("#allocation").scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -96));
    await screenshotViewport(page, "app-account-composition.png");

    await page.getByRole("button", { name: "포트폴리오 분석" }).click();
    await page.getByRole("heading", { name: "포트폴리오 전체 평가금 일봉" }).waitFor();
    await page.getByText("보유주식 TWR", { exact: true }).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshotViewport(page, "app-analysis.png");

    await page.getByRole("button", { name: "백테스트", exact: true }).click();
    await page.getByRole("heading", { name: "포트폴리오 전략 백테스트" }).waitFor();
    await page.getByText("총 6종목 · 주식", { exact: false }).waitFor();
    await Promise.all(portfolioAssets.map((asset) => (
      page.getByText(`${asset.market} · ${asset.symbol} · 상장 ${asset.listDate}`, { exact: true }).waitFor()
    )));
    const initialAmount = await page.getByLabel("초기 투자금 · KRW").inputValue();
    if (Number(initialAmount) !== INITIAL_VALUE) {
      throw new Error(`백테스트 시작 평가금이 ${INITIAL_VALUE}원이 아닙니다: ${initialAmount}`);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshotViewport(page, "app-backtest.png");

    await page.getByRole("button", { name: "백테스트 실행" }).click();
    await page.getByRole("heading", { name: "현금흐름 제거 성장 비교" }).waitFor();
    await page.getByRole("heading", { name: "현금흐름 제거 성장 비교" }).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -92));
    // Recharts의 선 그리기 애니메이션이 끝난 뒤 전체 경로를 캡처한다.
    await page.waitForTimeout(1_200);
    await screenshotViewport(page, "app-backtest-result.png");

    await page.getByRole("button", { name: "최적화", exact: true }).click();
    await page.getByRole("heading", { name: "최적화 기준 포트폴리오" }).waitFor();
    await page.getByRole("heading", { name: "비교·검증·최적화 연구실" }).waitFor();

    await page.getByRole("button", { name: "Monte Carlo", exact: true }).click();
    await page.getByRole("button", { name: "고급 분석 실행", exact: true }).click();
    await page.getByText("손실 종료 확률", { exact: true }).waitFor();
    await page.getByText("8.40%", { exact: true }).waitFor();
    await page.getByRole("button", { name: "분위수 경로 불러오기", exact: true }).click();
    await page.getByRole("button", { name: "분위수 경로 불러오기", exact: true }).waitFor({ state: "detached" });

    await page.getByRole("button", { name: "최적화", exact: true }).click();
    await page.getByRole("button", { name: "고급 분석 실행", exact: true }).click();
    await page.getByText("추천 비중", { exact: true }).waitFor();

    await page.getByRole("button", { name: "Walk-forward", exact: true }).click();
    await page.getByRole("button", { name: "고급 분석 실행", exact: true }).click();
    await page.getByRole("button", { name: "Walk-forward fold 불러오기", exact: true }).click();
    await page.getByText("2025-01-02~2025-03-31", { exact: true }).waitFor();

    await page.getByRole("button", { name: "스트레스", exact: true }).click();
    await page.getByRole("button", { name: "고급 분석 실행", exact: true }).click();
    await page.getByText("스트레스 합성 결과", { exact: true }).waitFor();

    await page.getByRole("button", { name: "민감도", exact: true }).click();
    await page.getByRole("button", { name: "고급 분석 실행", exact: true }).click();
    await page.getByText("민감도 sensitivity-rebalance", { exact: true }).waitFor();

    await page.getByRole("button", { name: "연구 도구", exact: true }).click();
    await page.getByRole("button", { name: "연구 도구 실행", exact: true }).click();
    await page.getByText("GLD", { exact: true }).waitFor();
    await page.getByRole("button", { name: "시장 국면", exact: true }).click();
    await page.getByRole("button", { name: "연구 도구 실행", exact: true }).click();
    await page.getByText("up_low_vol", { exact: true }).waitFor();
    await page.getByRole("button", { name: "관측값 불러오기", exact: true }).click();
    await page.getByText("2026-07-16", { exact: true }).waitFor();
    await page.getByRole("button", { name: "수익 기여", exact: true }).click();
    await page.getByRole("button", { name: "연구 도구 실행", exact: true }).click();
    await page.getByText("시간연결 기여", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Pareto", exact: true }).click();
    await page.getByRole("button", { name: "연구 도구 실행", exact: true }).click();
    await page.getByText("0.910", { exact: true }).waitFor();
    await page.getByRole("button", { name: "중복 자산", exact: true }).click();
    await page.getByRole("button", { name: "연구 도구 실행", exact: true }).click();
    await page.getByText("중복 후보", { exact: true }).waitFor();
    await page.getByRole("button", { name: "리밸런싱 계획", exact: true }).click();
    await page.getByRole("button", { name: "연구 도구 실행", exact: true }).click();
    await page.getByText("분석 결과는 계획만 계산하며 주문을 생성하지 않습니다.", { exact: true }).waitFor();
  } finally {
    await context.close();
  }
}

async function verifyMobileApplication(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
  await context.addInitScript(() => window.localStorage.setItem("portfolio-theme", "dark"));
  const page = await context.newPage();
  await routeApplicationApi(page);
  try {
    await page.goto(`${appUrl}/#optimization`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "최적화", exact: true }).click();
    await page.getByRole("heading", { name: "최적화 기준 포트폴리오" }).waitFor();
    await page.getByRole("button", { name: "Monte Carlo", exact: true }).click();
    await page.getByRole("button", { name: "고급 분석 실행", exact: true }).click();
    await page.getByText("평균 최종 잔액", { exact: true }).waitFor();
    const hasViewportOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (hasViewportOverflow) throw new Error("모바일 페이지에 의도하지 않은 전체 가로 스크롤이 있습니다.");
  } finally {
    await context.close();
  }
}

async function captureArchitectureSlides(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", locale: "ko-KR" });
  const page = await context.newPage();
  try {
    for (const [source, target] of [
      ["aws-runtime-architecture.html", "aws-runtime-architecture.png"],
      ["api-report-flow.html", "api-report-flow.png"],
    ]) {
      const file = path.join(projectRoot, "docs", "presentation", source);
      await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
      await page.screenshot({ path: path.join(outputDirectory, target), type: "png", animations: "disabled" });
    }
  } finally {
    await context.close();
  }
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const browser = await launchBrowser();
  try {
    if (captureApp) {
      await captureApplication(browser);
      await verifyMobileApplication(browser);
    }
    if (captureArchitecture) await captureArchitectureSlides(browser);
  } finally {
    await browser.close();
  }

  const generated = [
    ...(captureApp ? ["app-overview.png", "app-account-composition.png", "app-analysis.png", "app-backtest.png", "app-backtest-result.png"] : []),
    ...(captureArchitecture ? ["aws-runtime-architecture.png", "api-report-flow.png"] : []),
  ];
  console.log(`README presentation assets generated (${generated.length}):`);
  for (const filename of generated) console.log(`- docs/presentation/generated/${filename}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
