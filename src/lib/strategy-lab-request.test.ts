import { afterEach, describe, expect, it, vi } from "vitest";
import { toolSchemas } from "../../server/mcp/schemas";
import { runAdvancedAnalysis, type AdvancedAnalysisOperation } from "./advanced-analysis";
import {
  buildExposureAnalysisRequest,
  buildMonteCarloRequest,
  buildOptimizationRequest,
  buildOutlookMonteCarloPayload,
  buildOutlookOptimizationPayload,
  buildWalkForwardPayload,
  buildWalkForwardRequest,
  parseExposureConstituentsDraft,
  parseRobustScoreWeightsDraft,
  withQuantityMode,
} from "./strategy-lab-request";
import type { BacktestRunConfiguration } from "@/types";

const baseConfig: BacktestRunConfiguration = {
  assets: [{ symbol: "AAA", weight: 54, lotSize: 2 }, { symbol: "BBB", weight: 36, lotSize: 5 }],
  startDate: "2021-01-01",
  endDate: "2025-12-31",
  initialAmount: 100_000_000,
  monthlyCashFlow: -500_000,
  cashFlowFrequency: "monthly",
  cashFlowTiming: "period_start",
  rebalanceFrequency: "quarterly",
  riskFreeRatePercent: 2,
  transactionCostBps: 8,
  currencyMode: "KRW",
  baseCurrency: "KRW",
  cashFlows: [],
  execution: {
    cashTargetPercent: 10,
    quantityMode: "fractional",
    cashFlowRebalanceMode: "target_weights",
    tradeDatePolicy: "next_common_observation",
    cashAnnualYieldPercent: 2.5,
  },
  benchmark: "NONE",
};

const optimizationControls = {
  objective: "robust_score",
  candidateBudget: 800,
  seed: 12_345,
  minWeightPercent: 0,
  maxWeightPercent: 80,
  minWeightsPercent: { AAA: 10 },
  maxWeightsPercent: { BBB: 70 },
  maxAssets: 2,
  requiredAssets: ["AAA"],
  excludedAssets: [],
  algorithm: "nsga_ii" as const,
  covarianceEstimator: "ledoit_wolf" as const,
  baselines: ["equal_weight", "risk_parity", "hrp"] as const,
  ledgerValidationBudget: 16,
  ledgerQuantityMode: "whole" as const,
  regimePolicyEnabled: true,
  regimePolicyMethod: "mcts" as const,
  assetGroups: {
    AAA: { sector: "Technology", country: "US", currency: "USD", assetType: "Equity" },
    BBB: { sector: "Financials", country: "KR", currency: "KRW", assetType: "Equity" },
  },
  groupConstraints: [{ dimension: "sector" as const, group: "Technology", minWeightPercent: 10, maxWeightPercent: 60 }],
  robustScoreWeights: { sharpe: 0.4, oosAverageSharpe: 0.6 },
  robustValidationMode: "walk_forward" as const,
  robustValidationWindowMode: "anchored" as const,
  robustValidationTrainWindow: 252,
  robustValidationTestWindow: 63,
  robustValidationStep: 42,
  robustValidationFoldCount: 4,
  robustValidationGap: 5,
  robustValidationEmbargo: 7,
};

const walkForwardControls = {
  mode: "anchored" as const,
  trainWindow: 252,
  testWindow: 63,
  step: 42,
  gap: 5,
  embargo: 7,
  foldCandidateBudget: 120,
  seed: 12_345,
  additionalSeeds: "99, 12345, 99",
};

const monteCarloControls = {
  method: "regime_conditioned" as const,
  horizonDays: 504,
  pathCount: 2_000,
  blockLength: 21,
  seed: 12_345,
  goalAmount: 150_000_000,
  quantiles: [0.05, 0.5, 0.95],
  samplePathCount: 5,
  rebalanceFrequency: "threshold" as const,
  rebalanceThresholdPercent: 4,
  cashWeightPercent: 10,
  cashAnnualYieldPercent: 2.5,
  transactionCostBps: 12,
  periodicCashFlow: -750_000,
  cashFlowFrequencyDays: 21,
  inflationAnnualPercent: 2.2,
  quantityMode: "whole" as const,
  lotSizes: { AAA: 2, BBB: 5 },
  calibrationOrigins: 18,
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function capturePost(operation: AdvancedAnalysisOperation, body: unknown): Promise<unknown> {
  let posted: unknown;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(`/api/portfolio/advanced/${operation}`);
    expect(init?.method).toBe("POST");
    posted = JSON.parse(String(init?.body));
    return json({ result: { accepted: true } });
  }));
  await runAdvancedAnalysis({ operation, body });
  return posted;
}

afterEach(() => vi.unstubAllGlobals());

describe("strategy lab API request parity", () => {
  it("2단계 최적화와 Outlook에 알고리즘·기준 후보·그룹·강건 점수·ledger·국면 정책을 보낸다", async () => {
    const optimization = buildOptimizationRequest(baseConfig, {
      ...optimizationControls,
      baselines: [...optimizationControls.baselines],
    });
    expect(toolSchemas.optimize_portfolio.safeParse(optimization).success).toBe(true);
    expect(optimization).toMatchObject({
      algorithm: "nsga_ii",
      covarianceEstimator: "ledoit_wolf",
      baselines: ["equal_weight", "risk_parity", "hrp"],
      assetGroups: { AAA: { sector: "Technology", currency: "USD" } },
      groupConstraints: [{ dimension: "sector", group: "Technology", minWeight: 0.1, maxWeight: 0.6 }],
      robustScoreWeights: { sharpe: 0.4, oosAverageSharpe: 0.6 },
      robustValidation: {
        enabled: true,
        mode: "walk_forward",
        windowMode: "anchored",
        trainWindow: 252,
        testWindow: 63,
        step: 42,
        foldCount: 4,
        gap: 5,
        embargo: 7,
      },
      ledgerValidation: { budget: 16, quantityMode: "whole", lotSizes: { AAA: 2, BBB: 5 } },
      regimePolicySearch: { enabled: true, method: "mcts", baselineActions: ["equal_weight", "risk_parity", "hrp"] },
    });
    expect(await capturePost("optimization", optimization)).toMatchObject({ algorithm: "nsga_ii", ledgerValidation: { quantityMode: "whole" } });

    const outlook = {
      baseConfig: withQuantityMode(baseConfig, "whole"),
      optimization: buildOutlookOptimizationPayload({
        enabled: true,
        ...optimizationControls,
        baselines: [...optimizationControls.baselines],
      }),
      walkForward: buildWalkForwardPayload(walkForwardControls),
      monteCarlo: buildOutlookMonteCarloPayload(monteCarloControls),
      stressScenarios: [{ name: "기준 시나리오" }],
      sensitivity: { enabled: true, transactionCostShockBps: 30, includeZeroCashFlow: true, rebalanceModes: ["none", "annually"] },
      confidenceWeights: { oos: 0.45, monteCarloCalibration: 0.35, dataQuality: 0.2 },
    };
    expect(toolSchemas.analyze_portfolio_outlook.safeParse(outlook).success).toBe(true);
    expect(outlook).toMatchObject({
      baseConfig: { execution: { quantityMode: "whole" } },
      optimization: {
        baselines: ["equal_weight", "risk_parity", "hrp"],
        robustScoreWeights: { sharpe: 0.4, oosAverageSharpe: 0.6 },
        robustValidation: { enabled: true, mode: "walk_forward", windowMode: "anchored", foldCount: 4, gap: 5, embargo: 7 },
        ledgerValidationBudget: 16,
      },
      sensitivity: { transactionCostShockBps: 30, includeZeroCashFlow: true, rebalanceModes: ["none", "annually"] },
    });
    expect(await capturePost("outlook", outlook)).toMatchObject({
      baseConfig: { execution: { quantityMode: "whole" } },
      optimization: { baselines: ["equal_weight", "risk_parity", "hrp"] },
      sensitivity: { transactionCostShockBps: 30 },
    });
  });

  it("standalone Walk-forward POST body에 anchored·gap·embargo·fold 예산·중복 제거 seed 배열을 보낸다", async () => {
    const optimization = buildOptimizationRequest(baseConfig, { ...optimizationControls, baselines: [...optimizationControls.baselines] });
    const request = buildWalkForwardRequest(optimization, walkForwardControls);
    expect(toolSchemas.walk_forward_optimize.safeParse(request).success).toBe(true);
    const posted = await capturePost("walk-forward", request);
    expect(posted).toMatchObject({
      mode: "anchored",
      trainWindow: 252,
      testWindow: 63,
      step: 42,
      gap: 5,
      embargo: 7,
      foldCandidateBudget: 120,
      seeds: [12_345, 99],
    });
  });

  it("standalone Monte Carlo POST body에 방법·현금·비용·인출·물가·정수 lot·calibration을 보낸다", async () => {
    const request = buildMonteCarloRequest(baseConfig, monteCarloControls);
    expect(toolSchemas.simulate_portfolio_monte_carlo.safeParse(request).success).toBe(true);
    const posted = await capturePost("monte-carlo", request);
    expect(posted).toMatchObject({
      method: "regime_conditioned",
      rebalanceFrequency: "threshold",
      rebalanceThresholdPercent: 4,
      cashWeight: 0.1,
      cashAnnualYieldPercent: 2.5,
      transactionCostBps: 12,
      periodicCashFlow: -750_000,
      cashFlowFrequencyDays: 21,
      inflationAnnualPercent: 2.2,
      quantityMode: "whole",
      lotSizes: { AAA: 2, BBB: 5 },
      calibrationOrigins: 18,
    });
  });

  it("ETF 구성종목 JSON을 strict 계약으로 검증하고 look-through POST 입력으로 보존한다", async () => {
    const parsed = parseExposureConstituentsDraft('[{"symbol":"aapl","weight":0.7,"sector":"Technology","country":"US","currency":"usd","assetType":"STOCK","hedged":true,"factors":{"value":0.4}},{"symbol":"MSFT","weight":0.3}]');
    expect(parsed).toEqual({ value: [
      { symbol: "AAPL", weight: 0.7, sector: "Technology", country: "US", currency: "USD", assetType: "STOCK", hedged: true, factors: { value: 0.4 } },
      { symbol: "MSFT", weight: 0.3 },
    ] });
    expect(parseExposureConstituentsDraft('[{"symbol":"AAPL","weight":1,"bogus":1}]').error).toContain("지원하지 않는 필드");
    expect(parseExposureConstituentsDraft('[{"symbol":"AAPL","weight":0.7},{"symbol":"MSFT","weight":0.4}]').error).toContain("합계는 1을 초과");
    expect(parseExposureConstituentsDraft('[{"symbol":"AAPL","weight":1,"hedged":"yes"}]').error).toContain("boolean");
    const request = buildExposureAnalysisRequest([{
      symbol: "AAA",
      weight: 1,
      currency: "usd",
      assetType: "ETF",
      factors: { value: 0.2 },
      constituents: parsed.value,
    }], true);
    expect(toolSchemas.analyze_portfolio_exposures.safeParse(request).success).toBe(true);
    const posted = await capturePost("exposures", request) as { lookThrough: boolean; assets: Array<{ currency: string; constituents: unknown[] }> };
    expect(posted.lookThrough).toBe(true);
    expect(posted.assets[0].currency).toBe("USD");
    expect(posted.assets[0].constituents).toEqual(parsed.value);
  });

  it("강건 점수 JSON은 빈 객체 또는 0..1 양의 가중치만 허용한다", () => {
    expect(parseRobustScoreWeightsDraft("")).toEqual({ value: {} });
    expect(parseRobustScoreWeightsDraft('{"sharpe":0.4,"oosWorstSharpe":0.6}')).toEqual({ value: { sharpe: 0.4, oosWorstSharpe: 0.6 } });
    expect(parseRobustScoreWeightsDraft('{"sharpe":1.2}').error).toContain("0~1");
    expect(parseRobustScoreWeightsDraft('{"sharpe":0}').error).toContain("0보다 커야");
    expect(parseRobustScoreWeightsDraft('{"sharpTypo":0.5}').error).toContain("지원하지 않는");
  });
});
