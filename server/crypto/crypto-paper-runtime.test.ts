import { describe, expect, it, vi } from "vitest";
import type { RunTaskContext } from "../services/run-service.js";
import type { SimulationModelLane, SimulationStartRequest } from "../simulation/contracts.js";
import {
  SCALPING_AI_QUANTILES,
  type AiForecastRequest,
} from "../worker/ai-contract.js";
import type {
  BinanceKline,
  BinanceMarketEvent,
  BinanceRestMarketData,
} from "./binance-market-data.js";
import type {
  BinanceInstrumentRules,
  BinanceScannerCandidate,
  BinanceScannerSnapshot,
} from "./contracts.js";
import {
  CryptoPaperRuntime,
  CryptoPaperRuntimeError,
  monotonicCryptoRiskClock,
  type CryptoAiLaneClient,
  type CryptoPublicStreams,
  type CryptoRuntimeClock,
} from "./crypto-paper-runtime.js";

const START = Date.parse("2026-07-25T00:10:00.000Z");
const HASH = "a".repeat(64);

const rules: BinanceInstrumentRules = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  marginAsset: "USDT",
  contractType: "PERPETUAL",
  onboardDate: 0,
  tickSize: 0.1,
  stepSize: 0.001,
  minQuantity: 0.001,
  minNotional: 5,
  maintenanceMarginRate: 0.004,
  maintenanceMarginSource: "binance_user_data_brackets",
  maximumInitialLeverage: 125,
  maintenanceMarginMaximumNotional: 1_000_000_000,
};

const candidate: BinanceScannerCandidate = {
  rank: 1,
  symbol: "BTCUSDT",
  price: 100,
  volume: 10_000,
  quoteVolume: 1_000_000,
  relativeVolume: 2,
  spreadBps: 2,
  realizedVolatility60m: 0.005,
  priceChangePercent24h: 3,
  atrPercent14: 0.004,
  volatilityScore: 1,
  score: 1,
  scoreComponents: {
    tradingAmount: 1,
    volume: 1,
    relativeVolume: 1,
    realizedVolatility60m: 1,
    priceChange24h: 1,
    atrPercent14: 1,
  },
  dataQuality: {
    status: "available",
    finalBars: 64,
    missingFields: [],
    reasons: [],
    observedAt: new Date(START).toISOString(),
  },
};

const scannerSnapshot: BinanceScannerSnapshot = {
  schemaVersion: "binance-usdm-scanner/v1",
  market: {
    kind: "crypto_futures",
    venue: "BINANCE_USDM",
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
  },
  scannerSnapshotId: HASH,
  snapshotId: HASH,
  generatedAt: new Date(START).toISOString(),
  expiresAt: new Date(START + 60_000).toISOString(),
  criterion: "volatility",
  candidates: [candidate],
  evidence: {
    exchangeInfoObservedAt: new Date(START).toISOString(),
    universeSize: 1,
    liquidityPoolSize: 1,
    spreadQualifiedSize: 1,
    requirements: {
      status: "TRADING",
      contractType: "PERPETUAL",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      minimumListingAgeDays: 7,
      liquidityPoolSize: 50,
      maximumSpreadBps: 10,
    },
    volatilityWeights: {
      realized60m: 0.5,
      change24h: 0.3,
      atr14: 0.2,
    },
  },
};

function simulationRequest(
  lanes: SimulationStartRequest["modelLanes"] = ["kronos_base"],
): SimulationStartRequest {
  return {
    market: {
      kind: "crypto_futures",
      venue: "BINANCE_USDM",
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
    },
    marketCountry: "US",
    initialCash: 10_000,
    durationMinutes: 1,
    selection: { mode: "auto", criterion: "volatility", symbolCount: 1 },
    strategy: { mode: "single" },
    preset: "risk_management",
    riskTolerance: 25,
    costs: {
      commissionBpsPerSide: 4,
      taxBpsOnExit: 0,
      spreadBpsRoundTrip: 2,
      slippageBpsPerSide: 1,
    },
    modelLanes: lanes,
    execution: { mode: "paper" },
  };
}

function restBars(): unknown[] {
  return Array.from({ length: 64 }, (_, index) => {
    const openTime = START - (65 - index) * 60_000;
    const price = 100 + Math.sin(index / 8) * 0.1;
    return [
      openTime,
      String(price),
      String(price + 0.2),
      String(price - 0.2),
      String(price),
      "10",
      openTime + 59_999,
      "1000",
      10,
      "5",
      "500",
      "0",
    ];
  });
}

class ScheduledClock implements CryptoRuntimeClock {
  private jobs: Array<{ at: number; callback: () => void }> = [];

  constructor(private current = START) {}

  now = () => this.current;

  schedule(at: number, callback: () => void): void {
    this.jobs.push({ at, callback });
    this.jobs.sort((left, right) => left.at - right.at);
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  async sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const target = this.current + milliseconds;
    const next = this.jobs[0];
    if (next && next.at <= target) {
      this.jobs.shift();
      this.current = next.at;
      next.callback();
      return;
    }
    this.current = target;
  }
}

class ScheduledStreams implements CryptoPublicStreams {
  readonly close = vi.fn().mockResolvedValue(undefined);

  constructor(
    private readonly clock: ScheduledClock,
    private readonly schedule: Array<
      { at: number; event: BinanceMarketEvent }
      | { at: number; disconnect: Error }
    >,
  ) {}

  async subscribe(
    _symbols: readonly string[],
    onEvent: (event: BinanceMarketEvent) => void,
    onDisconnect?: (error?: unknown) => void,
  ) {
    for (const item of this.schedule) {
      this.clock.schedule(item.at, () => {
        if ("event" in item) onEvent(item.event);
        else onDisconnect?.(item.disconnect);
      });
    }
    return { close: this.close };
  }
}

function context() {
  const controller = new AbortController();
  const updates: number[] = [];
  const value: RunTaskContext = {
    runId: "crypto-run-1",
    signal: controller.signal,
    updateProgress: vi.fn(async (progress: number) => {
      updates.push(progress);
    }),
    isCancelled: vi.fn().mockResolvedValue(false),
    throwIfCancelled: vi.fn().mockResolvedValue(undefined),
  };
  return { value, updates, controller };
}

function finalKline(receivedAt: number, final: boolean): BinanceMarketEvent {
  const openTime = START - 60_000;
  return {
    kind: "kline",
    source: "binance_ws",
    symbol: "BTCUSDT",
    interval: "1m",
    openTime,
    closeTime: START - 1,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 20,
    quoteVolume: 2_000,
    tradeCount: 20,
    final,
    receivedAt,
  };
}

function nextFinalKline(openTime: number, receivedAt: number): BinanceMarketEvent {
  return {
    kind: "kline",
    source: "binance_ws",
    symbol: "BTCUSDT",
    interval: "1m",
    openTime,
    closeTime: openTime + 59_999,
    open: 101,
    high: 101.5,
    low: 100.5,
    close: 101,
    volume: 20,
    quoteVolume: 2_020,
    tradeCount: 20,
    final: true,
    receivedAt,
  };
}

function aggTrade(at: number, price = 100): BinanceMarketEvent {
  return {
    kind: "agg_trade",
    source: "binance_ws",
    symbol: "BTCUSDT",
    aggregateTradeId: String(at),
    price,
    quantity: 1,
    executedAt: at,
    buyerWasMaker: false,
    receivedAt: at,
  };
}

function markPrice(at: number, price: number): BinanceMarketEvent {
  return {
    kind: "mark_price",
    source: "binance_ws",
    symbol: "BTCUSDT",
    markPrice: price,
    indexPrice: price,
    fundingRate: 0.0001,
    nextFundingTime: at + 8 * 60 * 60_000,
    eventTime: at,
    receivedAt: at,
  };
}

function bookTicker(at: number, bidPrice = 99.99, askPrice = 100.01): BinanceMarketEvent {
  return {
    kind: "book_ticker",
    source: "binance_ws",
    symbol: "BTCUSDT",
    bidPrice,
    bidQuantity: 10,
    askPrice,
    askQuantity: 10,
    eventTime: at,
    receivedAt: at,
  };
}

function riskPrelude(at = START + 10, price = 100): Array<{ at: number; event: BinanceMarketEvent }> {
  return [
    { at, event: bookTicker(at, price - 0.01, price + 0.01) },
    { at: at + 10, event: markPrice(at + 10, price) },
  ];
}

const longReturns = [-0.01, -0.005, 0.005, 0.02, 0.04, 0.06, 0.08];
const shortReturns = [-0.08, -0.06, -0.04, -0.02, -0.005, 0.005, 0.01];

function response(
  lane: SimulationModelLane,
  request: AiForecastRequest,
  generatedAt: number,
  returns: readonly number[],
) {
  return {
    request_id: request.request_id,
    mode: "forecast",
    status: "available",
    generated_at: new Date(generatedAt).toISOString(),
    model: {
      model_id: lane === "kronos_base" ? "NeoQuasar/Kronos-base" : "Vincent05R/FinCast",
      model_revision: lane === "kronos_base" ? "k-rev" : "f-rev",
      dtype: lane === "kronos_base" ? "float32" : "mixed_float16",
      peak_vram_mb: lane === "kronos_base" ? 6_000 : 4_000,
    },
    latency_ms: 10,
    model_runs: [{
      role: lane,
      expected_model_id: lane === "kronos_base"
        ? "NeoQuasar/Kronos-base"
        : "Vincent05R/FinCast",
      latency_ms: 10,
      model: {
        model_id: lane === "kronos_base" ? "NeoQuasar/Kronos-base" : "Vincent05R/FinCast",
        model_revision: lane === "kronos_base" ? "k-rev" : "f-rev",
        dtype: lane === "kronos_base" ? "float32" : "mixed_float16",
        peak_vram_mb: lane === "kronos_base" ? 6_000 : 4_000,
      },
    }],
    series: [{
      instrument_key: request.series[0]!.instrument_key,
      status: "available",
      input_end_at: request.series[0]!.input_end_at,
      horizons: [{
        horizon_minutes: 5,
        return_quantiles: SCALPING_AI_QUANTILES.map((quantile, index) => ({
          quantile,
          value: returns[index],
        })),
      }],
    }],
  };
}

function laneClient(
  lane: SimulationModelLane,
  generatedAt: number,
  returns: readonly number[],
  observed: AiForecastRequest[],
): CryptoAiLaneClient {
  return {
    request: vi.fn(async (request: AiForecastRequest) => {
      observed.push(structuredClone(request));
      return response(lane, request, generatedAt, returns);
    }),
  };
}

function rest() {
  return {
    klines: vi.fn().mockResolvedValue(restBars()),
  } satisfies Pick<BinanceRestMarketData, "klines">;
}

function artifact(
  result: Awaited<ReturnType<CryptoPaperRuntime["run"]>>,
  type: string,
): UnknownRecord {
  const found = result.artifacts?.find((item) => item.type === type);
  return found?.content as UnknownRecord;
}

type UnknownRecord = Record<string, unknown>;

describe("CryptoPaperRuntime", () => {
  it("never rewinds the daily-risk clock for a late prior-day event after UTC rollover", () => {
    const afterRollover = Date.parse("2026-07-26T00:00:00.250Z");
    const latePriorDay = Date.parse("2026-07-25T23:59:59.900Z");
    expect(monotonicCryptoRiskClock(
      afterRollover,
      afterRollover + 100,
      latePriorDay,
    )).toBe(afterRollover + 100);
  });

  it("lets only a final kline trigger inference and fills on the first strictly later eligible event", async () => {
    const clock = new ScheduledClock();
    const observed: AiForecastRequest[] = [];
    const client = laneClient("kronos_base", START + 150, longReturns, observed);
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 50, event: finalKline(START + 50, false) },
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 120, event: aggTrade(START + 120) },
      { at: START + 200, event: aggTrade(START + 200) },
    ]);
    const snapshots: unknown[] = [];
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
      onSnapshot: (_runId, snapshot) => {
        snapshots.push(snapshot);
      },
    });
    const taskContext = context();
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: taskContext.value,
    });

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(1);
    const inputEnd = Date.parse(observed[0]!.series[0]!.input_end_at);
    expect(inputEnd).toBe(START - 1);
    expect(observed[0]!.series[0]!.bars.every(
      (bar) => Date.parse(bar.timestamp) <= inputEnd,
    )).toBe(true);
    const trades = artifact(result, "simulation-trades");
    const lanes = trades.lanes as UnknownRecord;
    const ledger = (lanes.kronos_base as UnknownRecord).ledger as UnknownRecord;
    const fills = ledger.fills as Array<UnknownRecord>;
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      action: "open",
      side: "long",
      decisionAt: START + 150,
      executedAt: START + 200,
    });
    expect((fills[0]!.executedAt as number) > (fills[0]!.decisionAt as number)).toBe(true);
    const terminal = (result.result as UnknownRecord).snapshot as UnknownRecord;
    expect(terminal.futuresRisk).toMatchObject({
      newEntriesBlocked: true,
      riskStreams: {
        healthy: false,
        bookTicker: { status: "stale" },
        markPrice: { status: "stale" },
      },
    });
    expect((terminal.futuresPositions as UnknownRecord[])[0]).toMatchObject({
      entryBlocked: true,
      riskWarnings: expect.arrayContaining(["book_ticker_stale", "mark_price_stale"]),
    });
    expect(artifact(result, "simulation-provenance").maintenanceMargin).toEqual({
      source: "binance_user_data_brackets",
      rate: 0.004,
      maximumInitialLeverage: 125,
      qualifiedMaximumNotional: 1_000_000_000,
      requiredMaximumNotional: 30_000,
      exchangeInfoMaintenanceMarginIgnored: true,
      rawPayloadRetained: false,
    });
    expect(snapshots.length).toBeGreaterThan(1);
    expect(taskContext.updates.at(-1)).toBe(1);
  });

  it("never looks back to a kline open that preceded model completion", async () => {
    const clock = new ScheduledClock();
    const observed: AiForecastRequest[] = [];
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      ...riskPrelude(START + 60_020, 101),
      {
        at: START + 60_100,
        event: nextFinalKline(START, START + 60_100),
      },
      { at: START + 60_200, event: aggTrade(START + 60_200, 102) },
    ]);
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {
        kronos_base: laneClient("kronos_base", START + 150, longReturns, observed),
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const request = { ...simulationRequest(), durationMinutes: 2 };
    const result = await runtime.run({
      request,
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const trades = artifact(result, "simulation-trades");
    const lanes = trades.lanes as UnknownRecord;
    const ledger = (lanes.kronos_base as UnknownRecord).ledger as UnknownRecord;
    const fills = ledger.fills as Array<UnknownRecord>;
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      action: "open",
      price: 102.1,
      decisionAt: START + 150,
      executedAt: START + 60_200,
    });
    expect(fills[0]!.executedAt).not.toBe(START);
  });

  it("revalidates risk, gross exposure, and margin against the actual fill price", async () => {
    const clock = new ScheduledClock();
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 190, event: markPrice(START + 190, 400) },
      { at: START + 200, event: aggTrade(START + 200, 400) },
    ]);
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {
        kronos_base: laneClient("kronos_base", START + 150, longReturns, []),
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const trades = artifact(result, "simulation-trades");
    const lanes = trades.lanes as UnknownRecord;
    const ledger = (lanes.kronos_base as UnknownRecord).ledger as UnknownRecord;
    const equity = ledger.equity as number;
    const grossExposure = ledger.grossExposure as number;
    const totalIsolatedMargin = ledger.totalIsolatedMargin as number;
    const fills = ledger.fills as Array<UnknownRecord>;
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 200 });
    expect(grossExposure).toBeLessThanOrEqual(equity * 1.5 + rules.tickSize);
    expect(totalIsolatedMargin).toBeLessThanOrEqual(equity * 0.2 + rules.tickSize);
    expect((fills[0]!.quantity as number) * 400).toBeLessThan(15_000);
  });

  it("keeps long and short lanes independent on the same canonical request and fill barrier", async () => {
    const clock = new ScheduledClock();
    const kronosRequests: AiForecastRequest[] = [];
    const fincastRequests: AiForecastRequest[] = [];
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 200, event: aggTrade(START + 200) },
    ]);
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {
        kronos_base: laneClient(
          "kronos_base",
          START + 130,
          longReturns,
          kronosRequests,
        ),
        fincast: laneClient("fincast", START + 160, shortReturns, fincastRequests),
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: simulationRequest(["kronos_base", "fincast"]),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    expect(kronosRequests).toEqual(fincastRequests);

    const trades = artifact(result, "simulation-trades");
    const lanes = trades.lanes as UnknownRecord;
    const kronosFills = ((lanes.kronos_base as UnknownRecord).ledger as UnknownRecord)
      .fills as Array<UnknownRecord>;
    const fincastFills = ((lanes.fincast as UnknownRecord).ledger as UnknownRecord)
      .fills as Array<UnknownRecord>;
    expect(kronosFills[0]).toMatchObject({
      side: "long",
      decisionAt: START + 160,
      executedAt: START + 200,
    });
    expect(fincastFills[0]).toMatchObject({
      side: "short",
      decisionAt: START + 160,
      executedAt: START + 200,
    });
    const comparison = artifact(result, "simulation-comparison");
    expect(comparison).toMatchObject({
      sameOrigin: true,
      sameContext: true,
      sameCosts: true,
      sameFillBarrier: true,
      outcome: "inconclusive",
    });
  });

  it("records an unavailable lane without fabricating a forecast, trade, or fallback", async () => {
    const clock = new ScheduledClock();
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 200, event: aggTrade(START + 200) },
    ]);
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {},
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: simulationRequest(["fincast"]),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const trades = artifact(result, "simulation-trades");
    expect(trades.trades).toEqual([]);
    const comparison = artifact(result, "simulation-comparison");
    expect(comparison.lanes).toEqual([
      expect.objectContaining({
        id: "fincast",
        status: "unavailable",
        unavailableReason: "worker_unavailable",
      }),
    ]);
    const diagnostics = artifact(result, "simulation-diagnostics");
    expect(diagnostics).toMatchObject({
      workerFallbackUsed: false,
      modelFailureMasqueradedAsAnotherLane: false,
    });
  });

  it("blocks new entries at a 3% UTC loss and closes the position reduce-only", async () => {
    const clock = new ScheduledClock();
    const observed: AiForecastRequest[] = [];
    const wideSpreadCandidate = { ...candidate, spreadBps: 9 };
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 200, event: aggTrade(START + 200) },
      { at: START + 300, event: markPrice(START + 300, 95) },
      { at: START + 400, event: aggTrade(START + 400, 94) },
    ]);
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {
        kronos_base: laneClient("kronos_base", START + 150, longReturns, observed),
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: wideSpreadCandidate,
      context: context().value,
    });
    const trades = artifact(result, "simulation-trades");
    const lanes = trades.lanes as UnknownRecord;
    const ledger = (lanes.kronos_base as UnknownRecord).ledger as UnknownRecord;
    const fills = ledger.fills as Array<UnknownRecord>;
    expect(fills).toHaveLength(2);
    expect(fills[1]).toMatchObject({
      action: "reduce",
      reduceOnly: true,
      reason: "daily_loss_gate",
      executedAt: START + 400,
    });
    const terminal = (result.result as UnknownRecord).snapshot as UnknownRecord;
    expect(terminal.futuresRisk).toMatchObject({
      newEntriesBlocked: true,
      dailyLossLimitRatio: 0.03,
    });
  });

  it("coalesces high-frequency market ingress and drops non-final klines without queue growth", async () => {
    const clock = new ScheduledClock();
    const close = vi.fn().mockResolvedValue(undefined);
    const streams: CryptoPublicStreams = {
      subscribe: async (_symbols, onEvent) => {
        clock.schedule(START + 100, () => {
          for (let index = 0; index < 1_000; index += 1) {
            onEvent(finalKline(START + 100, false));
            onEvent(bookTicker(
              START + 100,
              99.9 + index / 100_000,
              100.1 + index / 100_000,
            ));
            onEvent(markPrice(START + 100, 100 + index / 100_000));
          }
          onEvent(finalKline(START + 100, true));
        });
        return { close };
      },
    };
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {},
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const diagnostics = artifact(result, "simulation-diagnostics");
    expect(diagnostics.marketEventQueue).toMatchObject({
      maximumAllowedDepth: 256,
      droppedNonFinalKlines: 1_000,
      coalescedMarkPrices: 999,
      overflowCount: 0,
    });
    expect((diagnostics.marketEventQueue as UnknownRecord).coalescedBookTickers)
      .toBeGreaterThanOrEqual(998);
    expect((diagnostics.marketEventQueue as UnknownRecord).maximumDepth).toBeLessThanOrEqual(3);
  });

  it("bounds cancellation polling, progress writes, and equity artifacts on a busy stream", async () => {
    const clock = new ScheduledClock();
    const schedule: Array<{ at: number; event: BinanceMarketEvent }> = [];
    for (let offset = 100; offset < 60_000; offset += 100) {
      schedule.push(offset % 200 === 0
        ? { at: START + offset, event: markPrice(START + offset, 100 + offset / 1_000_000) }
        : {
          at: START + offset,
          event: bookTicker(START + offset, 99.99, 100.01),
        });
    }
    const taskContext = context();
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams: new ScheduledStreams(clock, schedule),
      laneClients: {},
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: taskContext.value,
    });
    const equity = artifact(result, "simulation-equity");
    const points = (equity.lanes as UnknownRecord).kronos_base as Array<{
      timestamp: string;
      equity: number;
    }>;
    expect(points.length).toBeLessThanOrEqual(13);
    for (let index = 1; index < points.length; index += 1) {
      expect(
        Date.parse(points[index]!.timestamp) - Date.parse(points[index - 1]!.timestamp),
      ).toBeGreaterThanOrEqual(5_000);
    }
    expect(vi.mocked(taskContext.value.updateProgress).mock.calls.length).toBeLessThanOrEqual(14);
    expect(vi.mocked(taskContext.value.isCancelled).mock.calls.length).toBeLessThanOrEqual(61);
    const diagnostics = artifact(result, "simulation-diagnostics");
    expect(diagnostics).toMatchObject({
      progressUpdateIntervalMs: 5_000,
      cancellationPollIntervalMs: 1_000,
      equitySampling: {
        intervalMs: 5_000,
        maximumSamplesPerLane: 5_000,
      },
    });
  });

  it("starts the requested duration after REST context setup completes", async () => {
    const clock = new ScheduledClock();
    const delayedRest = {
      klines: vi.fn(async () => {
        clock.advance(30_000);
        return restBars();
      }),
    } satisfies Pick<BinanceRestMarketData, "klines">;
    const runtime = new CryptoPaperRuntime({
      rest: delayedRest,
      streams: new ScheduledStreams(clock, []),
      laneClients: {},
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const terminal = (result.result as UnknownRecord).snapshot as UnknownRecord;
    expect(Date.parse(terminal.startedAt as string)).toBe(START + 30_000);
    expect(
      Date.parse(terminal.expiresAt as string) - Date.parse(terminal.startedAt as string),
    ).toBe(60_000);
    expect(artifact(result, "simulation-diagnostics")).toMatchObject({
      setupDurationMs: 30_000,
    });
  });

  it("blocks inference when bookTicker and markPrice are missing and exposes the reason", async () => {
    const clock = new ScheduledClock();
    const client = laneClient("kronos_base", START + 150, longReturns, []);
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams: new ScheduledStreams(clock, [
        { at: START + 100, event: finalKline(START + 100, true) },
      ]),
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    expect(client.request).not.toHaveBeenCalled();
    const terminal = (result.result as UnknownRecord).snapshot as UnknownRecord;
    expect(terminal.futuresRisk).toMatchObject({
      newEntriesBlocked: true,
      riskStreams: {
        healthy: false,
        bookTicker: { status: "missing" },
        markPrice: { status: "missing" },
      },
    });
    const decisions = artifact(result, "simulation-decisions").decisions as UnknownRecord[];
    expect(decisions[0]?.reason).toContain("risk_stream_");
  });

  it("bounds an abort-ignoring worker by the remaining runtime expiry", async () => {
    vi.useFakeTimers();
    try {
      const clock = new ScheduledClock();
      let workerSignal: AbortSignal | undefined;
      let notifyStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const client: CryptoAiLaneClient = {
        request: vi.fn(async (_request, signal) => {
          workerSignal = signal;
          notifyStarted?.();
          return await new Promise<never>(() => undefined);
        }),
      };
      const runtime = new CryptoPaperRuntime({
        rest: rest(),
        streams: new ScheduledStreams(clock, [
          ...riskPrelude(START + 59_000),
          { at: START + 59_500, event: finalKline(START + 59_500, true) },
        ]),
        laneClients: { kronos_base: client },
        instrumentRules: rules,
        clock,
        contextBars: 64,
        inferenceDeadlineMs: 5_000,
      });
      const running = runtime.run({
        request: simulationRequest(),
        snapshot: scannerSnapshot,
        selected: candidate,
        context: context().value,
      });
      await started;
      expect(workerSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      const result = await running;
      expect(workerSignal?.aborted).toBe(true);
      const comparison = artifact(result, "simulation-comparison");
      expect(comparison.lanes).toEqual([
        expect.objectContaining({
          unavailableReason: "crypto_runtime_expiry_deadline_exceeded",
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escapes an abort-ignoring worker immediately on the coordinator signal", async () => {
    const clock = new ScheduledClock();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const client: CryptoAiLaneClient = {
      request: vi.fn(async () => {
        notifyStarted?.();
        return await new Promise<never>(() => undefined);
      }),
    };
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams: new ScheduledStreams(clock, [
        ...riskPrelude(),
        { at: START + 100, event: finalKline(START + 100, true) },
      ]),
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const taskContext = context();
    const running = runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: taskContext.value,
    });
    await started;
    taskContext.controller.abort(new Error("test_cancelled"));
    await expect(running).rejects.toThrow("test_cancelled");
  });

  it("orders a replacement mark after an intervening fill event", async () => {
    const clock = new ScheduledClock();
    let emit: ((event: BinanceMarketEvent) => void) | undefined;
    let injected = false;
    const streams: CryptoPublicStreams = {
      subscribe: async (_symbols, onEvent) => {
        emit = onEvent;
        for (const item of [
          ...riskPrelude(),
          { at: START + 100, event: finalKline(START + 100, true) },
        ]) {
          clock.schedule(item.at, () => onEvent(item.event));
        }
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
    };
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {
        kronos_base: laneClient("kronos_base", START + 150, shortReturns, []),
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
      onSnapshot: (_runId, snapshot) => {
        if (injected || !snapshot.decisions.some((decision) => decision.status === "pending")) {
          return;
        }
        injected = true;
        emit?.(markPrice(START + 180, 100));
        emit?.(aggTrade(START + 200, 100));
        emit?.(markPrice(START + 210, 400));
      },
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const trades = artifact(result, "simulation-trades");
    const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord).fills as UnknownRecord[];
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 200 });
    expect(fills[1]).toMatchObject({ action: "reduce", reason: "liquidation" });
    expect(artifact(result, "simulation-diagnostics").marketEventQueue).toMatchObject({
      coalescedMarkPrices: 1,
      overflowCount: 0,
    });
  });

  it("retains first-fill and adverse aggTrade extrema within a fixed burst bound", async () => {
    const clock = new ScheduledClock();
    let emit: ((event: BinanceMarketEvent) => void) | undefined;
    let injected = false;
    const streams: CryptoPublicStreams = {
      subscribe: async (_symbols, onEvent) => {
        emit = onEvent;
        for (const item of [
          ...riskPrelude(),
          { at: START + 100, event: finalKline(START + 100, true) },
        ]) {
          clock.schedule(item.at, () => onEvent(item.event));
        }
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
    };
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {
        kronos_base: laneClient("kronos_base", START + 150, longReturns, []),
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
      onSnapshot: (_runId, snapshot) => {
        if (injected || !snapshot.decisions.some((decision) => decision.status === "pending")) {
          return;
        }
        injected = true;
        for (let index = 0; index < 1_000; index += 1) {
          const price = index === 0 ? 100 : index === 1 ? 90 : 100 + (index % 3) * 0.01;
          emit?.(aggTrade(START + 200 + index, price));
        }
        clock.schedule(START + 2_000, () => emit?.(aggTrade(START + 2_000, 99)));
      },
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const trades = artifact(result, "simulation-trades");
    const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord).fills as UnknownRecord[];
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 200 });
    expect(fills[1]).toMatchObject({ action: "reduce", reason: "protection" });
    const queue = artifact(result, "simulation-diagnostics").marketEventQueue as UnknownRecord;
    expect(queue.maximumBufferedAggTrades).toBeLessThanOrEqual(5);
    expect(queue.droppedAggTrades).toBeGreaterThan(900);
    expect(queue.overflowCount).toBe(0);
  });

  it("requalifies REST and fresh risk streams before accepting post-reconnect entries", async () => {
    const clock = new ScheduledClock();
    const marketRest = rest();
    const streams: CryptoPublicStreams = {
      subscribe: async (_symbols, onEvent, _onDisconnect, onState) => {
        for (const item of [
          ...riskPrelude(),
          { at: START + 100, event: finalKline(START + 100, true) },
          ...riskPrelude(START + 60_020, 101),
          {
            at: START + 60_100,
            event: nextFinalKline(START, START + 60_100),
          },
          { at: START + 60_200, event: aggTrade(START + 60_200, 101) },
        ]) {
          clock.schedule(item.at, () => onEvent(item.event));
        }
        clock.schedule(START + 200, () => {
          onState?.({
            status: "reconnecting",
            generation: 1,
            reconnectAttempt: 1,
          });
        });
        clock.schedule(START + 210, () => {
          onState?.({
            status: "connected",
            generation: 2,
            reconnectAttempt: 1,
          });
          // This is deliberately delivered immediately after reconnect and
          // before a new book/mark pair. It must not fill the old pending open.
          onEvent(aggTrade(START + 220, 100));
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
    };
    const client: CryptoAiLaneClient = {
      request: vi.fn(async (request: AiForecastRequest) => response(
        "kronos_base",
        request,
        Math.max(clock.now(), Date.parse(request.series[0]!.input_end_at)),
        longReturns,
      )),
    };
    const runtime = new CryptoPaperRuntime({
      rest: marketRest,
      streams,
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: { ...simulationRequest(), durationMinutes: 2 },
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    expect(marketRest.klines).toHaveBeenCalledTimes(2);
    const trades = artifact(result, "simulation-trades");
    const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord).fills as UnknownRecord[];
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 60_200 });
    const decisions = artifact(result, "simulation-decisions").decisions as UnknownRecord[];
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "blocked",
        reason: "stream_reconnecting",
      }),
    ]));
  });

  it("preserves a transient liquidation mark even when a recovery mark follows in the burst", async () => {
    const clock = new ScheduledClock();
    let emit: ((event: BinanceMarketEvent) => void) | undefined;
    let fillInjected = false;
    let marksInjected = false;
    const streams: CryptoPublicStreams = {
      subscribe: async (_symbols, onEvent) => {
        emit = onEvent;
        for (const item of [
          ...riskPrelude(),
          { at: START + 100, event: finalKline(START + 100, true) },
        ]) {
          clock.schedule(item.at, () => onEvent(item.event));
        }
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
    };
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {
        kronos_base: laneClient("kronos_base", START + 150, longReturns, []),
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
      onSnapshot: (_runId, snapshot) => {
        if (!fillInjected
          && snapshot.decisions.some((decision) => decision.status === "pending")) {
          fillInjected = true;
          emit?.(aggTrade(START + 200, 100));
          return;
        }
        if (!marksInjected && snapshot.futuresPositions.length > 0) {
          marksInjected = true;
          emit?.(markPrice(START + 300, 0.1));
          emit?.(markPrice(START + 310, 100));
        }
      },
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const trades = artifact(result, "simulation-trades");
    const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord).fills as UnknownRecord[];
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 200 });
    expect(fills[1]).toMatchObject({ action: "reduce", reason: "liquidation" });
    expect(artifact(result, "simulation-diagnostics").marketEventQueue).toMatchObject({
      preservedCriticalMarkPrices: 1,
      overflowCount: 0,
    });
  });

  it("preserves a transient protective-stop mark before a recovery mark", async () => {
    const clock = new ScheduledClock();
    let emit: ((event: BinanceMarketEvent) => void) | undefined;
    let fillInjected = false;
    let marksInjected = false;
    const streams: CryptoPublicStreams = {
      subscribe: async (_symbols, onEvent) => {
        emit = onEvent;
        for (const item of [
          ...riskPrelude(),
          { at: START + 100, event: finalKline(START + 100, true) },
        ]) {
          clock.schedule(item.at, () => onEvent(item.event));
        }
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
    };
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {
        kronos_base: laneClient("kronos_base", START + 150, longReturns, []),
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
      onSnapshot: (_runId, snapshot) => {
        if (!fillInjected
          && snapshot.decisions.some((decision) => decision.status === "pending")) {
          fillInjected = true;
          emit?.(aggTrade(START + 200, 100));
          return;
        }
        const position = snapshot.futuresPositions[0] as
          | { protectiveStopPrice?: number }
          | undefined;
        if (!marksInjected && position?.protectiveStopPrice !== undefined) {
          marksInjected = true;
          emit?.(markPrice(START + 300, position.protectiveStopPrice - 0.1));
          emit?.(markPrice(START + 310, 100));
          clock.schedule(START + 400, () => emit?.(aggTrade(START + 400, 99)));
        }
      },
    });
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const trades = artifact(result, "simulation-trades");
    const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord).fills as UnknownRecord[];
    expect(fills[1]).toMatchObject({
      action: "reduce",
      reason: "protection",
      executedAt: START + 400,
    });
    expect(artifact(result, "simulation-diagnostics").marketEventQueue).toMatchObject({
      preservedCriticalMarkPrices: 1,
      overflowCount: 0,
    });
  });

  it("fails closed with stream_desync instead of continuing on stale public data", async () => {
    const clock = new ScheduledClock();
    const streams = new ScheduledStreams(clock, [
      { at: START + 100, disconnect: new Error("socket closed") },
    ]);
    const snapshots: Array<{ phase: string }> = [];
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {},
      instrumentRules: rules,
      clock,
      contextBars: 64,
      onSnapshot: (_runId, snapshot) => {
        snapshots.push(snapshot);
      },
    });
    await expect(runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    })).rejects.toMatchObject({
      name: "CryptoPaperRuntimeError",
      code: "stream_desync",
    } satisfies Partial<CryptoPaperRuntimeError>);
    expect(snapshots.at(-1)?.phase).toBe("failed");
    expect(streams.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "public exchangeInfo maintenance data",
      instrumentRules: {
        ...rules,
        maintenanceMarginRate: 1 as const,
        maintenanceMarginSource: "unavailable" as const,
        maximumInitialLeverage: undefined,
        maintenanceMarginMaximumNotional: undefined,
      },
    },
    {
      label: "a signed bracket below required gross exposure",
      instrumentRules: {
        ...rules,
        maintenanceMarginMaximumNotional: 29_999,
      },
    },
  ])("fails closed before subscribing for $label", async ({ instrumentRules }) => {
    const clock = new ScheduledClock();
    const streams = new ScheduledStreams(clock, []);
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {},
      instrumentRules: instrumentRules as BinanceInstrumentRules,
      clock,
      contextBars: 64,
    });
    await expect(runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    })).rejects.toMatchObject({
      name: "CryptoPaperRuntimeError",
      code: "invalid_runtime_input",
    });
    expect(streams.close).not.toHaveBeenCalled();
  });
});
