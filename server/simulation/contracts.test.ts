import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIMULATION_COSTS,
  createSimulationStartRequestSchema,
} from "./contracts.js";

describe("AI paper simulation contracts", () => {
  const schema = createSimulationStartRequestSchema({ maxDurationMinutes: 390 });

  it("applies market, strategy, risk, scanner, and cost defaults", () => {
    expect(schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      selection: { mode: "auto", symbolCount: 1 },
    })).toEqual({
      marketCountry: "KR",
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
    });
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

  it("defaults omitted US exit tax to zero while preserving explicit overrides", () => {
    expect(schema.parse({
      marketCountry: "US",
      initialCash: 100_000,
      durationMinutes: 60,
      selection: { mode: "manual", symbols: ["AAPL"] },
    }).costs).toEqual({
      ...DEFAULT_SIMULATION_COSTS,
      taxBpsOnExit: 0,
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
