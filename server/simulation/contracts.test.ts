import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIMULATION_COSTS,
  createSimulationStartRequestSchema,
} from "./contracts.js";

describe("AI paper simulation contracts", () => {
  const schema = createSimulationStartRequestSchema({ maxDurationMinutes: 390 });

  it("applies explicit market, scanner, strategy, and cost defaults", () => {
    expect(schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      symbolCount: 1,
    })).toEqual({
      marketCountry: "KR",
      criterion: "trading_amount",
      initialCash: 1_000_000,
      durationMinutes: 60,
      symbolCount: 1,
      preset: "risk_management",
      costs: DEFAULT_SIMULATION_COSTS,
    });
  });

  it("accepts both markets, all scanner criteria and one or two symbols", () => {
    expect(schema.parse({
      marketCountry: "US",
      criterion: "volatility",
      initialCash: 10_000_000,
      durationMinutes: 390,
      symbolCount: 2,
      preset: "breakout",
      costs: {
        commissionBpsPerSide: 0,
        taxBpsOnExit: 0,
        spreadBpsRoundTrip: 12,
        slippageBpsPerSide: 3,
      },
    })).toMatchObject({
      marketCountry: "US",
      criterion: "volatility",
      symbolCount: 2,
      preset: "breakout",
    });
  });

  it("defaults omitted US exit tax to zero while preserving explicit overrides", () => {
    expect(schema.parse({
      marketCountry: "US",
      initialCash: 100_000,
      durationMinutes: 60,
      symbolCount: 1,
    }).costs).toEqual({
      ...DEFAULT_SIMULATION_COSTS,
      taxBpsOnExit: 0,
    });
    expect(schema.parse({
      marketCountry: "US",
      initialCash: 100_000,
      durationMinutes: 60,
      symbolCount: 1,
      costs: { taxBpsOnExit: 7 },
    }).costs.taxBpsOnExit).toBe(7);
  });

  it("rejects missing core values, unknown keys, non-finite values and configured limit violations", () => {
    expect(() => schema.parse({ durationMinutes: 60, symbolCount: 1 })).toThrow();
    expect(() => schema.parse({ initialCash: 1_000_000, symbolCount: 1 })).toThrow();
    expect(() => schema.parse({ initialCash: 1_000_000, durationMinutes: 60 })).toThrow();
    expect(() => schema.parse({
      initialCash: Number.POSITIVE_INFINITY,
      durationMinutes: 60,
      symbolCount: 1,
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 391,
      symbolCount: 1,
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      symbolCount: 3,
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      symbolCount: 1,
      autoOrder: true,
    })).toThrow();
  });

  it("enforces strict bounded cost assumptions while defaulting omitted cost fields", () => {
    expect(schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      symbolCount: 1,
      costs: { spreadBpsRoundTrip: 10 },
    }).costs).toEqual({
      ...DEFAULT_SIMULATION_COSTS,
      spreadBpsRoundTrip: 10,
    });
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      symbolCount: 1,
      costs: { spreadBpsRoundTrip: 5_001 },
    })).toThrow();
    expect(() => schema.parse({
      initialCash: 1_000_000,
      durationMinutes: 60,
      symbolCount: 1,
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
