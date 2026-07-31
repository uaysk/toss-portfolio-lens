import { describe, expect, it } from "vitest";
import type { PortfolioRunRecord } from "../repositories/run-repository.js";
import {
  SIMULATION_REPORT_LIMITS,
  boundedCharts,
  historyItem,
  runStockMarket,
} from "./query-report-projection.js";

function run(overrides: Partial<PortfolioRunRecord> = {}): PortfolioRunRecord {
  return {
    id: "simulation-run",
    kind: "ai_trading_simulation",
    ownerSubject: "owner",
    requestHash: "request-hash",
    dataRevision: "revision",
    engineVersion: "engine",
    status: "completed",
    progress: 1,
    completedCandidates: 1,
    totalCandidates: 1,
    input: {
      schemaVersion: "ai-paper-simulation/v9",
      market: { kind: "stock", country: "US" },
      initialCash: 10_000,
      durationMinutes: 60,
      preset: "risk_management",
      riskTolerance: 50,
      selection: { mode: "manual", symbols: ["QQQ"] },
      strategy: { mode: "single" },
    },
    result: {
      snapshot: {
        market: { kind: "stock", country: "US" },
        currency: "USD",
        initialCash: 10_000,
        equity: 10_250,
        cash: 250,
        selected: [{
          symbol: "QQQ",
          model: {
            modelId: "amazon/chronos-2",
            modelRevision: "revision-a",
            device: "cuda",
          },
        }],
        positions: [{ symbol: "QQQ", unrealizedPnl: 200 }],
        trades: [{ id: "trade-1" }],
        decisions: [{ id: "decision-1" }],
        warnings: ["snapshot warning"],
      },
    },
    summary: {
      tradeCount: 3,
      decisionCount: 5,
      totalCosts: 12,
    },
    warnings: ["run warning"],
    tags: [],
    createdAt: Date.parse("2026-07-31T00:00:00.000Z"),
    updatedAt: Date.parse("2026-07-31T01:00:00.000Z"),
    ...overrides,
  };
}

describe("simulation query/report projection", () => {
  it("projects a canonical v9 history item without changing its public shape", () => {
    const item = historyItem(run());
    expect(item).toMatchObject({
      schemaVersion: "ai-paper-simulation/v9",
      runId: "simulation-run",
      status: "completed",
      market: { kind: "stock", country: "US" },
      marketCountry: "US",
      currency: "USD",
      initialCash: 10_000,
      finalEquity: 10_250,
      netProfitLoss: 250,
      totalCosts: 12,
      tradeCount: 3,
      decisionCount: 5,
      positionCount: 1,
      model: {
        modelId: "amazon/chronos-2",
        modelRevision: "revision-a",
        device: "cuda",
      },
      warnings: ["run warning", "snapshot warning"],
    });
    expect(item.returnRatio).toBeCloseTo(0.025);
  });

  it("rejects non-canonical stored runs instead of inventing a stock market", () => {
    expect(() => runStockMarket(run({
      input: { schemaVersion: "ai-paper-simulation/v9" },
      result: undefined,
    }))).toThrow("market is required");
  });

  it("bounds charts and keeps the latest evidence rows", () => {
    const bars = Array.from(
      { length: SIMULATION_REPORT_LIMITS.barsPerChart + 2 },
      (_, index) => ({ index }),
    );
    const charts = boundedCharts([
      { symbol: "AAA", bars, indicators: [], patterns: [] },
      { symbol: "BBB", bars: [], indicators: [], patterns: [] },
      { symbol: "CCC", bars: [], indicators: [], patterns: [] },
      { symbol: "DDD", bars: [], indicators: [], patterns: [] },
    ]);

    expect(charts).toHaveLength(SIMULATION_REPORT_LIMITS.charts);
    expect(charts[0]?.bars).toHaveLength(SIMULATION_REPORT_LIMITS.barsPerChart);
    expect(charts[0]?.bars).toEqual(
      bars.slice(-SIMULATION_REPORT_LIMITS.barsPerChart),
    );
  });
});
