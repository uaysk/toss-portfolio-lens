import { describe, expect, it } from "vitest";
import {
  AI_SIMULATION_CONTRACT_VERSION,
  DEFAULT_SIMULATION_COSTS,
  createSimulationStartRequestSchema,
} from "./contracts.js";

describe("AI paper simulation contracts", () => {
  const schema = createSimulationStartRequestSchema({ maxDurationMinutes: 390 });

  it("publishes the normalized stock and crypto contract as v7", () => {
    expect(AI_SIMULATION_CONTRACT_VERSION).toBe("ai-paper-simulation/v7");
  });

  it("applies market, strategy, risk, scanner, and cost defaults", () => {
    expect(schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
    })).toEqual({
      marketCountry: "KR",
      market: { kind: "stock", country: "KR" },
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: {
        mode: "auto",
        criterion: "trading_amount",
        symbolCount: 1,
      },
      preset: "risk_management",
      riskTolerance: 50,
      costs: DEFAULT_SIMULATION_COSTS,
      modelLanes: ["kronos_base"],
      execution: { mode: "paper" },
    });
  });

  it("normalizes Binance USDT perpetual requests and keeps legacy stock state off the wire", () => {
    const parsed = schema.parse({
      market: {
        kind: "crypto_futures",
        venue: "BINANCE_USDM",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
      },
      initialCash: 10_000,
      durationMinutes: 120,
      selection: { mode: "auto", criterion: "volatility", symbolCount: 1 },
      modelLanes: ["kronos_base", "fincast"],
      execution: { mode: "paper" },
    });
    expect(parsed.market.kind).toBe("crypto_futures");
    expect(parsed.costs).toEqual({
      commissionBpsPerSide: 4,
      taxBpsOnExit: 0,
      spreadBpsRoundTrip: 2,
      slippageBpsPerSide: 1,
    });
    expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty("marketCountry");
    expect(() => schema.parse({
      market: {
        kind: "crypto_futures",
        venue: "BINANCE_USDM",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
      },
      initialCash: 10_000,
      durationMinutes: 120,
      selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
    })).toThrow();
    expect(() => schema.parse({
      market: {
        kind: "crypto_futures",
        venue: "BINANCE_USDM",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
      },
      initialCash: 10_000,
      durationMinutes: 120,
      selection: { mode: "auto", criterion: "volatility", symbolCount: 1 },
      execution: { mode: "live" },
    })).toThrow();
  });

  it("accepts both markets, every scanner criterion, one or two auto symbols, and risk endpoints", () => {
    expect(schema.parse({
      marketCountry: "US",
      initialCash: 10_000_000,
      durationMinutes: 390,
      selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
      preset: "breakout",
      riskTolerance: 100,
      costs: {
        commissionBpsPerSide: 0,
        taxBpsOnExit: 0,
        spreadBpsRoundTrip: 12,
        slippageBpsPerSide: 3,
      },
    })).toMatchObject({
      marketCountry: "US",
      selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
      preset: "breakout",
      riskTolerance: 100,
    });
    expect(schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 1,
      selection: { mode: "auto", criterion: "volume", symbolCount: 1 },
      preset: "trend",
      riskTolerance: 0,
    })).toMatchObject({
      selection: { criterion: "volume", symbolCount: 1 },
      riskTolerance: 0,
    });
  });

  it("accepts a strict US pair strategy while keeping omitted strategy backward compatible", () => {
    expect(schema.parse({
      marketCountry: "US",
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["TSLA"] },
      strategy: {
        mode: "pair",
        pairId: "tsla-tsll-tslq",
      },
    })).toMatchObject({
      marketCountry: "US",
      strategy: {
        mode: "pair",
        pairId: "tsla-tsll-tslq",
        allowDegradedMode: false,
      },
    });

    expect(schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
    })).not.toHaveProperty("strategy");
  });

  it("rejects pair strategies outside the US, unknown catalog ids, and mixed strategy fields", () => {
    expect(() => schema.parse({
      marketCountry: "KR",
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["005930"] },
      strategy: {
        mode: "pair",
        pairId: "soxx-soxl-soxs",
        allowDegradedMode: false,
      },
    })).toThrow();
    expect(() => schema.parse({
      marketCountry: "US",
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["SOXX"] },
      strategy: {
        mode: "pair",
        pairId: "unknown-pair",
      },
    })).toThrow();
    expect(() => schema.parse({
      marketCountry: "US",
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["SOXX"] },
      strategy: {
        mode: "single",
        pairId: "soxx-soxl-soxs",
      },
    })).toThrow();
    expect(() => schema.parse({
      marketCountry: "US",
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["TSLA"] },
      strategy: {
        mode: "pair",
        pairId: "tsla-tsll-tslq",
        allowDegradedMode: true,
      },
    })).toThrow();
  });

  it("normalizes one or two manually selected symbols and rejects duplicates after normalization", () => {
    expect(schema.parse({
      marketCountry: "US",
      initialCash: 100_000,
      durationMinutes: 30,
      selection: { mode: "manual", symbols: [" nvda ", "brk.b"] },
    }).selection).toEqual({
      mode: "manual",
      symbols: ["NVDA", "BRK.B"],
    });
    expect(schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 30,
      selection: { mode: "manual", symbols: ["005930"] },
    }).selection).toEqual({
      mode: "manual",
      symbols: ["005930"],
    });
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 30,
      selection: { mode: "manual", symbols: ["nvda", " NVDA "] },
    })).toThrow();
  });

  it("applies Toss US commission and tax defaults while preserving explicit overrides", () => {
    expect(schema.parse({
      marketCountry: "US",
      initialCash: 100_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["AAPL"] },
    }).costs).toEqual({
      commissionBpsPerSide: 10,
      taxBpsOnExit: 0,
      spreadBpsRoundTrip: 5,
      slippageBpsPerSide: 2,
    });
    expect(schema.parse({
      marketCountry: "US",
      initialCash: 100_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
      costs: { taxBpsOnExit: 7 },
    }).costs.taxBpsOnExit).toBe(7);
  });

  it("strictly discriminates auto and manual selection without accepting mixed or legacy fields", () => {
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1, symbols: ["AAA"] },
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["AAA"], criterion: "volume" },
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: [] },
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["AAA", "BBB", "CCC"] },
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      criterion: "volume",
      symbolCount: 1,
    })).toThrow();
  });

  it("rejects missing core values, invalid risk, symbols, non-finite values and duration limits", () => {
    expect(() => schema.parse({
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      selection: { mode: "auto", symbolCount: 1 },
    })).toThrow();
    expect(() => schema.parse({ initialCash: 1_000_000, durationMinutes: 60 })).toThrow();
    expect(() => schema.parse({
      initialCash: Number.POSITIVE_INFINITY,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 391,
      selection: { mode: "auto", symbolCount: 1 },
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
      riskTolerance: 101,
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
      riskTolerance: 49.5,
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["-BAD"] },
      autoOrder: true,
    })).toThrow();
  });

  it("enforces strict bounded cost assumptions while defaulting omitted cost fields", () => {
    expect(schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
      costs: { spreadBpsRoundTrip: 10 },
    }).costs).toEqual({
      ...DEFAULT_SIMULATION_COSTS,
      spreadBpsRoundTrip: 10,
    });
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
      costs: { spreadBpsRoundTrip: 5_001 },
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
      costs: { commissionBpsPerSide: 1, hiddenFee: 1 },
    })).toThrow();
  });

  it("rejects invalid configured duration limits", () => {
    expect(() => createSimulationStartRequestSchema({ maxDurationMinutes: 0 })).toThrow(
      "positive safe integer",
    );
    expect(() => createSimulationStartRequestSchema({ maxDurationMinutes: 1.5 })).toThrow(
      "positive safe integer",
    );
  });
});
