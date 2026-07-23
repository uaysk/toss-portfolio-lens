import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_SIMULATION_REQUEST,
  aiSimulationErrorMessage,
  normalizeAiSimulationRun,
  normalizeAiSimulationSnapshot,
  normalizeAiSimulationStatus,
  validateAiSimulationRequest,
  type AiSimulationRequest,
} from "./ai-simulation";

describe("AI simulation request validation", () => {
  it("accepts both markets, all presets, and one or two AI-selected symbols", () => {
    for (const marketCountry of ["KR", "US"] as const) {
      for (const symbolCount of [1, 2] as const) {
        expect(validateAiSimulationRequest({
          ...DEFAULT_AI_SIMULATION_REQUEST,
          marketCountry,
          symbolCount,
        })).toEqual([]);
      }
    }
  });

  it("applies server-provided cash and duration limits without inventing values", () => {
    const limits = {
      minimumInitialCash: 100_000,
      maximumInitialCash: 20_000_000,
      minimumDurationMinutes: 15,
      maximumDurationMinutes: 240,
    };
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      durationMinutes: 15,
    }, limits)).toEqual([]);
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      initialCash: 50_000,
      durationMinutes: 241,
    }, limits)).toEqual([
      "예수금은 100000 이상이어야 합니다.",
      "테스트 기간은 240분 이하여야 합니다.",
    ]);
  });

  it("rejects unsupported modes, fractional periods, and invalid costs", () => {
    const invalid = {
      ...DEFAULT_AI_SIMULATION_REQUEST,
      marketCountry: "JP",
      criterion: "market_cap",
      durationMinutes: 12.5,
      symbolCount: 3,
      preset: "guaranteed_profit",
      costs: { ...DEFAULT_AI_SIMULATION_REQUEST.costs, slippageBpsPerSide: -1 },
    } as unknown as AiSimulationRequest;
    expect(validateAiSimulationRequest(invalid)).toEqual(expect.arrayContaining([
      "시장 선택이 올바르지 않습니다.",
      "종목 선정 기준이 올바르지 않습니다.",
      "AI 전략 프리셋이 올바르지 않습니다.",
      "테스트 기간은 1분 이상의 정수여야 합니다.",
      "AI 선정 종목 수는 1개 또는 2개여야 합니다.",
      "편도 슬리피지 bps는 0 이상의 숫자여야 합니다.",
    ]));
  });
});

describe("AI simulation response normalization", () => {
  it("reads nested runtime limits and preserves explicit disabled status", () => {
    expect(normalizeAiSimulationStatus({
      enabled: false,
      reason: "AI worker unavailable",
      limits: {
        initialCash: { min: 100_000, max: 50_000_000 },
        durationMinutes: { minimum: 10, maximum: 390 },
      },
      capabilities: { realOrders: false, mcp: false, symbolCountMaximum: 2 },
      policy: { decisionIntervalSeconds: 20 },
      limitations: ["실시간 데이터가 없으면 시작할 수 없습니다."],
    })).toEqual({
      enabled: false,
      message: "AI worker unavailable",
      decisionIntervalSeconds: 20,
      limits: {
        minimumInitialCash: 100_000,
        maximumInitialCash: 50_000_000,
        minimumDurationMinutes: 10,
        maximumDurationMinutes: 390,
      },
      capabilities: { realOrders: false, mcp: false, symbolCountMaximum: 2 },
      limitations: ["실시간 데이터가 없으면 시작할 수 없습니다."],
    });
  });

  it("normalizes a causal snapshot and drops incomplete ledger entries", () => {
    const snapshot = normalizeAiSimulationSnapshot({
      phase: "monitoring",
      startedAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-24T01:00:00.000Z",
      marketCountry: "US",
      currency: "USD",
      initialCash: 10_000,
      cash: 4_990,
      equity: 10_120,
      progress: 0.5,
      decisionIntervalSeconds: 20,
      selected: [
        {
          symbol: "NVDA",
          name: "NVIDIA",
          score: 0.82,
          upProbability: 0.61,
          predictedMedianReturn: 0.004,
          model: { modelId: "chronos", modelRevision: "pinned" },
        },
        { score: 1 },
      ],
      positions: [
        { symbol: "NVDA", quantity: 3, averagePrice: 170, marketPrice: 171, unrealizedPnl: 3 },
        { symbol: "BAD", averagePrice: 1 },
      ],
      trades: [
        { symbol: "NVDA", side: "buy", executedAt: "2026-07-24T00:02:00.000Z", price: 170, quantity: 3, amount: 510, cost: 0.4, source: "next_valid_quote" },
        { symbol: "BAD", side: "sell" },
      ],
      decisions: [
        { symbol: "NVDA", action: "buy", decidedAt: "2026-07-24T00:01:00.000Z", eligibleAfter: "2026-07-24T00:02:00.000Z", reason: "forecast_and_signal_aligned", model: "chronos" },
        { symbol: "BAD", action: "buy" },
      ],
      warnings: ["호가 unavailable 구간은 다음 확정 분봉을 사용했습니다."],
      capabilities: { realOrders: false },
    });

    expect(snapshot).toMatchObject({
      phase: "monitoring",
      currency: "USD",
      progress: 0.5,
      decisionIntervalSeconds: 20,
      selected: [{ symbol: "NVDA", model: "chronos · pinned" }],
      positions: [{ symbol: "NVDA", quantity: 3 }],
      trades: [{ symbol: "NVDA", source: "next_valid_quote" }],
      decisions: [{ symbol: "NVDA", eligibleAfter: "2026-07-24T00:02:00.000Z" }],
      capabilities: { realOrders: false },
    });
    expect(snapshot.selected).toHaveLength(1);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.decisions).toHaveLength(1);
  });

  it("unwraps start and status responses and keeps errors explicit", () => {
    expect(normalizeAiSimulationRun({
      run: { id: "simulation-1", status: "running" },
      snapshot: {
        phase: "monitoring",
        currency: "KRW",
        initialCash: 1_000_000,
        cash: 1_000_000,
        equity: 1_000_000,
        progress: 0.1,
      },
    })).toMatchObject({
      runId: "simulation-1",
      status: "running",
      snapshot: { phase: "monitoring", currency: "KRW" },
    });
    expect(aiSimulationErrorMessage({ error: { message: "기간이 올바르지 않습니다." } }, "fallback"))
      .toBe("기간이 올바르지 않습니다.");
  });
});
