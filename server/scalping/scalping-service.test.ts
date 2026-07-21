import { describe, expect, it, vi } from "vitest";
import type { IntradayBarRecord } from "../repositories/scalping-repository.js";
import { ScalpingService, type ScalpingServiceConfig } from "./scalping-service.js";
import { ScalpingScanner } from "./scanner-service.js";

const NOW = Date.parse("2026-07-21T03:00:30.000Z");

function bars(count = 200): IntradayBarRecord[] {
  const firstClose = NOW - (count - 1) * 60_000 - 30_000;
  return Array.from({ length: count }, (_, index) => {
    const close = firstClose + index * 60_000;
    return {
      symbol: "005930",
      intervalMinutes: 1,
      openTime: new Date(close - 60_000).toISOString(),
      closeTime: new Date(close).toISOString(),
      sessionDate: "2026-07-21",
      source: "kis_ws",
      state: "final",
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1_000 + index,
      turnover: (101 + index) * (1_000 + index),
      tradeCount: 10,
      quality: "complete",
      updatedAt: NOW,
    };
  });
}

function usBars(count = 200): IntradayBarRecord[] {
  const firstClose = Date.parse("2026-07-21T13:31:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const close = firstClose + index * 60_000;
    return {
      marketCountry: "US",
      symbol: "AAPL",
      intervalMinutes: 1,
      openTime: new Date(close - 60_000).toISOString(),
      closeTime: new Date(close).toISOString(),
      sessionDate: "2026-07-21",
      source: "toss_rest",
      state: "final",
      open: 200 + index / 10,
      high: 201 + index / 10,
      low: 199 + index / 10,
      close: 200.5 + index / 10,
      volume: 10_000 + index,
      turnover: (200.5 + index / 10) * (10_000 + index),
      quality: "complete",
      updatedAt: NOW,
    };
  });
}

function config(): ScalpingServiceConfig {
  return {
    minimumTopCount: 1,
    maximumTopCount: 50,
    workspaceBarLimit: 500,
    candlePageSize: 200,
    minimumAnalysisBars: 20,
    barRefreshAfterMs: 3_600_000,
    volumeProfileBucketCount: 24,
    volumeProfileInstrumentLimit: 20,
    relativeVolumeLookbackSessions: 5,
    tradeFetchCount: 20,
    forecastMinimumBars: 20,
    forecastMaximumBars: 500,
    evaluationMaximumOrigins: 3,
    evaluationOriginStrideBars: 5,
    sessionOpenMinuteKst: 9 * 60,
    sessionCloseMinuteKst: 15 * 60 + 30,
    now: () => NOW,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const series = bars();
  const toss = {
    getRankings: vi.fn().mockResolvedValue([{
      provider: "toss", symbol: "005930", name: "삼성전자", marketCountry: "KR", currency: "KRW",
      rank: 1, rankedAt: new Date(NOW).toISOString(), price: 200, changeRateRatio: 0.01,
      volume: 1_000_000, tradingAmount: 200_000_000,
    }]),
    getPrices: vi.fn().mockResolvedValue([{
      provider: "toss", symbol: "005930", currency: "KRW", observedAt: new Date(NOW).toISOString(),
      price: 200, volume: 1_000_000, tradingAmount: 200_000_000,
    }]),
    getMinuteCandles: vi.fn().mockResolvedValue([]),
    getOrderbook: vi.fn().mockResolvedValue({
      provider: "toss", symbol: "005930", observedAt: new Date(NOW).toISOString(),
      asks: [{ price: 201, quantity: 10 }], bids: [{ price: 199, quantity: 12 }],
    }),
    getTrades: vi.fn().mockResolvedValue([]),
    getWarnings: vi.fn().mockResolvedValue([]),
    getMarketCalendar: vi.fn(async (marketCountry: "KR" | "US", sessionDate: string) => ({
      marketCountry,
      sessionDate,
      regularMarket: marketCountry === "US" ? {
        startAt: `${sessionDate}T13:30:00.000Z`,
        endAt: `${sessionDate}T20:00:00.000Z`,
      } : null,
    })),
    rateLimitSnapshot: vi.fn().mockReturnValue({ intervalMs: 100 }),
  };
  const kis = { getVolumeRanking: vi.fn().mockResolvedValue({
    items: [], quality: "available", diagnostics: [], providerTimestamp: new Date(NOW).toISOString(),
  }), getFluctuationRanking: vi.fn().mockResolvedValue({
    items: [], quality: "available", diagnostics: [], providerTimestamp: new Date(NOW).toISOString(),
  }), getOverseasVolumeRanking: vi.fn().mockResolvedValue({
    items: [], quality: "available", diagnostics: [], providerTimestamp: new Date(NOW).toISOString(),
  }), getOverseasTradingAmountRanking: vi.fn().mockResolvedValue({
    items: [], quality: "available", diagnostics: [], providerTimestamp: new Date(NOW).toISOString(),
  }) };
  const repository = {
    listBars: vi.fn().mockResolvedValue(series),
    putBars: vi.fn().mockResolvedValue(undefined),
    latestPredictions: vi.fn().mockResolvedValue([]),
  };
  const scanner = { scan: vi.fn((request, snapshot) => ({
    generatedAt: new Date(NOW).toISOString(),
    criterion: request.criterion,
    requestedTopCount: request.topCount,
    candidates: [{
      symbol: "005930", name: "삼성전자", currency: "KRW", price: 200, volume: 1_000_000,
      tradingAmount: 200_000_000, volatilityScore: 0.9, providerRanks: { toss: 1 }, warnings: [],
      filtered: false, filterReasons: [], quality: {
        status: "available", missing: [], reasons: [], sources: ["toss"], observedAt: new Date(NOW).toISOString(),
      },
    }],
    excluded: [],
    quality: { status: "available", missing: [], reasons: [], sources: ["toss"], observedAt: new Date(NOW).toISOString() },
    _snapshot: snapshot,
  })) };
  const live = {
    snapshot: vi.fn().mockReturnValue({}),
    recover: vi.fn().mockResolvedValue(undefined),
    state: { connection: "connected", subscriptions: 2, symbols: ["005930"], historicalOrderbookAvailable: false },
  };
  const analysis = {
    instruments: [{
      instrument_key: "005930",
      scanner_metrics: {
        realized_volatility: { value: 0.03 }, normalized_atr: { value: 1.2 },
        day_range_ratio: { value: 0.05 }, bollinger_width_expansion: { value: 0.4 },
        relative_volume: { value: 1.8 }, trading_amount: { value: 123_000 }, spread_bps: { value: 10 },
      },
      signals: {
        latest: {
          status: "entry_candidate", calculation_timestamp: series.at(-1)!.closeTime,
          basis_price: 200, stop_candidate_price: 190, target_price_range: { low: 215, high: 225 },
        },
        points: series.map((bar, index) => ({
          status: "watch",
          calculation_timestamp: bar.closeTime,
          multi_timeframe_agreement: index % 2 ? "aligned_bullish" : "mixed_or_neutral",
        })),
      },
    }],
  };
  const rust = { compute: vi.fn().mockResolvedValue({ result: analysis, summary: {}, warnings: [], artifacts: [] }) };
  const ai = {
    forecast: vi.fn().mockResolvedValue({ response: { status: "available" }, predictions: [] }),
    evaluate: vi.fn().mockResolvedValue({ run: { id: "run-1", status: "queued" }, reused: false }),
  };
  return { toss, kis, repository, scanner, live, rust, ai, analysis, series, ...overrides };
}

function service(parts: ReturnType<typeof dependencies>) {
  return new ScalpingService(
    parts.toss as never,
    parts.kis as never,
    parts.scanner as never,
    parts.live as never,
    parts.repository as never,
    parts.rust as never,
    parts.ai as never,
    undefined,
    undefined,
    config(),
  );
}

function actualScanner() {
  return new ScalpingScanner({
    minimumTopCount: 1, maximumTopCount: 50, minimumVolume: 0,
    minimumTradingAmount: 0, usMinimumTradingAmount: 0, maximumSpreadBps: 5_000,
    filterLowLiquidity: true, filterWideSpread: true, blockingWarningCodes: [], cautionWarningCodes: [],
    minimumVolatilityComponents: 4,
    volatilityWeights: {
      realizedVolatility: 1, normalizedAtr: 1, dayRangeRatio: 1, bollingerWidthExpansion: 1,
      relativeVolume: 1, tradingAmount: 1, spreadBps: 1,
    },
    providerPrecedence: ["toss", "kis"], staleAfterMs: 60_000, now: () => NOW,
  });
}

describe("ScalpingService", () => {
  it("starts chart and quote enrichment without waiting for the price batch", async () => {
    const parts = dependencies();
    let resolvePrices!: (value: unknown[]) => void;
    parts.toss.getPrices.mockImplementation(() => new Promise((resolve) => {
      resolvePrices = resolve;
    }));
    const pending = service(parts).workspace({
      criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });
    await vi.waitFor(() => {
      expect(parts.repository.listBars).toHaveBeenCalled();
      expect(parts.toss.getOrderbook).toHaveBeenCalled();
      expect(parts.toss.getTrades).toHaveBeenCalled();
    });
    resolvePrices([{
      provider: "toss", symbol: "005930", currency: "KRW", observedAt: new Date(NOW).toISOString(),
      price: 200, volume: 1_000_000, tradingAmount: 200_000_000,
    }]);
    await expect(pending).resolves.toHaveProperty("workspace");
  });

  it("uses one Rust batch for every workspace symbol and only maps Rust scanner metrics", async () => {
    const parts = dependencies();
    const output = await service(parts).workspace({
      criterion: "volatility", topCount: 1, interval: "1m", layoutColumns: 2, preset: "trend",
    });
    expect(parts.rust.compute).toHaveBeenCalledTimes(1);
    expect(parts.toss.getRankings.mock.calls.map(([criterion]) => criterion)).toEqual([
      "trading_amount", "volume", "change_rate",
    ]);
    expect(parts.kis.getVolumeRanking).toHaveBeenCalledWith({ basisCode: "0", market: "J" });
    expect(parts.kis.getFluctuationRanking).toHaveBeenCalledWith({ sortCode: "0", market: "J" });
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.instruments).toHaveLength(1);
    expect(payload.scalping_analysis.instruments[0].bars.at(-1)).toMatchObject({
      timestamp: parts.series.at(-1)!.closeTime,
      complete: true,
    });
    expect(payload.scalping_analysis.instruments[0].bars.at(-1).timestamp)
      .not.toBe(parts.series.at(-1)!.openTime);
    expect(payload.scalping_analysis.instruments[0].session_start_confirmed_dates).toEqual(["2026-07-21"]);
    expect(payload.scalping_analysis.instruments[0].complete_session_dates).toEqual([]);
    const snapshot = parts.scanner.scan.mock.calls[0]![1] as Record<string, any>;
    expect(snapshot.volatilityInputs["005930"]).toEqual({
      realizedVolatility: 0.03,
      normalizedAtr: 1.2,
      dayRangeRatio: 0.05,
      bollingerWidthExpansion: 0.4,
      relativeVolume: 1.8,
      tradingAmount: 123_000,
      spreadBps: 10,
    });
    expect(output.workspace.diagnostics).toMatchObject({
      analysisBatchRequestCount: 1,
      browserIndicatorCalculation: false,
    });
  });

  it("excludes partial or stale finalized bars before marking Rust and AI inputs complete", async () => {
    const parts = dependencies();
    const excludedTimes = new Set([parts.series[40]!.closeTime, parts.series[80]!.closeTime]);
    parts.repository.listBars.mockResolvedValue(parts.series.map((bar, index) => ({
      ...bar,
      quality: index === 40 ? "partial" : index === 80 ? "stale" : bar.quality,
    })));
    await service(parts).workspace({
      criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });
    const rustRequest = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(rustRequest.scalping_analysis.instruments[0].bars.length).toBeLessThan(parts.series.length);
    expect(rustRequest.scalping_analysis.instruments[0].bars
      .filter(({ timestamp }: { timestamp: string }) => excludedTimes.has(timestamp))).toEqual([]);
    expect(rustRequest.scalping_analysis.instruments[0].bars
      .every(({ complete }: { complete: boolean }) => complete)).toBe(true);

    parts.rust.compute.mockClear();
    await service(parts).forecast({ symbols: ["005930"], interval: "1m" });
    const aiRequest = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(aiRequest.series[0].bars
      .filter(({ timestamp }: { timestamp: string }) => excludedTimes.has(timestamp))).toEqual([]);
    expect(aiRequest.series[0].bars.every(({ complete }: { complete: boolean }) => complete)).toBe(true);
  });

  it("keeps complete price bars in Rust analysis when volume is unavailable", async () => {
    const parts = dependencies();
    const missingVolumeAt = parts.series[80]!.closeTime;
    parts.repository.listBars.mockResolvedValue(parts.series.map((bar, index) => (
      index === 80 ? { ...bar, volume: undefined, quality: "complete" } : bar
    )));
    await service(parts).workspace({
      criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });
    const request = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    const bar = request.scalping_analysis.instruments[0].bars
      .find(({ timestamp }: { timestamp: string }) => timestamp === missingVolumeAt);
    expect(bar).toMatchObject({ timestamp: missingVolumeAt, complete: true });
    expect(bar).not.toHaveProperty("volume");
  });

  it("selects the US provider universe without mixing domestic KIS rankings and preserves market metadata", async () => {
    const parts = dependencies();
    const series = usBars();
    parts.toss.getRankings.mockResolvedValue([{
      provider: "toss", symbol: "AAPL", name: "Apple", marketCountry: "US", exchange: "NAS", currency: "USD",
      rank: 1, rankedAt: new Date(NOW).toISOString(), price: 220, volume: 2_000_000, tradingAmount: 440_000_000,
    }]);
    parts.toss.getPrices.mockResolvedValue([{
      provider: "toss", symbol: "AAPL", currency: "USD", observedAt: new Date(NOW).toISOString(), price: 220,
    }]);
    parts.kis.getOverseasVolumeRanking.mockImplementation(async ({ exchange }: { exchange: string }) => ({
      items: exchange === "NAS" ? [{
        symbol: "MSFT", name: "Microsoft", exchange: "NAS", rank: 1, price: 510,
        changeAmount: 5, changeRate: 1, accumulatedVolume: 1_000_000, accumulatedTradingAmount: 510_000_000,
      }] : exchange === "NYS" ? [{
        symbol: "IBM", name: "IBM", exchange: "NYS", rank: 1, price: 300,
        changeAmount: 3, changeRate: 1, accumulatedVolume: 2_000_000, accumulatedTradingAmount: 400_000_000,
      }] : [],
      quality: "available", diagnostics: [], providerTimestamp: new Date(NOW).toISOString(),
    }));
    parts.repository.listBars.mockResolvedValue(series);

    const output = await service(parts).workspace({
      marketCountry: "US", criterion: "volatility", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });

    expect(parts.toss.getRankings.mock.calls.map(([criterion, , market]) => [criterion, market])).toEqual([
      ["trading_amount", "US"], ["volume", "US"], ["change_rate", "US"],
    ]);
    expect(parts.kis.getVolumeRanking).not.toHaveBeenCalled();
    expect(parts.kis.getFluctuationRanking).not.toHaveBeenCalled();
    expect(parts.repository.latestPredictions).toHaveBeenCalledWith(expect.any(Array), false, "US");
    expect(parts.repository.listBars.mock.calls.every(([input]) => input.marketCountry === "US")).toBe(true);
    expect(parts.kis.getOverseasVolumeRanking.mock.calls.map(([request]) => request.exchange)).toEqual(["NAS", "NYS", "AMS"]);
    expect(parts.kis.getOverseasTradingAmountRanking.mock.calls.map(([request]) => request.exchange)).toEqual(["NAS", "NYS", "AMS"]);
    const snapshot = parts.scanner.scan.mock.calls[0]![1] as Record<string, any>;
    expect(snapshot.rankings).toContainEqual(expect.objectContaining({
      provider: "kis", symbol: "MSFT", marketCountry: "US", currency: "USD", exchange: "NAS",
    }));
    expect(snapshot.rankings.filter(({ provider }: { provider: string }) => provider === "kis")
      .map(({ rank }: { rank: number }) => rank).sort()).toEqual([1, 2]);
    expect(output.workspace.marketCountry).toBe("US");
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.instruments[0]).toMatchObject({
      key: "AAPL", market: "US", currency: "USD",
    });
    expect(payload.scalping_analysis.instruments[0].session_start_confirmed_dates).toContain("2026-07-21");
  });

  it("propagates fulfilled-but-partial KIS US rankings into workspace quality", async () => {
    const parts = dependencies();
    parts.toss.getRankings.mockResolvedValue([{
      provider: "toss", symbol: "AAPL", name: "Apple", marketCountry: "US", exchange: "NAS", currency: "USD",
      rank: 1, rankedAt: new Date(NOW).toISOString(), price: 220, volume: 1_000_000, tradingAmount: 220_000_000,
    }]);
    parts.toss.getPrices.mockResolvedValue([]);
    parts.repository.listBars.mockResolvedValue(usBars());
    parts.kis.getOverseasVolumeRanking.mockImplementation(async ({ exchange }: { exchange: string }) => ({
      items: exchange === "NYS" ? [{
        symbol: "IBM", name: "IBM", exchange: "NYS", rank: 1, price: 300,
        changeAmount: 3, changeRate: 1, accumulatedVolume: 2_000_000, accumulatedTradingAmount: 400_000_000,
      }] : [],
      quality: exchange === "NYS" ? "partial" : "available",
      diagnostics: exchange === "NYS" ? [{
        index: 99, code: "malformed-row", fields: ["symbol"], message: "one provider row was excluded",
      }] : [],
      providerTimestamp: new Date(NOW).toISOString(),
    }));
    const subject = new ScalpingService(
      parts.toss as never, parts.kis as never, actualScanner(), parts.live as never,
      parts.repository as never, parts.rust as never, parts.ai as never,
      undefined, undefined, config(),
    );
    const output = await subject.workspace({
      marketCountry: "US", criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });
    expect(output.workspace.quality.status).toBe("partial");
    expect(output.workspace.diagnostics.providerErrors).toContain("kis_ranking_partial");
  });

  it("uses the New York regular session and DST-aware timezone for US forecasts", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(usBars());
    await service(parts).forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].timezone).toBe("America/New_York");
    expect(request.series[0].input_end_at).toBe("2026-07-21T16:50:00.000Z");
    expect(request.series[0].future_timestamps.at(-1)).toBe("2026-07-21T17:50:00.000Z");
  });

  it("does not synthesize US forecast timestamps past a confirmed early close", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(usBars());
    parts.toss.getMarketCalendar.mockResolvedValue({
      marketCountry: "US", sessionDate: "2026-07-21",
      regularMarket: { startAt: "2026-07-21T13:30:00.000Z", endAt: "2026-07-21T17:00:00.000Z" },
    });
    const output = await service(parts).forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });
    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      forecast: { status: "unavailable" },
      predictions: [{ symbol: "AAPL", unavailable: { code: "future_market_schedule_unavailable" } }],
    });
  });

  it("returns unavailable for a US forecast when the confirmed calendar session is missing", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(usBars());
    parts.toss.getMarketCalendar.mockResolvedValue({
      marketCountry: "US", sessionDate: "2026-07-21", regularMarket: null,
    });
    const output = await service(parts).forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });
    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output.predictions[0]).toMatchObject({
      symbol: "AAPL", status: "unavailable", unavailable: { code: "future_market_schedule_unavailable" },
    });
  });

  it("uses instrument metadata as an exchange fallback for a user-requested US symbol", async () => {
    const parts = dependencies();
    parts.toss.getRankings.mockResolvedValue([]);
    parts.toss.getPrices.mockResolvedValue([{
      provider: "toss", symbol: "AAPL", currency: "USD", observedAt: new Date(NOW).toISOString(), price: 220,
    }]);
    parts.repository.listBars.mockResolvedValue(usBars());
    const portfolio = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "AAPL", name: "Apple", market: "NASDAQ", currency: "USD", securityType: "stock",
      }]),
      getPortfolio: vi.fn().mockResolvedValue({
        selectedAccountId: "account-1", asOf: new Date(NOW).toISOString(), holdings: [],
      }),
    };
    const subject = new ScalpingService(
      parts.toss as never, parts.kis as never, parts.scanner as never, parts.live as never,
      parts.repository as never, parts.rust as never, parts.ai as never,
      portfolio as never, undefined, config(),
    );
    const output = await subject.workspace({
      marketCountry: "US", criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1,
      preset: "trend", symbols: ["AAPL"],
    });
    expect(output.workspace.candidates.find(({ symbol }) => symbol === "AAPL")).toMatchObject({
      symbol: "AAPL", currency: "USD", exchange: "NAS",
    });
  });

  it("확정 봉 뒤 포지션은 다음 유효 호가 이전 스냅샷일 때만 label 보조 입력으로 전달한다", async () => {
    const parts = dependencies();
    const lastClose = parts.series.at(-1)!.closeTime;
    const nextQuote = new Date(Date.parse(lastClose) + 30_000).toISOString();
    parts.toss.getOrderbook.mockResolvedValue({
      provider: "toss", symbol: "005930", observedAt: nextQuote,
      asks: [{ price: 201, quantity: 10 }], bids: [{ price: 199, quantity: 12 }],
    });
    const portfolio = {
      getInstruments: vi.fn().mockResolvedValue([]),
      getPortfolio: vi.fn().mockResolvedValue({
        selectedAccountId: "account-1",
        asOf: new Date(Date.parse(lastClose) + 15_000).toISOString(),
        holdings: [{ symbol: "005930", quantity: 3, averagePrice: 190 }],
      }),
    };
    const subject = new ScalpingService(
      parts.toss as never, parts.kis as never, parts.scanner as never, parts.live as never,
      parts.repository as never, parts.rust as never, parts.ai as never,
      portfolio as never, undefined, config(),
    );
    await subject.workspace({ criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend" });
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.instruments[0].position).toEqual({
      as_of_timestamp: new Date(Date.parse(lastClose) + 15_000).toISOString(),
      quantity: 3,
      average_price: 190,
    });
    expect(payload.scalping_analysis.instruments[0].next_valid_quote_timestamp).toBe(nextQuote);
  });

  it("builds a batch forecast from finalized bar close times and never uses the same close as a future timestamp", async () => {
    const parts = dependencies();
    const output = await service(parts).forecast({ symbols: ["005930"], interval: "5m" });
    expect(parts.rust.compute).toHaveBeenCalledTimes(1);
    expect(parts.ai.forecast).toHaveBeenCalledTimes(1);
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].input_end_at).toBe(parts.series.at(-1)!.closeTime);
    expect(request.series[0].bars.at(-1).timestamp).toBe(request.series[0].input_end_at);
    expect(Date.parse(request.series[0].future_timestamps[0])).toBeGreaterThan(Date.parse(request.series[0].input_end_at));
    expect(request.series[0].target_stop).toEqual({ side: "long", stop_price: 190, target_price: 220 });
    expect(output.forecast).toEqual({ status: "available" });
  });

  it("does not emit live forecast targets that are already in the past", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(parts.series.slice(0, -5));
    const output = await service(parts).forecast({ symbols: ["005930"], interval: "1m" });
    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output.predictions[0]).toMatchObject({
      symbol: "005930", unavailable: { code: "future_market_schedule_unavailable" },
    });
  });

  it("constructs chronological rolling origins from observed future bar timestamps and forwards all costs", async () => {
    const parts = dependencies();
    const result = await service(parts).evaluate({
      symbols: ["005930"], interval: "1m",
      evaluation: {
        walkForward: true, retrospective: true,
        commissionBpsPerSide: 1.5, taxBpsOnExit: 18, spreadBpsRoundTrip: 8, slippageBpsPerSide: 3,
      },
    });
    const request = parts.ai.evaluate.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].origins).toHaveLength(3);
    const originTimes = request.series[0].origins.map((origin: any) => origin.origin);
    expect(originTimes).toEqual([...originTimes].sort());
    for (const origin of request.series[0].origins) {
      expect(origin.future_timestamps).toHaveLength(60);
      expect(Date.parse(origin.future_timestamps[0])).toBeGreaterThan(Date.parse(origin.origin));
      expect(parts.series.some((bar) => bar.closeTime === origin.future_timestamps[0])).toBe(true);
      expect(origin.target_stop).toBeNull();
      expect(["aligned_bullish", "mixed_or_neutral"]).toContain(origin.regime);
    }
    expect(request.cost_assumptions).toEqual({
      commission_bps_per_side: 1.5,
      tax_bps_on_exit: 18,
      spread_bps_round_trip: 8,
      slippage_bps_per_side: 3,
    });
    expect(result).toMatchObject({ retrospective: true, walkForward: true, randomSplit: false });
  });

  it("투자 경고 상태를 확인할 수 없는 종목을 안전 필터 입력으로 표시한다", async () => {
    const parts = dependencies();
    parts.toss.getWarnings.mockRejectedValue(new Error("warning endpoint unavailable"));
    const output = await service(parts).workspace({
      criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });
    const snapshot = parts.scanner.scan.mock.calls[0]![1] as Record<string, any>;
    expect(snapshot.instrumentStates[0].reasons).toContain("investment_warning_status_unavailable");
    expect(output.workspace.diagnostics.providerErrors).toContain("toss_warning_status_unavailable:005930");
  });

  it("keeps a US candidate partial instead of blocking it when warning status is unavailable", async () => {
    const parts = dependencies();
    parts.toss.getRankings.mockResolvedValue([{
      provider: "toss", symbol: "AAPL", name: "Apple", marketCountry: "US", exchange: "NAS", currency: "USD",
      rank: 1, rankedAt: new Date(NOW).toISOString(), price: 220, volume: 1_000_000, tradingAmount: 220_000_000,
    }]);
    parts.toss.getPrices.mockResolvedValue([{
      provider: "toss", symbol: "AAPL", currency: "USD", observedAt: new Date(NOW).toISOString(),
      price: 220, volume: 1_000_000, tradingAmount: 220_000_000,
    }]);
    parts.toss.getWarnings.mockRejectedValue(new Error("US warning status unavailable"));
    parts.repository.listBars.mockResolvedValue(usBars());
    const scanner = actualScanner();
    const subject = new ScalpingService(
      parts.toss as never, parts.kis as never, scanner, parts.live as never,
      parts.repository as never, parts.rust as never, parts.ai as never,
      undefined, undefined, config(),
    );
    const output = await subject.workspace({
      marketCountry: "US", criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });
    expect(output.workspace.excluded).toEqual([]);
    expect(output.workspace.candidates[0]).toMatchObject({
      symbol: "AAPL",
      quality: {
        status: "partial",
        missing: expect.arrayContaining(["investment_warning_status"]),
      },
    });
  });

  it("표시 수에 비례한 후보 풀만 분봉·호가·Rust batch 보강 대상으로 사용한다", async () => {
    const parts = dependencies();
    parts.toss.getRankings.mockResolvedValue(Array.from({ length: 30 }, (_, index) => ({
      provider: "toss",
      symbol: String(index + 1).padStart(6, "0"),
      name: `종목 ${index + 1}`,
      marketCountry: "KR",
      currency: "KRW",
      rank: index + 1,
      rankedAt: new Date(NOW).toISOString(),
      price: 100 + index,
      changeRateRatio: 0.01,
      volume: 1_000_000,
      tradingAmount: 200_000_000,
    })) as never);
    await service(parts).workspace({
      criterion: "volume", topCount: 5, interval: "1m", layoutColumns: 2, preset: "trend",
    });
    expect(parts.toss.getPrices).toHaveBeenCalledWith(
      Array.from({ length: 10 }, (_, index) => String(index + 1).padStart(6, "0")),
    );
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.instruments).toHaveLength(10);
  });

  it("확정 봉 revision별 실시간 분석을 모든 종목 한 batch로 계산하고 provider를 재조회하지 않는다", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockImplementation(async ({ symbol }: { symbol: string }) => (
      parts.series.map((bar) => ({ ...bar, symbol }))
    ));
    let resolveCompute: ((value: unknown) => void) | undefined;
    parts.rust.compute.mockImplementation(() => new Promise((resolve) => {
      resolveCompute = resolve;
    }));
    const subject = service(parts);
    const request = {
      symbols: ["005930", "000660"], interval: "1m" as const, preset: "trend" as const,
    };
    const first = subject.realtimeAnalysis(request);
    const second = subject.realtimeAnalysis(request);
    await vi.waitFor(() => expect(parts.rust.compute).toHaveBeenCalledTimes(1));
    resolveCompute!({ result: parts.analysis, summary: {}, warnings: [], artifacts: [] });
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.response_mode).toBe("latest_summary");
    expect(payload.scalping_analysis.instruments.map((item: { key: string }) => item.key)).toEqual(["005930", "000660"]);
    expect(parts.toss.getRankings).not.toHaveBeenCalled();
    expect(parts.toss.getPrices).not.toHaveBeenCalled();
    expect(left).toMatchObject({
      schemaVersion: "scalping-realtime-analysis/v1",
      interval: "1m",
      preset: "trend",
      diagnostics: {
        analysisBatchRequestCount: 1,
        analysisBatchInstrumentCount: 2,
        finalizedBarsOnly: true,
        providerRescan: false,
      },
    });
  });

  it("returns unavailable instead of fabricated forecasts when the AI worker is absent", async () => {
    const parts = dependencies({ ai: undefined });
    const result = await service(parts as never).forecast({ symbols: ["005930"], interval: "1m" });
    expect(result).toEqual({
      forecast: { status: "unavailable", code: "ai_worker_unavailable" },
      predictions: [],
    });
  });

  it("paginates provider candles with an exclusive cursor and de-duplicates the configured history window", async () => {
    const parts = dependencies();
    const candles = Array.from({ length: 500 }, (_, index) => ({
      provider: "toss" as const,
      symbol: "005930",
      timestamp: new Date(Date.parse("2026-07-21T00:00:00Z") + index * 60_000).toISOString(),
      sessionDate: "2026-07-21",
      interval: "1m" as const,
      status: "final" as const,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1_000 + index,
    }));
    parts.toss.getMinuteCandles.mockReset()
      .mockResolvedValueOnce(candles.slice(300))
      .mockResolvedValueOnce(candles.slice(100, 300))
      .mockResolvedValueOnce(candles.slice(0, 100));
    const instance = service(parts) as unknown as {
      fetchMinuteHistory(symbol: string, existing: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };
    const result = await instance.fetchMinuteHistory("005930", []);
    expect(result).toHaveLength(500);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(3);
    expect(parts.toss.getMinuteCandles.mock.calls[0]).toEqual(["005930", 200, undefined, "KR"]);
    expect(Date.parse(parts.toss.getMinuteCandles.mock.calls[1]![2] as string))
      .toBeLessThan(Date.parse(candles[300]!.timestamp));
    expect(new Set(result.map((bar) => bar.openTime)).size).toBe(500);
  });

  it("treats a past Toss candle with complete OHLCV as complete even when provider finality is unknown", async () => {
    const parts = dependencies();
    parts.toss.getMinuteCandles.mockResolvedValue([{
      provider: "toss", symbol: "005930", timestamp: "2026-07-21T02:00:00.000Z",
      sessionDate: "2026-07-21", interval: "1m", status: "unknown",
      open: 100, high: 102, low: 99, close: 101, volume: 1_000,
    }]);
    const instance = service(parts) as unknown as {
      fetchMinuteHistory(symbol: string, existing: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };
    await expect(instance.fetchMinuteHistory("005930", [])).resolves.toEqual([
      expect.objectContaining({ state: "final", quality: "complete", volume: 1_000 }),
    ]);
  });

  it("keeps a complete Toss OHLC candle when optional volume is unavailable", async () => {
    const parts = dependencies();
    parts.toss.getMinuteCandles.mockResolvedValue([{
      provider: "toss", symbol: "005930", timestamp: "2026-07-21T02:00:00.000Z",
      sessionDate: "2026-07-21", interval: "1m", status: "unknown",
      open: 100, high: 102, low: 99, close: 101,
    }]);
    const instance = service(parts) as unknown as {
      fetchMinuteHistory(symbol: string, existing: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };
    const [bar] = await instance.fetchMinuteHistory("005930", []);
    expect(bar).toMatchObject({ state: "final", quality: "complete", close: 101 });
    expect(bar).not.toHaveProperty("volume");
  });

  it.each([
    ["summer DST", "2026-07-21", "2026-07-21T13:30:00.000Z"],
    ["winter standard time", "2026-01-21", "2026-01-21T14:30:00.000Z"],
  ])("anchors US 60-minute Toss recovery at 09:30 ET during %s", async (_label, sessionDate, openAt) => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue([]);
    parts.toss.getMinuteCandles.mockResolvedValue(Array.from({ length: 60 }, (_, index) => ({
      provider: "toss" as const,
      symbol: "AAPL",
      timestamp: new Date(Date.parse(openAt) + index * 60_000).toISOString(),
      sessionDate,
      interval: "1m" as const,
      status: "final" as const,
      open: 200 + index / 100,
      high: 201 + index / 100,
      low: 199 + index / 100,
      close: 200.5 + index / 100,
      volume: 100,
    })));
    const instance = service(parts) as unknown as {
      loadBars(symbols: string[], interval: 60, marketCountry: "US"): Promise<Map<string, IntradayBarRecord[]>>;
    };
    await instance.loadBars(["AAPL"], 60, "US");
    const persisted = parts.repository.putBars.mock.calls[0]![0] as IntradayBarRecord[];
    expect(persisted.find(({ intervalMinutes }) => intervalMinutes === 60)).toMatchObject({
      openTime: openAt,
      closeTime: new Date(Date.parse(openAt) + 60 * 60_000).toISOString(),
      sessionDate,
    });
  });
});
