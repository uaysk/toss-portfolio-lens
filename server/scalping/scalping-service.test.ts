import { describe, expect, it, vi } from "vitest";
import type { IntradayBarRecord } from "../repositories/scalping-repository.js";
import {
  rerankDomesticKisRankings,
  ScalpingService,
  type ScalpingServiceConfig,
} from "./scalping-service.js";
import { ProviderUnavailableError, ValidationError } from "./domain-errors.js";
import { marketLocalTimestamp } from "./market-session.js";
import { ScalpingScanner, type ScannerResult } from "./scanner-service.js";

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

function usBarsFromClose(
  firstClose: string,
  count: number,
  sessionDate: string,
  symbol = "AAPL",
): IntradayBarRecord[] {
  const first = Date.parse(firstClose);
  return Array.from({ length: count }, (_, index) => {
    const closeTime = first + index * 60_000;
    return {
      marketCountry: "US" as const,
      symbol,
      intervalMinutes: 1 as const,
      openTime: new Date(closeTime - 60_000).toISOString(),
      closeTime: new Date(closeTime).toISOString(),
      sessionDate,
      source: "toss_rest" as const,
      state: "final" as const,
      open: 200 + index / 10,
      high: 201 + index / 10,
      low: 199 + index / 10,
      close: 200.5 + index / 10,
      volume: 10_000 + index,
      turnover: (200.5 + index / 10) * (10_000 + index),
      quality: "complete" as const,
      updatedAt: NOW,
    };
  });
}

function fullUsCalendar(sessionDate: string, afterMarketEndMinutes = 24 * 60) {
  const day = Date.parse(`${sessionDate}T00:00:00.000Z`);
  const timestamp = (minutes: number) => new Date(day + minutes * 60_000).toISOString();
  return {
    marketCountry: "US" as const,
    sessionDate,
    dayMarket: { startAt: timestamp(0), endAt: timestamp(8 * 60) },
    preMarket: { startAt: timestamp(8 * 60), endAt: timestamp(13 * 60 + 30) },
    regularMarket: { startAt: timestamp(13 * 60 + 30), endAt: timestamp(20 * 60) },
    afterMarket: { startAt: timestamp(20 * 60), endAt: timestamp(afterMarketEndMinutes) },
  };
}

function krBarsFromClose(firstClose: string, count: number): IntradayBarRecord[] {
  const first = Date.parse(firstClose);
  return Array.from({ length: count }, (_, index) => {
    const closeTime = first + index * 60_000;
    return {
      marketCountry: "KR" as const,
      symbol: "005930",
      intervalMinutes: 1 as const,
      openTime: new Date(closeTime - 60_000).toISOString(),
      closeTime: new Date(closeTime).toISOString(),
      sessionDate: "2026-07-21",
      source: "kis_ws" as const,
      state: "final" as const,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1_000 + index,
      turnover: (101 + index) * (1_000 + index),
      quality: "complete" as const,
      updatedAt: closeTime,
    };
  });
}

function config(): ScalpingServiceConfig {
  return {
    minimumTopCount: 1,
    maximumTopCount: 50,
    maximumSubscriptions: 150,
    workspaceBarLimit: 500,
    usWorkspaceBarLimit: 500,
    workspaceChartBarLimit: 500,
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
    preMarketOpenMinuteKst: 8 * 60,
    preMarketCloseMinuteKst: 8 * 60 + 50,
    sessionOpenMinuteKst: 9 * 60,
    sessionCloseMinuteKst: 15 * 60 + 30,
    afterMarketOpenMinuteKst: 15 * 60 + 40,
    afterMarketCloseMinuteKst: 20 * 60,
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
  const scanner = { scan: vi.fn((request, _snapshot: unknown): ScannerResult => ({
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
  })) };
  const live = {
    snapshot: vi.fn().mockReturnValue({}),
    recover: vi.fn().mockResolvedValue(undefined),
    state: { connection: "connected", subscriptions: 2, symbols: ["005930"], historicalOrderbookAvailable: false },
  };
  const analysis = {
    schema_version: "scalping-analysis-result/v3",
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

function service(parts: ReturnType<typeof dependencies>, overrides: Partial<ScalpingServiceConfig> = {}) {
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
    { ...config(), ...overrides },
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

function directAnalysisInput(barsBySymbol: ReadonlyMap<string, IntradayBarRecord[]>) {
  return {
    symbols: [...barsBySymbol.keys()],
    interval: 1 as const,
    preset: "trend" as const,
    barsBySymbol,
    metadata: new Map(),
    holdings: new Map(),
    books: new Map(),
    trades: new Map(),
    marketCountry: "US" as const,
    responseMode: "latest_summary" as const,
    includeVolumeProfile: false,
  };
}

describe("rerankDomesticKisRankings", () => {
  const ranking = (symbol: string, rank: number, volume: number, tradingAmount: number) => ({
    provider: "kis" as const,
    symbol,
    name: symbol,
    marketCountry: "KR" as const,
    currency: "KRW",
    rank,
    rankedAt: new Date(NOW).toISOString(),
    price: 100,
    volume,
    tradingAmount,
  });

  it("sums disjoint KRX/NXT accumulations once per venue and deterministically reranks", () => {
    const result = rerankDomesticKisRankings([
      { venue: "KRX", ranking: ranking("A", 1, 100, 1_000) },
      { venue: "KRX", ranking: ranking("A", 2, 90, 900) },
      { venue: "NXT", ranking: ranking("A", 1, 50, 600) },
      { venue: "KRX", ranking: ranking("B", 2, 120, 1_500) },
    ], "trading_amount");

    expect(result).toEqual([
      expect.objectContaining({ symbol: "A", rank: 1, volume: 150, tradingAmount: 1_600 }),
      expect.objectContaining({ symbol: "B", rank: 2, volume: 120, tradingAmount: 1_500 }),
    ]);
  });
});

describe("ScalpingService", () => {
  it("propagates a cancelled simulation signal without dispatching AI work", async () => {
    const parts = dependencies();
    const controller = new AbortController();
    controller.abort(new Error("simulation stopped"));
    await expect(service(parts).forecast({
      symbols: ["005930"],
      interval: "1m",
    }, { signal: controller.signal })).rejects.toThrow("simulation stopped");
    expect(parts.ai.forecast).not.toHaveBeenCalled();
  });

  it("exposes the evidence-based KRX/NXT and calendar-confirmed US session policies", () => {
    const status = service(dependencies()).status();
    expect(status.limits).toMatchObject({
      topCount: { minimum: 1, maximum: 50 },
      maximumSubscriptions: 150,
    });
    expect(status.sessions.KR).toEqual({
      timezone: "Asia/Seoul",
      policy: "KRX_NXT_evidence_based",
      eligibility: "per_instrument_latest_session_bar_evidence",
      windows: [
        { kind: "pre_market", openMinute: 480, closeMinute: 530 },
        { kind: "regular_market", openMinute: 540, closeMinute: 930 },
        { kind: "after_market", openMinute: 940, closeMinute: 1_200 },
      ],
    });
    expect(status.sessions.US).toEqual({
      timezone: "America/New_York",
      policy: "toss_calendar_confirmed_extended_hours",
      eligibility: "date_specific_day_pre_regular_after_periods",
      windows: [
        { kind: "day_market", openMinute: 1_200, closeMinute: 1_440, localDateOffset: -1 },
        { kind: "day_market", openMinute: 0, closeMinute: 240, localDateOffset: 0 },
        { kind: "pre_market", openMinute: 240, closeMinute: 570, localDateOffset: 0 },
        { kind: "regular_market", openMinute: 570, closeMinute: 960, localDateOffset: 0 },
        { kind: "after_market", openMinute: 960, closeMinute: 1_200, localDateOffset: 0 },
      ],
    });
    expect(status.limitations).toEqual(expect.arrayContaining([
      expect.stringContaining("데이마켓 호가는 제공하지 않습니다"),
      expect.stringContaining("호가 기반 지표는 unavailable 또는 partial"),
    ]));
  });

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

  it("사용자 지정 종목을 우선 배치하고 표시 수 안에서 순위 종목으로 채운다", async () => {
    const parts = dependencies();
    const rankedSymbols = Array.from({ length: 20 }, (_, index) => String(index + 1).padStart(6, "0"));
    parts.scanner.scan.mockImplementation((request) => ({
      generatedAt: new Date(NOW).toISOString(),
      criterion: request.criterion,
      requestedTopCount: request.topCount,
      candidates: rankedSymbols.slice(0, request.topCount).map((symbol, index) => ({
        symbol,
        currency: "KRW",
        price: 100 + index,
        volume: 1_000_000 - index,
        tradingAmount: 200_000_000 - index,
        providerRanks: { toss: index + 1 },
        warnings: [],
        filtered: false,
        filterReasons: [],
        quality: {
          status: "available" as const,
          missing: [],
          reasons: [],
          sources: ["toss"],
          observedAt: new Date(NOW).toISOString(),
        },
      })),
      excluded: [],
      quality: {
        status: "available" as const,
        missing: [],
        reasons: [],
        sources: ["toss"],
        observedAt: new Date(NOW).toISOString(),
      },
    }));
    const subject = service(parts);

    const five = await subject.workspace({
      criterion: "volume", topCount: 5, interval: "1m", layoutColumns: 1, preset: "trend", symbols: ["999999"],
    });
    expect(five.workspace.candidates.map(({ symbol }) => symbol)).toEqual([
      "999999", "000001", "000002", "000003", "000004",
    ]);
    expect(five.workspace.instruments.map(({ symbol }) => symbol)).toEqual(
      five.workspace.candidates.map(({ symbol }) => symbol),
    );

    const twenty = await subject.workspace({
      criterion: "volume", topCount: 20, interval: "1m", layoutColumns: 4, preset: "trend", symbols: ["999999"],
    });
    expect(twenty.workspace.candidates).toHaveLength(20);
    expect(twenty.workspace.candidates[0]?.symbol).toBe("999999");
    expect(twenty.workspace.candidates.at(-1)?.symbol).toBe("000019");
    expect(twenty.workspace.instruments.map(({ symbol }) => symbol)).toEqual(
      twenty.workspace.candidates.map(({ symbol }) => symbol),
    );
  });

  it("returns a scan-only candidate list without bars, Rust analysis, predictions, or trade markers", async () => {
    const parts = dependencies();
    const output = await service(parts).workspace({
      criterion: "volume",
      topCount: 1,
      interval: "1m",
      layoutColumns: 1,
      preset: "trend",
      scanOnly: true,
    });

    expect(output.workspace.candidates.map(({ symbol }) => symbol)).toEqual(["005930"]);
    expect(output.workspace.instruments).toEqual([]);
    expect(output.workspace.diagnostics.analysisBatchInstrumentCount).toBe(0);
    expect(output.workspace.diagnostics.analysisBatchRequestCount).toBe(0);
    expect(parts.repository.listBars).not.toHaveBeenCalled();
    expect(parts.repository.latestPredictions).not.toHaveBeenCalled();
    expect(parts.rust.compute).not.toHaveBeenCalled();
  });

  it("uses a candidate-wide screening batch for volatility but returns no detailed instruments", async () => {
    const parts = dependencies();
    const output = await service(parts).workspace({
      criterion: "volatility",
      topCount: 1,
      interval: "1m",
      layoutColumns: 1,
      preset: "trend",
      scanOnly: true,
    });

    expect(output.workspace.candidates).toHaveLength(1);
    expect(output.workspace.instruments).toEqual([]);
    expect(output.workspace.diagnostics.analysisBatchInstrumentCount).toBe(1);
    expect(output.workspace.diagnostics.analysisBatchRequestCount).toBe(1);
    expect(parts.rust.compute).toHaveBeenCalledTimes(1);
  });

  it("limits detailed bars, Rust analysis, prediction lookup, and output to the selected symbol", async () => {
    const parts = dependencies();
    const output = await service(parts).workspace({
      criterion: "volume",
      topCount: 1,
      interval: "1m",
      layoutColumns: 1,
      preset: "trend",
      symbols: ["005930"],
      analysisSymbol: "005930",
    });

    expect(output.workspace.analysisSymbol).toBe("005930");
    expect(output.workspace.instruments.map(({ symbol }) => symbol)).toEqual(["005930"]);
    expect(output.workspace.diagnostics.analysisBatchInstrumentCount).toBe(1);
    expect(output.workspace.diagnostics.analysisBatchRequestCount).toBe(1);
    expect(parts.rust.compute).toHaveBeenCalledTimes(1);
    expect(parts.repository.latestPredictions).toHaveBeenCalledWith(["005930"], false, "KR");
  });

  it("rejects a request that mixes scan-only mode with a detailed analysis symbol", async () => {
    await expect(service(dependencies()).workspace({
      criterion: "volume",
      topCount: 1,
      interval: "1m",
      layoutColumns: 1,
      preset: "trend",
      scanOnly: true,
      analysisSymbol: "005930",
    })).rejects.toThrow("목록 스캔과 상세 분석 종목은 한 요청에서 함께 지정할 수 없습니다.");
  });

  it("표시 수보다 많은 사용자 지정 종목 요청을 거부한다", async () => {
    await expect(service(dependencies()).workspace({
      criterion: "volume",
      topCount: 5,
      interval: "1m",
      layoutColumns: 1,
      preset: "trend",
      symbols: ["000001", "000002", "000003", "000004", "000005", "000006"],
    })).rejects.toThrow("사용자 지정 종목 수는 표시 종목 수를 넘을 수 없습니다.");
  });

  it("includes KRX and NXT ranking candidates while isolating an unavailable NXT ranking", async () => {
    const parts = dependencies();
    parts.kis.getVolumeRanking.mockImplementation(async ({ market }: { market: string }) => {
      if (market === "NX") throw new Error("provider detail must not escape");
      return {
        items: [{
          symbol: "000660", name: "SK하이닉스", rank: 1, price: 250_000, changeAmount: 1_000,
          changeRate: 0.4, accumulatedVolume: 2_000_000, accumulatedTradingAmount: 500_000_000_000,
        }],
        quality: "available", diagnostics: [], providerTimestamp: new Date(NOW).toISOString(),
      };
    });

    const output = await service(parts).workspace({
      criterion: "trading_amount", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });

    expect(parts.kis.getVolumeRanking.mock.calls.map(([request]) => request.market)).toEqual(["J", "NX"]);
    expect(output.workspace.candidates).toHaveLength(1);
    expect(output.workspace.quality.status).toBe("partial");
    expect(output.workspace.diagnostics.providerErrors).toEqual(expect.arrayContaining([
      "kis_ranking_partial",
      "kis_nxt_volume_ranking_unavailable",
    ]));
    expect(JSON.stringify(output)).not.toContain("provider detail must not escape");
  });

  it("keeps scanner candidates when the Rust batch is temporarily unavailable", async () => {
    const parts = dependencies();
    parts.rust.compute.mockRejectedValue(new Error("socket EAGAIN detail"));

    const output = await service(parts).workspace({
      criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });

    expect(output.workspace.candidates).toHaveLength(1);
    expect(output.workspace.instruments[0]?.technical).toEqual({
      status: "unavailable", reason: "rust_analysis_unavailable",
    });
    expect(output.workspace.quality.status).toBe("partial");
    expect(output.workspace.diagnostics.providerErrors).toContain("rust_analysis_unavailable");
    expect(JSON.stringify(output)).not.toContain("EAGAIN");
  });

  it("returns a deterministic unavailable workspace when the scanner contract fails", async () => {
    const parts = dependencies();
    parts.scanner.scan.mockImplementation(() => {
      throw new Error("malformed provider row detail");
    });

    const output = await service(parts).workspace({
      criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });

    expect(output.workspace.candidates).toEqual([]);
    expect(output.workspace.quality).toMatchObject({
      status: "source_unavailable",
      missing: expect.arrayContaining(["scanner_contract"]),
      reasons: expect.arrayContaining(["scanner_contract_unavailable"]),
    });
    expect(output.workspace.diagnostics.providerErrors).toContain("scanner_contract_unavailable");
    expect(JSON.stringify(output)).not.toContain("malformed provider row detail");
  });

  it("isolates a per-symbol intraday store failure and keeps requested symbols unavailable", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockImplementation(async ({ symbol }: { symbol: string }) => {
      if (symbol === "BROKEN") throw new Error("database detail");
      return parts.series;
    });

    const output = await service(parts).workspace({
      criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend", symbols: ["BROKEN"],
    });

    expect(output.workspace.candidates.map(({ symbol }) => symbol)).toContain("BROKEN");
    expect(output.workspace.instruments.find(({ symbol }) => symbol === "BROKEN")?.bars).toEqual([]);
    expect(output.workspace.quality.status).toBe("partial");
    expect(output.workspace.diagnostics.providerErrors).toContain("intraday_bar_store_unavailable:BROKEN");
    expect(JSON.stringify(output)).not.toContain("database detail");
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
    expect(parts.kis.getVolumeRanking.mock.calls.map(([request]) => request.market)).toEqual(["J", "NX"]);
    expect(parts.kis.getFluctuationRanking).toHaveBeenCalledWith({ sortCode: "0", market: "J" });
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.instruments).toHaveLength(1);
    expect(payload.scalping_analysis.instruments[0].bars.at(-1)).toMatchObject({
      timestamp: marketLocalTimestamp(parts.series.at(-1)!.closeTime, "KR"),
      complete: true,
    });
    expect(payload.scalping_analysis.instruments[0].bars.at(-1).timestamp)
      .not.toBe(parts.series.at(-1)!.openTime);
    expect(payload.scalping_analysis.instruments[0].session_start_confirmed_dates).toEqual([]);
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
      .find(({ timestamp }: { timestamp: string }) => timestamp === marketLocalTimestamp(missingVolumeAt, "KR"));
    expect(bar).toMatchObject({ timestamp: marketLocalTimestamp(missingVolumeAt, "KR"), complete: true });
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
    expect(parts.toss.getOrderbook).not.toHaveBeenCalled();
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
    expect(output.workspace.instruments[0]).toMatchObject({
      orderbook: undefined,
      orderbookStatus: {
        status: "unavailable",
        code: "kis_us_orderbook_unavailable",
        reason: expect.stringContaining("데이마켓 호가는 제공되지 않으며"),
      },
    });
    expect(output.workspace.diagnostics).toMatchObject({
      orderbookPolicy: "fresh_kis_standard_feed_top_of_book_only; day_market_unavailable; no_toss_fallback",
    });
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

  it("uses the confirmed New York extended sessions and DST-aware timezone for US forecasts", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(usBars());
    parts.toss.getMarketCalendar.mockImplementation(async (_market: string, sessionDate: string) => (
      fullUsCalendar(sessionDate)
    ));
    await service(parts, { now: () => Date.parse("2026-07-21T16:50:30.000Z") })
      .forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });
    const rustPayload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(rustPayload.scalping_analysis.instruments[0].session_windows).toEqual([
      { kind: "day_market", open_minute: 1_200, close_minute: 1_440, local_date_offset: -1 },
      { kind: "day_market", open_minute: 0, close_minute: 240, local_date_offset: 0 },
      { kind: "pre_market", open_minute: 240, close_minute: 570, local_date_offset: 0 },
      { kind: "regular_market", open_minute: 570, close_minute: 960, local_date_offset: 0 },
      { kind: "after_market", open_minute: 960, close_minute: 1_200, local_date_offset: 0 },
    ]);
    expect(rustPayload.scalping_analysis.instruments[0].bars[0].timestamp)
      .toBe("2026-07-21T09:31:00.000-04:00");
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].timezone).toBe("America/New_York");
    expect(request.series[0].input_end_at).toBe("2026-07-21T16:50:00.000Z");
    expect(request.series[0].future_timestamps.at(-1)).toBe("2026-07-21T17:50:00.000Z");
  });

  it("keeps one US trading-session date while a day-market forecast crosses New York midnight", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(
      usBarsFromClose("2026-07-22T03:31:00.000Z", 20, "2026-07-22"),
    );
    parts.toss.getMarketCalendar.mockImplementation(async (_market: string, sessionDate: string) => (
      fullUsCalendar(sessionDate)
    ));

    await service(parts, { now: () => Date.parse("2026-07-22T03:50:30.000Z") })
      .forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });

    expect(parts.ai.forecast).toHaveBeenCalledTimes(1);
    const rustPayload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(new Set(rustPayload.scalping_analysis.instruments[0].bars.map(
      (bar: Record<string, unknown>) => bar.session_date,
    ))).toEqual(new Set(["2026-07-22"]));
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].future_timestamps).toHaveLength(60);
    expect(request.series[0].future_timestamps[0]).toBe("2026-07-22T03:51:00.000Z");
    expect(request.series[0].future_timestamps[9]).toBe("2026-07-22T04:00:00.000Z");
    expect(request.series[0].future_timestamps[10]).toBe("2026-07-22T04:01:00.000Z");
    expect(request.series[0].future_timestamps.at(-1)).toBe("2026-07-22T04:50:00.000Z");
  });

  it("skips the Toss-confirmed US after/day gap and resumes on the next trading-session date", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(
      usBarsFromClose("2026-07-21T23:31:00.000Z", 20, "2026-07-21"),
    );
    parts.toss.getMarketCalendar.mockImplementation(async (_market: string, sessionDate: string) => (
      fullUsCalendar(sessionDate, 23 * 60 + 50)
    ));

    await service(parts, { now: () => Date.parse("2026-07-21T23:50:30.000Z") })
      .forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });

    expect(parts.ai.forecast).toHaveBeenCalledTimes(1);
    expect(parts.toss.getMarketCalendar).toHaveBeenCalledWith("US", "2026-07-22");
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].future_timestamps[0]).toBe("2026-07-22T00:01:00.000Z");
    expect(request.series[0].future_timestamps.at(-1)).toBe("2026-07-22T01:00:00.000Z");
    expect(request.series[0].future_timestamps).not.toContain("2026-07-21T23:51:00.000Z");
  });

  it("skips only an explicitly closed US calendar day when extending a forecast", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(
      usBarsFromClose("2026-07-21T23:31:00.000Z", 20, "2026-07-21"),
    );
    parts.toss.getMarketCalendar.mockImplementation(async (_market: string, sessionDate: string) => (
      sessionDate === "2026-07-22"
        ? {
            marketCountry: "US" as const,
            sessionDate,
            dayMarket: null,
            preMarket: null,
            regularMarket: null,
            afterMarket: null,
          }
        : fullUsCalendar(sessionDate, sessionDate === "2026-07-21" ? 23 * 60 + 50 : 24 * 60)
    ));

    await service(parts, { now: () => Date.parse("2026-07-21T23:50:30.000Z") })
      .forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });

    expect(parts.ai.forecast).toHaveBeenCalledTimes(1);
    expect(parts.toss.getMarketCalendar.mock.calls.map(([, date]) => date)).toEqual([
      "2026-07-21", "2026-07-21", "2026-07-22", "2026-07-23",
    ]);
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].future_timestamps[0]).toBe("2026-07-23T00:01:00.000Z");
  });

  it("fails closed instead of treating a missing US calendar response as a holiday", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(
      usBarsFromClose("2026-07-21T23:31:00.000Z", 20, "2026-07-21"),
    );
    parts.toss.getMarketCalendar.mockImplementation(async (_market: string, sessionDate: string) => {
      if (sessionDate === "2026-07-22") throw new Error("calendar offline");
      return fullUsCalendar(sessionDate, 23 * 60 + 50);
    });

    const output = await service(parts, { now: () => Date.parse("2026-07-21T23:50:30.000Z") })
      .forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });

    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output.predictions[0]).toMatchObject({
      symbol: "AAPL",
      unavailable: { code: "future_market_schedule_unavailable" },
    });
    expect(parts.toss.getMarketCalendar).toHaveBeenCalledTimes(3);
  });

  it("uses a confirmed US early-close window and limits Rust input to the latest session", async () => {
    const parts = dependencies();
    parts.toss.getMarketCalendar.mockResolvedValue({
      marketCountry: "US", sessionDate: "2026-07-21",
      regularMarket: { startAt: "2026-07-21T13:30:00.000Z", endAt: "2026-07-21T17:00:00.000Z" },
    });
    const previous = usBarsFromClose("2026-07-20T13:31:00.000Z", 60, "2026-07-20");
    const earlyClose = usBarsFromClose("2026-07-21T13:31:00.000Z", 210, "2026-07-21");
    const subject = service(parts) as unknown as {
      computeAnalysis(input: ReturnType<typeof directAnalysisInput>): Promise<unknown>;
    };
    await subject.computeAnalysis(directAnalysisInput(new Map([["AAPL", [...previous, ...earlyClose]]])));

    expect(parts.toss.getMarketCalendar).toHaveBeenCalledTimes(2);
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    const instrument = payload.scalping_analysis.instruments[0];
    expect(instrument.session_windows).toEqual([
      { kind: "regular_market", open_minute: 570, close_minute: 780, local_date_offset: 0 },
    ]);
    expect(new Set(instrument.bars.map((bar: Record<string, unknown>) => bar.session_date))).toEqual(new Set(["2026-07-21"]));
    expect(instrument.bars.at(-1).timestamp).toBe("2026-07-21T13:00:00.000-04:00");
    expect(instrument).not.toHaveProperty("next_valid_quote_timestamp");
  });

  it("keeps multi-session Rust context on a normal US day and de-duplicates calendar dates", async () => {
    const parts = dependencies();
    const barsBySymbol = new Map(["AAPL", "MSFT"].map((symbol) => [symbol, [
      ...usBarsFromClose("2026-07-20T13:31:00.000Z", 60, "2026-07-20", symbol),
      ...usBarsFromClose("2026-07-21T13:31:00.000Z", 200, "2026-07-21", symbol),
    ]]));
    const subject = service(parts) as unknown as {
      computeAnalysis(input: ReturnType<typeof directAnalysisInput>): Promise<unknown>;
    };
    await subject.computeAnalysis(directAnalysisInput(barsBySymbol));

    expect(parts.toss.getMarketCalendar).toHaveBeenCalledTimes(2);
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.instruments).toHaveLength(2);
    for (const instrument of payload.scalping_analysis.instruments) {
      expect(instrument.session_windows).toEqual([
        { kind: "regular_market", open_minute: 570, close_minute: 960, local_date_offset: 0 },
      ]);
      expect(new Set(instrument.bars.map((bar: Record<string, unknown>) => bar.session_date)))
        .toEqual(new Set(["2026-07-20", "2026-07-21"]));
    }
  });

  it.each(["unavailable", "invalid"] as const)(
    "fails US technical analysis closed when the latest calendar is %s",
    async (mode) => {
      const parts = dependencies();
      if (mode === "unavailable") {
        parts.toss.getMarketCalendar.mockRejectedValue(new Error("calendar offline"));
      } else {
        parts.toss.getMarketCalendar.mockResolvedValue({
          marketCountry: "US", sessionDate: "2026-07-21",
          regularMarket: { startAt: "2026-07-21T13:30:30.000Z", endAt: "2026-07-21T20:00:00.000Z" },
        });
      }
      const subject = service(parts) as unknown as {
        computeAnalysis(input: ReturnType<typeof directAnalysisInput>): Promise<unknown>;
      };
      const result = await subject.computeAnalysis(directAnalysisInput(new Map([["AAPL", usBars()]])));

      expect(parts.rust.compute).not.toHaveBeenCalled();
      expect(result).toEqual({
        instruments: [{
          instrument_key: "AAPL",
          symbol: "AAPL",
          status: "unavailable",
          reason: "us_market_calendar_unavailable_or_invalid",
          availability: {
            status: "unavailable",
            reason: "confirmed_us_session_schedule_required",
          },
        }],
      });
    },
  );

  it.each(["unavailable", "invalid"] as const)(
    "does not queue retrospective AI evaluation when the US technical calendar is %s",
    async (mode) => {
      const parts = dependencies();
      parts.repository.listBars.mockResolvedValue(usBars());
      if (mode === "unavailable") {
        parts.toss.getMarketCalendar.mockRejectedValue(new Error("calendar offline"));
      } else {
        parts.toss.getMarketCalendar.mockResolvedValue({
          marketCountry: "US", sessionDate: "2026-07-21",
          regularMarket: { startAt: "2026-07-21T13:30:30.000Z", endAt: "2026-07-21T20:00:00.000Z" },
        });
      }

      const result = await service(parts).evaluate({
        marketCountry: "US", symbols: ["AAPL"], interval: "1m",
        evaluation: {
          walkForward: true, retrospective: true,
          commissionBpsPerSide: 1, taxBpsOnExit: 1, spreadBpsRoundTrip: 1, slippageBpsPerSide: 1,
        },
      });

      expect(parts.rust.compute).not.toHaveBeenCalled();
      expect(parts.ai.evaluate).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: "unavailable",
        code: "technical_analysis_unavailable",
        excluded: [{
          symbol: "AAPL",
          status: "unavailable",
          code: "us_market_calendar_unavailable_or_invalid",
          reason: "confirmed_us_session_schedule_required",
        }],
        retrospective: true,
        walkForward: true,
        randomSplit: false,
      });
    },
  );

  it("excludes a calendar-unavailable US symbol instead of encoding it as a neutral evaluation signal", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockImplementation(async ({ symbol }: { symbol: string }) => (
      symbol === "AAPL"
        ? usBarsFromClose("2026-07-21T13:31:00.000Z", 200, "2026-07-21", symbol)
        : usBarsFromClose("2026-07-20T13:31:00.000Z", 200, "2026-07-20", symbol)
    ));
    parts.toss.getMarketCalendar.mockImplementation(async (_market: string, sessionDate: string) => {
      if (sessionDate === "2026-07-21") throw new Error("calendar offline");
      return {
        marketCountry: "US" as const,
        sessionDate,
        regularMarket: {
          startAt: `${sessionDate}T13:30:00.000Z`,
          endAt: `${sessionDate}T20:00:00.000Z`,
        },
      };
    });
    parts.rust.compute.mockImplementation(async (_job: string, request: Record<string, any>) => ({
      result: {
        schema_version: "scalping-analysis-result/v3",
        instruments: request.scalping_analysis.instruments.map((instrument: Record<string, any>) => ({
          instrument_key: instrument.key,
          signals: {
            points: instrument.bars.map((bar: Record<string, any>) => ({
              calculation_timestamp: bar.timestamp,
              status: "watch",
            })),
          },
        })),
      },
    }));

    const result = await service(parts).evaluate({
      marketCountry: "US", symbols: ["AAPL", "MSFT"], interval: "1m",
      evaluation: {
        walkForward: true, retrospective: true,
        commissionBpsPerSide: 1, taxBpsOnExit: 1, spreadBpsRoundTrip: 1, slippageBpsPerSide: 1,
      },
    });

    const request = parts.ai.evaluate.mock.calls[0]![0] as Record<string, any>;
    expect(request.series.map((item: Record<string, unknown>) => item.instrument_key)).toEqual(["MSFT"]);
    expect(request.series[0].origins.every((origin: Record<string, unknown>) => origin.technical_signal === 0)).toBe(true);
    expect(result).toMatchObject({
      run: { id: "run-1" },
      excluded: [{
        symbol: "AAPL",
        status: "unavailable",
        code: "us_market_calendar_unavailable_or_invalid",
        reason: "confirmed_us_session_schedule_required",
      }],
    });
  });

  it("does not synthesize US forecast timestamps past a confirmed early close", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(usBars());
    parts.toss.getMarketCalendar.mockResolvedValue({
      marketCountry: "US", sessionDate: "2026-07-21",
      regularMarket: { startAt: "2026-07-21T13:30:00.000Z", endAt: "2026-07-21T17:00:00.000Z" },
    });
    const output = await service(parts, { now: () => Date.parse("2026-07-21T16:50:30.000Z") })
      .forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });
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
    const output = await service(parts, { now: () => Date.parse("2026-07-21T16:50:30.000Z") })
      .forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });
    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output.predictions[0]).toMatchObject({
      symbol: "AAPL", status: "unavailable", unavailable: { code: "future_market_schedule_unavailable" },
    });
  });

  it("does not mark the omitted US 60-minute regular-session tail as a complete session", () => {
    const parts = dependencies();
    const hourly = Array.from({ length: 6 }, (_, index): IntradayBarRecord => ({
      ...usBars(1)[0]!,
      intervalMinutes: 60,
      openTime: new Date(Date.parse("2026-07-21T13:30:00.000Z") + index * 60 * 60_000).toISOString(),
      closeTime: new Date(Date.parse("2026-07-21T14:30:00.000Z") + index * 60 * 60_000).toISOString(),
    }));
    const instance = service(parts) as unknown as {
      confirmedSessionDates(
        bars: IntradayBarRecord[], interval: 60, marketCountry: "US",
        sessionWindows: readonly { kind: "regular_market"; openMinute: number; closeMinute: number }[],
      ): { started: string[]; complete: string[] };
    };
    expect(instance.confirmedSessionDates(hourly, 60, "US", [
      { kind: "regular_market", openMinute: 570, closeMinute: 960 },
    ])).toEqual({
      started: ["2026-07-21"],
      complete: [],
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

  it("enriches a regular US scan candidate with an explicit instrument-metadata exchange", async () => {
    const parts = dependencies();
    parts.toss.getRankings.mockResolvedValue([{
      provider: "toss", symbol: "AAPL", name: "Apple", marketCountry: "US", currency: "USD",
      rank: 1, rankedAt: new Date(NOW).toISOString(), price: 220,
      volume: 1_000_000, tradingAmount: 220_000_000,
    }]);
    parts.toss.getPrices.mockResolvedValue([{
      provider: "toss", symbol: "AAPL", currency: "USD", observedAt: new Date(NOW).toISOString(),
      price: 220, volume: 1_000_000, tradingAmount: 220_000_000,
    }]);
    parts.scanner.scan.mockReturnValue({
      generatedAt: new Date(NOW).toISOString(),
      criterion: "volume",
      requestedTopCount: 1,
      candidates: [{
        symbol: "AAPL", name: "Apple", currency: "USD", price: 220, volume: 1_000_000,
        tradingAmount: 220_000_000, providerRanks: { toss: 1 }, warnings: [],
        filtered: false, filterReasons: [], quality: {
          status: "available", missing: [], reasons: [], sources: ["toss"],
          observedAt: new Date(NOW).toISOString(),
        },
      }],
      excluded: [],
      quality: {
        status: "available", missing: [], reasons: [], sources: ["toss"],
        observedAt: new Date(NOW).toISOString(),
      },
    });
    const portfolio = {
      getInstruments: vi.fn().mockResolvedValue([{
        symbol: "AAPL", name: "Apple", market: "NASDAQ", currency: "USD", securityType: "stock",
      }]),
      getPortfolio: vi.fn(),
    };
    const subject = new ScalpingService(
      parts.toss as never, parts.kis as never, parts.scanner as never, parts.live as never,
      parts.repository as never, parts.rust as never, parts.ai as never,
      portfolio as never, undefined, config(),
    );

    const output = await subject.workspace({
      marketCountry: "US", criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1,
      preset: "trend", scanOnly: true, includePortfolioContext: false,
    });

    expect(output.workspace.candidates).toEqual([
      expect.objectContaining({ symbol: "AAPL", exchange: "NAS", filtered: false }),
    ]);
    expect(output.workspace.diagnostics).toMatchObject({
      exchangeEligibleCandidateCount: 1,
      exchangeMetadataFallbackCount: 1,
    });
    expect(portfolio.getPortfolio).not.toHaveBeenCalled();
  });

  it("does not guess a US exchange from generic metadata or overwrite a ranked exchange", async () => {
    const parts = dependencies();
    parts.toss.getRankings.mockResolvedValue([
      {
        provider: "toss", symbol: "UNKNOWN", marketCountry: "US", currency: "USD",
        rank: 1, rankedAt: new Date(NOW).toISOString(), price: 10,
        volume: 1_000_000, tradingAmount: 10_000_000,
      },
      {
        provider: "toss", symbol: "IBM", marketCountry: "US", exchange: "NYS", currency: "USD",
        rank: 2, rankedAt: new Date(NOW).toISOString(), price: 200,
        volume: 1_000_000, tradingAmount: 200_000_000,
      },
    ]);
    parts.toss.getPrices.mockResolvedValue([]);
    const candidate = (symbol: string, exchange?: "NYS") => ({
      symbol, ...(exchange ? { exchange } : {}), currency: "USD", price: 100,
      volume: 1_000_000, tradingAmount: 100_000_000, providerRanks: { toss: 1 }, warnings: [],
      filtered: false, filterReasons: [], quality: {
        status: "available" as const, missing: [], reasons: [], sources: ["toss" as const],
        observedAt: new Date(NOW).toISOString(),
      },
    });
    parts.scanner.scan.mockReturnValue({
      generatedAt: new Date(NOW).toISOString(),
      criterion: "volume",
      requestedTopCount: 2,
      candidates: [candidate("UNKNOWN"), candidate("IBM", "NYS")],
      excluded: [],
      quality: {
        status: "available", missing: [], reasons: [], sources: ["toss"],
        observedAt: new Date(NOW).toISOString(),
      },
    });
    const portfolio = {
      getInstruments: vi.fn().mockResolvedValue([
        { symbol: "UNKNOWN", name: "Unknown", market: "US", currency: "USD" },
        { symbol: "IBM", name: "IBM", market: "NASDAQ", currency: "USD" },
      ]),
      getPortfolio: vi.fn(),
    };
    const subject = new ScalpingService(
      parts.toss as never, parts.kis as never, parts.scanner as never, parts.live as never,
      parts.repository as never, parts.rust as never, parts.ai as never,
      portfolio as never, undefined, config(),
    );

    const output = await subject.workspace({
      marketCountry: "US", criterion: "volume", topCount: 2, interval: "1m", layoutColumns: 1,
      preset: "trend", scanOnly: true, includePortfolioContext: false,
    });

    expect(output.workspace.candidates.find(({ symbol }) => symbol === "UNKNOWN")?.exchange).toBeUndefined();
    expect(output.workspace.candidates.find(({ symbol }) => symbol === "IBM")?.exchange).toBe("NYS");
    expect(output.workspace.diagnostics).toMatchObject({
      exchangeEligibleCandidateCount: 1,
      exchangeMetadataFallbackCount: 0,
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

  it("isolated workspace 스캔은 실제 포트폴리오를 조회하거나 공유 보유 문맥을 덮어쓰지 않는다", async () => {
    const parts = dependencies();
    const portfolio = {
      getInstruments: vi.fn().mockResolvedValue([]),
      getPortfolio: vi.fn().mockResolvedValue({
        selectedAccountId: "account-1",
        asOf: parts.series.at(-1)!.closeTime,
        holdings: [{ symbol: "005930", quantity: 99, averagePrice: 1 }],
      }),
    };
    const subject = new ScalpingService(
      parts.toss as never, parts.kis as never, parts.scanner as never, parts.live as never,
      parts.repository as never, parts.rust as never, parts.ai as never,
      portfolio as never, undefined, config(),
    );
    await subject.workspace({
      criterion: "volume",
      topCount: 1,
      interval: "1m",
      layoutColumns: 1,
      preset: "trend",
      scanOnly: true,
      includePortfolioContext: false,
    });
    expect(portfolio.getPortfolio).not.toHaveBeenCalled();
    const realtime = await subject.realtimeAnalysis({
      symbols: ["005930"],
      interval: "1m",
      preset: "trend",
    }) as Record<string, any>;
    expect(realtime.diagnostics.positionContext).toBe("unavailable");
  });

  it("workspace 포지션 문맥은 계좌·종목 집합·TTL이 모두 일치할 때만 재사용한다", async () => {
    let currentNow = NOW;
    const parts = dependencies();
    const portfolio = {
      getInstruments: vi.fn().mockResolvedValue([]),
      getPortfolio: vi.fn().mockResolvedValue({
        selectedAccountId: "account-1",
        asOf: parts.series.at(-1)!.closeTime,
        holdings: [{ symbol: "005930", quantity: 7, averagePrice: 190 }],
      }),
    };
    const subject = new ScalpingService(
      parts.toss as never, parts.kis as never, parts.scanner as never, parts.live as never,
      parts.repository as never, parts.rust as never, parts.ai as never,
      portfolio as never, undefined, {
        ...config(),
        workspaceContextTtlMs: 10,
        now: () => currentNow,
      },
    );
    await subject.workspace({
      accountId: "account-1",
      criterion: "volume",
      topCount: 1,
      interval: "1m",
      layoutColumns: 1,
      preset: "trend",
    });

    parts.rust.compute.mockClear();
    const matching = await subject.realtimeAnalysis({
      accountId: "account-1",
      symbols: ["005930"],
      interval: "1m",
      preset: "trend",
    });
    expect((parts.rust.compute.mock.calls[0]![1] as Record<string, any>)
      .scalping_analysis.instruments[0].position).toMatchObject({ quantity: 7 });
    expect(matching.diagnostics.positionContext).toBe("latest_workspace_snapshot");

    parts.rust.compute.mockClear();
    const otherAccount = await subject.realtimeAnalysis({
      accountId: "account-2",
      symbols: ["005930"],
      interval: "1m",
      preset: "trend",
    });
    expect((parts.rust.compute.mock.calls[0]![1] as Record<string, any>)
      .scalping_analysis.instruments[0].position).toBeUndefined();
    expect(otherAccount.diagnostics.positionContext).toBe("unavailable");

    parts.rust.compute.mockClear();
    const otherSymbols = await subject.realtimeAnalysis({
      accountId: "account-1",
      symbols: ["000660"],
      interval: "1m",
      preset: "trend",
    });
    expect((parts.rust.compute.mock.calls[0]![1] as Record<string, any>)
      .scalping_analysis.instruments[0].position).toBeUndefined();
    expect(otherSymbols.diagnostics.positionContext).toBe("unavailable");

    currentNow += 10;
    parts.rust.compute.mockClear();
    const expired = await subject.realtimeAnalysis({
      accountId: "account-1",
      symbols: ["005930"],
      interval: "1m",
      preset: "trend",
    });
    expect((parts.rust.compute.mock.calls[0]![1] as Record<string, any>)
      .scalping_analysis.instruments[0].position).toBeUndefined();
    expect(expired.diagnostics.positionContext).toBe("unavailable");
  });

  it("실시간 Rust 분석은 공유 실제 holdings 대신 명시한 가상 포지션만 사용한다", async () => {
    const parts = dependencies();
    const portfolio = {
      getInstruments: vi.fn().mockResolvedValue([]),
      getPortfolio: vi.fn().mockResolvedValue({
        selectedAccountId: "account-1",
        asOf: parts.series.at(-1)!.closeTime,
        holdings: [{ symbol: "005930", quantity: 99, averagePrice: 1 }],
      }),
    };
    const subject = new ScalpingService(
      parts.toss as never, parts.kis as never, parts.scanner as never, parts.live as never,
      parts.repository as never, parts.rust as never, parts.ai as never,
      portfolio as never, undefined, config(),
    );
    await subject.workspace({
      criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
    });
    parts.rust.compute.mockClear();
    const asOf = parts.series.at(-1)!.closeTime;
    const realtime = await subject.realtimeAnalysis({
      symbols: ["005930"],
      interval: "1m",
      preset: "risk_management",
      positionContext: {
        mode: "isolated",
        positions: [{ symbol: "005930", quantity: 3, averagePrice: 190, asOf }],
      },
    }) as Record<string, any>;
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.instruments[0].position).toEqual({
      as_of_timestamp: asOf,
      quantity: 3,
      average_price: 190,
    });
    expect(realtime.diagnostics.positionContext).toBe("isolated_request");
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

  it("excludes a provider-labeled final candle whose close is still in the future", async () => {
    const parts = dependencies();
    const last = parts.series.at(-1)!;
    const unclosedFinal = {
      ...last,
      openTime: last.closeTime,
      closeTime: new Date(Date.parse(last.closeTime) + 60_000).toISOString(),
      open: last.close,
      high: last.close + 2,
      low: last.close - 1,
      close: last.close + 1,
      state: "final" as const,
    };
    parts.repository.listBars.mockResolvedValue([...parts.series, unclosedFinal]);

    await service(parts).forecast({ symbols: ["005930"], interval: "1m" });

    const rustRequest = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    const aiRequest = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(rustRequest.scalping_analysis.instruments[0].bars.at(-1).timestamp)
      .toBe(marketLocalTimestamp(last.closeTime, "KR"));
    expect(aiRequest.series[0].input_end_at).toBe(last.closeTime);
    expect(aiRequest.series[0].bars.some(
      ({ timestamp }: { timestamp: string }) => timestamp === unclosedFinal.closeTime,
    )).toBe(false);
  });

  it("excludes a future-close final candle from realtime Rust analysis", async () => {
    const parts = dependencies();
    const last = parts.series.at(-1)!;
    const unclosedFinal = {
      ...last,
      openTime: last.closeTime,
      closeTime: new Date(Date.parse(last.closeTime) + 60_000).toISOString(),
      open: last.close,
      high: last.close + 2,
      low: last.close - 1,
      close: last.close + 1,
      state: "final" as const,
    };
    parts.repository.listBars.mockResolvedValue([...parts.series, unclosedFinal]);

    await service(parts).realtimeAnalysis({
      symbols: ["005930"],
      interval: "1m",
      preset: "trend",
    }, { skipAutomaticRefresh: true });

    const rustRequest = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(rustRequest.scalping_analysis.instruments[0].bars.at(-1).timestamp)
      .toBe(marketLocalTimestamp(last.closeTime, "KR"));
    expect(rustRequest.scalping_analysis.instruments[0].bars).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timestamp: marketLocalTimestamp(unclosedFinal.closeTime, "KR"),
        }),
      ]),
    );
  });

  it("propagates cancellation into realtime Rust computation", async () => {
    const parts = dependencies();
    let rustSignal: AbortSignal | undefined;
    parts.rust.compute.mockImplementation((
      _kind: unknown,
      _payload: unknown,
      options: { signal?: AbortSignal },
    ) => new Promise((_resolve, reject) => {
      rustSignal = options.signal;
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = service(parts).realtimeAnalysis({
      symbols: ["005930"],
      interval: "1m",
      preset: "trend",
    }, {
      signal: controller.signal,
      skipAutomaticRefresh: true,
    });
    await vi.waitFor(() => expect(rustSignal).toBe(controller.signal));

    controller.abort(new Error("simulation stopped during Rust analysis"));

    await expect(pending).rejects.toThrow("simulation stopped during Rust analysis");
    expect(rustSignal?.aborted).toBe(true);
  });

  it("keeps full KR session evidence while bounding the model context", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue([
      ...krBarsFromClose("2026-07-21T08:01:00+09:00", 1),
      ...krBarsFromClose("2026-07-21T13:51:00+09:00", 100),
    ]);

    await service(parts, {
      forecastMaximumBars: 100,
      now: () => Date.parse("2026-07-21T15:30:30+09:00"),
    }).forecast({ marketCountry: "KR", symbols: ["005930"], interval: "1m" });

    const rustRequest = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(rustRequest.scalping_analysis.instruments[0].session_windows).toEqual([
      { kind: "pre_market", open_minute: 480, close_minute: 530, local_date_offset: 0 },
      { kind: "regular_market", open_minute: 540, close_minute: 930, local_date_offset: 0 },
      { kind: "after_market", open_minute: 940, close_minute: 1_200, local_date_offset: 0 },
    ]);
    const aiRequest = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(aiRequest.series[0].bars).toHaveLength(100);
    expect(aiRequest.series[0].future_timestamps[0]).toBe("2026-07-21T06:41:00.000Z");
  });

  it("rechecks the batch immediately before AI dispatch after a slow calendar call", async () => {
    const parts = dependencies();
    let now = Date.parse("2026-07-21T13:50:30.000Z");
    let calendarCalls = 0;
    parts.repository.listBars.mockResolvedValue(
      usBarsFromClose("2026-07-21T13:31:00.000Z", 20, "2026-07-21"),
    );
    parts.toss.getMarketCalendar.mockImplementation(async (_market: string, sessionDate: string) => {
      calendarCalls += 1;
      if (calendarCalls >= 2) now = Date.parse("2026-07-21T13:51:30.000Z");
      return fullUsCalendar(sessionDate);
    });

    const output = await service(parts, { now: () => now })
      .forecast({ marketCountry: "US", symbols: ["AAPL"], interval: "1m" });

    expect(parts.rust.compute).toHaveBeenCalledTimes(1);
    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output.predictions[0]).toMatchObject({
      symbol: "AAPL",
      unavailable: { code: "stale_final_bar" },
    });
  });

  it("uses finalized NXT after-market bars for Rust analysis and live AI forecasts", async () => {
    const parts = dependencies();
    const afterMarket = krBarsFromClose("2026-07-21T15:41:00+09:00", 32);
    parts.repository.listBars.mockResolvedValue(afterMarket);
    await service(parts, { now: () => Date.parse("2026-07-21T16:12:30+09:00") })
      .forecast({ marketCountry: "KR", symbols: ["005930"], interval: "1m" });

    const rustPayload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(rustPayload.scalping_analysis.instruments[0]).toMatchObject({
      session_windows: [
        { kind: "regular_market", open_minute: 540, close_minute: 930 },
        { kind: "after_market", open_minute: 940, close_minute: 1_200 },
      ],
    });
    expect(rustPayload.scalping_analysis.instruments[0].bars.at(-1).timestamp)
      .toBe("2026-07-21T16:12:00.000+09:00");
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].input_end_at).toBe("2026-07-21T07:12:00.000Z");
    expect(request.series[0].future_timestamps[0]).toBe("2026-07-21T07:13:00.000Z");
    expect(request.series[0].future_timestamps.at(-1)).toBe("2026-07-21T08:12:00.000Z");
  });

  it("continues an NXT after-market forecast into the next Toss-confirmed KR regular session", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(krBarsFromClose("2026-07-21T19:06:00+09:00", 20));
    parts.toss.getMarketCalendar.mockResolvedValue({
      marketCountry: "KR", sessionDate: "2026-07-22",
      regularMarket: {
        startAt: "2026-07-22T09:00:00+09:00",
        endAt: "2026-07-22T15:30:00+09:00",
      },
    });

    await service(parts, { now: () => Date.parse("2026-07-21T19:25:30+09:00") })
      .forecast({ marketCountry: "KR", symbols: ["005930"], interval: "1m" });

    expect(parts.toss.getMarketCalendar).toHaveBeenCalledWith("KR", "2026-07-22");
    expect(parts.ai.forecast).toHaveBeenCalledTimes(1);
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    const future = request.series[0].future_timestamps as string[];
    expect(future).toHaveLength(60);
    expect(future[0]).toBe("2026-07-21T10:26:00.000Z");
    expect(future[34]).toBe("2026-07-21T11:00:00.000Z");
    expect(future[35]).toBe("2026-07-22T00:01:00.000Z");
    expect(future.at(-1)).toBe("2026-07-22T00:25:00.000Z");
    expect(future.every((timestamp, index) => (
      index === 0 || Date.parse(timestamp) > Date.parse(future[index - 1]!)
    ))).toBe(true);
  });

  it("skips only calendar-confirmed KR closures when extending an NXT forecast", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(krBarsFromClose("2026-07-21T19:37:00+09:00", 20));
    parts.toss.getMarketCalendar.mockImplementation(async (marketCountry: "KR" | "US", sessionDate: string) => ({
      marketCountry,
      sessionDate,
      regularMarket: sessionDate === "2026-07-22" ? null : {
        startAt: `${sessionDate}T09:00:00+09:00`,
        endAt: `${sessionDate}T15:30:00+09:00`,
      },
    }));

    await service(parts, { now: () => Date.parse("2026-07-21T19:56:30+09:00") })
      .forecast({ marketCountry: "KR", symbols: ["005930"], interval: "1m" });

    expect(parts.toss.getMarketCalendar.mock.calls.map(([, date]) => date)).toEqual([
      "2026-07-22", "2026-07-23",
    ]);
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    const future = request.series[0].future_timestamps as string[];
    expect(future.slice(0, 4)).toEqual([
      "2026-07-21T10:57:00.000Z",
      "2026-07-21T10:58:00.000Z",
      "2026-07-21T10:59:00.000Z",
      "2026-07-21T11:00:00.000Z",
    ]);
    expect(future[4]).toBe("2026-07-23T00:01:00.000Z");
    expect(future.at(-1)).toBe("2026-07-23T00:56:00.000Z");
    expect(future.some((timestamp) => timestamp.startsWith("2026-07-22"))).toBe(false);
  });

  it("fails closed when the next KR trading calendar cannot be confirmed", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(krBarsFromClose("2026-07-21T19:06:00+09:00", 20));
    parts.toss.getMarketCalendar.mockRejectedValue(new Error("calendar offline"));

    const output = await service(parts, { now: () => Date.parse("2026-07-21T19:25:30+09:00") })
      .forecast({ marketCountry: "KR", symbols: ["005930"], interval: "1m" });

    expect(parts.toss.getMarketCalendar).toHaveBeenCalledTimes(1);
    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output.predictions[0]).toMatchObject({
      symbol: "005930", unavailable: { code: "future_market_schedule_unavailable" },
    });
  });

  it("skips the scheduled 15:30-15:40 break when creating causal forecast timestamps", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue([
      ...krBarsFromClose("2026-07-21T08:01:00+09:00", 1),
      ...krBarsFromClose("2026-07-21T15:06:00+09:00", 20),
    ]);
    await service(parts, { now: () => Date.parse("2026-07-21T15:25:30+09:00") })
      .forecast({ marketCountry: "KR", symbols: ["005930"], interval: "1m" });
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].future_timestamps.slice(0, 7)).toEqual([
      "2026-07-21T06:26:00.000Z",
      "2026-07-21T06:27:00.000Z",
      "2026-07-21T06:28:00.000Z",
      "2026-07-21T06:29:00.000Z",
      "2026-07-21T06:30:00.000Z",
      "2026-07-21T06:41:00.000Z",
      "2026-07-21T06:42:00.000Z",
    ]);
    expect(request.series[0].future_timestamps.at(-1)).toBe("2026-07-21T07:35:00.000Z");
  });

  it("does not infer NXT after-market eligibility for a regular-only instrument", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(krBarsFromClose("2026-07-21T15:11:00+09:00", 20));
    const output = await service(parts, { now: () => Date.parse("2026-07-21T15:30:30+09:00") })
      .forecast({ marketCountry: "KR", symbols: ["005930"], interval: "1m" });

    const rustPayload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(rustPayload.scalping_analysis.instruments[0].session_windows).toEqual([
      { kind: "regular_market", open_minute: 540, close_minute: 930, local_date_offset: 0 },
    ]);
    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output.predictions[0]).toMatchObject({
      symbol: "005930",
      unavailable: { code: "future_market_schedule_unavailable" },
    });
  });

  it("builds KR session windows independently from each instrument's latest-session evidence", async () => {
    const parts = dependencies();
    const subject = service(parts) as unknown as {
      computeAnalysis(input: Record<string, unknown>): Promise<unknown>;
    };
    const preEvidence = krBarsFromClose("2026-07-21T08:01:00+09:00", 20)
      .map((bar) => ({ ...bar, symbol: "NXT" }));
    const regularOnly = krBarsFromClose("2026-07-21T09:01:00+09:00", 20)
      .map((bar) => ({ ...bar, symbol: "KRX" }));
    const outsideRegularQuote = {
      provider: "kis" as const, symbol: "KRX", observedAt: "2026-07-21T15:41:00+09:00",
      asks: [{ price: 101, quantity: 10 }], bids: [{ price: 99, quantity: 12 }],
      totalAskQuantity: 10, totalBidQuantity: 12,
    };
    await subject.computeAnalysis({
      symbols: ["NXT", "KRX"],
      interval: 1,
      preset: "trend",
      barsBySymbol: new Map([["NXT", preEvidence], ["KRX", regularOnly]]),
      metadata: new Map(), holdings: new Map(), books: new Map([["KRX", outsideRegularQuote]]), trades: new Map(),
      marketCountry: "KR", responseMode: "latest_summary", includeVolumeProfile: false,
    });

    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.instruments.map((instrument: Record<string, any>) => ({
      key: instrument.key,
      windows: instrument.session_windows,
      nextQuote: instrument.next_valid_quote_timestamp,
    }))).toEqual([
      {
        key: "NXT",
        windows: [
          { kind: "pre_market", open_minute: 480, close_minute: 530, local_date_offset: 0 },
          { kind: "regular_market", open_minute: 540, close_minute: 930, local_date_offset: 0 },
          { kind: "after_market", open_minute: 940, close_minute: 1_200, local_date_offset: 0 },
        ],
        nextQuote: undefined,
      },
      {
        key: "KRX",
        windows: [{ kind: "regular_market", open_minute: 540, close_minute: 930, local_date_offset: 0 }],
        nextQuote: undefined,
      },
    ]);
  });

  it("rejects gap, post-close, and next-session quotes as next-valid-quote timestamps", async () => {
    const parts = dependencies();
    const subject = service(parts) as unknown as {
      computeAnalysis(input: Record<string, unknown>): Promise<unknown>;
    };
    const inputs = [
      {
        symbol: "G0855",
        bars: krBarsFromClose("2026-07-21T08:01:00+09:00", 20),
        observedAt: "2026-07-21T08:55:00+09:00",
      },
      {
        symbol: "G1535",
        bars: [
          ...krBarsFromClose("2026-07-21T08:01:00+09:00", 1),
          ...krBarsFromClose("2026-07-21T15:11:00+09:00", 20),
        ],
        observedAt: "2026-07-21T15:35:00+09:00",
      },
      {
        symbol: "G2001",
        bars: krBarsFromClose("2026-07-21T19:41:00+09:00", 20),
        observedAt: "2026-07-21T20:01:00+09:00",
      },
      {
        symbol: "NEXTDAY",
        bars: krBarsFromClose("2026-07-21T15:11:00+09:00", 20),
        observedAt: "2026-07-22T09:01:00+09:00",
      },
    ];
    await subject.computeAnalysis({
      symbols: inputs.map(({ symbol }) => symbol),
      interval: 1,
      preset: "trend",
      barsBySymbol: new Map(inputs.map(({ symbol, bars: values }) => [
        symbol,
        values.map((bar) => ({ ...bar, symbol })),
      ])),
      metadata: new Map(), holdings: new Map(), trades: new Map(),
      books: new Map(inputs.map(({ symbol, observedAt }) => [symbol, {
        provider: "kis", symbol, observedAt,
        asks: [{ price: 101, quantity: 10 }], bids: [{ price: 99, quantity: 12 }],
        totalAskQuantity: 10, totalBidQuantity: 12,
      }])),
      marketCountry: "KR", responseMode: "latest_summary", includeVolumeProfile: false,
    });
    const payload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(payload.scalping_analysis.instruments).toHaveLength(4);
    for (const instrument of payload.scalping_analysis.instruments) {
      expect(instrument).not.toHaveProperty("next_valid_quote_timestamp");
    }
  });

  it("does not confirm a regular open as an integrated-session start when pre-market is configured", () => {
    const parts = dependencies();
    const subject = service(parts) as unknown as {
      confirmedSessionDates(
        values: IntradayBarRecord[],
        interval: 1,
        marketCountry: "KR",
        windows: Array<{ kind: "pre_market" | "regular_market" | "after_market"; openMinute: number; closeMinute: number }>,
      ): { started: string[]; complete: string[] };
    };
    const regularOnly = krBarsFromClose("2026-07-21T09:01:00+09:00", 20);
    expect(subject.confirmedSessionDates(regularOnly, 1, "KR", [
      { kind: "pre_market", openMinute: 480, closeMinute: 530 },
      { kind: "regular_market", openMinute: 540, closeMinute: 930 },
      { kind: "after_market", openMinute: 940, closeMinute: 1_200 },
    ])).toEqual({ started: [], complete: [] });
  });

  it("returns unavailable instead of fabricating a post-20:00 forecast schedule", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(krBarsFromClose("2026-07-21T19:41:00+09:00", 20));
    const output = await service(parts, { now: () => Date.parse("2026-07-21T20:00:30+09:00") })
      .forecast({ marketCountry: "KR", symbols: ["005930"], interval: "1m" });
    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output.predictions[0]).toMatchObject({
      symbol: "005930",
      unavailable: { code: "future_market_schedule_unavailable" },
    });
  });

  it("does not emit live forecast targets that are already in the past", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(parts.series.slice(0, -5));
    const output = await service(parts).forecast({ symbols: ["005930"], interval: "1m" });
    expect(parts.ai.forecast).not.toHaveBeenCalled();
    expect(output.predictions[0]).toMatchObject({
      symbol: "005930", unavailable: { code: "stale_final_bar" },
    });
  });

  it("re-reads a stale forecast batch after REST recovery and bounds cold history to the AI context", async () => {
    const parts = dependencies();
    const stale = parts.series.slice(0, -5);
    parts.repository.listBars
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValue(parts.series);
    parts.toss.getMinuteCandles.mockResolvedValue(parts.series.slice(-20).map((bar) => ({
      provider: "toss" as const,
      symbol: bar.symbol,
      timestamp: bar.openTime,
      sessionDate: bar.sessionDate,
      interval: "1m" as const,
      status: "final" as const,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      tradingAmount: bar.turnover,
    })));

    await service(parts, {
      barRefreshAfterMs: 3_600_000,
      workspaceBarLimit: 500,
      forecastMaximumBars: 100,
    }).forecast({ symbols: ["005930"], interval: "1m" });

    expect(parts.repository.listBars.mock.calls.every(([request]) => request.limit === 532)).toBe(true);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledWith(
      "005930",
      200,
      undefined,
      "KR",
      { bypassCache: true },
    );
    expect(parts.ai.forecast).toHaveBeenCalledTimes(1);
    const request = parts.ai.forecast.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].bars).toHaveLength(100);
    expect(request.series[0].input_end_at).toBe(parts.series.at(-1)!.closeTime);
    expect(Date.parse(request.series[0].future_timestamps[0]))
      .toBeGreaterThan(NOW);
  });

  it("constructs chronological rolling origins from observed future bar timestamps and forwards all costs", async () => {
    const parts = dependencies();
    const result = await service(parts).evaluate({
      symbols: ["005930"], interval: "1m", preset: "breakout",
      evaluation: {
        walkForward: true, retrospective: true,
        commissionBpsPerSide: 1.5, taxBpsOnExit: 18, spreadBpsRoundTrip: 8, slippageBpsPerSide: 3,
      },
    });
    const request = parts.ai.evaluate.mock.calls[0]![0] as Record<string, any>;
    const rustRequest = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(rustRequest.scalping_analysis.output_projection).toMatchObject({
      series_tail_points: 180,
      signal_snapshots: [{ instrument_key: "005930" }],
    });
    expect(rustRequest.scalping_analysis.signal).toEqual({ enabled: true, preset: "breakout" });
    expect(rustRequest.scalping_analysis.indicators).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "breakout-donchian", kind: "donchian_channel" }),
    ]));
    expect(rustRequest.scalping_analysis.output_projection.signal_snapshots[0].timestamps).toHaveLength(3);
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

  it("uses bounded Rust signal snapshots instead of full technical series for evaluation", async () => {
    const parts = dependencies();
    parts.rust.compute.mockImplementation(async (_job: string, payload: Record<string, any>) => ({
      result: {
        schema_version: "scalping-analysis-result/v3",
        instruments: payload.scalping_analysis.instruments.map((instrument: Record<string, any>) => {
          const selection = payload.scalping_analysis.output_projection.signal_snapshots
            .find((item: Record<string, unknown>) => item.instrument_key === instrument.key);
          return {
            instrument_key: instrument.key,
            signals: { points: [] },
            signal_snapshots: (selection?.timestamps ?? []).map((calculation_timestamp: string) => ({
              calculation_timestamp,
              technical_signal: 1,
              multi_timeframe_agreement: "aligned_bullish",
              basis_price: 100,
              stop_candidate_price: 99,
              target_candidate_price: 102,
            })),
          };
        }),
      },
    }));

    await service(parts).evaluate({
      symbols: ["005930"], interval: "1m",
      evaluation: {
        walkForward: true, retrospective: true,
        commissionBpsPerSide: 1, taxBpsOnExit: 1, spreadBpsRoundTrip: 1, slippageBpsPerSide: 1,
      },
    });

    const request = parts.ai.evaluate.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].origins).toHaveLength(3);
    expect(request.series[0].origins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        technical_signal: 1,
        regime: "aligned_bullish",
        target_stop: { side: "long", target_price: 102, stop_price: 99 },
      }),
    ]));
  });

  it.each([
    [
      "pre-to-regular",
      "2026-07-21T08:30:00+09:00",
      "2026-07-21T09:01:00+09:00",
      "2026-07-21T08:49:00+09:00",
      "2026-07-21T08:50:00+09:00",
      "2026-07-21T09:01:00+09:00",
    ],
    [
      "regular-to-after",
      "2026-07-21T15:10:00+09:00",
      "2026-07-21T15:41:00+09:00",
      "2026-07-21T15:29:00+09:00",
      "2026-07-21T15:30:00+09:00",
      "2026-07-21T15:41:00+09:00",
    ],
  ])("accepts the exact scheduled %s break as continuous retrospective active minutes", async (
    _label, beforeStart, afterStart, expectedOrigin, expectedLastBeforeBreak, expectedFirstAfterBreak,
  ) => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue([
      ...krBarsFromClose(beforeStart, 21),
      ...krBarsFromClose(afterStart, 60),
    ]);
    await service(parts).evaluate({
      symbols: ["005930"], interval: "1m",
      evaluation: {
        walkForward: true, retrospective: true,
        commissionBpsPerSide: 1, taxBpsOnExit: 1, spreadBpsRoundTrip: 1, slippageBpsPerSide: 1,
      },
    });
    const request = parts.ai.evaluate.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].origins).toHaveLength(1);
    expect(request.series[0].origins[0].origin).toBe(new Date(Date.parse(expectedOrigin)).toISOString());
    expect(request.series[0].origins[0].future_timestamps.slice(0, 2)).toEqual([
      new Date(Date.parse(expectedLastBeforeBreak)).toISOString(),
      new Date(Date.parse(expectedFirstAfterBreak)).toISOString(),
    ]);
  });

  it("still rejects a real missing minute inside an NXT retrospective window", async () => {
    const parts = dependencies();
    const sequence = [
      ...krBarsFromClose("2026-07-21T15:10:00+09:00", 21),
      ...krBarsFromClose("2026-07-21T15:41:00+09:00", 60),
    ];
    parts.repository.listBars.mockResolvedValue(sequence.filter((_, index) => index !== 30));
    const error: unknown = await service(parts).evaluate({
      symbols: ["005930"], interval: "1m",
      evaluation: {
        walkForward: true, retrospective: true,
        commissionBpsPerSide: 1, taxBpsOnExit: 1, spreadBpsRoundTrip: 1, slippageBpsPerSide: 1,
      },
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      message: "시간 순서 평가에 필요한 과거 분봉이 부족합니다.",
    });
    expect(parts.ai.evaluate).not.toHaveBeenCalled();
  });

  it("matches Rust +09:00 signal instants to UTC repository bars during evaluation", async () => {
    const parts = dependencies();
    const points = (parts.analysis.instruments[0].signals.points as Array<Record<string, unknown>>);
    for (const [index, point] of points.entries()) {
      const bar = parts.series[index]!;
      const local = new Date(Date.parse(bar.closeTime) + 9 * 60 * 60_000).toISOString();
      Object.assign(point, {
        calculation_timestamp: `${local.slice(0, 23)}+09:00`,
        status: "entry_candidate",
        multi_timeframe_agreement: "aligned_bullish",
        basis_price: bar.close,
        stop_candidate_price: bar.close - 1,
        target_price_range: { low: bar.close + 1, high: bar.close + 2 },
      });
    }
    await service(parts).evaluate({
      symbols: ["005930"], interval: "1m",
      evaluation: {
        walkForward: true, retrospective: true,
        commissionBpsPerSide: 1, taxBpsOnExit: 1, spreadBpsRoundTrip: 1, slippageBpsPerSide: 1,
      },
    });
    const request = parts.ai.evaluate.mock.calls[0]![0] as Record<string, any>;
    expect(request.series[0].origins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        technical_signal: 1,
        regime: "aligned_bullish",
        target_stop: expect.objectContaining({ side: "long" }),
      }),
    ]));
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
    expect(payload.scalping_analysis).toMatchObject({
      schema_version: "scalping-analysis-request/v3",
      output_projection: { series_tail_points: 180, signal_snapshots: [] },
    });
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

  it("분석 worker의 잘못된 schema를 client validation 오류로 노출하지 않는다", async () => {
    const parts = dependencies();
    parts.rust.compute.mockResolvedValue({
      result: {
        schema_version: "scalping-analysis-result/v2",
        instruments: [],
        private_provider_detail: "must-not-leak",
      },
      summary: {},
      warnings: [],
      artifacts: [],
    });

    await expect(service(parts).realtimeAnalysis({
      symbols: ["005930"],
      interval: "1m",
      preset: "trend",
    })).rejects.toBeInstanceOf(ProviderUnavailableError);
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
    const openTimes = [
      ...Array.from({ length: 50 }, (_, index) => Date.parse("2026-07-21T08:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 390 }, (_, index) => Date.parse("2026-07-21T09:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 60 }, (_, index) => Date.parse("2026-07-21T15:40:00+09:00") + index * 60_000),
    ];
    const candles = openTimes.map((openTime, index) => ({
      provider: "toss" as const,
      symbol: "005930",
      timestamp: new Date(openTime).toISOString(),
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

  it("continues cursor pagination across short pages until the integrated-session coverage target", async () => {
    const parts = dependencies();
    const openTimes = [
      ...Array.from({ length: 50 }, (_, index) => Date.parse("2026-07-21T08:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 390 }, (_, index) => Date.parse("2026-07-21T09:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 260 }, (_, index) => Date.parse("2026-07-21T15:40:00+09:00") + index * 60_000),
    ];
    const all = openTimes.map((openTime) => ({
      provider: "toss" as const,
      symbol: "005930",
      timestamp: new Date(openTime).toISOString(),
      sessionDate: "2026-07-21",
      interval: "1m" as const,
      status: "final" as const,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    parts.toss.getMinuteCandles.mockReset()
      .mockResolvedValueOnce(all.slice(510))
      .mockResolvedValueOnce(all.slice(320, 510))
      .mockResolvedValueOnce(all.slice(130, 320))
      .mockResolvedValueOnce(all.slice(0, 130));
    const instance = service(parts, {
      workspaceBarLimit: 700,
      now: () => Date.parse("2026-07-22T00:00:00.000Z"),
    }) as unknown as {
      fetchMinuteHistory(symbol: string, values: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };
    const result = await instance.fetchMinuteHistory("005930", []);
    expect(result).toHaveLength(700);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(4);
    expect(new Set(result.map(({ openTime }) => openTime)).size).toBe(700);
  });

  it("uses known continuous coverage to avoid a full history refresh but repairs a middle gap", async () => {
    const parts = dependencies();
    const openTimes = [
      ...Array.from({ length: 50 }, (_, index) => Date.parse("2026-07-21T08:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 390 }, (_, index) => Date.parse("2026-07-21T09:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 260 }, (_, index) => Date.parse("2026-07-21T15:40:00+09:00") + index * 60_000),
    ];
    const candles = openTimes.map((openTime) => ({
      provider: "toss" as const, symbol: "005930", timestamp: new Date(openTime).toISOString(),
      sessionDate: "2026-07-21", interval: "1m" as const, status: "final" as const,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    const records = candles.map((candle): IntradayBarRecord => ({
      ...parts.series[0]!,
      openTime: candle.timestamp,
      closeTime: new Date(Date.parse(candle.timestamp) + 60_000).toISOString(),
    }));
    const instance = service(parts, {
      workspaceBarLimit: 700,
      now: () => Date.parse("2026-07-22T00:00:00.000Z"),
    }) as unknown as {
      fetchMinuteHistory(symbol: string, values: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };

    parts.toss.getMinuteCandles.mockReset().mockResolvedValue(candles.slice(510));
    await instance.fetchMinuteHistory("005930", records);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(1);

    parts.toss.getMinuteCandles.mockReset()
      .mockResolvedValueOnce(candles.slice(510))
      .mockResolvedValueOnce(candles.slice(320, 510))
      .mockResolvedValueOnce(candles.slice(130, 320));
    const withMiddleGap = records.filter((_, index) => index !== 300);
    const repaired = await instance.fetchMinuteHistory("005930", withMiddleGap);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(3);
    expect(repaired.some(({ openTime }) => openTime === candles[300]!.timestamp)).toBe(true);
  });

  it("bounds a fully seeded refresh to the configured newest page despite a permanent historical gap", async () => {
    const parts = dependencies();
    const openTimes = [
      ...Array.from({ length: 50 }, (_, index) => Date.parse("2026-07-21T08:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 390 }, (_, index) => Date.parse("2026-07-21T09:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 260 }, (_, index) => Date.parse("2026-07-21T15:40:00+09:00") + index * 60_000),
    ];
    const candles = openTimes.map((openTime) => ({
      provider: "toss" as const, symbol: "005930", timestamp: new Date(openTime).toISOString(),
      sessionDate: "2026-07-21", interval: "1m" as const, status: "final" as const,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    const records = candles.map((candle): IntradayBarRecord => ({
      ...parts.series[0]!,
      openTime: candle.timestamp,
      closeTime: new Date(Date.parse(candle.timestamp) + 60_000).toISOString(),
    }));
    const seededWithPermanentGap = [
      {
        ...records[0]!,
        openTime: "2026-07-20T23:00:00.000Z",
        closeTime: "2026-07-20T23:01:00.000Z",
        sessionDate: "2026-07-20",
      },
      ...records.filter((_, index) => index !== 300),
    ];
    parts.toss.getMinuteCandles.mockReset().mockResolvedValue(candles.slice(510));
    const instance = service(parts, {
      workspaceBarLimit: 700,
      now: () => Date.parse("2026-07-22T00:00:00.000Z"),
    }) as unknown as {
      fetchMinuteHistory(symbol: string, values: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };

    await instance.fetchMinuteHistory("005930", seededWithPermanentGap);

    expect(seededWithPermanentGap).toHaveLength(700);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(1);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledWith("005930", 200, undefined, "KR");
  });

  it("repairs a recent gap from the newest page without expanding a seeded refresh", async () => {
    const parts = dependencies();
    const openTimes = [
      ...Array.from({ length: 50 }, (_, index) => Date.parse("2026-07-21T08:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 390 }, (_, index) => Date.parse("2026-07-21T09:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 260 }, (_, index) => Date.parse("2026-07-21T15:40:00+09:00") + index * 60_000),
    ];
    const candles = openTimes.map((openTime) => ({
      provider: "toss" as const, symbol: "005930", timestamp: new Date(openTime).toISOString(),
      sessionDate: "2026-07-21", interval: "1m" as const, status: "final" as const,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    const records = candles.map((candle): IntradayBarRecord => ({
      ...parts.series[0]!,
      openTime: candle.timestamp,
      closeTime: new Date(Date.parse(candle.timestamp) + 60_000).toISOString(),
    }));
    const recentGapIndex = 600;
    const seededWithRecentGap = [
      {
        ...records[0]!,
        openTime: "2026-07-20T23:00:00.000Z",
        closeTime: "2026-07-20T23:01:00.000Z",
        sessionDate: "2026-07-20",
      },
      ...records.filter((_, index) => index !== recentGapIndex),
    ];
    parts.toss.getMinuteCandles.mockReset().mockResolvedValue(candles.slice(510));
    const instance = service(parts, {
      workspaceBarLimit: 700,
      now: () => Date.parse("2026-07-22T00:00:00.000Z"),
    }) as unknown as {
      fetchMinuteHistory(symbol: string, values: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };

    const refreshed = await instance.fetchMinuteHistory("005930", seededWithRecentGap);

    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(1);
    expect(refreshed.some(({ openTime }) => openTime === candles[recentGapIndex]!.timestamp)).toBe(true);
  });

  it("keeps exhaustive pagination for a cold workspace", async () => {
    const parts = dependencies();
    const openTimes = [
      ...Array.from({ length: 50 }, (_, index) => Date.parse("2026-07-21T08:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 390 }, (_, index) => Date.parse("2026-07-21T09:00:00+09:00") + index * 60_000),
      ...Array.from({ length: 60 }, (_, index) => Date.parse("2026-07-21T15:40:00+09:00") + index * 60_000),
    ];
    const candles = openTimes.map((openTime) => ({
      provider: "toss" as const,
      symbol: "005930",
      timestamp: new Date(openTime).toISOString(),
      sessionDate: "2026-07-21",
      interval: "1m" as const,
      status: "final" as const,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    }));
    parts.toss.getMinuteCandles.mockReset()
      .mockResolvedValueOnce(candles.slice(300))
      .mockResolvedValueOnce(candles.slice(100, 300))
      .mockResolvedValueOnce(candles.slice(0, 100));
    const instance = service(parts) as unknown as {
      fetchMinuteHistory(symbol: string, values: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };

    const fetched = await instance.fetchMinuteHistory("005930", []);

    expect(fetched).toHaveLength(500);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(3);
  });

  it("콜드 히스토리가 목표 개수 미만이면 매 page마다 정렬·timezone 전체 검증을 반복하지 않는다", () => {
    const parts = dependencies();
    const instance = service(parts, { workspaceBarLimit: 700 }) as unknown as {
      minuteCoverageIsSufficient(values: IntradayBarRecord[], marketCountry: "KR"): boolean;
    };
    const invalidUntilTarget = Array.from({ length: 699 }, () => ({
      ...parts.series[0]!,
      openTime: "not-a-timestamp",
      closeTime: "not-a-timestamp",
    }));
    expect(instance.minuteCoverageIsSufficient(invalidUntilTarget, "KR")).toBe(false);
  });

  it("continues after a first page overlapping DB rows but stops when the provider ignores the cursor", async () => {
    const parts = dependencies();
    const page = Array.from({ length: 190 }, (_, index) => ({
      provider: "toss" as const,
      symbol: "005930",
      timestamp: new Date(Date.parse("2026-07-21T00:00:00.000Z") + index * 60_000).toISOString(),
      sessionDate: "2026-07-21",
      interval: "1m" as const,
      status: "final" as const,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    parts.toss.getMinuteCandles.mockReset().mockResolvedValue(page);
    const existing = page.map((candle) => ({
      ...parts.series[0]!,
      openTime: candle.timestamp,
      closeTime: new Date(Date.parse(candle.timestamp) + 60_000).toISOString(),
    }));
    const instance = service(parts) as unknown as {
      fetchMinuteHistory(symbol: string, values: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };
    const result = await instance.fetchMinuteHistory("005930", existing);
    expect(result).toHaveLength(190);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(2);
    expect(parts.toss.getMinuteCandles.mock.calls[1]![2]).toBeDefined();
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

  it("filters a Toss candle that begins exactly at the configured NXT close before persistence", async () => {
    const parts = dependencies();
    parts.toss.getMinuteCandles
      .mockResolvedValueOnce([
        {
          provider: "toss", symbol: "005930", timestamp: "2026-07-21T10:59:00.000Z",
          sessionDate: "2026-07-21", interval: "1m", status: "final",
          open: 100, high: 102, low: 99, close: 101, volume: 1_000,
        },
        {
          provider: "toss", symbol: "005930", timestamp: "2026-07-21T11:00:00.000Z",
          sessionDate: "2026-07-21", interval: "1m", status: "unknown",
          open: 101, high: 101, low: 101, close: 101, volume: 10,
        },
      ])
      .mockResolvedValueOnce([]);
    const instance = service(parts, {
      now: () => Date.parse("2026-07-21T20:00:30+09:00"),
    }) as unknown as {
      fetchMinuteHistory(symbol: string, existing: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };

    const bars = await instance.fetchMinuteHistory("005930", []);

    expect(bars.map(({ openTime, closeTime }) => ({ openTime, closeTime }))).toEqual([{
      openTime: "2026-07-21T10:59:00.000Z",
      closeTime: "2026-07-21T11:00:00.000Z",
    }]);
  });

  it("continues cold pagination when the newest Toss page contains only an NXT close-boundary row", async () => {
    const parts = dependencies();
    const candle = (timestamp: string) => ({
      provider: "toss" as const, symbol: "005930", timestamp,
      sessionDate: "2026-07-21", interval: "1m" as const, status: "final" as const,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    });
    parts.toss.getMinuteCandles.mockReset()
      .mockResolvedValueOnce([candle("2026-07-21T11:00:00.000Z")])
      .mockResolvedValueOnce([candle("2026-07-21T10:59:00.000Z")])
      .mockResolvedValueOnce([]);
    const instance = service(parts, {
      now: () => Date.parse("2026-07-21T20:00:30+09:00"),
    }) as unknown as {
      fetchMinuteHistory(symbol: string, existing: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };

    const bars = await instance.fetchMinuteHistory("005930", []);

    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(3);
    expect(bars.map(({ openTime }) => openTime)).toEqual(["2026-07-21T10:59:00.000Z"]);
  });

  it("stops cold pagination when Toss repeats the same invalid close-boundary page", async () => {
    const parts = dependencies();
    const boundary = {
      provider: "toss" as const, symbol: "005930", timestamp: "2026-07-21T11:00:00.000Z",
      sessionDate: "2026-07-21", interval: "1m" as const, status: "final" as const,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    };
    parts.toss.getMinuteCandles.mockReset().mockResolvedValue([boundary]);
    const instance = service(parts) as unknown as {
      fetchMinuteHistory(symbol: string, existing: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };

    await expect(instance.fetchMinuteHistory("005930", [])).resolves.toEqual([]);
    expect(parts.toss.getMinuteCandles).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["KR", "005930", "2026-07-21", "2026-07-20T23:49:00.000Z", "2026-07-20T23:50:00.000Z"],
    ["KR", "005930", "2026-07-21", "2026-07-21T06:29:00.000Z", "2026-07-21T06:30:00.000Z"],
    ["KR", "005930", "2026-07-21", "2026-07-21T10:59:00.000Z", "2026-07-21T11:00:00.000Z"],
    ["US", "AAPL", "2026-07-21", "2026-07-21T23:59:00.000Z", "2026-07-22T00:00:00.000Z"],
  ] as const)("keeps the last valid %s minute and rejects the configured session-close minute", async (
    marketCountry, symbol, sessionDate, validTimestamp, invalidTimestamp,
  ) => {
    const parts = dependencies();
    const candle = (timestamp: string) => ({
      provider: "toss" as const, symbol, timestamp, sessionDate,
      interval: "1m" as const, status: "final" as const,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    });
    parts.toss.getMinuteCandles.mockReset()
      .mockResolvedValueOnce([candle(validTimestamp), candle(invalidTimestamp)])
      .mockResolvedValueOnce([]);
    const instance = service(parts) as unknown as {
      fetchMinuteHistory(
        requestedSymbol: string, existing: IntradayBarRecord[], country: "KR" | "US",
      ): Promise<IntradayBarRecord[]>;
    };

    const bars = await instance.fetchMinuteHistory(symbol, [], marketCountry);

    expect(bars.map(({ openTime }) => openTime)).toEqual([validTimestamp]);
  });

  it("rejects non-minute-aligned and session-date-mismatched Toss candles", async () => {
    const parts = dependencies();
    const candle = (timestamp: string, sessionDate: string) => ({
      provider: "toss" as const, symbol: "005930", timestamp, sessionDate,
      interval: "1m" as const, status: "final" as const,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    });
    parts.toss.getMinuteCandles.mockReset()
      .mockResolvedValueOnce([
        candle("2026-07-21T02:00:00.000Z", "2026-07-21"),
        candle("2026-07-21T02:00:30.000Z", "2026-07-21"),
        candle("2026-07-21T02:01:00.000Z", "2026-07-20"),
      ])
      .mockResolvedValueOnce([]);
    const instance = service(parts) as unknown as {
      fetchMinuteHistory(symbol: string, existing: IntradayBarRecord[]): Promise<IntradayBarRecord[]>;
    };

    const bars = await instance.fetchMinuteHistory("005930", []);

    expect(bars.map(({ openTime }) => openTime)).toEqual(["2026-07-21T02:00:00.000Z"]);
  });

  it("rebuilds higher KR intervals from canonical one-minute windows and ignores legacy break buckets", async () => {
    const parts = dependencies();
    const oneMinute = [
      ...krBarsFromClose("2026-07-21T15:16:00+09:00", 15),
      ...krBarsFromClose("2026-07-21T15:31:00+09:00", 10),
      ...krBarsFromClose("2026-07-21T15:41:00+09:00", 15),
    ];
    parts.repository.listBars.mockResolvedValue(oneMinute);
    const instance = service(parts, { now: () => Date.parse("2026-07-21T16:00:00+09:00") }) as unknown as {
      loadBarsForSymbol(symbol: string, interval: 15, marketCountry: "KR"): Promise<{ bars: IntradayBarRecord[] }>;
    };
    const result = await instance.loadBarsForSymbol("005930", 15, "KR");
    expect(result.bars.map(({ openTime, closeTime, state }) => ({ openTime, closeTime, state }))).toEqual([
      { openTime: "2026-07-21T06:15:00.000Z", closeTime: "2026-07-21T06:30:00.000Z", state: "final" },
      { openTime: "2026-07-21T06:40:00.000Z", closeTime: "2026-07-21T06:55:00.000Z", state: "final" },
    ]);
    expect(result.bars.some(({ openTime }) => openTime === "2026-07-21T06:30:00.000Z")).toBe(false);
    const oneMinuteResult = await (instance as unknown as {
      loadBarsForSymbol(symbol: string, interval: 1, marketCountry: "KR"): Promise<{ bars: IntradayBarRecord[] }>;
    }).loadBarsForSymbol("005930", 1, "KR");
    expect(oneMinuteResult.bars).toHaveLength(30);
    expect(oneMinuteResult.bars.some(({ openTime }) => (
      Date.parse(openTime) >= Date.parse("2026-07-21T06:30:00.000Z")
      && Date.parse(openTime) < Date.parse("2026-07-21T06:40:00.000Z")
    ))).toBe(false);
  });

  it("merges canonical persisted higher history while filtering legacy 09:00-anchored NXT rows", async () => {
    const parts = dependencies();
    const currentMinutes = krBarsFromClose("2026-07-21T15:41:00+09:00", 15);
    const higher = (openTime: string, closeTime: string, sessionDate: string): IntradayBarRecord => ({
      ...currentMinutes[0]!,
      intervalMinutes: 15,
      openTime,
      closeTime,
      sessionDate,
      state: "final",
    });
    const historical = higher("2026-07-20T06:40:00.000Z", "2026-07-20T06:55:00.000Z", "2026-07-20");
    const legacy = higher("2026-07-21T06:30:00.000Z", "2026-07-21T06:45:00.000Z", "2026-07-21");
    parts.repository.listBars.mockImplementation(async ({ intervalMinutes }: { intervalMinutes: number }) => (
      intervalMinutes === 1 ? currentMinutes : [historical, legacy]
    ));
    const instance = service(parts, { now: () => Date.parse("2026-07-21T16:00:00+09:00") }) as unknown as {
      loadBarsForSymbol(symbol: string, interval: 15, marketCountry: "KR"): Promise<{ bars: IntradayBarRecord[] }>;
    };
    const result = await instance.loadBarsForSymbol("005930", 15, "KR");
    expect(result.bars.map(({ openTime }) => openTime)).toEqual([
      historical.openTime,
      "2026-07-21T06:40:00.000Z",
    ]);
  });

  it("exposes clamped partial KR regular and NXT after-market tails without synthetic 60-minute closes", async () => {
    const parts = dependencies();
    const oneMinute = [
      ...krBarsFromClose("2026-07-21T15:01:00+09:00", 30),
      ...krBarsFromClose("2026-07-21T19:41:00+09:00", 20),
    ];
    parts.repository.listBars.mockImplementation(async ({ intervalMinutes }: { intervalMinutes: number }) => (
      intervalMinutes === 1 ? oneMinute : []
    ));
    const instance = service(parts, { now: () => Date.parse("2026-07-21T20:01:00+09:00") }) as unknown as {
      loadBarsForSymbol(symbol: string, interval: 60, marketCountry: "KR"): Promise<{ bars: IntradayBarRecord[] }>;
    };
    const result = await instance.loadBarsForSymbol("005930", 60, "KR");
    expect(result.bars).toEqual([
      expect.objectContaining({
        openTime: "2026-07-21T06:00:00.000Z",
        closeTime: "2026-07-21T06:30:00.000Z",
        state: "final",
        quality: "partial",
      }),
      expect.objectContaining({
        openTime: "2026-07-21T10:40:00.000Z",
        closeTime: "2026-07-21T11:00:00.000Z",
        state: "final",
        quality: "partial",
      }),
    ]);
    expect(result.bars.some(({ closeTime }) => (
      closeTime === "2026-07-21T07:00:00.000Z"
      || closeTime === "2026-07-21T11:40:00.000Z"
    ))).toBe(false);
  });

  it("keeps a clamped session tail in the chart response but never sends it to Rust technical analysis", async () => {
    const parts = dependencies();
    const oneMinute = krBarsFromClose("2026-07-21T14:01:00+09:00", 90);
    parts.repository.listBars.mockImplementation(async ({ intervalMinutes }: { intervalMinutes: number }) => (
      intervalMinutes === 1 ? oneMinute : []
    ));
    const output = await service(parts, {
      now: () => Date.parse("2026-07-21T15:31:00+09:00"),
      barRefreshAfterMs: 10 * 60_000,
      minimumAnalysisBars: 1,
    }).workspace({
      criterion: "volume", topCount: 1, interval: "60m", layoutColumns: 1, preset: "trend",
    });

    expect(output.workspace.instruments[0]?.bars).toEqual([
      expect.objectContaining({
        openTime: "2026-07-21T05:00:00.000Z",
        closeTime: "2026-07-21T06:00:00.000Z",
        quality: "recovered",
      }),
      expect.objectContaining({
        openTime: "2026-07-21T06:00:00.000Z",
        closeTime: "2026-07-21T06:30:00.000Z",
        state: "final",
        quality: "partial",
      }),
    ]);
    const rustPayload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(rustPayload.scalping_analysis.instruments[0].bars).toHaveLength(1);
    expect(rustPayload.scalping_analysis.instruments[0].bars[0].timestamp)
      .toBe("2026-07-21T15:00:00.000+09:00");
    expect(JSON.stringify(rustPayload)).not.toContain("2026-07-21T15:30:00.000+09:00");
  });

  it.each([
    ["KR", "005930", [
      ["2026-07-21T05:00:00.000Z", "2026-07-21T06:00:00.000Z", "final"],
      ["2026-07-21T06:00:00.000Z", "2026-07-21T07:00:00.000Z", "forming"],
      ["2026-07-21T10:40:00.000Z", "2026-07-21T11:40:00.000Z", "final"],
    ]],
    ["US", "AAPL", [
      ["2026-07-21T18:30:00.000Z", "2026-07-21T19:30:00.000Z", "final"],
      ["2026-07-21T19:30:00.000Z", "2026-07-21T20:30:00.000Z", "forming"],
    ]],
  ] as const)("filters persisted %s 60-minute legacy tails regardless of forming state", async (marketCountry, symbol, rows) => {
    const parts = dependencies();
    const stored = rows.map(([openTime, closeTime, state]): IntradayBarRecord => ({
      ...parts.series[0]!,
      marketCountry,
      symbol,
      intervalMinutes: 60,
      openTime,
      closeTime,
      state,
      sessionDate: "2026-07-21",
    }));
    parts.repository.listBars.mockImplementation(async ({ intervalMinutes }: { intervalMinutes: number }) => (
      intervalMinutes === 1 ? [] : stored
    ));
    const instance = service(parts) as unknown as {
      loadBarsForSymbol(
        value: string, interval: 60, country: "KR" | "US",
      ): Promise<{ bars: IntradayBarRecord[] }>;
    };
    const result = await instance.loadBarsForSymbol(symbol, 60, marketCountry);
    expect(result.bars.map(({ openTime }) => openTime)).toEqual([rows[0][0]]);
  });

  it("uses the larger US calculation-history limit without sending the full history to charts", async () => {
    const parts = dependencies();
    parts.repository.listBars.mockResolvedValue(usBars());
    parts.toss.getRankings.mockResolvedValue([{
      provider: "toss", symbol: "AAPL", name: "Apple", marketCountry: "US", exchange: "NAS", currency: "USD",
      rank: 1, rankedAt: new Date(NOW).toISOString(), price: 220, volume: 1_000, tradingAmount: 220_000,
    }]);
    const output = await service(parts, {
      workspaceBarLimit: 500,
      usWorkspaceBarLimit: 900,
      workspaceChartBarLimit: 60,
    }).workspace({
      marketCountry: "US", criterion: "volume", topCount: 1, interval: "1m", layoutColumns: 1, preset: "trend",
      symbols: ["AAPL"],
    });

    expect(parts.repository.listBars.mock.calls.some(([request]) => (
      request.marketCountry === "US" && request.intervalMinutes === 1 && request.limit === 900
    ))).toBe(true);
    const rustPayload = parts.rust.compute.mock.calls[0]![1] as Record<string, any>;
    expect(rustPayload.scalping_analysis.instruments[0].bars).toHaveLength(200);
    expect(parts.rust.compute).toHaveBeenCalledTimes(1);
    expect(output.workspace.instruments[0].bars).toHaveLength(60);
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
