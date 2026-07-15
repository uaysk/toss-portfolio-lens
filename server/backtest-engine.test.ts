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
