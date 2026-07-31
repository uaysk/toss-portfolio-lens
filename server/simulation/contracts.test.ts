import { describe, expect, it } from "vitest";
import {
  AI_SIMULATION_CONTRACT_VERSION,
  DEFAULT_CRYPTO_FUTURES_RISK_LIMITS,
  createSimulationStartRequestSchema,
} from "./contracts.js";

const schema = createSimulationStartRequestSchema({ maxDurationMinutes: 390 });
const cryptoMarket = {
  kind: "crypto_futures" as const,
  venue: "BINANCE_USDM" as const,
  quoteAsset: "USDT" as const,
  contractType: "PERPETUAL" as const,
};

const cryptoBase = {
  contractVersion: "ai-paper-simulation/v9" as const,
  market: cryptoMarket,
  initialCash: 10_000,
  durationMinutes: 60,
  strategy: { mode: "single" as const },
  execution: { mode: "paper" as const },
};

describe("AI paper simulation v9 contract", () => {
  it("publishes only v9", () => {
    expect(AI_SIMULATION_CONTRACT_VERSION).toBe("ai-paper-simulation/v9");
    for (const contractVersion of [undefined, "ai-paper-simulation/v7", "ai-paper-simulation/v8"]) {
      expect(() => schema.parse({
        ...cryptoBase,
        contractVersion,
        simulationCase: "btc_eth",
        selection: { mode: "manual", symbols: ["BTCUSDT"] },
      })).toThrow();
    }
  });

  it("rejects removed request compatibility fields", () => {
    const canonical = {
      ...cryptoBase,
      simulationCase: "btc_eth" as const,
      selection: { mode: "manual" as const, symbols: ["BTCUSDT"] as const },
    };
    for (const removed of [
      { marketCountry: "US" },
      { sourceContractVersion: "ai-paper-simulation/v8" },
      { modelLanes: ["chronos2"] },
      { modelPlan: [] },
    ]) {
      expect(() => schema.parse({ ...canonical, ...removed })).toThrow();
    }
  });

  it("resolves the canonical BTC·ETH plan on the server", () => {
    const parsed = schema.parse({
      ...cryptoBase,
      simulationCase: "btc_eth",
      selection: { mode: "manual", symbols: ["BTCUSDT", "ETHUSDT"] },
    });
    expect(parsed.modelLanes).toEqual(["chronos2", "fincast"]);
    expect(parsed.resolvedModelPlan).toEqual([
      expect.objectContaining({
        symbol: "BTCUSDT",
        modelLane: "chronos2",
        role: "primary",
        required: true,
      }),
      expect.objectContaining({
        symbol: "BTCUSDT",
        modelLane: "fincast",
        role: "veto",
        required: true,
      }),
      expect.objectContaining({
        symbol: "ETHUSDT",
        modelLane: "fincast",
        role: "primary",
        required: true,
      }),
      expect.objectContaining({
        symbol: "ETHUSDT",
        modelLane: "chronos2",
        role: "shadow",
        required: false,
      }),
    ]);
  });

  it("resolves high-volatility scanner and model defaults", () => {
    const parsed = schema.parse({
      ...cryptoBase,
      simulationCase: "high_vol_crypto",
      selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
    });
    expect(parsed.scanner).toMatchObject({
      symbolCount: 2,
      minimumListingDays: 90,
      minimumTradingAmountUsd: 25_000_000,
      maximumSpreadBps: 12,
    });
    expect(parsed.riskLimits).toEqual(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS);
    expect(parsed.resolvedModelPlan.map(({ modelLane, role }) => ({ modelLane, role })))
      .toEqual([
        { modelLane: "chronos2", role: "primary" },
        { modelLane: "fincast", role: "veto" },
      ]);
  });

  it("resolves the US ETF pair plan", () => {
    const parsed = schema.parse({
      contractVersion: "ai-paper-simulation/v9",
      simulationCase: "us_etf_pair",
      market: { kind: "stock", country: "US" },
      initialCash: 100_000,
      durationMinutes: 60,
      selection: { mode: "auto", criterion: "trading_amount", symbolCount: 1 },
      strategy: {
        mode: "pair",
        pairId: "qqq-tqqq-sqqq",
        allowDegradedMode: false,
      },
      execution: { mode: "paper" },
    });
    expect(parsed.resolvedModelPlan.map(({ modelLane, role, required }) => ({
      modelLane,
      role,
      required,
    }))).toEqual([
      { modelLane: "chronos2", role: "primary", required: true },
      { modelLane: "fincast", role: "shadow", required: false },
    ]);
    expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty("marketCountry");
  });

  it("rejects mismatched cases, markets, selection modes, and non-paper execution", () => {
    expect(() => schema.parse({
      ...cryptoBase,
      simulationCase: "btc_eth",
      selection: { mode: "auto", criterion: "volatility", symbolCount: 1 },
    })).toThrow("simulationCase");
    expect(() => schema.parse({
      ...cryptoBase,
      simulationCase: "high_vol_crypto",
      selection: { mode: "manual", symbols: ["SOLUSDT"] },
    })).toThrow();
    expect(() => schema.parse({
      ...cryptoBase,
      simulationCase: "btc_eth",
      selection: { mode: "manual", symbols: ["BTCUSDT"] },
      execution: { mode: "live" },
    })).toThrow();
  });

  it("enforces crypto cash, duration, and risk limits", () => {
    expect(() => schema.parse({
      ...cryptoBase,
      simulationCase: "btc_eth",
      initialCash: 100_000_001,
      selection: { mode: "manual", symbols: ["BTCUSDT"] },
    })).toThrow("100,000,000");
    expect(() => schema.parse({
      ...cryptoBase,
      simulationCase: "btc_eth",
      durationMinutes: 391,
      selection: { mode: "manual", symbols: ["BTCUSDT"] },
    })).toThrow();
    expect(() => schema.parse({
      ...cryptoBase,
      simulationCase: "btc_eth",
      selection: { mode: "manual", symbols: ["BTCUSDT"] },
      riskLimits: { maximumLeverage: 16 },
    })).toThrow();
  });
});
