import type {
  BacktestAssetInput,
  BacktestBenchmarkKey,
  BacktestRunRequest,
} from "../backtest.js";

export function parseBacktestPayload(value: unknown): BacktestRunRequest {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const assets: BacktestAssetInput[] = Array.isArray(body.assets)
    ? body.assets.map((value) => {
        const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
        return {
          symbol: typeof item.symbol === "string" ? item.symbol : "",
          weight: typeof item.weight === "number" ? item.weight : Number.NaN,
          ...(typeof item.lotSize === "number" ? { lotSize: item.lotSize } : {}),
          ...(typeof item.delistDate === "string" ? { delistDate: item.delistDate } : {}),
          ...(typeof item.universeMemberFrom === "string" ? { universeMemberFrom: item.universeMemberFrom } : {}),
          ...(typeof item.universeMemberTo === "string" ? { universeMemberTo: item.universeMemberTo } : {}),
        };
      })
    : [];
  return {
    assets,
    startDate: typeof body.startDate === "string" ? body.startDate : "",
    endDate: typeof body.endDate === "string" ? body.endDate : "",
    initialAmount: typeof body.initialAmount === "number" ? body.initialAmount : Number.NaN,
    monthlyCashFlow: typeof body.monthlyCashFlow === "number" ? body.monthlyCashFlow : Number.NaN,
    cashFlowFrequency: typeof body.cashFlowFrequency === "string"
      ? body.cashFlowFrequency as BacktestRunRequest["cashFlowFrequency"]
      : "monthly",
    cashFlowTiming: typeof body.cashFlowTiming === "string"
      ? body.cashFlowTiming as BacktestRunRequest["cashFlowTiming"]
      : "period_start",
    riskFreeRatePercent: typeof body.riskFreeRatePercent === "number" ? body.riskFreeRatePercent : 0,
    transactionCostBps: typeof body.transactionCostBps === "number" ? body.transactionCostBps : 0,
    currencyMode: body.currencyMode === "local" ? "local" : "KRW",
    baseCurrency: "KRW",
    rebalanceFrequency: typeof body.rebalanceFrequency === "string"
      ? body.rebalanceFrequency as BacktestRunRequest["rebalanceFrequency"]
      : "none",
    ...(typeof body.rebalanceThresholdPercent === "number"
      ? { rebalanceThresholdPercent: body.rebalanceThresholdPercent }
      : {}),
    cashFlows: Array.isArray(body.cashFlows) ? body.cashFlows.map((value) => {
      const flow = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        date: typeof flow.date === "string" ? flow.date : "",
        amount: typeof flow.amount === "number" ? flow.amount : Number.NaN,
        ...(typeof flow.memo === "string" ? { memo: flow.memo } : {}),
      };
    }) : [],
    targetWeightSchedule: Array.isArray(body.targetWeightSchedule) ? body.targetWeightSchedule.map((value) => {
      const entry = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      const rawWeights = entry.weights && typeof entry.weights === "object" && !Array.isArray(entry.weights)
        ? entry.weights as Record<string, unknown>
        : {};
      return {
        date: typeof entry.date === "string" ? entry.date : "",
        weights: Object.fromEntries(Object.entries(rawWeights).map(([symbol, weight]) => [
          symbol,
          typeof weight === "number" ? weight : Number.NaN,
        ])),
        cashTargetPercent: typeof entry.cashTargetPercent === "number" ? entry.cashTargetPercent : 0,
        ...(typeof entry.regime === "string" ? { regime: entry.regime } : {}),
        ...(typeof entry.action === "string" ? { action: entry.action } : {}),
      };
    }) : [],
    execution: body.execution && typeof body.execution === "object" ? {
      cashTargetPercent: typeof (body.execution as Record<string, unknown>).cashTargetPercent === "number"
        ? Number((body.execution as Record<string, unknown>).cashTargetPercent) : 0,
      quantityMode: (body.execution as Record<string, unknown>).quantityMode === "whole" ? "whole" : "fractional",
      cashFlowRebalanceMode: ["target_weights", "drift_reduction", "full"].includes(
        String((body.execution as Record<string, unknown>).cashFlowRebalanceMode),
      )
        ? (body.execution as Record<string, unknown>).cashFlowRebalanceMode as "target_weights" | "drift_reduction" | "full"
        : "target_weights",
      tradeDatePolicy: "next_common_observation",
      cashAnnualYieldPercent: typeof (body.execution as Record<string, unknown>).cashAnnualYieldPercent === "number"
        ? Number((body.execution as Record<string, unknown>).cashAnnualYieldPercent) : 0,
    } : undefined,
    ...(body.realism && typeof body.realism === "object" && !Array.isArray(body.realism)
      ? { realism: body.realism as BacktestRunRequest["realism"] }
      : {}),
    benchmark: typeof body.benchmark === "string" ? body.benchmark as BacktestBenchmarkKey : "NONE",
    ...(typeof body.benchmarkSymbol === "string" ? { benchmarkSymbol: body.benchmarkSymbol } : {}),
  };
}
