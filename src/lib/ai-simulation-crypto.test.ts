import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
  normalizeAiSimulationCandidates,
  normalizeAiSimulationCryptoStatus,
  normalizeAiSimulationFuturesPositions,
  normalizeAiSimulationFuturesRisk,
  normalizeAiSimulationMarket,
  normalizeAiSimulationModelComparison,
  validateAiSimulationCryptoRequest,
} from "@/lib/ai-simulation";

describe("ai simulation v9 crypto contract", () => {
  it("normalizes only discriminated stock and Binance USD-M markets", () => {
    expect(normalizeAiSimulationMarket(undefined)).toBeUndefined();
    expect(normalizeAiSimulationMarket({ kind: "stock", country: "KR" }))
      .toEqual({ kind: "stock", country: "KR" });
    expect(normalizeAiSimulationMarket({
      kind: "crypto_futures",
      venue: "BINANCE_USDM",
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
    })).toEqual({
      kind: "crypto_futures",
      venue: "BINANCE_USDM",
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
    });
  });

  it("accepts the exact Binance scanner contract without percent inflation", () => {
    const result = normalizeAiSimulationCandidates({
      snapshotId: "scanner-1",
      criterion: "volatility",
      evidence: [{ summary: "finalized bars only" }],
      candidates: [{
        symbol: "BTCUSDT",
        price: 67_418,
        quoteVolume: 1_626_000_000,
        spreadBps: 0.8,
        realizedVolatility60m: 0.018,
        priceChangePercent24h: 5,
        atrPercent14: 0.012,
        volatilityScore: 0.91,
        scoreComponents: { realizedVolatility60m: 0.5 },
        eligible: true,
        dataQuality: {
          status: "complete",
          finalBars: 1024,
          missingFields: ["markPrice"],
          observedAt: "2026-07-24T00:24:00.000Z",
        },
      }],
    });
    expect(result.snapshotId).toBe("scanner-1");
    expect(result.warnings).toContain("finalized bars only");
    expect(result.candidates[0]).toMatchObject({
      symbol: "BTCUSDT",
      currentPrice: 67_418,
      tradingAmount: 1_626_000_000,
      volatility24h: 0.05,
      atrPercent: 0.012,
      quality: {
        status: "complete",
        finalBars: 1024,
        missing: ["markPrice"],
      },
    });
  });

  it("exposes only boolean/enum worker status and keeps live closed", () => {
    expect(normalizeAiSimulationCryptoStatus({
      cryptoFutures: {
        schemaVersion: "ai-paper-simulation/v9",
        credentials: { configured: true, signedReadSucceeded: true },
        executionGates: { paper: true, testnet: false, live: false },
        workers: {
          chronos2: { status: "healthy", precision: "fp32" },
          fincast: { status: "memory_pressure", precision: "fp16" },
        },
      },
    })).toEqual({
      credentialsConfigured: true,
      signedReadSucceeded: true,
      executionGates: { paper: true, testnet: false, live: false },
      workers: {
        chronos2: {
          lane: "chronos2",
          status: "healthy",
          available: true,
          precision: "fp32",
        },
        fincast: {
          lane: "fincast",
          status: "memory_pressure",
          available: false,
          precision: "fp16",
        },
      },
    });
  });

  it("fails old detailed AI worker telemetry and missing v9 status versions closed", () => {
    expect(normalizeAiSimulationCryptoStatus({
      cryptoFutures: {
        schemaVersion: "ai-paper-simulation/v9",
        credentials: { configured: true, signedReadSucceeded: true },
        executionGates: { paper: true, testnet: false, live: false },
        workers: {
          chronos2: {
            status: "ready",
            available: true,
            precision: "float32",
            model_id: "amazon/chronos-2",
            peak_vram_mb: 6_000,
          },
        },
      },
    })).toMatchObject({
      workers: {
        chronos2: {
          status: "unavailable",
          available: false,
          precision: "unknown",
          reason: "unsupported_worker_telemetry_contract",
        },
      },
    });
    expect(normalizeAiSimulationCryptoStatus({
      credentialsConfigured: true,
      signedReadSucceeded: true,
      paperEnabled: true,
      workers: {
        chronos2: { status: "ready", available: true },
      },
    })).toEqual({
      credentialsConfigured: false,
      signedReadSucceeded: false,
      executionGates: { paper: false, testnet: false, live: false },
      workers: {},
    });
  });

  it("normalizes long/short futures ledger and independent model lanes", () => {
    expect(normalizeAiSimulationFuturesPositions([{
      symbol: "ethusdt",
      positionSide: "SHORT",
      positionAmount: "0.5",
      averagePrice: "3470",
      leverage: "4",
      liquidationPrice: "4220",
    }])[0]).toMatchObject({
      symbol: "ETHUSDT",
      side: "short",
      marginMode: "isolated",
      quantity: 0.5,
      leverage: 4,
    });
    const comparison = normalizeAiSimulationModelComparison({
      outcome: "inconclusive",
      same_origin: true,
      same_context: true,
      same_costs: true,
      same_fill_barrier: true,
      models: {
        chronos2: { status: "complete", dtype: "float32", pinball_loss: 0.01 },
        fincast: {
          status: "complete",
          dtype: "float16",
          pinball_loss: 0.009,
          provenance: {
            model_id: "Vincent05R/FinCast",
            model_revision: "fincast-revision",
            source_revision: "source-sha",
            loader_version: "loader-v1",
            loaded: true,
            device: "cuda:0",
            device_name: "Tesla P40",
            precision_validation: "passed",
            memory_status: "ok",
            peak_vram_mb: 4_920,
            precision_failure_reasons: [],
          },
        },
      },
    });
    expect(comparison?.lanes.map(({ id, precision }) => [id, precision])).toEqual([
      ["chronos2", "fp32"],
      ["fincast", "fp16"],
    ]);
    expect(comparison?.lanes[1]).toMatchObject({
      provenance: {
        modelId: "Vincent05R/FinCast",
        modelRevision: "fincast-revision",
        sourceRevision: "source-sha",
        loaderVersion: "loader-v1",
        loaded: true,
        device: "cuda:0",
        deviceName: "Tesla P40",
        precisionValidation: "passed",
        memoryStatus: "ok",
        peakVramMb: 4_920,
        precisionFailureReasons: [],
      },
    });
    expect(normalizeAiSimulationFuturesRisk({
      riskPerTradeRatio: 0.008,
      dailyLossLimitRatio: 0.05,
      grossExposureRatio: 0.4,
      grossExposureLimitRatio: 1.2,
      marginUsageRatio: 0.1,
      marginUsageLimitRatio: 0.3,
      maximumLeverage: 12,
      liquidationBufferMultiple: 2.5,
    })).toMatchObject({
      riskPerTradeRatio: 0.008,
      dailyLossLimitRatio: 0.05,
      grossExposureLimitRatio: 1.2,
      marginUsageLimitRatio: 0.3,
      maximumLeverage: 12,
      liquidationBufferMultiple: 2.5,
    });
  });

  it("uses strict v9 requests and allows paper only", () => {
    expect(DEFAULT_AI_SIMULATION_CRYPTO_REQUEST.contractVersion).toBe("ai-paper-simulation/v9");
    expect(validateAiSimulationCryptoRequest(DEFAULT_AI_SIMULATION_CRYPTO_REQUEST)).toEqual([]);
    expect(validateAiSimulationCryptoRequest({
      ...DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
      execution: { mode: "live" as "paper" },
    })).toContain("현재 운영에서는 paper 실행만 허용됩니다.");
  });

  it("matches the server cash hard caps and applies the advertised duration cap", () => {
    expect(validateAiSimulationCryptoRequest({
      ...DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
      initialCash: 99,
      durationMinutes: 391,
    }, {
      maximumDurationMinutes: 390,
    })).toEqual(expect.arrayContaining([
      "시작 USDT는 100 이상이어야 합니다.",
      "테스트 기간은 390분 이하여야 합니다.",
    ]));
    expect(validateAiSimulationCryptoRequest({
      ...DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
      initialCash: 100_000_001,
    })).toContain("시작 USDT는 100000000 이하여야 합니다.");
    expect(validateAiSimulationCryptoRequest({
      ...DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
      initialCash: 100,
      durationMinutes: 390,
    }, {
      maximumDurationMinutes: 390,
    })).toEqual([]);
  });

  it("rejects risk overrides outside the backend hard safety envelope", () => {
    const issues = validateAiSimulationCryptoRequest({
      ...DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
      riskLimits: {
        riskPerTradeRate: 0.006,
        dailyLossLimitRate: 0.035,
        maximumLeverage: 15,
        grossExposureLimitRate: 1.55,
        marginUsageLimitRate: 1.01,
        liquidationBufferMultiple: 1.75,
      },
    });
    expect(issues).toEqual(expect.arrayContaining([
      "거래당 위험 값은 0.001~0.005 범위여야 합니다.",
      "UTC 일손실 중단선 값은 0.005~0.03 범위여야 합니다.",
      "gross exposure 상한 값은 0.1~1.5 범위여야 합니다.",
      "증거금 사용률 상한 값은 0.05~1 범위여야 합니다.",
      "청산 buffer 배수 값은 2~5 범위여야 합니다.",
    ]));
  });

  it("accepts a 100% paper margin usage ceiling while keeping the default at 20%", () => {
    expect(DEFAULT_AI_SIMULATION_CRYPTO_REQUEST.riskLimits.marginUsageLimitRate).toBe(0.2);
    expect(validateAiSimulationCryptoRequest({
      ...DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
      riskLimits: {
        ...DEFAULT_AI_SIMULATION_CRYPTO_REQUEST.riskLimits,
        marginUsageLimitRate: 1,
      },
    })).toEqual([]);
  });
});
