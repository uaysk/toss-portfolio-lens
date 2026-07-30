import { describe, expect, it, vi } from "vitest";
import type { BinanceKline } from "./binance-market-data.js";
import {
  CRYPTO_RUST_INDICATORS,
  CRYPTO_RUST_OUTPUT_TAIL_POINTS,
  CryptoRustTechnicalAnalyzer,
  type CryptoRustComputePort,
} from "./crypto-rust-technical.js";

const START = Date.parse("2026-01-02T00:00:00.000Z");

function bar(
  index: number,
  input: Partial<Pick<BinanceKline, "interval" | "final" | "symbol">> = {},
): BinanceKline {
  const interval = input.interval ?? "1m";
  const duration = interval === "1m" ? 60_000 : interval === "30s" ? 30_000 : 15_000;
  const openTime = START + index * 60_000;
  const open = 100 + index;
  return {
    symbol: input.symbol ?? "BTCUSDT",
    interval,
    openTime,
    closeTime: openTime + duration - 1,
    open,
    high: open + 2,
    low: open - 1,
    close: open + 1,
    volume: 10 + index,
    quoteVolume: (10 + index) * (open + 1),
    tradeCount: 100 + index,
    final: input.final ?? true,
  };
}

function scalpingResult(payload: Record<string, unknown>): Record<string, unknown> {
  const request = (payload.scalping_analysis as {
    instruments: Array<{
      key: string;
      bars: Array<{ timestamp: string }>;
    }>;
    indicators: Array<{
      id: string;
      kind: string;
      parameters?: Record<string, string | number | boolean>;
    }>;
  });
  const instrument = request.instruments[0]!;
  const originAt = instrument.bars.at(-1)!.timestamp;
  const previousAt = instrument.bars.at(-2)?.timestamp ?? originAt;
  const eligibleAt = new Date(Date.parse(originAt) + 60_000).toISOString();
  return {
    schema_version: "scalping-analysis-result/v3",
    scalping_engine_version: "scalping-analysis/1.4.0",
    indicator_engine_version: "technical-indicators/1.5.0",
    response_mode: "full_series",
    interval_minutes: 1,
    instruments: [{
      instrument_key: instrument.key,
      interval_minutes: 1,
      bar_count: instrument.bars.length,
      indicators: request.indicators.map(({ id, kind, parameters }, index) => ({
        instrument_key: instrument.key,
        indicator_id: id,
        kind,
        parameters: parameters ?? {},
        availability: { status: "available", reason: "calculated" },
        points: [
          {
            timestamp: previousAt,
            state: "available",
            values: { value: index + 0.5, ignored_null: null },
          },
          {
            timestamp: originAt,
            state: "available",
            values: { value: index + 1, ignored_infinite: null },
          },
        ],
      })),
      signals: {
        points: [{
          instrument_key: instrument.key,
          status: "entry_candidate",
          calculation_timestamp: originAt,
          signal_timestamp: originAt,
          earliest_eligible_timestamp: eligibleAt,
          basis_price: 170,
          stop_candidate_price: 168.3,
          target_price_range: { low: 173.4, high: 173.4 },
          multi_timeframe_agreement: "aligned_bullish",
          multi_timeframe_trends: {
            "1m": "bullish",
            "5m": "bullish",
            "15m": "neutral",
          },
          confidence: 0.83,
          confidence_semantics: "deterministic completeness, not a probability",
          data_quality: { status: "available", reason: "finalized_ohlcv_bar_available" },
          rationale: ["finalized_close_vs_session_vwap"],
        }],
      },
      scanner_metrics: {
        realized_volatility: {
          availability: { status: "available", reason: "calculated" },
          value: 0.4,
          metadata: { engine: "technical-indicators/1.5.0" },
        },
        normalized_atr: {
          availability: { status: "available", reason: "calculated" },
          value: 1.2,
          metadata: { unit: "percent" },
        },
        day_range_ratio: {
          availability: { status: "available", reason: "calculated" },
          value: 0.03,
          metadata: { unit: "ratio" },
        },
        bollinger_width_expansion: {
          availability: { status: "available", reason: "calculated" },
          value: -0.1,
          metadata: { baseline_period: 20 },
        },
        relative_volume: {
          availability: { status: "available", reason: "calculated" },
          value: 1.4,
          metadata: {
            baseline: "same_local_minute_prior_sessions",
            current_session_excluded: true,
          },
        },
        trading_amount: {
          availability: { status: "available", reason: "calculated" },
          value: 1_000_000,
          metadata: {
            formula: "sum(caller_supplied_final_bar_amount)",
            missing_policy: "complete_current_session_coverage_required",
          },
        },
        spread_bps: {
          availability: { status: "unavailable", reason: "best_bid_and_best_ask_not_supplied" },
          value: null,
          metadata: { unit: "basis_points" },
        },
      },
      market_evidence: {
        schemaVersion: "rust-market-evidence/v2",
        trendScore: 0.7,
        momentumScore: 0.5,
        breakoutScore: 0.4,
        choppiness: 35,
        normalizedAtr: 1.2,
        realizedVolatility: 0.4,
        dayRangeRatio: 0.03,
        bollingerWidthExpansion: -0.1,
        relativeVolume: 1.4,
        tradingAmount: 1_000_000,
        spreadBps: null,
        orderbookDepth: null,
        orderbookImbalance: null,
        executionStrength: null,
        liquidityQuality: null,
        exitRisk: 0.1,
        sessionVwap: 150,
        openingRange5: 0.01,
        openingRange15: 0.02,
        openingRange30: 0.03,
        timeOfDayRelativeVolume: 1.4,
        benchmarkRelativeStrength: null,
        quoteFreshnessMs: null,
        regime: "trend",
        passedGates: ["finalized_data"],
        blockedGates: [],
        unavailableFields: [
          "spreadBps",
          "orderbookDepth",
          "orderbookImbalance",
          "executionStrength",
          "liquidityQuality",
        ],
        originAt,
        observedAt: originAt,
      },
      data_quality: {
        status: "available",
        final_bar_count: instrument.bars.length,
        same_session_gap_count: 0,
        missing_volume_count: 0,
        missing_amount_count: 0,
        orderbook_history: "unavailable",
        reasons: [],
      },
    }],
    diagnostics: {
      series_tail_points: CRYPTO_RUST_OUTPUT_TAIL_POINTS,
    },
  };
}

function fakePort(
  mutate?: (result: Record<string, unknown>) => void,
): {
  port: CryptoRustComputePort;
  compute: ReturnType<typeof vi.fn>;
} {
  const compute = vi.fn(async (_kind: string, payload: Record<string, unknown>) => {
    const result = scalpingResult(payload);
    mutate?.(result);
    return { result };
  });
  return {
    port: {
      compute: compute as CryptoRustComputePort["compute"],
    },
    compute,
  };
}

describe("CryptoRustTechnicalAnalyzer", () => {
  it("sends finalized canonical 1m OHLC, volume, amount and the complete indicator set", async () => {
    const { port, compute } = fakePort();
    const analyzer = new CryptoRustTechnicalAnalyzer(port);
    const source = [
      ...Array.from({ length: 70 }, (_, index) => bar(index)),
      bar(70, { final: false }),
      bar(71, { interval: "30s" }),
    ];

    const result = await analyzer.analyze({
      symbol: "btcusdt",
      bars: source,
      preset: "trend",
    });

    expect(compute).toHaveBeenCalledTimes(1);
    const [kind, payload, options] = compute.mock.calls[0]!;
    expect(kind).toBe("scalping_analysis");
    expect(options).toEqual({ includeArtifacts: false });
    const request = (payload.scalping_analysis as {
      schema_version: string;
      response_mode: string;
      adjustment_policy: string;
      interval_minutes: number;
      instruments: Array<Record<string, unknown>>;
      indicators: Array<Record<string, unknown>>;
      signal: Record<string, unknown>;
      output_projection: Record<string, unknown>;
    });
    expect(request).toMatchObject({
      schema_version: "scalping-analysis-request/v3",
      response_mode: "full_series",
      adjustment_policy: "unadjusted",
      interval_minutes: 1,
      signal: { enabled: true, preset: "trend" },
      output_projection: {
        series_tail_points: 64,
        signal_snapshots: [],
      },
    });
    expect(request.indicators).toEqual(CRYPTO_RUST_INDICATORS);
    expect(request.indicators.find(({ kind }) => kind === "historical_volatility"))
      .toMatchObject({ parameters: { annualization: 525_600 } });
    expect(request.instruments).toHaveLength(1);
    expect(request.instruments[0]).toMatchObject({
      key: "BTCUSDT",
      symbol: "BTCUSDT",
      market: "BINANCE_USDM",
      currency: "USDT",
      instrument_type: "crypto",
    });
    const requestBars = request.instruments[0]!.bars as Array<Record<string, unknown>>;
    expect(requestBars).toHaveLength(70);
    expect(requestBars.at(-1)).toEqual({
      timestamp: "2026-01-02T01:10:00.000Z",
      session_date: "2026-01-02",
      open: 169,
      high: 171,
      low: 168,
      close: 170,
      volume: 79,
      amount: 13_430,
      complete: true,
    });
    expect(requestBars.every((item) => item.complete === true)).toBe(true);

    expect(result).toMatchObject({
      schemaVersion: "crypto-rust-technical/v1",
      symbol: "BTCUSDT",
      originAt: "2026-01-02T01:10:00.000Z",
      calculationAt: "2026-01-02T01:10:00.000Z",
      signalAt: "2026-01-02T01:10:00.000Z",
      earliestEligibleAt: "2026-01-02T01:11:00.000Z",
      status: "entry_candidate",
      technicalSignal: 1,
      confidence: 0.83,
      multiTimeframeAgreement: "aligned_bullish",
      input: {
        interval: "1m",
        barCount: 70,
        usesOhlc: true,
        usesVolume: true,
        usesQuoteVolumeAsAmount: true,
      },
      marketEvidence: {
        schemaVersion: "rust-market-evidence/v2",
        trendScore: 0.7,
        relativeVolume: 1.4,
        tradingAmount: 1_000_000,
        originAt: "2026-01-02T01:10:00.000Z",
        observedAt: "2026-01-02T01:10:00.000Z",
      },
    });
    expect(result.calculations).toHaveLength(CRYPTO_RUST_INDICATORS.length);
    expect(result.calculations[0]).toMatchObject({
      id: "ema-fast-9",
      kind: "ema",
      latest: {
        at: "2026-01-02T01:10:00.000Z",
        values: { value: 1 },
      },
      previous: {
        at: "2026-01-02T01:09:00.000Z",
        values: { value: 0.5 },
      },
    });
    expect(result.scannerEvidence).toEqual({
      schemaVersion: "rust-scanner-evidence/v1",
      originAt: "2026-01-02T01:10:00.000Z",
      tradingAmount: {
        availability: { status: "available", reason: "calculated" },
        value: 1_000_000,
        metadata: {
          formula: "sum(caller_supplied_final_bar_amount)",
          missing_policy: "complete_current_session_coverage_required",
        },
      },
      relativeVolume: {
        availability: { status: "available", reason: "calculated" },
        value: 1.4,
        metadata: {
          baseline: "same_local_minute_prior_sessions",
          current_session_excluded: true,
        },
      },
      provenance: {
        source: "rust_scalping_scanner_metrics",
        resultSchemaVersion: "scalping-analysis-result/v3",
        market: "BINANCE_USDM",
        quoteAsset: "USDT",
        interval: "1m",
        finalizedBarsOnly: true,
        tradingAmountSource: "quote_volume",
        relativeVolumeBaseline: "same_local_minute_prior_sessions",
        currentSessionExcluded: true,
      },
      components: {
        availableMetricCount: 2,
        tradingAmount: 1_000_000,
        relativeVolume: 1.4,
      },
    });
  });

  it("rejects a worker calculation point after the finalized origin", async () => {
    const { port } = fakePort((result) => {
      const instrument = (result.instruments as Array<Record<string, unknown>>)[0]!;
      const calculation = (instrument.indicators as Array<Record<string, unknown>>)[0]!;
      const points = calculation.points as Array<Record<string, unknown>>;
      points.push({
        timestamp: "2026-01-02T01:11:00.000Z",
        state: "available",
        values: { value: 999 },
      });
    });
    const analyzer = new CryptoRustTechnicalAnalyzer(port);

    await expect(analyzer.analyze({
      symbol: "BTCUSDT",
      bars: Array.from({ length: 70 }, (_, index) => bar(index)),
      preset: "risk_management",
    })).rejects.toThrow("future calculation point");
  });

  it("fails closed on Rust engine or echoed-indicator parameter drift", async () => {
    const staleEngine = fakePort((result) => {
      result.indicator_engine_version = "technical-indicators/stale";
    });
    await expect(new CryptoRustTechnicalAnalyzer(staleEngine.port).analyze({
      symbol: "BTCUSDT",
      bars: Array.from({ length: 70 }, (_, index) => bar(index)),
      preset: "trend",
    })).rejects.toThrow("contract does not match");

    const driftedParameter = fakePort((result) => {
      const instrument = (result.instruments as Array<Record<string, unknown>>)[0]!;
      const calculation = (instrument.indicators as Array<Record<string, unknown>>)[0]!;
      calculation.parameters = { period: 99, source: "close" };
    });
    await expect(new CryptoRustTechnicalAnalyzer(driftedParameter.port).analyze({
      symbol: "BTCUSDT",
      bars: Array.from({ length: 70 }, (_, index) => bar(index)),
      preset: "trend",
    })).rejects.toThrow("parameters drifted");
  });

  it("rejects malformed final 1m boundaries and duplicate finalized minutes", async () => {
    const { port } = fakePort();
    const analyzer = new CryptoRustTechnicalAnalyzer(port);
    const malformed = { ...bar(0), closeTime: START + 58_000 };
    await expect(analyzer.analyze({
      symbol: "BTCUSDT",
      bars: [malformed],
      preset: "breakout",
    })).rejects.toThrow("not an exact one-minute candle");

    await expect(analyzer.analyze({
      symbol: "BTCUSDT",
      bars: [bar(0), bar(0)],
      preset: "breakout",
    })).rejects.toThrow("duplicate minute");
  });

  it("fails closed when scanner metric schema or provenance is not exact", async () => {
    const { port } = fakePort((result) => {
      const instrument = (result.instruments as Array<Record<string, unknown>>)[0]!;
      const scanner = instrument.scanner_metrics as Record<string, Record<string, unknown>>;
      const relative = scanner.relative_volume!;
      relative.metadata = {
        baseline: "current_session_including_future",
        current_session_excluded: false,
      };
    });
    const analyzer = new CryptoRustTechnicalAnalyzer(port);

    await expect(analyzer.analyze({
      symbol: "BTCUSDT",
      bars: Array.from({ length: 70 }, (_, index) => bar(index)),
      preset: "trend",
    })).rejects.toThrow("relative-volume provenance");
  });

  it("preserves explicit unavailable scanner metrics without fabricating values", async () => {
    const { port } = fakePort((result) => {
      const instrument = (result.instruments as Array<Record<string, unknown>>)[0]!;
      const scanner = instrument.scanner_metrics as Record<string, Record<string, unknown>>;
      for (const key of ["relative_volume", "trading_amount"]) {
        scanner[key]!.availability = {
          status: "unavailable",
          reason: "session_start_coverage_not_confirmed",
        };
        scanner[key]!.value = null;
      }
    });
    const analyzer = new CryptoRustTechnicalAnalyzer(port);
    const result = await analyzer.analyze({
      symbol: "BTCUSDT",
      bars: Array.from({ length: 70 }, (_, index) => bar(index)),
      preset: "risk_management",
    });

    expect(result.scannerEvidence.components).toEqual({
      availableMetricCount: 0,
      tradingAmount: null,
      relativeVolume: null,
    });
    expect(result.scannerEvidence.relativeVolume.availability.status).toBe("unavailable");
    expect(result.scannerEvidence.tradingAmount.availability.status).toBe("unavailable");
  });
});
