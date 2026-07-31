import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_SIMULATION_REQUEST,
  aiSimulationErrorMessage,
  normalizeAiSimulationHistory,
  normalizeAiSimulationReport,
  normalizeAiSimulationRun,
  normalizeAiSimulationSnapshot,
  normalizeAiSimulationStatus,
  validateAiSimulationRequest,
  type AiSimulationRequest,
} from "./ai-simulation";

describe("AI simulation v9 request validation", () => {
  it("builds only the strict US ETF pair wire shape", () => {
    expect(DEFAULT_AI_SIMULATION_REQUEST).toMatchObject({
      contractVersion: "ai-paper-simulation/v9",
      simulationCase: "us_etf_pair",
      market: { kind: "stock", country: "US" },
      strategy: {
        mode: "pair",
        pairId: "qqq-tqqq-sqqq",
        allowDegradedMode: false,
      },
      execution: { mode: "paper" },
    });
    expect(DEFAULT_AI_SIMULATION_REQUEST).not.toHaveProperty("marketCountry");
    expect(DEFAULT_AI_SIMULATION_REQUEST).not.toHaveProperty("modelLanes");
    expect(DEFAULT_AI_SIMULATION_REQUEST).not.toHaveProperty("modelPlan");
    expect(validateAiSimulationRequest(DEFAULT_AI_SIMULATION_REQUEST)).toEqual([]);
  });

  it("fails closed for old contracts, noncanonical markets, and degraded pair mode", () => {
    const invalid = {
      ...DEFAULT_AI_SIMULATION_REQUEST,
      contractVersion: "ai-paper-simulation/v8",
      market: { kind: "stock", country: "KR" },
      strategy: {
        mode: "pair",
        pairId: "qqq-tqqq-sqqq",
        allowDegradedMode: true,
      },
    } as unknown as AiSimulationRequest;
    expect(validateAiSimulationRequest(invalid)).toEqual(expect.arrayContaining([
      "ai-paper-simulation/v9 계약만 지원합니다.",
      "미국 ETF 페어 시장만 지원합니다.",
      "페어 전략은 degraded 실행을 허용하지 않습니다.",
    ]));
  });

  it("applies server-provided monetary and duration limits", () => {
    expect(validateAiSimulationRequest({
      ...DEFAULT_AI_SIMULATION_REQUEST,
      initialCash: 50_000,
      durationMinutes: 241,
    }, {
      minimumInitialCash: 100_000,
      maximumDurationMinutes: 240,
    })).toEqual(expect.arrayContaining([
      "예수금은 100000 이상이어야 합니다.",
      "테스트 기간은 240분 이하여야 합니다.",
    ]));
  });
});

describe("AI simulation v9 response normalization", () => {
  it("normalizes status and pair catalog capability", () => {
    const status = normalizeAiSimulationStatus({
      enabled: true,
      limits: {
        minimumInitialCash: 100_000,
        maximumDurationMinutes: 240,
      },
      pairStrategy: {
        enabled: true,
        catalogVersion: "scalping-pair-catalog/v4",
        pairs: [{
          pairId: "qqq-tqqq-sqqq",
          displaySignalSymbol: "QQQ",
          modelTargetSymbol: "QQQ",
          auxiliarySymbols: [],
          bull: { executionSymbol: "TQQQ", leverageMultiplier: 3 },
          bear: { executionSymbol: "SQQQ", leverageMultiplier: -3 },
        }],
      },
    });
    expect(status.enabled).toBe(true);
    expect(status.limits.maximumDurationMinutes).toBe(240);
    expect(status.pairStrategy?.catalog[0]).toMatchObject({
      id: "qqq-tqqq-sqqq",
      displaySignalSymbol: "QQQ",
      modelTargetSymbol: "QQQ",
    });
  });

  it("fails closed for an obsolete pair catalog or signal-symbol alias", () => {
    const obsolete = normalizeAiSimulationStatus({
      enabled: true,
      pairStrategy: {
        enabled: true,
        catalogVersion: "scalping-pair-catalog/v2",
        pairs: [{
          pairId: "qqq-tqqq-sqqq",
          signalSymbol: "QQQ",
          bull: { executionSymbol: "TQQQ" },
          bear: { executionSymbol: "SQQQ" },
        }],
      },
    });
    expect(obsolete.pairStrategy).toMatchObject({
      enabled: false,
      catalogVersion: "scalping-pair-catalog/v4",
      catalog: [],
    });
  });

  it("does not promote the removed flat AI telemetry shape into crypto status", () => {
    const status = normalizeAiSimulationStatus({
      enabled: true,
      credentialsConfigured: true,
      signedReadSucceeded: true,
      paperEnabled: true,
      modelWorkers: {
        chronos2: {
          status: "ready",
          available: true,
          peak_vram_mb: 6_000,
        },
      },
    });
    expect(status.cryptoFutures).toBeUndefined();
  });

  it("normalizes canonical market, resolved plan, and both model forecasts", () => {
    const snapshot = normalizeAiSimulationSnapshot({
      phase: "running",
      market: { kind: "stock", country: "US" },
      simulationCase: "us_etf_pair",
      currency: "USD",
      initialCash: 100_000,
      cash: 90_000,
      equity: 101_000,
      progress: 0.5,
      selection: { mode: "auto", criterion: "trading_amount", symbolCount: 1 },
      strategy: {
        mode: "pair",
        pairId: "qqq-tqqq-sqqq",
        allowDegradedMode: false,
      },
      resolvedModelPlan: [{
        symbol: "*",
        modelLane: "chronos2",
        role: "primary",
        required: true,
        preferredHorizonsMinutes: [15, 30, 60],
      }, {
        symbol: "*",
        modelLane: "fincast",
        role: "shadow",
        required: false,
        preferredHorizonsMinutes: [15, 30, 60],
      }],
      selected: [],
      positions: [],
      charts: [],
      trades: [],
      decisions: [],
      modelForecasts: [{
        lane: "chronos2",
        signalSymbol: "QQQ",
        status: "available",
        origin: "2026-07-31T14:00:00.000Z",
        projectionPolicy: "native_input_origin",
        modelId: "amazon/chronos-2",
        points: [{
          horizonMinutes: 15,
          targetTimestamp: "2026-07-31T14:15:00.000Z",
          q10Price: 99,
          medianPrice: 100,
          q90Price: 101,
        }],
      }, {
        lane: "fincast",
        signalSymbol: "QQQ",
        status: "unavailable",
        projectionPolicy: "native_input_origin",
        modelId: "Vincent05R/FinCast",
        points: [],
        unavailableReason: "shadow unavailable",
      }],
      warnings: [],
      capabilities: {},
      modelLanes: ["chronos2", "fincast"],
      execution: { mode: "paper" },
    });
    expect(snapshot.simulationCase).toBe("us_etf_pair");
    expect(snapshot.resolvedModelPlan).toHaveLength(2);
    expect(snapshot.modelForecasts.map(({ lane }) => lane)).toEqual([
      "chronos2",
      "fincast",
    ]);
    expect(snapshot).not.toHaveProperty("kronosForecasts");
  });

  it("unwraps run envelopes and keeps errors explicit", () => {
    expect(normalizeAiSimulationRun({
      run: { id: "run-1", status: "queued" },
    })).toEqual({ runId: "run-1", status: "queued" });
    expect(aiSimulationErrorMessage({
      error: {
        message: "invalid request",
        issues: [{ message: "contractVersion is required" }],
      },
    }, "fallback")).toBe("invalid request · contractVersion is required");
  });

  it("normalizes durable history without requiring a live snapshot", () => {
    const page = normalizeAiSimulationHistory({
      items: [{
        runId: "run-1",
        status: "completed",
        market: { kind: "stock", country: "US" },
        currency: "USD",
        selected: [{ symbol: "QQQ" }],
        warnings: [],
      }],
      nextCursor: "next",
    });
    expect(page.nextCursor).toBe("next");
    expect(page.items[0]).toMatchObject({
      runId: "run-1",
      market: { kind: "stock", country: "US" },
    });
  });

  it("normalizes a canonical report and rejects removed model identities", () => {
    const report = normalizeAiSimulationReport({
      run: { id: "run-1", status: "completed" },
      report: {
        configuration: {
          market: { kind: "stock", country: "US" },
          initialCash: 100_000,
          selection: { mode: "auto", criterion: "trading_amount", symbolCount: 1 },
          strategy: {
            mode: "pair",
            pairId: "qqq-tqqq-sqqq",
            allowDegradedMode: false,
          },
          execution: { mode: "paper" },
        },
        performance: {
          currency: "USD",
          finalEquity: 101_000,
        },
        selected: [{ symbol: "QQQ" }],
        decisions: [],
        trades: [],
        positions: [],
        charts: [],
        modelForecasts: [],
        warnings: [],
      },
    });
    expect(report).toMatchObject({
      runId: "run-1",
      status: "completed",
      performance: {
        currency: "USD",
        finalEquity: 101_000,
      },
      modelForecasts: [],
    });
  });
});
