import { describe, expect, it } from "vitest";
import {
  BacktestValidationError,
  simulateBacktest,
  type BacktestAssetDefinition,
  type BacktestPricePoint,
} from "./backtest-engine.js";

const assets: BacktestAssetDefinition[] = [
  { symbol: "005930", name: "국내 종목", market: "KRX", currency: "KRW", listDate: "1975-06-11", weight: 50 },
  { symbol: "AAPL", name: "미국 종목", market: "NASDAQ", currency: "USD", listDate: "1980-12-12", weight: 50 },
];

function prices(points: Array<[string, number]>): BacktestPricePoint[] {
  return points.map(([date, close]) => ({ date, close }));
}

function generatedPrices(days: number, valueAt: (index: number) => number): BacktestPricePoint[] {
  const start = Date.parse("2025-01-02T00:00:00Z");
  return Array.from({ length: days }, (_, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    close: valueAt(index),
  }));
}

describe("portfolio backtest engine", () => {
  it("국내·해외 종목의 공통 거래일부터 현금흐름을 제거한 성장과 위험을 계산한다", () => {
    const result = simulateBacktest({
      assets,
      prices: new Map([
        ["KRW:005930", prices([
          ["2026-01-02", 100],
          ["2026-02-02", 110],
          ["2026-03-02", 121],
        ])],
        ["USD:AAPL", prices([
          ["2026-01-03", 100],
          ["2026-02-02", 100],
          ["2026-03-02", 100],
        ])],
      ]),
      requestedStartDate: "2026-01-01",
      endDate: "2026-03-02",
      initialAmount: 1_000,
      monthlyCashFlow: 100,
      rebalanceFrequency: "none",
    });

    expect(result.effectiveStartDate).toBe("2026-01-03");
    expect(result.endDate).toBe("2026-03-02");
    expect(result.metrics.totalContributions).toBe(1_200);
    expect(result.metrics.totalWithdrawals).toBe(0);
    expect(result.metrics.totalReturnPercent).toBeCloseTo(10.4783, 4);
    expect(result.metrics.finalBalance).toBe(1_310);
    expect(result.metrics.maxDrawdownPercent).toBe(0);
    expect(result.contributions.reduce((sum, item) => sum + item.profitLoss, 0)).toBe(110);
    expect(result.correlations.assets.map((item) => item.symbol)).toEqual(["005930", "AAPL"]);
    expect(result.points.at(-1)).toMatchObject({ date: "2026-03-02", growth: 1104.78, balance: 1310 });
  });

  it("리밸런싱이 종목 간 자금 이동을 성과 기여도로 계산하지 않는다", () => {
    const result = simulateBacktest({
      assets,
      prices: new Map([
        ["KRW:005930", prices([["2026-01-02", 100], ["2026-02-02", 120], ["2026-03-02", 120]])],
        ["USD:AAPL", prices([["2026-01-02", 100], ["2026-02-02", 100], ["2026-03-02", 120]])],
      ]),
      requestedStartDate: "2026-01-02",
      endDate: "2026-03-02",
      initialAmount: 1_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "monthly",
    });

    expect(result.metrics.finalBalance).toBe(1_210);
    expect(result.metrics.totalReturnPercent).toBe(21);
    expect(result.contributions.map((item) => item.profitLoss).sort((left, right) => left - right)).toEqual([100, 110]);
    expect(result.contributions.reduce((sum, item) => sum + item.contributionPercent, 0)).toBe(21);
  });

  it("동일한 공통 거래일로 벤치마크의 수익과 위험 지표를 계산한다", () => {
    const result = simulateBacktest({
      assets: [{ ...assets[0], weight: 100 }],
      prices: new Map([["KRW:005930", prices([
        ["2026-01-02", 100],
        ["2026-01-03", 110],
        ["2026-01-04", 121],
      ])]]),
      requestedStartDate: "2026-01-02",
      endDate: "2026-01-04",
      initialAmount: 1_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none",
      benchmark: {
        key: "CUSTOM:USD:AAPL",
        name: "Apple",
        prices: prices([
          ["2026-01-02", 100],
          ["2026-01-03", 90],
          ["2026-01-04", 99],
        ]),
      },
    });

    expect(result.metrics.totalReturnPercent).toBe(21);
    expect(result.benchmarkMetrics).toMatchObject({
      totalReturnPercent: -1,
      maxDrawdownPercent: -10,
      maxDrawdownDays: 2,
      bestYearPercent: -1,
      positiveMonthsPercent: 0,
    });
    expect(result.benchmarkMetrics?.annualizedVolatilityPercent).not.toBeNull();
  });

  it("롤링·활성위험·꼬리위험·위험기여·거래비용·FIFO·품질 지표를 함께 계산한다", () => {
    const domestic = generatedPrices(150, (index) => 100 * Math.exp(index * 0.0008 + Math.sin(index / 5) * 0.035));
    const overseas = generatedPrices(150, (index) => 100 * Math.exp(index * 0.0004 + Math.cos(index / 7) * 0.025));
    const benchmark = generatedPrices(150, (index) => 100 * Math.exp(index * 0.0005 + Math.sin(index / 6) * 0.02));
    const result = simulateBacktest({
      assets,
      prices: new Map([["KRW:005930", domestic], ["USD:AAPL", overseas]]),
      requestedStartDate: domestic[0].date,
      endDate: domestic.at(-1)!.date,
      initialAmount: 10_000_000,
      monthlyCashFlow: 100_000,
      rebalanceFrequency: "monthly",
      riskFreeRatePercent: 3,
      transactionCostBps: 12,
      benchmark: { key: "SP500", name: "S&P 500", prices: benchmark },
    });

    expect(result.advanced.benchmarkComparison).toMatchObject({ key: "SP500", observations: 149 });
    expect(result.advanced.benchmarkComparison?.trackingErrorPercent).not.toBeNull();
    expect(result.advanced.benchmarkComparison?.beta).not.toBeNull();
    expect(result.advanced.rolling.at(-1)).toMatchObject({ date: domestic.at(-1)!.date });
    expect(result.advanced.rolling.at(-1)?.return120d).not.toBeNull();
    expect(result.advanced.rolling.at(-1)?.volatility60d).not.toBeNull();
    expect(result.advanced.drawdowns.episodes.length).toBeGreaterThan(0);
    expect(result.advanced.drawdowns.ulcerIndex).not.toBeNull();
    expect(result.advanced.tailRisk.historicalVar95Percent).not.toBeNull();
    expect(result.advanced.tailRisk.maxConsecutiveLossDays).toBeGreaterThan(0);
    expect(result.advanced.monthlyReturns.length).toBeGreaterThan(3);
    expect(result.advanced.riskContributions).toHaveLength(2);
    expect(result.advanced.riskContributions.reduce((sum, item) => sum + (item.riskContributionPercent ?? 0), 0)).toBeCloseTo(100, 2);
    expect(result.advanced.exposure.hhi).toBeGreaterThan(0);
    expect(result.advanced.exposure.effectivePositions).toBeGreaterThan(1);
    expect(result.advanced.costEfficiency.transactionCostBps).toBe(12);
    expect(result.advanced.costEfficiency.estimatedTotalCost).toBeGreaterThan(0);
    expect(result.advanced.costEfficiency.netEstimatedReturnPercent).toBeLessThan(result.advanced.costEfficiency.grossReturnPercent);
    expect(result.advanced.costEfficiency.monthly.length).toBeGreaterThan(3);
    expect(result.advanced.tradeBehavior.buyCount).toBeGreaterThan(2);
    expect(result.advanced.tradeBehavior.sellCount).toBeGreaterThan(0);
    expect(result.advanced.tradeBehavior.unmatchedSellCount).toBe(0);
    expect(result.advanced.dataQuality).toMatchObject({ confidence: "high", commonCoveragePercent: 100 });
    expect(result.contributions.reduce((sum, item) => sum + item.timeLinkedContributionPercent, 0)).toBeCloseTo(result.metrics.totalReturnPercent, 3);
  });

  it("설정한 무위험수익률을 Sharpe와 Sortino에 반영한다", () => {
    const series = generatedPrices(80, (index) => 100 * Math.exp(index * 0.001 + Math.sin(index / 4) * 0.02));
    const baseInput = {
      assets: [{ ...assets[0], weight: 100 }],
      prices: new Map([["KRW:005930", series]]),
      requestedStartDate: series[0].date,
      endDate: series.at(-1)!.date,
      initialAmount: 1_000_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none" as const,
    };
    const zeroRate = simulateBacktest({ ...baseInput, riskFreeRatePercent: 0 });
    const highRate = simulateBacktest({ ...baseInput, riskFreeRatePercent: 10 });

    expect(highRate.metrics.sharpeRatio).toBeLessThan(zeroRate.metrics.sharpeRatio!);
    expect(highRate.metrics.sortinoRatio).toBeLessThan(zeroRate.metrics.sortinoRatio!);
  });

  it("비중 합계가 100%가 아니면 실행하지 않는다", () => {
    expect(() => simulateBacktest({
      assets: [{ ...assets[0], weight: 99 }],
      prices: new Map([["KRW:005930", prices([["2026-01-02", 100], ["2026-01-03", 101]])]]),
      requestedStartDate: "2026-01-02",
      endDate: "2026-01-03",
      initialAmount: 1_000,
      monthlyCashFlow: 0,
      rebalanceFrequency: "none",
    })).toThrow(BacktestValidationError);
  });
});
