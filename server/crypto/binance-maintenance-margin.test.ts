import { describe, expect, it, vi } from "vitest";
import { BinanceServerCredentials } from "./binance-credentials.js";
import {
  BinanceMaintenanceMarginProvider,
  BinanceMaintenanceMarginUnavailableError,
  normalizeBinanceMaintenanceMarginSchedule,
  resolveConservativeMaintenanceMargin,
  type BinanceMaintenanceMarginRestApi,
} from "./binance-maintenance-margin.js";
import type { BinanceInstrumentRules } from "./contracts.js";

const SYMBOL = "BTCUSDT";

function bracketFixture() {
  return {
    symbol: SYMBOL,
    notionalCoef: "0.5",
    ignoredAccountField: "must-not-survive-projection",
    brackets: [
      {
        bracket: 3n,
        initialLeverage: 20n,
        notionalCap: "1000000",
        notionalFloor: "250000",
        maintMarginRatio: "0.01",
        cum: "1300",
      },
      {
        bracket: 1,
        initialLeverage: 150,
        notionalCap: 50000,
        notionalFloor: 0,
        maintMarginRatio: 0.004,
        cum: 0,
        ignoredBracketField: "must-not-survive-projection",
      },
      {
        bracket: 2,
        initialLeverage: 50,
        notionalCap: 250000,
        notionalFloor: 50000,
        maintMarginRatio: 0.005,
        cum: 50,
      },
      // Exact duplicate rows are harmlessly deduplicated.
      {
        bracket: 1,
        initialLeverage: 150,
        notionalCap: 50000,
        notionalFloor: 0,
        maintMarginRatio: 0.004,
        cum: 0,
      },
    ],
  };
}

function credentials(): BinanceServerCredentials {
  return new BinanceServerCredentials(
    "fixture-api-key-value",
    "fixture-secret-key-value",
  );
}

function restFixture(payload = bracketFixture()): {
  rest: BinanceMaintenanceMarginRestApi;
  read: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(async () => ({
    data: () => payload,
  }));
  return {
    read,
    rest: { notionalAndLeverageBrackets: read },
  };
}

const unavailableRules: BinanceInstrumentRules = {
  symbol: SYMBOL,
  baseAsset: "BTC",
  quoteAsset: "USDT",
  marginAsset: "USDT",
  contractType: "PERPETUAL",
  onboardDate: 1,
  tickSize: 0.1,
  stepSize: 0.001,
  minQuantity: 0.001,
  minNotional: 5,
  maintenanceMarginRate: 1,
  maintenanceMarginSource: "unavailable",
};

describe("Binance USER_DATA maintenance-margin brackets", () => {
  it("strictly normalizes, deduplicates, sorts, and projects only bracket fields", () => {
    const schedule = normalizeBinanceMaintenanceMarginSchedule([bracketFixture()], SYMBOL);

    expect(schedule.brackets.map((item) => item.bracket)).toEqual([1, 2, 3]);
    expect(schedule.brackets.map((item) => item.conservativeNotionalFloor))
      .toEqual([0, 25_000, 125_000]);
    expect(schedule.maximumCoveredNotional).toBe(500_000);
    expect(schedule.provenance).toEqual({
      endpoint: "notional_and_leverage_brackets_user_data",
      exchangeInfoMaintenanceIgnored: true,
      notionalCoefficientPolicy: "earliest_of_reported_or_scaled_floor",
      maximumNotionalPolicy: "highest_applicable_maintenance_margin_ratio",
      cumulativePolicy: "assume_zero_conservative",
      rawPayloadRetained: false,
    });
    expect(JSON.stringify(schedule)).not.toContain("ignoredAccountField");
    expect(JSON.stringify(schedule)).not.toContain("ignoredBracketField");
  });

  it("moves an adjusted tier floor earlier and chooses the highest MMR through max notional", () => {
    const schedule = normalizeBinanceMaintenanceMarginSchedule(bracketFixture(), SYMBOL);
    const resolution = resolveConservativeMaintenanceMargin(schedule, 30_000);

    // The reported second floor is 50k. With coefficient ambiguity it starts
    // conservatively at min(50k, 50k * 0.5) = 25k.
    expect(resolution.maintenanceMarginRate).toBe(0.005);
    expect(resolution.maximumInitialLeverage).toBe(50);
    // Binance reports cum=50 for tier two; assuming cum=0 produces the larger
    // (therefore conservative) maintenance amount.
    expect(resolution.maintenanceMarginAtMaximumNotional).toBe(150);
    expect(resolution.provenance.cumulativePolicy).toBe("assume_zero_conservative");
  });

  it("accepts Binance's current 150x bracket evidence but rejects values above it", () => {
    const schedule = normalizeBinanceMaintenanceMarginSchedule(bracketFixture(), SYMBOL);
    expect(resolveConservativeMaintenanceMargin(schedule, 10_000).maximumInitialLeverage)
      .toBe(150);
    expect(() => normalizeBinanceMaintenanceMarginSchedule({
      ...bracketFixture(),
      brackets: bracketFixture().brackets.map((item) => (
        Number(item.bracket) === 1 ? { ...item, initialLeverage: 151 } : item
      )),
    }, SYMBOL)).toThrow(BinanceMaintenanceMarginUnavailableError);
  });

  it("fails closed beyond the conservatively covered maximum notional", () => {
    const schedule = normalizeBinanceMaintenanceMarginSchedule(bracketFixture(), SYMBOL);
    expect(() => resolveConservativeMaintenanceMargin(schedule, 500_000)).not.toThrow();
    expect(() => resolveConservativeMaintenanceMargin(schedule, 500_000.01))
      .toThrow(BinanceMaintenanceMarginUnavailableError);
  });

  it.each([
    {
      label: "wrong symbol",
      mutate: (value: ReturnType<typeof bracketFixture>) => ({ ...value, symbol: "ETHUSDT" }),
    },
    {
      label: "non-finite ratio",
      mutate: (value: ReturnType<typeof bracketFixture>) => ({
        ...value,
        brackets: value.brackets.map((item, index) => (
          index === 0 ? { ...item, maintMarginRatio: "Infinity" } : item
        )),
      }),
    },
    {
      label: "conflicting duplicate",
      mutate: (value: ReturnType<typeof bracketFixture>) => ({
        ...value,
        brackets: value.brackets.map((item, index) => (
          index === 3 ? { ...item, cum: 1 } : item
        )),
      }),
    },
    {
      label: "notional gap",
      mutate: (value: ReturnType<typeof bracketFixture>) => ({
        ...value,
        brackets: value.brackets.map((item) => (
          item.bracket === 2 ? { ...item, notionalFloor: 50_001 } : item
        )),
      }),
    },
    {
      label: "decreasing MMR",
      mutate: (value: ReturnType<typeof bracketFixture>) => ({
        ...value,
        brackets: value.brackets.map((item) => (
          Number(item.bracket) === 3 ? { ...item, maintMarginRatio: 0.0045 } : item
        )),
      }),
    },
  ])("rejects the whole response for $label", ({ mutate }) => {
    expect(() => normalizeBinanceMaintenanceMarginSchedule(mutate(bracketFixture()), SYMBOL))
      .toThrow(BinanceMaintenanceMarginUnavailableError);
  });

  it("caches normalized schedules and performs only explicit refreshes", async () => {
    let now = 1_000;
    const { rest, read } = restFixture();
    const provider = new BinanceMaintenanceMarginProvider({
      credentials: credentials(),
      rest,
      ttlMs: 100,
      now: () => now,
    });

    expect(provider.status()).toEqual({
      configured: true,
      ready: false,
      state: "not_ready",
    });
    const first = await provider.schedule("btcusdt");
    expect(await provider.schedule(SYMBOL)).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ symbol: SYMBOL });
    expect(provider.status()).toEqual({
      configured: true,
      ready: true,
      state: "ready",
    });

    now += 10;
    await provider.schedule(SYMBOL, { forceRefresh: true });
    expect(read).toHaveBeenCalledTimes(2);
    now += 101;
    await provider.schedule(SYMBOL);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent refreshes", async () => {
    let resolveResponse!: (value: { data(): unknown }) => void;
    const read = vi.fn(() => new Promise<{ data(): unknown }>((resolve) => {
      resolveResponse = resolve;
    }));
    const provider = new BinanceMaintenanceMarginProvider({
      credentials: credentials(),
      rest: { notionalAndLeverageBrackets: read },
    });
    const first = provider.schedule(SYMBOL);
    const second = provider.schedule(SYMBOL);
    resolveResponse({ data: () => bracketFixture() });

    await expect(first).resolves.toEqual(await second);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("clears cached schedules and exposes enum/boolean status after refresh failure", async () => {
    let now = 1_000;
    const { rest, read } = restFixture();
    const provider = new BinanceMaintenanceMarginProvider({
      credentials: credentials(),
      rest,
      ttlMs: 10,
      now: () => now,
    });
    await provider.schedule(SYMBOL);
    now += 11;
    read.mockRejectedValueOnce(Object.assign(
      new Error("raw account payload and secret-like diagnostics"),
      { status: 429 },
    ));

    const failure = await provider.schedule(SYMBOL).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BinanceMaintenanceMarginUnavailableError);
    expect(String(failure)).not.toContain("account payload");
    expect(provider.status()).toEqual({
      configured: true,
      ready: false,
      state: "rate_limited",
    });

    read.mockResolvedValueOnce({ data: () => bracketFixture() });
    await provider.schedule(SYMBOL);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("returns resolved instrument rules only after a valid signed bracket read", async () => {
    const { rest } = restFixture();
    const provider = new BinanceMaintenanceMarginProvider({
      credentials: credentials(),
      rest,
    });
    const resolved = await provider.resolveInstrumentRules(unavailableRules, 30_000);

    expect(resolved.rules).toEqual(expect.objectContaining({
      maintenanceMarginRate: 0.005,
      maximumInitialLeverage: 50,
      maintenanceMarginMaximumNotional: 30_000,
      maintenanceMarginSource: "binance_user_data_brackets",
    }));
    expect(resolved.resolution.source).toBe("binance_user_data_brackets");
  });

  it("is explicitly unconfigured and throws without credential-wrapped access", async () => {
    const provider = new BinanceMaintenanceMarginProvider({});
    expect(provider.status()).toEqual({
      configured: false,
      ready: false,
      state: "unconfigured",
    });
    await expect(provider.schedule(SYMBOL)).rejects.toMatchObject({
      state: "unconfigured",
    });
  });
});
