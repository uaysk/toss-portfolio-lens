import type { BacktestSimulationInput } from "../server/contracts/backtest.js";
import type { OptimizationInput } from "../server/contracts/optimization.js";

type Fixture = {
  backtest: BacktestSimulationInput;
  optimization: OptimizationInput;
};

function date(index: number): string {
  return new Date(Date.UTC(2018, 0, 1 + index)).toISOString().slice(0, 10);
}

export function buildSyntheticFixture(dayCount = 1_260, assetCount = 8): Fixture {
  const baseDefinitions = [
    { symbol: "KR1", currency: "KRW" as const, weight: 18, phase: 0.1, drift: 0.00035 },
    { symbol: "KR2", currency: "KRW" as const, weight: 16, phase: 0.8, drift: 0.00028 },
    { symbol: "KR3", currency: "KRW" as const, weight: 15, phase: 1.6, drift: 0.00022 },
    { symbol: "KR4", currency: "KRW" as const, weight: 14, phase: 2.4, drift: 0.00018 },
    { symbol: "US1", currency: "USD" as const, weight: 13, phase: 0.4, drift: 0.00042 },
    { symbol: "US2", currency: "USD" as const, weight: 10, phase: 1.2, drift: 0.00038 },
    { symbol: "US3", currency: "USD" as const, weight: 8, phase: 2.0, drift: 0.00031 },
    { symbol: "US4", currency: "USD" as const, weight: 6, phase: 2.8, drift: 0.00026 },
  ];
  const safeAssetCount = Math.max(2, Math.min(20, Math.trunc(assetCount)));
  const expanded = [...baseDefinitions];
  for (let index = expanded.length; index < safeAssetCount; index += 1) {
    expanded.push({
      symbol: `S${String(index + 1).padStart(2, "0")}`,
      currency: index % 2 ? "USD" as const : "KRW" as const,
      weight: 1,
      phase: (index * 0.63) % Math.PI,
      drift: 0.00016 + (index % 7) * 0.000035,
    });
  }
  const selected = expanded.slice(0, safeAssetCount);
  const selectedWeight = selected.reduce((sum, definition) => sum + definition.weight, 0);
  const definitions = safeAssetCount === baseDefinitions.length
    ? selected
    : selected.map((definition) => ({ ...definition, weight: definition.weight / selectedWeight * 100 }));
  const prices = new Map<string, Array<{ date: string; close: number; localClose: number; fxRate: number }>>();
  const optimizationSeries: OptimizationInput["priceSeries"] = [];

  for (const [assetIndex, definition] of definitions.entries()) {
    let localClose = 80 + assetIndex * 13;
    const points = [];
    for (let index = 0; index < dayCount; index += 1) {
      const cyclical = Math.sin(index / (11 + assetIndex) + definition.phase) * 0.006;
      const secondary = Math.cos(index / (37 + assetIndex * 2) + definition.phase) * 0.0025;
      localClose *= Math.max(0.85, 1 + definition.drift + cyclical + secondary);
      const fxRate = definition.currency === "USD"
        ? 1_080 + index * 0.09 + Math.sin(index / 29) * 24
        : 1;
      points.push({ date: date(index), close: localClose * fxRate, localClose, fxRate });
    }
    prices.set(`${definition.currency}:${definition.symbol}`, points);
    optimizationSeries.push({
      key: definition.symbol,
      label: definition.symbol,
      points: points.map((point) => ({ date: point.date, value: point.close })),
    });
  }

  let benchmarkClose = 100;
  const benchmark = Array.from({ length: dayCount }, (_, index) => {
    benchmarkClose *= 1 + 0.0003 + Math.sin(index / 17) * 0.0045 + Math.cos(index / 53) * 0.0015;
    return { date: date(index), close: benchmarkClose };
  });

  return {
    backtest: {
      assets: definitions.map((definition) => ({
        symbol: definition.symbol,
        name: definition.symbol,
        market: definition.currency === "KRW" ? "KRX" : "NASDAQ",
        currency: definition.currency,
        listDate: date(0),
        weight: definition.weight,
      })),
      prices,
      requestedStartDate: date(0),
      endDate: date(dayCount - 1),
      initialAmount: 100_000_000,
      monthlyCashFlow: 750_000,
      cashFlowFrequency: "monthly",
      cashFlowTiming: "period_start",
      rebalanceFrequency: "quarterly",
      riskFreeRatePercent: 2.5,
      transactionCostBps: 12,
      rebalanceThresholdPercent: 5,
      benchmark: { key: "SYNTH", name: "Synthetic benchmark", prices: benchmark },
    },
    optimization: {
      objective: "robust_score",
      priceSeries: optimizationSeries,
      benchmark: {
        key: "SYNTH",
        label: "Synthetic benchmark",
        points: benchmark.slice(1).map((point, index) => ({
          date: point.date,
          value: point.close / benchmark[index]!.close - 1,
        })),
      },
      constraints: { minWeight: 0, maxWeight: 0.6, maxAssets: definitions.length },
      seed: 73_421,
      candidateBudget: 1_000,
      riskFreeRatePercent: 2.5,
      confidence: 0.95,
      minimumSamples: 60,
      annualization: 252,
      transactionCostBps: 12,
    },
  };
}
