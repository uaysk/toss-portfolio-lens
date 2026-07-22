import { describe, expect, it } from "vitest";
import {
  SCALPING_MARKET_COUNTRIES,
  SCALPING_PRESETS,
  mergeScalpingStreamEvent,
  normalizeScalpingEvaluationMetrics,
  normalizeScalpingForecasts,
  normalizeScalpingStatus,
  normalizeScalpingWorkspace,
  parseScalpingStreamEvent,
  scalpingStreamUrl,
  scalpingTradeMarkerPoints,
  validateScalpingRequest,
  type ScalpingRequest,
} from "./scalping-assistant";

const request: ScalpingRequest = {
  marketCountry: "KR",
  criterion: "trading_amount",
  topCount: 10,
  interval: "1m",
  layoutColumns: 2,
  preset: "trend",
};

describe("scalping assistant request validation", () => {
  it("accepts both supported scan markets and rejects an unknown market", () => {
    expect(SCALPING_MARKET_COUNTRIES).toEqual(["KR", "US"]);
    for (const marketCountry of SCALPING_MARKET_COUNTRIES) {
      expect(validateScalpingRequest({ ...request, marketCountry })).toEqual([]);
    }
    expect(validateScalpingRequest({ ...request, marketCountry: "JP" as "KR" })).toContain("스캔 시장이 올바르지 않습니다.");
  });

  it("accepts the complete 5-50 boundary and all four presets", () => {
    expect(SCALPING_PRESETS).toEqual(["trend", "breakout", "mean_reversion", "risk_management"]);
    for (const topCount of [5, 50]) {
      for (const preset of SCALPING_PRESETS) {
        expect(validateScalpingRequest({ ...request, topCount, preset })).toEqual([]);
      }
    }
  });

  it("rejects counts outside 5-50 and fractional counts", () => {
    expect(validateScalpingRequest({ ...request, topCount: 4 })).toContain("표시 종목 수는 5~50의 정수여야 합니다.");
    expect(validateScalpingRequest({ ...request, topCount: 51 })).toContain("표시 종목 수는 5~50의 정수여야 합니다.");
    expect(validateScalpingRequest({ ...request, topCount: 5.5 })).toContain("표시 종목 수는 5~50의 정수여야 합니다.");
  });

  it("uses the server-provided top-count limits for counts and custom symbols", () => {
    const limits = { minimumTopCount: 5, maximumTopCount: 20 };
    expect(validateScalpingRequest({ ...request, topCount: 20 }, limits)).toEqual([]);
    expect(validateScalpingRequest({ ...request, topCount: 21 }, limits))
      .toContain("표시 종목 수는 5~20의 정수여야 합니다.");
    expect(validateScalpingRequest({ ...request, symbols: Array.from({ length: 21 }, (_, index) => `S${index}`) }, limits))
      .toContain("사용자 지정 종목 목록이 올바르지 않습니다.");
    expect(validateScalpingRequest({ ...request, topCount: 5, symbols: ["A", "B", "C", "D", "E", "F"] }, limits))
      .toContain("사용자 지정 종목 수는 표시 종목 수를 넘을 수 없습니다.");
  });
});

describe("scalping assistant response normalization", () => {
  it("keeps a disabled service explicit", () => {
    const status = normalizeScalpingStatus({
      enabled: false,
      reason: "SCALPING_ENABLED=false",
      providers: { toss: { status: "unavailable" }, kis: { status: "unavailable" } },
      limitations: ["historical_orderbook_unavailable"],
    });
    expect(status).toMatchObject({ enabled: false, message: "SCALPING_ENABLED=false" });
    expect(status.providers).toHaveLength(2);
    expect(status.limitations).toEqual(["historical_orderbook_unavailable"]);
  });

  it("reads concrete nested status limits and configured provider states", () => {
    const status = normalizeScalpingStatus({
      enabled: true,
      limits: { topCount: { minimum: 5, maximum: 20 }, maximumSubscriptions: 40 },
      providers: {
        toss: { configured: true },
        kis: { configured: true, websocket: { connection: "connected" } },
        ai: { configured: false },
      },
      capabilities: { autoOrder: false, mcp: false, historicalOrderbook: false },
      limitations: [],
    });
    expect(status.limits).toMatchObject({ minimumTopCount: 5, maximumTopCount: 20, maximumSubscriptions: 40 });
    expect(status.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "toss", status: "configured" }),
      expect.objectContaining({ name: "kis", status: "connected" }),
      expect.objectContaining({ name: "ai", status: "unavailable" }),
    ]));
    expect(status.capabilities).toContain("autoOrder:false");
  });

  it("joins scanner candidates and instruments while rejecting invalid OHLC", () => {
    const workspace = normalizeScalpingWorkspace({
      workspace: {
        generatedAt: "2026-07-21T09:05:00+09:00",
        criterion: "volatility",
        requestedTopCount: 5,
        interval: "5m",
        layoutColumns: 3,
        preset: "breakout",
        quality: { status: "partial", reasons: [], missing: ["kis"], sources: ["toss"] },
        candidates: [{
          symbol: "005930",
          name: "삼성전자",
          currency: "KRW",
          providerRanks: { toss: 1 },
          tradingAmount: 1000000,
          quality: { status: "partial", reasons: [], missing: ["spread"], sources: ["toss"] },
        }],
        instruments: [{
          symbol: "005930",
          bars: [
            { timestamp: "2026-07-21T09:00:00+09:00", open: 70000, high: 70100, low: 69900, close: 70050, complete: true, session_vwap: 70020 },
            { timestamp: "2026-07-21T09:05:00+09:00", open: 70050, high: 69900, low: 69800, close: 70000, complete: true },
          ],
          orderbook_status: { status: "unavailable", reason: "historical orderbook is not retained" },
        }],
      },
    }, request);

    expect(workspace).toMatchObject({ marketCountry: "KR", criterion: "volatility", interval: "5m", layoutColumns: 3, preset: "breakout" });
    expect(workspace.candidates[0]?.bars).toHaveLength(1);
    expect(workspace.candidates[0]?.bars[0]?.sessionVwap).toBe(70020);
    expect(workspace.candidates[0]?.orderbook).toBeUndefined();
    expect(workspace.candidates[0]?.orderbookUnavailableReason).toBe("historical orderbook is not retained");
    expect(workspace.candidates[0]?.forecast).toBeUndefined();
  });

  it("normalizes an applied US market from either response casing and falls back to the request", () => {
    const usRequest: ScalpingRequest = { ...request, marketCountry: "US" };
    expect(normalizeScalpingWorkspace({ workspace: { market_country: "US" } }, request).marketCountry).toBe("US");
    expect(normalizeScalpingWorkspace({ workspace: { marketCountry: "KR" } }, usRequest).marketCountry).toBe("KR");
    expect(normalizeScalpingWorkspace({ workspace: {} }, usRequest).marketCountry).toBe("US");
  });

  it("keeps only canonical US exchange codes from candidate metadata", () => {
    const usRequest: ScalpingRequest = { ...request, marketCountry: "US" };
    const workspace = normalizeScalpingWorkspace({ workspace: {
      marketCountry: "US",
      candidates: [
        { symbol: "AAPL", name: "Apple", currency: "USD", exchange: "nas", quality: { status: "available", sources: ["toss"] } },
        { symbol: "BRK.B", name: "Berkshire", currency: "USD", exchange: "NYSE", quality: { status: "available", sources: ["toss"] } },
      ],
    } }, usRequest);
    expect(workspace.candidates[0]?.exchange).toBe("NAS");
    expect(workspace.candidates[1]?.exchange).toBeUndefined();
  });

  it("normalizes the concrete server bars, Rust technical result, realtime snapshot, and stored prediction", () => {
    const closeTime = "2026-07-21T00:01:00.000Z";
    const rustCloseTime = "2026-07-21T09:01:00.000+09:00";
    const workspace = normalizeScalpingWorkspace({ workspace: {
      generatedAt: "2026-07-21T00:02:00.000Z",
      criterion: "trading_amount", requestedTopCount: 5, interval: "1m", layoutColumns: 2, preset: "trend",
      candidates: [{
        symbol: "005930", name: "삼성전자", currency: "KRW", providerRanks: { toss: 1 },
        price: 101, quality: { status: "available", reasons: [], missing: [], sources: ["toss", "kis"] },
      }],
      instruments: [{
        symbol: "005930",
        bars: [{
          symbol: "005930", intervalMinutes: 1, openTime: "2026-07-21T00:00:00.000Z", closeTime,
          sessionDate: "2026-07-21", state: "final", open: 100, high: 102, low: 99, close: 101,
          volume: 500, turnover: 50500, quality: "complete",
        }],
        technical: {
          intraday: {
            session_vwap: { points: [{ timestamp: rustCloseTime, values: { session_vwap: 100.5 } }] },
            anchored_vwap: { points: [{ timestamp: rustCloseTime, values: { anchored_vwap: 100.25 } }] },
            opening_range_5: { latest: { timestamp: closeTime, values: { high: 102, low: 99 } } },
            opening_range_15: { latest: { timestamp: closeTime, values: { high: 103, low: 98 } } },
            opening_range_30: { latest: { timestamp: closeTime, values: { high: 104, low: 97 } } },
            time_of_day_relative_volume: { latest: { timestamp: closeTime, values: { relative_volume: 1.8 } } },
            previous_session_levels: { latest: { timestamp: closeTime, values: { previous_high: 105, previous_low: 95, previous_close: 100 } } },
            current_session_levels: { latest: { timestamp: closeTime, values: { session_open: 100, session_high: 102, session_low: 99 } } },
            orderbook_imbalance: { values: { orderbook_imbalance: 0.2 } },
            execution_strength: { values: { execution_strength_percent: 125 } },
          },
          indicators: [{
            indicator_id: "trend-ema-fast", kind: "ema", availability: { status: "available" },
            points: [{ timestamp: rustCloseTime, values: { value: 100.4 } }],
          }],
          signals: { latest: {
            status: "entry_candidate", calculation_timestamp: closeTime, signal_timestamp: closeTime,
            earliest_eligible_timestamp: "2026-07-21T00:02:00.000Z", basis_price: 101,
            expected_entry_range: { low: 100.8, high: 101.2 }, stop_candidate_price: 99,
            target_price_range: { low: 104, high: 105 }, expected_reward_risk_ratio: 2,
            indicators: ["trend-ema-fast"], multi_timeframe_agreement: "aligned_bullish", confidence: 0.8,
            data_quality: { status: "available", reason: "finalized_ohlcv_bar_available" },
          } },
          volume_profile: { availability: { status: "available" }, profile: {
            point_of_control: 101, value_area_high: 103, value_area_low: 99, approximation: "bar_hlc3", buckets: [{ price_low: 99, price_high: 101, volume: 500 }],
          } },
          data_quality: { status: "available", reasons: [] },
        },
        realtime: {
          orderbook: { provider: "kis", symbol: "005930", observedAt: closeTime, asks: [{ price: 102, quantity: 20 }], bids: [{ price: 101, quantity: 25 }] },
          historicalOrderbook: { status: "unavailable", reason: "historical_orderbook_not_supplied" },
        },
        position: { quantity: 3, averagePrice: 98 },
        prediction: { status: "unavailable", reason: "prediction_not_generated" },
      }],
      quality: { status: "available", reasons: [], missing: [], sources: ["toss", "kis"] },
    } }, request);

    const candidate = workspace.candidates[0]!;
    expect(candidate.bars[0]).toMatchObject({ timestamp: closeTime, status: "final", tradingAmount: 50500, sessionVwap: 100.5, anchoredVwap: 100.25 });
    expect(candidate.bars[0]?.indicatorValues["trend-ema-fast:value"]).toBe(100.4);
    expect(candidate.levels).toMatchObject({ openingRange5: { high: 102, low: 99 }, previousClose: 100, dayOpen: 100 });
    expect(candidate).toMatchObject({ relativeVolume: 1.8, executionStrength: 125, signal: { state: "entry_candidate", eligibleAt: "2026-07-21T00:02:00.000Z", multiTimeframeAligned: true } });
    expect(candidate.orderbook).toMatchObject({ imbalance: 0.2, asks: [{ price: 102, quantity: 20 }] });
    expect(candidate.volumeProfile).toMatchObject({ status: "available", pointOfControl: 101, buckets: [{ priceLow: 99, priceHigh: 101, volume: 500 }] });
    expect(candidate.forecast).toMatchObject({ status: "unavailable", horizons: [], unavailableReason: "prediction_not_generated" });
    expect(candidate.indicators[0]).toMatchObject({ id: "trend-ema-fast", kind: "ema", status: "available", values: { value: 100.4 } });
  });

  it("never lets available technical data hide scanner or finalized-bar degradation", () => {
    const workspace = normalizeScalpingWorkspace({ workspace: {
      candidates: [{
        symbol: "AAPL", currency: "USD",
        quality: { status: "partial", reasons: ["warning_status_unavailable"], missing: ["spread"], sources: ["toss"] },
      }],
      instruments: [{
        symbol: "AAPL",
        bars: [{
          intervalMinutes: 1, closeTime: "2026-07-21T13:31:00.000Z", state: "final",
          open: 210, high: 211, low: 209, close: 210.5, quality: "partial",
        }],
        technical: { data_quality: { status: "available", reasons: ["indicator_available"], sources: ["rust"] } },
      }],
      quality: { status: "partial", sources: ["toss"] },
    } }, { ...request, marketCountry: "US" });

    expect(workspace.candidates[0]?.bars[0]?.quality).toBe("partial");
    expect(workspace.candidates[0]?.quality).toMatchObject({
      status: "partial",
      reasons: expect.arrayContaining(["warning_status_unavailable", "partial_final_intraday_bar", "indicator_available"]),
      missing: expect.arrayContaining(["spread", "complete_intraday_bar"]),
      sources: expect.arrayContaining(["toss", "rust", "derived"]),
    });
  });

  it("does not invent horizons for an unavailable or missing AI response", () => {
    expect(normalizeScalpingForecasts({ forecast: { status: "unavailable" }, predictions: [] }).size).toBe(0);
    const forecasts = normalizeScalpingForecasts({
      forecast: {
        model: { model_id: "NeoQuasar/Kronos-small", model_revision: "pinned", source_revision: "source", device: "unavailable", dtype: "float32" },
        generated_at: "2026-07-21T09:06:00+09:00",
      },
      predictions: [{
        instrument_key: "005930",
        status: "unavailable",
        input_end_at: "2026-07-21T09:05:00+09:00",
        horizons: [{ horizon_minutes: 5, up_probability: 0.99 }],
        unavailable: { code: "model_not_loaded", message: "model unavailable" },
      }],
    });
    expect(forecasts.get("005930")).toMatchObject({ status: "unavailable", horizons: [], unavailableReason: "model unavailable" });
  });

  it("merges only valid server stream bars and preserves forming/final status", () => {
    const initial = normalizeScalpingWorkspace({ workspace: {
      candidates: [{ symbol: "005930", name: "삼성전자", currency: "KRW", quality: { status: "available", reasons: [], missing: [], sources: ["kis"] } }],
      instruments: [],
      quality: { status: "available", reasons: [], missing: [], sources: ["kis"] },
    } }, request);
    const parsed = parseScalpingStreamEvent({ type: "bar", symbol: "005930", data: { intervalMinutes: 1, timestamp: "2026-07-21T09:01:00+09:00", open: 100, high: 102, low: 99, close: 101, status: "forming" } });
    expect(parsed).toBeDefined();
    const merged = mergeScalpingStreamEvent(initial, parsed!);
    expect(merged.candidates[0]?.bars).toEqual([expect.objectContaining({ intervalMinutes: 1, close: 101, status: "forming" })]);
    expect(merged.candidates[0]?.price).toBe(101);
  });

  it("preserves canonical KIS venues from snapshots and stream updates", () => {
    const initial = normalizeScalpingWorkspace({ workspace: {
      marketCountry: "KR",
      candidates: [{ symbol: "005930", currency: "KRW", quality: { status: "available", sources: ["kis"] } }],
      instruments: [{
        symbol: "005930",
        realtime: {
          trade: { market: "NXT", price: 101, executedAt: "2026-07-21T16:01:00+09:00" },
          orderbook: {
            market: "NXT", observedAt: "2026-07-21T16:01:00+09:00",
            asks: [{ price: 102, quantity: 3 }], bids: [{ price: 101, quantity: 4 }],
          },
        },
      }],
    } }, request);
    expect(initial.candidates[0]).toMatchObject({ venue: "NXT", orderbook: { venue: "NXT" } });

    const integrated = parseScalpingStreamEvent({
      type: "trade", symbol: "005930", marketCountry: "KR",
      data: { market: "INTEGRATED", price: 103, executionStrength: 120 },
    });
    expect(mergeScalpingStreamEvent(initial, integrated!).candidates[0]).toMatchObject({
      venue: "INTEGRATED", price: 103, executionStrength: 120,
    });
    const crossMarket = parseScalpingStreamEvent({
      type: "trade", symbol: "005930", marketCountry: "US", data: { market: "US", price: 999 },
    });
    expect(mergeScalpingStreamEvent(initial, crossMarket!)).toBe(initial);
  });

  it("keeps realtime quality monotone-worst and applies per-symbol provider diagnostics", () => {
    const initial = normalizeScalpingWorkspace({ workspace: {
      marketCountry: "US",
      interval: "1m",
      preset: "trend",
      candidates: [{
        symbol: "AAPL", exchange: "NAS", currency: "USD",
        quality: { status: "partial", reasons: ["spread_unavailable"], missing: ["spread"], sources: ["toss"] },
      }],
      quality: { status: "partial", sources: ["toss"] },
    } }, { ...request, marketCountry: "US" });
    const analysis = parseScalpingStreamEvent({
      type: "analysis",
      data: {
        schemaVersion: "scalping-realtime-analysis/v1", interval: "1m", preset: "trend",
        technical: { instruments: [{ instrument_key: "AAPL", data_quality: { status: "available", sources: ["rust"] } }] },
      },
    });
    const afterAnalysis = mergeScalpingStreamEvent(initial, analysis!);
    expect(afterAnalysis.candidates[0]?.quality.status).toBe("partial");

    const diagnostic = parseScalpingStreamEvent({
      type: "diagnostic", symbol: "AAPL",
      data: { status: "source_unavailable", code: "subscription-rejected", message: "provider rejected subscription" },
    });
    const degraded = mergeScalpingStreamEvent(afterAnalysis, diagnostic!);
    expect(degraded.candidates[0]?.quality).toMatchObject({
      status: "source_unavailable",
      reasons: expect.arrayContaining(["subscription-rejected", "provider rejected subscription"]),
      sources: expect.arrayContaining(["toss", "rust", "kis"]),
    });
  });

  it("preserves a final partial stream bar and degrades only its candidate", () => {
    const initial = normalizeScalpingWorkspace({ workspace: {
      candidates: [
        { symbol: "AAPL", currency: "USD", quality: { status: "available", sources: ["toss"] } },
        { symbol: "MSFT", currency: "USD", quality: { status: "available", sources: ["toss"] } },
      ],
      quality: { status: "available", sources: ["toss"] },
    } }, { ...request, marketCountry: "US" });
    const event = parseScalpingStreamEvent({
      type: "bar", symbol: "AAPL",
      data: {
        intervalMinutes: 1, closeTime: "2026-07-21T13:31:00.000Z", state: "final",
        open: 210, high: 211, low: 209, close: 210.5, quality: "partial",
      },
    });
    const merged = mergeScalpingStreamEvent(initial, event!);
    expect(merged.candidates[0]?.bars[0]).toMatchObject({ status: "final", quality: "partial" });
    expect(merged.candidates[0]?.quality.status).toBe("partial");
    expect(merged.candidates[1]?.quality.status).toBe("available");
  });

  it.each([
    ["1m", 1],
    ["5m", 5],
    ["15m", 15],
    ["30m", 30],
    ["60m", 60],
  ] as const)("maps %s only to an SSE bar with interval %i", (workspaceInterval, minutes) => {
    const scopedRequest = { ...request, interval: workspaceInterval };
    const initial = normalizeScalpingWorkspace({ workspace: {
      interval: workspaceInterval,
      candidates: [{ symbol: "005930", name: "삼성전자", currency: "KRW", quality: { status: "available", reasons: [], missing: [], sources: ["kis"] } }],
      instruments: [],
      quality: { status: "available", reasons: [], missing: [], sources: ["kis"] },
    } }, scopedRequest);
    const intervalField = minutes === 5 ? { interval_minutes: minutes } : { intervalMinutes: minutes };
    const parsed = parseScalpingStreamEvent({
      type: "bar",
      symbol: "005930",
      data: { ...intervalField, timestamp: "2026-07-21T09:05:00+09:00", open: 100, high: 103, low: 99, close: 102, status: "final" },
    });
    const merged = mergeScalpingStreamEvent(initial, parsed!);
    expect(merged.candidates[0]?.bars).toEqual([
      expect.objectContaining({ intervalMinutes: minutes, close: 102, status: "final" }),
    ]);
  });

  it("rejects stream bars whose interval is missing, unsupported, or different from the workspace", () => {
    const initial = normalizeScalpingWorkspace({ workspace: {
      interval: "15m",
      candidates: [{ symbol: "005930", name: "삼성전자", currency: "KRW", quality: { status: "available", reasons: [], missing: [], sources: ["kis"] } }],
      instruments: [],
      quality: { status: "available", reasons: [], missing: [], sources: ["kis"] },
    } }, { ...request, interval: "15m" });
    const base = { timestamp: "2026-07-21T09:15:00+09:00", open: 100, high: 103, low: 99, close: 102, status: "final" };
    for (const interval of [{}, { intervalMinutes: 2 }, { interval_minutes: 5 }]) {
      const parsed = parseScalpingStreamEvent({ type: "bar", symbol: "005930", data: { ...base, ...interval } });
      expect(mergeScalpingStreamEvent(initial, parsed!)).toBe(initial);
    }
  });

  it("merges a matching versioned realtime Rust analysis and rejects stale stream settings", () => {
    const at = "2026-07-21T09:01:00+09:00";
    const initial = normalizeScalpingWorkspace({ workspace: {
      interval: "1m",
      preset: "trend",
      candidates: [{ symbol: "005930", name: "삼성전자", currency: "KRW", quality: { status: "available", reasons: [], missing: [], sources: ["kis"] } }],
      instruments: [{ symbol: "005930", bars: [{ interval_minutes: 1, timestamp: at, open: 100, high: 103, low: 99, close: 102, state: "final" }] }],
      quality: { status: "available", reasons: [], missing: [], sources: ["kis"] },
    } }, request);
    const payload = {
      schemaVersion: "scalping-realtime-analysis/v1",
      interval: "1m",
      preset: "trend",
      technical: { instruments: [{
        instrument_key: "005930",
        indicators: [{
          indicator_id: "trend-ema-fast",
          kind: "ema",
          availability: { status: "available" },
          latest: { timestamp: at, values: { value: 101.5 } },
        }],
        intraday: {
          session_vwap: { latest: { timestamp: at, values: { session_vwap: 101 } } },
          time_of_day_relative_volume: { latest: { timestamp: at, values: { relative_volume: 1.7 } } },
          orderbook_imbalance: { values: { orderbook_imbalance: 0.25 } },
          execution_strength: { values: { execution_strength_percent: 123 } },
        },
        signals: { latest: { status: "hold", signal_timestamp: at, calculation_timestamp: at, basis_price: 102 } },
        data_quality: { status: "available", reasons: [] },
      }] },
    };
    const parsed = parseScalpingStreamEvent({ type: "analysis", data: payload });
    expect(parsed?.type).toBe("analysis");
    const merged = mergeScalpingStreamEvent(initial, parsed!);
    expect(merged.candidates[0]).toMatchObject({
      relativeVolume: 1.7,
      executionStrength: 123,
      signal: { state: "hold", basisPrice: 102 },
      indicators: [{ id: "trend-ema-fast", values: { value: 101.5 } }],
    });
    expect(merged.candidates[0]?.bars[0]).toMatchObject({ sessionVwap: 101, indicatorValues: { "trend-ema-fast:value": 101.5 } });

    for (const stale of [
      { ...payload, schemaVersion: "scalping-realtime-analysis/v0" },
      { ...payload, interval: "5m" },
      { ...payload, preset: "breakout" },
    ]) {
      expect(mergeScalpingStreamEvent(initial, parseScalpingStreamEvent({ type: "analysis", data: stale })!)).toBe(initial);
    }
  });

  it("builds the authenticated UI stream route with the applied interval and preset", () => {
    const url = new URL(scalpingStreamUrl(["AAPL", "spy"], "30m", "breakout", "US", { AAPL: "NAS", SPY: "NYS" }), "http://localhost");
    expect(url.pathname).toBe("/api/portfolio/scalping/stream");
    expect(url.searchParams.get("symbols")).toBe("AAPL,SPY");
    expect(url.searchParams.get("interval")).toBe("30m");
    expect(url.searchParams.get("preset")).toBe("breakout");
    expect(url.searchParams.get("marketCountry")).toBe("US");
    expect(url.searchParams.get("exchanges")).toBe("AAPL:NAS,SPY:NYS");
  });

  it("does not send US exchange routing for a domestic stream or invalid runtime exchange", () => {
    const domestic = new URL(scalpingStreamUrl(["005930"], "1m", "trend", "KR", { "005930": "NAS" }), "http://localhost");
    const invalid = new URL(scalpingStreamUrl(["AAPL"], "1m", "trend", "US", { AAPL: "NASDAQ" as "NAS" }), "http://localhost");
    expect(domestic.searchParams.has("exchanges")).toBe(false);
    expect(invalid.searchParams.has("exchanges")).toBe(false);
  });
});

describe("scalping evaluation and trade evidence", () => {
  it("normalizes every persisted evaluation metric needed by the result table", () => {
    const metrics = normalizeScalpingEvaluationMetrics({ content: [{
      horizon_minutes: 5,
      overall: { count: 12, direction_accuracy: 0.75, mae: 0.01, rmse: 0.02 },
      quantile_coverage: [{ quantile: 0.1, value: 0.17 }, { quantile: 0.9, value: 0.83 }],
      up_probability_brier: 0.21,
      target_stop_first_count: 4,
      target_stop_first_accuracy: 0.5,
      calibration: Array.from({ length: 10 }, () => ({ count: 0 })),
      by_symbol: { "005930": { count: 12, direction_accuracy: 0.75, mae: 0.01, rmse: 0.02 } },
      by_time: { "09": { count: 12, direction_accuracy: 0.75, mae: 0.01, rmse: 0.02 } },
      by_regime: { aligned_bullish: { count: 12, direction_accuracy: 0.75, mae: 0.01, rmse: 0.02 } },
      strategy_comparison: {
        technical_trade_count: 8,
        ai_filtered_trade_count: 5,
        technical_net_return: -0.03,
        ai_filtered_net_return: 0.04,
        technical_max_drawdown: 0.08,
        ai_filtered_max_drawdown: 0.05,
      },
    }] });
    expect(metrics).toEqual([expect.objectContaining({
      horizonMinutes: 5,
      overall: { count: 12, directionAccuracy: 0.75, mae: 0.01, rmse: 0.02 },
      targetStopFirstCount: 4,
      targetStopFirstAccuracy: 0.5,
      calibrationBinCount: 10,
      strategy: expect.objectContaining({ technicalNetReturn: -0.03, aiFilteredTradeCount: 5 }),
    })]);
    expect(metrics[0]?.quantileCoverage).toEqual([{ quantile: 0.1, value: 0.17 }, { quantile: 0.9, value: 0.83 }]);
    expect(Object.keys(metrics[0]?.byRegime ?? {})).toEqual(["aligned_bullish"]);
  });

  it("expands daily groups into truthful order-average fill markers without ordered-at fallback", () => {
    const workspace = normalizeScalpingWorkspace({ workspace: {
      candidates: [{ symbol: "005930", name: "삼성전자", currency: "KRW", quality: { status: "available", reasons: [], missing: [], sources: ["toss"] } }],
      instruments: [{
        symbol: "005930",
        tradeMarkers: [{
          id: "daily-buy",
          date: "2026-07-21",
          side: "buy",
          order_count: 3,
          details: [
            { order_id: "order-1", filled_at: "2026-07-21T09:01:20+09:00", filled_quantity: 2, average_filled_price: 100, filled_amount: 200 },
            { order_id: "order-2", filled_at: "2026-07-21T09:04:10+09:00", filled_quantity: 1, average_filled_price: 101, filled_amount: 101 },
            { order_id: "order-3", ordered_at: "2026-07-21T09:05:00+09:00", filled_quantity: 1, average_filled_price: 102 },
          ],
        }],
      }],
      quality: { status: "available", reasons: [], missing: [], sources: ["toss"] },
    } }, request);
    expect(workspace.candidates[0]?.tradeMarkers).toEqual([
      expect.objectContaining({ id: "daily-buy:order-1", timestamp: "2026-07-21T09:01:20+09:00", averagePrice: 100, detailLevel: "order_average_fill", groupOrderCount: 3 }),
      expect.objectContaining({ id: "daily-buy:order-2", timestamp: "2026-07-21T09:04:10+09:00", averagePrice: 101, detailLevel: "order_average_fill", groupOrderCount: 3 }),
      expect.objectContaining({ id: "daily-buy:order-3", averagePrice: 102, detailLevel: "order_average_fill", groupOrderCount: 3 }),
    ]);
    expect(workspace.candidates[0]?.tradeMarkers[2]?.timestamp).toBeUndefined();
  });

  it("never pins out-of-range or missing-price fills onto the first or final visible candle", () => {
    const bars = [
      { timestamp: "2026-07-21T09:01:00+09:00", intervalMinutes: 1 as const, open: 100, high: 101, low: 99, close: 100, status: "final" as const, indicatorValues: {} },
      { timestamp: "2026-07-21T09:02:00+09:00", intervalMinutes: 1 as const, open: 100, high: 102, low: 99, close: 101, status: "final" as const, indicatorValues: {} },
      { timestamp: "2026-07-21T09:03:00+09:00", intervalMinutes: 1 as const, open: 101, high: 103, low: 100, close: 102, status: "final" as const, indicatorValues: {} },
    ];
    const markers = [
      { id: "past", timestamp: "2026-07-21T08:59:59+09:00", side: "buy" as const, averagePrice: 99 },
      { id: "visible", timestamp: "2026-07-21T09:01:20+09:00", side: "buy" as const, averagePrice: 100.5 },
      { id: "missing-price", timestamp: "2026-07-21T09:02:20+09:00", side: "sell" as const },
      { id: "future", timestamp: "2026-07-21T09:03:01+09:00", side: "sell" as const, averagePrice: 103 },
    ];
    expect(scalpingTradeMarkerPoints(bars, markers)).toEqual([
      expect.objectContaining({ timestamp: "2026-07-21T09:02:00+09:00", price: 100.5, marker: expect.objectContaining({ id: "visible" }) }),
    ]);
  });
});
