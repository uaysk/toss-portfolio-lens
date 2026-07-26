import { describe, expect, it, vi } from "vitest";
import type { RunTaskContext } from "../services/run-service.js";
import type { SimulationModelLane, SimulationStartRequest } from "../simulation/contracts.js";
import {
  SCALPING_AI_HORIZONS,
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
import { FuturesPaperLedger } from "./futures-paper-ledger.js";
import {
  aggregatePortfolioEquitySeries,
  aggregatePortfolioLaneMetrics,
  aggregatePortfolioLaneProvenance,
  canonicalCryptoModelInputDigest,
  cryptoModelForecastIsFresh,
  CryptoPaperRuntime,
  CryptoPaperRuntimeError,
  cryptoRuntimeClientOrderId,
  cryptoRuntimeEntityId,
  groupPortfolioRuntimeArtifacts,
  monotonicCryptoRiskClock,
  PortfolioDailyLossGate,
  type CryptoAiLaneClient,
  type CryptoPaperRuntimeSnapshot,
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
    fincastCandleSeconds: 60,
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

function markPrice(
  at: number,
  price: number,
): Extract<BinanceMarketEvent, { kind: "mark_price" }> {
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
const flatReturns = [0, 0, 0, 0, 0, 0, 0];
const kronosModelRevision = "2b554741eca47781b64468546e77fef3e85130e6";
const kronosSourceRevision = "67b630e67f6a18c9e9be918d9b4337c960db1e9a";
const kronosTokenizerRevision = "0e0117387f39004a9016484a186a908917e22426";
const fincastModelRevision = "2d7d90b159db8961d27c2cf165d51195902ef92b";
const fincastSourceRevision = "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4";

function qualificationObservations(overrides: UnknownRecord = {}) {
  return {
    row_count: 7_680,
    non_finite_value_count: 0,
    crossing_row_count: 65,
    crossing_adjacent_pair_count: 74,
    adjusted_row_count: 65,
    q50_adjustment_iqr_ratio_median: 0,
    q50_adjustment_iqr_ratio_p95: 0.06324,
    q50_adjustment_iqr_ratio_max: 0.1502,
    postprocessed_monotonic: true,
    ...overrides,
  };
}

function response(
  lane: SimulationModelLane,
  request: AiForecastRequest,
  generatedAt: number,
  returns: readonly number[],
  modelOverrides: UnknownRecord = {},
) {
  const model = {
    model_id: lane === "kronos_base" ? "NeoQuasar/Kronos-base" : "Vincent05R/FinCast",
    model_revision: lane === "kronos_base" ? kronosModelRevision : fincastModelRevision,
    source_revision: lane === "kronos_base" ? kronosSourceRevision : fincastSourceRevision,
    loader_version: lane === "kronos_base"
      ? "kronos-source-67b630e"
      : "fincast-source-488b19d",
    license: lane === "kronos_base" ? "MIT" : "Apache-2.0",
    tokenizer_id: lane === "kronos_base" ? "NeoQuasar/Kronos-Tokenizer-base" : null,
    tokenizer_revision: lane === "kronos_base" ? kronosTokenizerRevision : null,
    loaded: true,
    device: "cuda",
    device_name: "Tesla P40",
    cuda_capability: "6.1",
    attention_backend: "math",
    dtype: lane === "kronos_base" ? "float32" : "mixed_float16",
    ...(lane === "kronos_base"
      ? { peak_vram_mb: 6_000 }
      : {
        precision_validation: "passed",
        peak_vram_bytes: 4_000 * 1024 * 1024,
        peak_vram_measurement: "cuda_allocated_or_reserved",
        memory_status: "ok",
        quantile_monotonicity_policy: "fp32_monotone_rearrangement_v1",
        fp32_quantile_observations: qualificationObservations(),
        mixed_quantile_observations: qualificationObservations({
          crossing_row_count: 67,
          crossing_adjacent_pair_count: 79,
          adjusted_row_count: 67,
        }),
        quantile_tail_policy: "tail_clamped_q10_q90",
        precision_failure_reasons: [],
      }),
    ...modelOverrides,
  };
  const modelInputBars = request.series[0]!.bars.slice(-512);
  return {
    request_id: request.request_id,
    mode: "forecast",
    status: "available",
    generated_at: new Date(generatedAt).toISOString(),
    model: structuredClone(model),
    latency_ms: 10,
    model_runs: [{
      role: lane,
      expected_model_id: lane === "kronos_base"
        ? "NeoQuasar/Kronos-base"
        : "Vincent05R/FinCast",
      latency_ms: 10,
      model: structuredClone(model),
      input_origins: [{
        instrument_key: request.series[0]!.instrument_key,
        context_start_at: modelInputBars[0]!.timestamp,
        input_end_at: request.series[0]!.input_end_at,
        bar_count: modelInputBars.length,
        input_digest: canonicalCryptoModelInputDigest(modelInputBars),
      }],
      input_end_aligned: true,
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

function responseWithDisplayPath(
  raw: ReturnType<typeof response>,
  options: {
    shiftedTargetHorizon?: number;
  } = {},
): unknown {
  const output = structuredClone(raw) as UnknownRecord;
  const series = (output.series as UnknownRecord[])[0]!;
  const inputEndAt = Date.parse(series.input_end_at as string);
  const originalHorizon = (series.horizons as UnknownRecord[])[0]!;
  const returnQuantiles = structuredClone(originalHorizon.return_quantiles);
  series.horizons = SCALPING_AI_HORIZONS.map((horizon, horizonIndex) => ({
    horizon_minutes: horizon,
    up_probability: 0.64,
    target_timestamp: new Date(
      inputEndAt
      + horizon * 60_000
      + (options.shiftedTargetHorizon === horizon ? 1_000 : 0),
    ).toISOString(),
    return_quantiles: structuredClone(returnQuantiles),
    price_quantiles: SCALPING_AI_QUANTILES.map((quantile, quantileIndex) => ({
      quantile,
      value: 100 + horizonIndex + quantileIndex * 0.1,
    })),
  }));
  return output;
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

async function runProvenanceSimulation(options: {
  lane: SimulationModelLane;
  attempts?: 1 | 2;
  modelOverrides?: (attempt: number) => UnknownRecord;
  transform?: (
    raw: ReturnType<typeof response>,
    attempt: number,
  ) => unknown;
}) {
  const clock = new ScheduledClock();
  const attempts = options.attempts ?? 1;
  let invocation = 0;
  const client: CryptoAiLaneClient = {
    request: vi.fn(async (request: AiForecastRequest) => {
      const attempt = invocation;
      invocation += 1;
      const raw = response(
        options.lane,
        request,
        Math.max(clock.now(), Date.parse(request.series[0]!.input_end_at)),
        flatReturns,
        options.modelOverrides?.(attempt),
      );
      return options.transform?.(raw, attempt) ?? raw;
    }),
  };
  const streams = new ScheduledStreams(clock, [
    ...riskPrelude(),
    { at: START + 100, event: finalKline(START + 100, true) },
    ...(attempts === 2
      ? [
        ...riskPrelude(START + 60_010, 101),
        {
          at: START + 60_100,
          event: nextFinalKline(START, START + 60_100),
        },
      ]
      : []),
  ]);
  const runtime = new CryptoPaperRuntime({
    rest: rest(),
    streams,
    laneClients: { [options.lane]: client },
    instrumentRules: rules,
    clock,
    contextBars: 64,
  });
  const result = await runtime.run({
    request: {
      ...simulationRequest([options.lane]),
      durationMinutes: attempts,
    },
    snapshot: scannerSnapshot,
    selected: candidate,
    context: context().value,
  });
  return { result, client, runtime };
}

describe("CryptoPaperRuntime", () => {
  it("serializes same-lane worker calls even when portfolio symbols request concurrently", async () => {
    const clock = new ScheduledClock();
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams: new ScheduledStreams(clock, []),
      laneClients: {},
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const gates = [deferred<void>(), deferred<void>()];
    let invocation = 0;
    let active = 0;
    let maximumActive = 0;
    const client: CryptoAiLaneClient = {
      request: vi.fn(async () => {
        const index = invocation;
        invocation += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await gates[index]!.promise;
          return { index };
        } finally {
          active -= 1;
        }
      }),
    };
    const requestLane = (
      runtime as unknown as {
        requestLane: (
          lane: SimulationModelLane,
          laneClient: CryptoAiLaneClient,
          request: AiForecastRequest,
          signal: AbortSignal,
        ) => Promise<unknown>;
      }
    ).requestLane.bind(runtime);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const request = {} as AiForecastRequest;

    const first = requestLane("kronos_base", client, request, firstController.signal);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
    const second = requestLane("kronos_base", client, request, secondController.signal);
    await Promise.resolve();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);

    gates[0]!.resolve(undefined);
    await first;
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(1);
    gates[1]!.resolve(undefined);
    await second;
    expect(maximumActive).toBe(1);
  });

  it("scopes same-timestamp portfolio identifiers by run and symbol", () => {
    const common = {
      runId: "crypto-run-1",
      lane: "kronos_base" as const,
      at: START + 123,
      sequence: 1,
    };
    const identifiers = ["BTCUSDT", "ETHUSDT"].flatMap((symbol) => [
      cryptoRuntimeEntityId("decision", { ...common, symbol }),
      cryptoRuntimeEntityId("fill", { ...common, symbol }),
      cryptoRuntimeClientOrderId({ ...common, symbol, action: "open" }),
    ]);

    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(cryptoRuntimeEntityId("decision", {
      ...common,
      symbol: "BTCUSDT",
    })).toBe(identifiers[0]);
    for (const clientOrderId of [identifiers[2]!, identifiers[5]!]) {
      expect(clientOrderId).toMatch(/^[.A-Z:/a-z0-9_-]{1,36}$/);
    }
  });

  it("matches the Python worker canonical input digest byte-for-byte", () => {
    expect(canonicalCryptoModelInputDigest([
      {
        timestamp: "2026-07-25T00:00:59.999Z",
        open: 100,
        high: 100.5,
        low: 99.25,
        close: 100.125,
        volume: 12.5,
        amount: 1_251.5625,
        complete: true,
      },
      {
        timestamp: "2026-07-25T00:01:59.999Z",
        open: 0.1,
        high: 0.3,
        low: 0.05,
        close: 0.2,
        volume: 0,
        amount: null,
        complete: true,
      },
    ])).toBe("5c040b70809bc0c525e6f438de98b4fe66341dc7a55953e2b688b95d136ec5d0");
  });

  it("never rewinds the daily-risk clock for a late prior-day event after UTC rollover", () => {
    const afterRollover = Date.parse("2026-07-26T00:00:00.250Z");
    const latePriorDay = Date.parse("2026-07-25T23:59:59.900Z");
    expect(monotonicCryptoRiskClock(
      afterRollover,
      afterRollover + 100,
      latePriorDay,
    )).toBe(afterRollover + 100);
  });

  it("shares a portfolio daily-loss gate without blocking an offset sleeve early", () => {
    const gate = new PortfolioDailyLossGate({
      lanes: ["kronos_base"],
      symbols: ["BTCUSDT", "ETHUSDT"],
      perSymbolInitialCash: 5_000,
      dailyLossLimitRate: 0.03,
      observedAt: START,
    });

    expect(gate.observe({
      lane: "kronos_base",
      symbol: "BTCUSDT",
      equity: 4_800,
      observedAt: START + 1_000,
      dailyLossLimitRate: 0.03,
    })).toMatchObject({
      drawdownRate: 0.02,
      blocked: false,
      closeAllReduceOnly: false,
    });
    expect(gate.observe({
      lane: "kronos_base",
      symbol: "ETHUSDT",
      equity: 5_200,
      observedAt: START + 1_001,
      dailyLossLimitRate: 0.03,
    })).toMatchObject({
      drawdownRate: 0,
      blocked: false,
      closeAllReduceOnly: false,
    });
    expect(gate.observe({
      lane: "kronos_base",
      symbol: "BTCUSDT",
      equity: 4_500,
      observedAt: START + 2_000,
      dailyLossLimitRate: 0.03,
    })).toMatchObject({
      drawdownRate: 0.03,
      blocked: true,
      closeAllReduceOnly: true,
    });
    expect(gate.state("kronos_base").blocked).toBe(true);

    const rollover = Date.parse("2026-07-26T00:00:00.000Z");
    expect(gate.observe({
      lane: "kronos_base",
      symbol: "ETHUSDT",
      equity: 5_100,
      observedAt: rollover,
      dailyLossLimitRate: 0.03,
    })).toMatchObject({
      dayStartEquity: 9_600,
      drawdownRate: 0,
      blocked: false,
    });
  });

  it("aggregates partitioned equity as one causal portfolio drawdown series", () => {
    const points = aggregatePortfolioEquitySeries([
      [
        { timestamp: new Date(START).toISOString(), equity: 5_000, drawdown: 0 },
        { timestamp: new Date(START + 1_000).toISOString(), equity: 4_800, drawdown: 0.04 },
        { timestamp: new Date(START + 2_000).toISOString(), equity: 4_900, drawdown: 0.02 },
      ],
      [
        { timestamp: new Date(START).toISOString(), equity: 5_000, drawdown: 0 },
        { timestamp: new Date(START + 1_000).toISOString(), equity: 5_200, drawdown: 0 },
        { timestamp: new Date(START + 2_000).toISOString(), equity: 5_000, drawdown: 0.038 },
      ],
    ], 5_000);

    expect(points.map(({ equity }) => equity)).toEqual([10_000, 10_000, 9_900]);
    expect(points[0]?.drawdown).toBe(0);
    expect(points[1]?.drawdown).toBe(0);
    expect(points[2]?.drawdown).toBeCloseTo(0.01, 12);
  });

  it("aggregates two-symbol lane metrics by their additive and weighted semantics", () => {
    const at = (offset: number) => new Date(START + offset).toISOString();
    const firstLane = {
      aggregationBasis: {
        schemaVersion: "crypto-model-metric-aggregation/v1",
        prediction: {
          pinballLossSum: 2,
          pinballLossCount: 2,
          medianAbsoluteErrorSum: 1,
          medianAbsoluteErrorCount: 2,
          directionHitSum: 1,
          directionCount: 2,
          coverageHitSum: 1,
          coverageCount: 2,
          nominalCoverageSum: 1.6,
          nominalCoverageCount: 2,
        },
        trading: {
          netPnl: 10,
          grossProfit: 30,
          grossLoss: 10,
          winCount: 2,
          outcomeCount: 3,
          turnoverNotional: 1_000,
          initialCash: 5_000,
          funding: 2,
          fees: 3,
          leverageDistribution: [2],
        },
        operations: {
          attempts: 10,
          successes: 8,
          latencySum: 800,
          latencyCount: 8,
          timeoutCount: 1,
          peakVramMb: 6_000,
        },
        equity: [
          { timestamp: at(0), equity: 5_000, drawdown: 0 },
          { timestamp: at(1_000), equity: 4_800, drawdown: 0.04 },
          { timestamp: at(2_000), equity: 4_900, drawdown: 0.02 },
        ],
      },
    };
    const secondLane = {
      aggregationBasis: {
        schemaVersion: "crypto-model-metric-aggregation/v1",
        prediction: {
          pinballLossSum: 8,
          pinballLossCount: 4,
          medianAbsoluteErrorSum: 3,
          medianAbsoluteErrorCount: 4,
          directionHitSum: 3,
          directionCount: 4,
          coverageHitSum: 2,
          coverageCount: 4,
          nominalCoverageSum: 3.2,
          nominalCoverageCount: 4,
        },
        trading: {
          netPnl: -5,
          grossProfit: 10,
          grossLoss: 20,
          winCount: 1,
          outcomeCount: 2,
          turnoverNotional: 2_000,
          initialCash: 5_000,
          funding: -1,
          fees: 4,
          leverageDistribution: [3, 4],
        },
        operations: {
          attempts: 10,
          successes: 4,
          latencySum: 1_200,
          latencyCount: 4,
          timeoutCount: 2,
          peakVramMb: 9_000,
        },
        equity: [
          { timestamp: at(0), equity: 5_000, drawdown: 0 },
          { timestamp: at(1_000), equity: 5_100, drawdown: 0 },
          { timestamp: at(2_000), equity: 4_800, drawdown: 0.0588 },
        ],
      },
    };

    const aggregated = aggregatePortfolioLaneMetrics(
      [firstLane, secondLane],
      2,
    );

    expect(aggregated.consistent).toBe(true);
    expect(aggregated.metrics).toMatchObject({
      netPnl: 5,
      funding: 1,
      fees: 7,
      timeoutCount: 3,
      peakVramMb: 9_000,
      availabilityRatio: 0.6,
      winRate: 0.6,
      profitFactor: 4 / 3,
      turnover: 0.3,
      leverageDistribution: [2, 3, 4],
    });
    expect(aggregated.metrics.pinballLoss).toBeCloseTo(10 / 6, 12);
    expect(aggregated.metrics.medianReturnMae).toBeCloseTo(4 / 6, 12);
    expect(aggregated.metrics.directionAccuracy).toBeCloseTo(4 / 6, 12);
    expect(aggregated.metrics.quantileCoverage).toBeCloseTo(0.5, 12);
    expect(aggregated.metrics.calibrationError).toBeCloseTo(0.3, 12);
    expect(aggregated.metrics.latencyMs).toBeCloseTo(2_000 / 12, 12);
    expect(aggregated.metrics.maxDrawdown).toBeCloseTo(0.03, 12);
  });

  it("counts each rowless per-symbol diagnostics artifact as one portfolio item", () => {
    const grouped = groupPortfolioRuntimeArtifacts([
      {
        summary: {},
        result: {},
        artifacts: [{
          type: "simulation-diagnostics",
          content: { symbol: "BTCUSDT" },
        }],
      },
      {
        summary: {},
        result: {},
        artifacts: [{
          type: "simulation-diagnostics",
          content: { symbol: "ETHUSDT" },
        }],
      },
    ]);

    expect(grouped).toEqual([{
      type: "simulation-diagnostics",
      contents: [
        { symbol: "BTCUSDT" },
        { symbol: "ETHUSDT" },
      ],
      rowCount: 2,
    }]);
  });

  it("preserves matching portfolio lane provenance and fails mismatches closed", () => {
    const provenance = {
      modelId: "NeoQuasar/Kronos-base",
      modelRevision: kronosModelRevision,
      precision: "fp32",
      device: "cuda",
    };
    expect(aggregatePortfolioLaneProvenance([
      { provenance },
      { provenance: structuredClone(provenance) },
    ], 2)).toEqual({
      consistent: true,
      provenance,
    });
    expect(aggregatePortfolioLaneProvenance([
      { provenance },
      {
        provenance: {
          ...provenance,
          modelRevision: "unexpected-revision",
        },
      },
    ], 2)).toMatchObject({
      consistent: false,
      provenance,
    });
    expect(aggregatePortfolioLaneProvenance([
      { provenance },
    ], 2)).toMatchObject({
      consistent: false,
      provenance,
    });
  });

  it("normalizes omitted Kronos precision provenance to safe native defaults", async () => {
    const { result } = await runProvenanceSimulation({ lane: "kronos_base" });
    const comparisonLane = (
      artifact(result, "simulation-comparison").lanes as UnknownRecord[]
    )[0]!;
    const comparisonProvenance = comparisonLane.provenance as UnknownRecord;
    expect(comparisonProvenance).toMatchObject({
      modelId: "NeoQuasar/Kronos-base",
      modelRevision: kronosModelRevision,
      sourceRevision: kronosSourceRevision,
      loaderVersion: "kronos-source-67b630e",
      license: "MIT",
      tokenizerId: "NeoQuasar/Kronos-Tokenizer-base",
      tokenizerRevision: kronosTokenizerRevision,
      loaded: true,
      device: "cuda",
      deviceName: "Tesla P40",
      cudaCapability: "6.1",
      attentionBackend: "math",
      precision: "fp32",
      precisionValidation: "not_required",
      memoryStatus: "ok",
      quantileMonotonicityPolicy: "native",
      quantileTailPolicy: "native",
      precisionFailureReasons: [],
      peakVramMb: 6_000,
    });
    const storedLane = (
      artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
    )[0]!;
    expect(storedLane).toMatchObject({
      ...comparisonProvenance,
      attempts: 1,
      successes: 1,
      errors: [],
    });
  });

  it("keeps matching child provenance in the portfolio lane and marks drift partial", async () => {
    const { result, runtime } = await runProvenanceSimulation({ lane: "kronos_base" });
    const firstSnapshot = (result.result as {
      snapshot: CryptoPaperRuntimeSnapshot;
    }).snapshot;
    const secondSnapshot = structuredClone(firstSnapshot);
    secondSnapshot.runId = "crypto-run-1:2:ETHUSDT";
    const request: SimulationStartRequest = {
      ...simulationRequest(["kronos_base"]),
      selection: { mode: "auto", criterion: "volatility", symbolCount: 2 },
    };
    const aggregate = (
      runtime as unknown as {
        aggregatePortfolioSnapshots: (
          runId: string,
          input: SimulationStartRequest,
          snapshots: readonly CryptoPaperRuntimeSnapshot[],
        ) => CryptoPaperRuntimeSnapshot;
      }
    ).aggregatePortfolioSnapshots.bind(runtime);

    const matching = aggregate(
      "crypto-run-1",
      request,
      [firstSnapshot, secondSnapshot],
    );
    const matchingLane = (
      (matching.modelComparison as UnknownRecord).lanes as UnknownRecord[]
    )[0]!;
    expect(matchingLane).toMatchObject({
      id: "kronos_base",
      status: "healthy",
      provenanceConsistent: true,
      provenance: {
        modelId: "NeoQuasar/Kronos-base",
        modelRevision: kronosModelRevision,
        precision: "fp32",
      },
    });

    const driftedSnapshot = structuredClone(secondSnapshot);
    const driftedComparison = driftedSnapshot.modelComparison as UnknownRecord;
    const driftedLane = (driftedComparison.lanes as UnknownRecord[])[0]!;
    const driftedProvenance = driftedLane.provenance as UnknownRecord;
    driftedProvenance.modelRevision = "unexpected-revision";
    const drifted = aggregate(
      "crypto-run-1",
      request,
      [firstSnapshot, driftedSnapshot],
    );
    expect(((drifted.modelComparison as UnknownRecord).lanes as UnknownRecord[])[0])
      .toMatchObject({
        id: "kronos_base",
        status: "partial",
        provenanceConsistent: false,
        unavailableReason: "portfolio_model_provenance_inconsistent",
      });
  });

  it("publishes strict 5/15/30/60 minute price paths for the candle timeline", async () => {
    const { result } = await runProvenanceSimulation({
      lane: "kronos_base",
      transform: (raw) => responseWithDisplayPath(raw),
    });
    const snapshot = (result.result as {
      snapshot: CryptoPaperRuntimeSnapshot;
    }).snapshot;
    const forecast = snapshot.modelForecasts[0] as UnknownRecord;
    const points = forecast.points as UnknownRecord[];

    expect(forecast).toMatchObject({
      lane: "kronos_base",
      signalSymbol: "BTCUSDT",
      status: "available",
      modelId: "NeoQuasar/Kronos-base",
    });
    expect(points.map((point) => point.horizonMinutes)).toEqual([5, 15, 30, 60]);
    expect(points.map((point) => Date.parse(point.targetTimestamp as string))).toEqual(
      SCALPING_AI_HORIZONS.map((horizon) => (
        Date.parse(forecast.origin as string) + horizon * 60_000
      )),
    );
    expect(snapshot.selected[0]).toMatchObject({
      symbol: "BTCUSDT",
      currentPrice: 100,
      priceObservedAt: new Date(START + 20).toISOString(),
      observedAt: new Date(START + 20).toISOString(),
      upProbability: 0.64,
      predictedMedianReturn: 0,
      model: {
        modelId: "NeoQuasar/Kronos-base",
        modelRevision: kronosModelRevision,
        device: "cuda",
      },
    });
    expect(snapshot.futuresRisk).toMatchObject({
      dailyLossLimitRatio: 0.03,
      riskPerTradeRatio: 0.005,
      grossExposureLimitRatio: 1.5,
      marginUsageLimitRatio: 0.2,
      maximumLeverage: 15,
      liquidationBufferMultiple: 2,
    });
    expect(snapshot.kronosForecasts).toEqual(snapshot.modelForecasts);
  });

  it("fails forecast visibility closed after later failures, circuit-open origins, or max horizon", () => {
    const inputEndAt = new Date(START).toISOString();
    const targets = [5, 15, 30, 60].map((minutes) => (
      new Date(START + minutes * 60_000).toISOString()
    ));
    expect(cryptoModelForecastIsFresh({
      inputEndAt,
      targetTimestamps: targets,
      latestFinalCandleCloseTime: START,
    })).toBe(true);
    expect(cryptoModelForecastIsFresh({
      inputEndAt,
      targetTimestamps: targets,
      latestFinalCandleCloseTime: START + 60_000,
    })).toBe(false);
    expect(cryptoModelForecastIsFresh({
      inputEndAt,
      targetTimestamps: targets,
      latestFinalCandleCloseTime: START + 60 * 60_000,
    })).toBe(false);
    expect(cryptoModelForecastIsFresh({
      inputEndAt,
      targetTimestamps: [new Date(START).toISOString()],
      latestFinalCandleCloseTime: START,
    })).toBe(false);
  });

  it("does not republish a successful price path after a later failure opens the circuit", async () => {
    const clock = new ScheduledClock();
    let invocation = 0;
    const client: CryptoAiLaneClient = {
      request: vi.fn(async (request: AiForecastRequest) => {
        invocation += 1;
        if (invocation > 1) throw new Error("model_call_failed");
        return responseWithDisplayPath(response(
          "kronos_base",
          request,
          Math.max(clock.now(), Date.parse(request.series[0]!.input_end_at)),
          flatReturns,
        ));
      }),
    };
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      ...riskPrelude(START + 60_010, 101),
      {
        at: START + 60_100,
        event: nextFinalKline(START, START + 60_100),
      },
      ...riskPrelude(START + 120_010, 102),
      {
        at: START + 120_100,
        event: nextFinalKline(START + 60_000, START + 120_100),
      },
    ]);
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
      circuitBreaker: {
        failureThreshold: 1,
        cooldownMs: 3_600_000,
      },
    });

    const result = await runtime.run({
      request: { ...simulationRequest(), durationMinutes: 3 },
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const terminal = (result.result as {
      snapshot: CryptoPaperRuntimeSnapshot;
    }).snapshot;

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(terminal.modelForecasts).toEqual([
      expect.objectContaining({
        lane: "kronos_base",
        status: "unavailable",
        points: [],
        unavailableReason: "model_forecast_stale",
      }),
    ]);
    expect(terminal.selected[0]).toMatchObject({
      symbol: "BTCUSDT",
      currentPrice: 102,
      observedAt: new Date(START + 120_020).toISOString(),
    });
    expect(terminal.selected[0]).not.toHaveProperty("upProbability");
    expect(terminal.selected[0]).not.toHaveProperty("predictedMedianReturn");
    expect(terminal.selected[0]).not.toHaveProperty("inputEndAt");
    expect(terminal.selected[0]).not.toHaveProperty("generatedAt");
    expect(terminal.selected[0]).not.toHaveProperty("model");
    expect(artifact(result, "simulation-decisions").decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unavailable",
          reason: "model_call_failed",
        }),
        expect.objectContaining({
          status: "unavailable",
          reason: "worker_circuit_open",
        }),
      ]),
    );
  });

  it("fails a display path closed when a model target is not the requested timestamp", async () => {
    const { result } = await runProvenanceSimulation({
      lane: "kronos_base",
      transform: (raw) => responseWithDisplayPath(raw, {
        shiftedTargetHorizon: 15,
      }),
    });
    const snapshot = (result.result as {
      snapshot: CryptoPaperRuntimeSnapshot;
    }).snapshot;

    expect(snapshot.modelForecasts).toEqual([
      expect.objectContaining({
        lane: "kronos_base",
        status: "unavailable",
        points: [],
        unavailableReason: "model_price_quantiles_invalid",
      }),
    ]);
  });

  it("preserves complete FinCast mixed-FP16 validation provenance", async () => {
    const { result } = await runProvenanceSimulation({ lane: "fincast" });
    const comparisonLane = (
      artifact(result, "simulation-comparison").lanes as UnknownRecord[]
    )[0]!;
    expect(comparisonLane).toMatchObject({
      id: "fincast",
      precision: "fp16",
      provenance: {
        modelId: "Vincent05R/FinCast",
        modelRevision: fincastModelRevision,
        sourceRevision: fincastSourceRevision,
        loaderVersion: "fincast-source-488b19d",
        license: "Apache-2.0",
        tokenizerId: null,
        tokenizerRevision: null,
        loaded: true,
        device: "cuda",
        deviceName: "Tesla P40",
        cudaCapability: "6.1",
        attentionBackend: "math",
        precision: "fp16",
        precisionValidation: "passed",
        memoryStatus: "ok",
        quantileMonotonicityPolicy: "fp32_monotone_rearrangement_v1",
        fp32QuantileObservations: {
          rowCount: 7_680,
          crossingRowCount: 65,
          crossingAdjacentPairCount: 74,
          adjustedRowCount: 65,
          q50AdjustmentIqrRatioP95: 0.06324,
          postprocessedMonotonic: true,
        },
        mixedQuantileObservations: {
          rowCount: 7_680,
          crossingRowCount: 67,
          crossingAdjacentPairCount: 79,
          adjustedRowCount: 67,
          postprocessedMonotonic: true,
        },
        quantileTailPolicy: "tail_clamped_q10_q90",
        precisionFailureReasons: [],
        peakVramBytes: 4_000 * 1024 * 1024,
        peakVramMeasurement: "cuda_allocated_or_reserved",
        peakVramMb: 4_000,
      },
    });
    const storedLane = (
      artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
    )[0]!;
    expect(storedLane).toMatchObject({
      precisionValidation: "passed",
      memoryStatus: "ok",
      quantileMonotonicityPolicy: "fp32_monotone_rearrangement_v1",
      fp32QuantileObservations: {
        rowCount: 7_680,
        crossingRowCount: 65,
        adjustedRowCount: 65,
      },
      mixedQuantileObservations: {
        rowCount: 7_680,
        crossingRowCount: 67,
        adjustedRowCount: 67,
      },
      quantileTailPolicy: "tail_clamped_q10_q90",
      precisionFailureReasons: [],
      peakVramBytes: 4_000 * 1024 * 1024,
      peakVramMeasurement: "cuda_allocated_or_reserved",
    });
  });

  it("preserves FinCast FP32 fallback qualification and bounded failure reasons", async () => {
    const { result } = await runProvenanceSimulation({
      lane: "fincast",
      modelOverrides: () => ({
        dtype: "float32",
        precision_validation: "fallback_fp32",
        precision_failure_reasons: [
          "q50_p95_error_above_15pct_fp32_iqr",
          "peak_vram_reduction_below_25pct",
        ],
      }),
    });
    const comparisonLane = (
      artifact(result, "simulation-comparison").lanes as UnknownRecord[]
    )[0]!;
    expect(comparisonLane).toMatchObject({
      precision: "fp32",
      provenance: {
        precision: "fp32",
        precisionValidation: "fallback_fp32",
        memoryStatus: "ok",
        quantileMonotonicityPolicy: "fp32_monotone_rearrangement_v1",
        quantileTailPolicy: "tail_clamped_q10_q90",
        precisionFailureReasons: [
          "q50_p95_error_above_15pct_fp32_iqr",
          "peak_vram_reduction_below_25pct",
        ],
      },
    });
    expect((
      artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
    )[0]).toMatchObject({
      precisionValidation: "fallback_fp32",
      precisionFailureReasons: [
        "q50_p95_error_above_15pct_fp32_iqr",
        "peak_vram_reduction_below_25pct",
      ],
    });
  });

  it.each([
    ["validated precision profile", {
      dtype: "float32",
      precision_validation: "fallback_fp32",
      precision_failure_reasons: ["peak_vram_reduction_below_25pct"],
    }],
    ["validated peak VRAM", {
      peak_vram_bytes: 3_900 * 1024 * 1024,
    }],
    ["bounded mixed quantile observations", {
      mixed_quantile_observations: qualificationObservations({
        crossing_row_count: 68,
        crossing_adjacent_pair_count: 80,
        adjusted_row_count: 68,
      }),
    }],
  ] as const)(
    "fails a successful lane closed when its %s drifts",
    async (_label, driftedModel) => {
      const { result, client } = await runProvenanceSimulation({
        lane: "fincast",
        attempts: 2,
        modelOverrides: (attempt) => attempt === 0 ? {} : driftedModel,
      });
      expect(client.request).toHaveBeenCalledTimes(2);
      const comparisonLane = (
        artifact(result, "simulation-comparison").lanes as UnknownRecord[]
      )[0]!;
      expect(comparisonLane).toMatchObject({
        status: "partial",
        unavailableReason: "model_provenance_inconsistent",
        provenance: {
          modelRevision: fincastModelRevision,
          precision: "fp16",
          precisionValidation: "passed",
        },
      });
      expect((
        artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
      )[0]).toMatchObject({
        modelRevision: fincastModelRevision,
        precision: "fp16",
        precisionValidation: "passed",
        attempts: 2,
        successes: 1,
        errors: ["model_provenance_inconsistent"],
      });
    },
  );

  it.each([
    ["model_id", "/tmp/private-model/id", "model_identity_mismatch"],
    ["model_revision", "/tmp/private-model/revision", "model_provenance_invalid"],
    ["source_revision", "/tmp/private-model/source", "model_provenance_invalid"],
    ["loader_version", "/tmp/private-model/loader", "model_provenance_invalid"],
    ["license", "/tmp/private-model/license", "model_provenance_invalid"],
  ] as const)(
    "rejects unpinned %s without persisting the supplied value",
    async (field, unsafeValue, expectedError) => {
      const { result } = await runProvenanceSimulation({
        lane: "fincast",
        modelOverrides: () => ({ [field]: unsafeValue }),
      });
      const serialized = JSON.stringify(result.artifacts);
      expect((
        artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
      )[0]).toMatchObject({
        attempts: 1,
        successes: 0,
        errors: [expectedError],
      });
      expect(serialized).not.toContain(unsafeValue);
    },
  );

  it.each([
    ["tokenizer_id", "/tmp/private-tokenizer/id"],
    ["tokenizer_revision", "/tmp/private-tokenizer/revision"],
  ] as const)(
    "requires the pinned Kronos %s and bounds the persisted error",
    async (field, unsafeValue) => {
      const { result } = await runProvenanceSimulation({
        lane: "kronos_base",
        modelOverrides: () => ({ [field]: unsafeValue }),
      });
      const serialized = JSON.stringify(result.artifacts);
      expect((
        artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
      )[0]).toMatchObject({
        attempts: 1,
        successes: 0,
        errors: ["model_tokenizer_provenance_invalid"],
      });
      expect(serialized).not.toContain(unsafeValue);
    },
  );

  it.each([
    ["loaded", false],
    ["device", "cpu"],
    ["device_name", "/tmp/private-device"],
    ["cuda_capability", "7.0"],
    ["attention_backend", "flash"],
  ] as const)(
    "requires safe loaded P40 CUDA math runtime provenance when %s is invalid",
    async (field, unsafeValue) => {
      const { result } = await runProvenanceSimulation({
        lane: "fincast",
        modelOverrides: () => ({ [field]: unsafeValue }),
      });
      const serialized = JSON.stringify(result.artifacts);
      expect((
        artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
      )[0]).toMatchObject({
        attempts: 1,
        successes: 0,
        errors: ["model_runtime_provenance_invalid"],
      });
      if (typeof unsafeValue === "string" && unsafeValue.startsWith("/tmp/")) {
        expect(serialized).not.toContain(unsafeValue);
      }
    },
  );

  it("rejects pinned provenance drift before it can replace prior lane provenance", async () => {
    const unsafeRevision = "/tmp/private-model/drifted-revision";
    const { result } = await runProvenanceSimulation({
      lane: "fincast",
      attempts: 2,
      modelOverrides: (attempt) => attempt === 0
        ? {}
        : { model_revision: unsafeRevision },
    });
    expect((
      artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
    )[0]).toMatchObject({
      modelRevision: fincastModelRevision,
      attempts: 2,
      successes: 1,
      errors: ["model_provenance_invalid"],
    });
    expect(JSON.stringify(result.artifacts)).not.toContain(unsafeRevision);
  });

  it.each([
    ["precision_validation", "model_precision_validation_invalid"],
    ["memory_status", "model_memory_status_invalid"],
    ["quantile_monotonicity_policy", "model_quantile_monotonicity_policy_invalid"],
    ["fp32_quantile_observations", "model_quantile_observations_invalid"],
    ["mixed_quantile_observations", "model_quantile_observations_invalid"],
    ["quantile_tail_policy", "model_quantile_tail_policy_invalid"],
    ["precision_failure_reasons", "model_precision_failure_reasons_invalid"],
    ["peak_vram_bytes", "model_peak_vram_invalid"],
  ] as const)(
    "rejects a FinCast response that omits mandatory %s provenance",
    async (field, expectedError) => {
      const { result } = await runProvenanceSimulation({
        lane: "fincast",
        transform: (raw) => {
          delete (raw.model as UnknownRecord)[field];
          const modelRuns = raw.model_runs as Array<UnknownRecord>;
          delete (modelRuns[0]!.model as UnknownRecord)[field];
          return raw;
        },
      });
      const comparisonLane = (
        artifact(result, "simulation-comparison").lanes as UnknownRecord[]
      )[0]!;
      expect(comparisonLane).toMatchObject({
        status: "unavailable",
        unavailableReason: expectedError,
      });
      expect((
        artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
      )[0]).toMatchObject({
        attempts: 1,
        successes: 0,
        errors: [expectedError],
      });
    },
  );

  it("persists null mixed observations only for a bounded mixed runtime failure", async () => {
    const { result } = await runProvenanceSimulation({
      lane: "fincast",
      modelOverrides: () => ({
        dtype: "float32",
        precision_validation: "fallback_fp32",
        precision_failure_reasons: ["mixed_inference_failure"],
        mixed_quantile_observations: null,
      }),
    });
    const lane = (
      artifact(result, "simulation-comparison").lanes as UnknownRecord[]
    )[0]!;
    expect(lane).toMatchObject({
      status: "completed",
      provenance: {
        precision: "fp32",
        precisionFailureReasons: ["mixed_inference_failure"],
        fp32QuantileObservations: {
          rowCount: 7_680,
          crossingRowCount: 65,
        },
        mixedQuantileObservations: null,
      },
    });
  });

  it("rejects path-like FinCast precision failure details", async () => {
    const { result } = await runProvenanceSimulation({
      lane: "fincast",
      modelOverrides: () => ({
        dtype: "float32",
        precision_validation: "fallback_fp32",
        precision_failure_reasons: ["/tmp/private-model/checkpoint"],
      }),
    });
    const storedLane = (
      artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
    )[0]!;
    expect(storedLane).toMatchObject({
      attempts: 1,
      successes: 0,
      errors: ["model_precision_failure_reasons_invalid"],
    });
    expect(JSON.stringify(storedLane)).not.toContain("/tmp/private-model");
  });

  it.each([
    ["context_start_at", "2026-01-01T00:00:00.000Z"],
    ["input_end_at", "2026-07-25T00:09:59.999001Z"],
    ["bar_count", 63],
    ["input_digest", "b".repeat(64)],
  ] as const)(
    "rejects model-run input origin evidence when %s does not match the sent bars",
    async (field, driftedValue) => {
      const { result } = await runProvenanceSimulation({
        lane: "fincast",
        transform: (raw) => {
          const modelRuns = raw.model_runs as Array<UnknownRecord>;
          const origins = modelRuns[0]!.input_origins as Array<UnknownRecord>;
          origins[0]![field] = driftedValue;
          return raw;
        },
      });
      expect((
        artifact(result, "simulation-provenance").modelLanes as UnknownRecord[]
      )[0]).toMatchObject({
        attempts: 1,
        successes: 0,
        errors: ["model_input_origin_mismatch"],
      });
    },
  );

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
    expect(taskContext.updates.at(-1)).toBe(0.999);
    expect(terminal).toMatchObject({ phase: "failed", progress: 0.999 });
    expect(result.terminalFailure?.code).toBe(
      "CRYPTO_TERMINAL_SETTLEMENT_INCOMPLETE",
    );
  });

  it("uses finalized 15-second aggTrade bars only for FinCast input while keeping the chart at one minute", async () => {
    const clock = new ScheduledClock();
    const observed: AiForecastRequest[] = [];
    const client = laneClient("fincast", START + 15_002, flatReturns, observed);
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(START + 14_980),
      { at: START + 1, event: aggTrade(START + 1) },
      { at: START + 15_001, event: aggTrade(START + 15_001, 101) },
    ]);
    const historicalTrades = Array.from({ length: 64 }, (_, index) => {
      const executedAt = START - (64 - index) * 15_000 + 1;
      return {
        a: index + 1,
        p: String(100 + index / 1_000),
        q: "1",
        T: executedAt,
        m: false,
      };
    });
    const runtime = new CryptoPaperRuntime({
      rest: {
        ...rest(),
        aggregateTrades: vi.fn().mockResolvedValue(historicalTrades),
      },
      streams,
      laneClients: { fincast: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const taskContext = context();
    const request = {
      ...simulationRequest(["fincast"]),
      fincastCandleSeconds: 15 as const,
    };
    const result = await runtime.run({
      request,
      snapshot: scannerSnapshot,
      selected: candidate,
      context: taskContext.value,
    });

    expect(observed).toHaveLength(1);
    const sentBars = observed[0]!.series[0]!.bars;
    expect(sentBars).toHaveLength(64);
    expect(sentBars.slice(1).every((bar, index) => (
      Date.parse(bar.timestamp) - Date.parse(sentBars[index]!.timestamp) === 15_000
    ))).toBe(true);
    expect(Date.parse(observed[0]!.series[0]!.input_end_at)).toBe(START + 14_999);
    expect(observed[0]!.series[0]!.future_timestamps.slice(1).every(
      (timestamp, index) => (
        Date.parse(timestamp)
        - Date.parse(observed[0]!.series[0]!.future_timestamps[index]!)
        === 60_000
      ),
    )).toBe(true);
    const terminal = (result.result as UnknownRecord).snapshot as CryptoPaperRuntimeSnapshot;
    expect(terminal.decisionCadence).toMatchObject({
      trigger: "final_fincast_15s_aggtrade_bar",
      modelCandleSeconds: 15,
      triggeredEvents: 1,
    });
    expect(terminal.capabilities).toMatchObject({
      modelCandleSeconds: 15,
      chartCandleSeconds: 60,
      realOrder: false,
    });
    expect((terminal.charts as Array<{ bars: Array<{ timestamp: string }> }>)[0]!.bars
      .every((bar, index, values) => (
        index === 0
        || Date.parse(bar.timestamp) - Date.parse(values[index - 1]!.timestamp) === 60_000
      ))).toBe(true);
  });

  it("drains risk streams during deferred inference and fills only after the completion watermark", async () => {
    const clock = new ScheduledClock();
    const worker = deferred<unknown>();
    const observed: AiForecastRequest[] = [];
    const snapshots: CryptoPaperRuntimeSnapshot[] = [];
    const client: CryptoAiLaneClient = {
      request: vi.fn((request: AiForecastRequest) => {
        observed.push(structuredClone(request));
        return worker.promise;
      }),
    };
    const staleBook = {
      ...bookTicker(START + 30_000, 90, 110),
      receivedAt: START + 31_610,
    };
    const staleMark = {
      ...markPrice(START + 30_000, 1),
      receivedAt: START + 31_620,
    };
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      {
        at: START + 31_000,
        event: bookTicker(START + 31_000, 99.96, 100.04),
      },
      { at: START + 31_600, event: markPrice(START + 31_600, 100) },
      { at: START + 31_610, event: staleBook },
      { at: START + 31_620, event: staleMark },
      // This arrived while the worker was unresolved and can never become
      // the causal fill for the resulting decision.
      { at: START + 31_940, event: aggTrade(START + 31_940) },
      { at: START + 32_100, event: aggTrade(START + 32_100) },
    ]);
    clock.schedule(START + 32_000, () => {
      const request = observed[0];
      if (!request) throw new Error("worker request was not observed before resolution");
      worker.resolve(response(
        "kronos_base",
        request,
        START + 32_000,
        longReturns,
      ));
    });
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
    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(Date.parse(observed[0]!.series[0]!.input_end_at)).toBe(START - 1);
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decisionCadence: expect.objectContaining({ inFlight: true }),
      }),
    ]));
    expect(snapshots.some((snapshot) => (
      snapshot.decisionCadence.inFlight
      && snapshot.futuresRisk.riskStreams.bookTicker.lastObservedAt
        === new Date(START + 31_000).toISOString()
      && snapshot.futuresRisk.riskStreams.markPrice.lastObservedAt
        === new Date(START + 31_600).toISOString()
    ))).toBe(true);

    const trades = artifact(result, "simulation-trades");
    const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord).fills as UnknownRecord[];
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      action: "open",
      decisionAt: START + 32_000,
      executedAt: START + 32_100,
    });
    const decisions = artifact(result, "simulation-decisions").decisions as UnknownRecord[];
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "open_long",
        status: "executed",
      }),
    ]));
    expect(decisions.find((decision) => decision.action === "open_long")?.roundTripCostRate)
      .toBeCloseTo(0.0012, 10);
    const terminal = (result.result as UnknownRecord).snapshot as CryptoPaperRuntimeSnapshot;
    expect(terminal.futuresRisk.riskStreams).toMatchObject({
      bookTicker: {
        lastObservedAt: new Date(START + 31_000).toISOString(),
      },
      markPrice: {
        lastObservedAt: new Date(START + 31_600).toISOString(),
      },
    });
  });

  it("runs one worker at a time and coalesces finalized bars to the latest origin", async () => {
    const clock = new ScheduledClock();
    const firstWorker = deferred<unknown>();
    const requests: AiForecastRequest[] = [];
    let active = 0;
    let maximumActive = 0;
    const client: CryptoAiLaneClient = {
      request: vi.fn((request: AiForecastRequest) => {
        const invocation = requests.length;
        requests.push(structuredClone(request));
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const result = invocation === 0
          ? firstWorker.promise
          : Promise.resolve(response(
            "kronos_base",
            request,
            Math.max(clock.now(), Date.parse(request.series[0]!.input_end_at)),
            longReturns,
          ));
        return result.finally(() => {
          active -= 1;
        });
      }),
    };
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      ...riskPrelude(START + 60_020, 101),
      {
        at: START + 60_100,
        event: nextFinalKline(START, START + 60_100),
      },
      ...riskPrelude(START + 120_020, 101),
      {
        at: START + 120_100,
        event: nextFinalKline(START + 60_000, START + 120_100),
      },
      { at: START + 124_100, event: aggTrade(START + 124_100, 101) },
    ]);
    clock.schedule(START + 124_000, () => {
      const request = requests[0];
      if (!request) throw new Error("first worker request was not observed");
      firstWorker.resolve(response(
        "kronos_base",
        request,
        START + 124_000,
        longReturns,
      ));
    });
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: { ...simulationRequest(), durationMinutes: 3 },
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(requests.map((request) => Date.parse(request.series[0]!.input_end_at))).toEqual([
      START - 1,
      START + 119_999,
    ]);
    const terminal = (result.result as UnknownRecord).snapshot as CryptoPaperRuntimeSnapshot;
    expect(terminal.decisionCadence).toMatchObject({
      triggeredEvents: 2,
      coalescedFinalKlines: 1,
      inFlight: false,
    });
    const trades = artifact(result, "simulation-trades");
    const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord).fills as UnknownRecord[];
    expect(fills[0]).toMatchObject({
      action: "open",
      decisionAt: START + 124_000,
      executedAt: START + 124_100,
    });
  });

  it("discards an older coalesced origin when a newer final bar is blocked", async () => {
    const clock = new ScheduledClock();
    const worker = deferred<unknown>();
    let workerRequest: AiForecastRequest | undefined;
    const client: CryptoAiLaneClient = {
      request: vi.fn((request) => {
        workerRequest = structuredClone(request);
        return worker.promise;
      }),
    };
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      ...riskPrelude(START + 60_020, 101),
      {
        at: START + 60_100,
        event: nextFinalKline(START, START + 60_100),
      },
      // No risk refresh precedes this newer final. It supersedes the queued
      // middle bar but is itself blocked for stale risk data.
      {
        at: START + 120_100,
        event: nextFinalKline(START + 60_000, START + 120_100),
      },
    ]);
    clock.schedule(START + 120_200, () => {
      worker.resolve(response(
        "kronos_base",
        workerRequest!,
        START + 120_200,
        longReturns,
      ));
    });
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: { ...simulationRequest(), durationMinutes: 3 },
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });

    expect(client.request).toHaveBeenCalledTimes(1);
    const terminal = (result.result as UnknownRecord).snapshot as CryptoPaperRuntimeSnapshot;
    expect(terminal.decisionCadence.coalescedFinalKlines).toBe(1);
    const decisions = artifact(result, "simulation-decisions").decisions as UnknownRecord[];
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        originAt: new Date(START + 119_999).toISOString(),
        status: "blocked",
        reason: expect.stringContaining("risk_stream_"),
      }),
    ]));
  });

  it("backfills a late forecast metric from the earliest completed target bar", async () => {
    const clock = new ScheduledClock();
    const worker = deferred<unknown>();
    let workerRequest: AiForecastRequest | undefined;
    const futureCloses = [101, 102, 103, 104, 105, 120];
    const scheduledBars = futureCloses.map((close, index) => {
      const openTime = START + index * 60_000;
      const receivedAt = START + (index + 1) * 60_000 + 100;
      return {
        at: receivedAt,
        event: {
          ...nextFinalKline(openTime, receivedAt),
          open: close,
          high: close + 0.5,
          low: close - 0.5,
          close,
        },
      };
    });
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      ...scheduledBars,
    ]);
    clock.schedule(START + 360_200, () => {
      worker.resolve(response(
        "kronos_base",
        workerRequest!,
        START + 360_200,
        longReturns,
      ));
    });
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: {
        kronos_base: {
          request: vi.fn((request) => {
            workerRequest = structuredClone(request);
            return worker.promise;
          }),
        },
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: { ...simulationRequest(), durationMinutes: 7 },
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });

    const comparison = artifact(result, "simulation-comparison");
    const lanes = comparison.lanes as Array<UnknownRecord>;
    const metrics = lanes[0]!.metrics as UnknownRecord;
    // Origin=100, the exact five-minute target closes at 105, and q50=2%.
    // The later 120 close must not be substituted after the worker returns.
    expect(metrics.medianReturnMae as number).toBeCloseTo(0.03, 10);
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
      // An exchange-clock-ahead event must not end the local run early.
      {
        at: START + 300,
        event: { ...aggTrade(START + 60_001), receivedAt: START + 300 },
      },
      {
        at: START + 60_000,
        event: {
          ...aggTrade(START + 60_002, 102),
          // Receipt time is telemetry only for terminal eligibility.
          receivedAt: START + 500,
        },
      },
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
    expect(kronosFills).toHaveLength(2);
    expect(fincastFills).toHaveLength(2);
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
    expect(kronosFills[1]).toMatchObject({
      action: "reduce",
      side: "long",
      reduceOnly: true,
      reason: "terminal_settlement",
      decisionAt: START + 60_000,
      executedAt: START + 60_002,
    });
    expect(fincastFills[1]).toMatchObject({
      action: "reduce",
      side: "short",
      reduceOnly: true,
      reason: "terminal_settlement",
      decisionAt: START + 60_000,
      executedAt: START + 60_002,
    });
    const comparison = artifact(result, "simulation-comparison");
    expect(comparison).toMatchObject({
      sameOrigin: true,
      sameContext: true,
      sameCosts: true,
      sameFillBarrier: true,
      outcome: "inconclusive",
    });
    const settlement = artifact(result, "simulation-trades").terminalSettlement as UnknownRecord;
    expect(settlement).toMatchObject({
      scheduling: "expiry_boundary_event",
      decisionAt: new Date(START + 60_000).toISOString(),
      settlementComplete: true,
      status: "settled",
      candidateEventsObserved: 1,
      boundaryTrigger: {
        kind: "agg_trade",
        causalAt: new Date(START + 60_002).toISOString(),
        receivedAt: new Date(START + 500).toISOString(),
        observedPrice: 102,
        aggregateTradeId: String(START + 60_002),
      },
      fillBarrierEvent: {
        kind: "agg_trade",
        causalAt: new Date(START + 60_002).toISOString(),
        receivedAt: new Date(START + 500).toISOString(),
        observedPrice: 102,
        aggregateTradeId: String(START + 60_002),
      },
    });
    expect(settlement.commonFillBarrierDigest).toEqual(expect.any(String));
    expect(settlement.lanes).toEqual([
      expect.objectContaining({
        lane: "kronos_base",
        status: "settled",
        settledBy: "terminal_reduce",
        remainingQuantity: 0,
        fillEventKind: "agg_trade",
      }),
      expect.objectContaining({
        lane: "fincast",
        status: "settled",
        settledBy: "terminal_reduce",
        remainingQuantity: 0,
        fillEventKind: "agg_trade",
      }),
    ]);
  });

  it("applies a nonzero exit-tax override to terminal paper fills and artifacts", async () => {
    const clock = new ScheduledClock();
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 200, event: aggTrade(START + 200) },
      {
        at: START + 60_000,
        event: {
          ...aggTrade(START + 60_002, 102),
          receivedAt: START + 500,
        },
      },
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
    const baseRequest = simulationRequest();
    const result = await runtime.run({
      request: {
        ...baseRequest,
        costs: {
          ...baseRequest.costs,
          taxBpsOnExit: 10,
        },
      },
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });
    const trades = artifact(result, "simulation-trades");
    const ledger = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord);
    const fills = ledger.fills as UnknownRecord[];
    const opened = fills[0]!;
    const closed = fills[1]!;
    const tradeRows = trades.trades as UnknownRecord[];
    const closingRow = tradeRows[1]!;
    const expectedExitTax = (closed.notional as number) * 10 / 10_000;

    expect(fills).toHaveLength(2);
    expect(opened.exitTax).toBe(0);
    expect(closed).toMatchObject({
      action: "reduce",
      reduceOnly: true,
      reason: "terminal_settlement",
    });
    expect(closed.exitTax).toBeCloseTo(expectedExitTax, 12);
    expect(closed.fee).toBeCloseTo(
      (closed.notional as number) * 14 / 10_000,
      12,
    );
    expect(ledger.exitTaxes).toBeCloseTo(expectedExitTax, 12);
    expect(ledger.fees).toBeCloseTo(
      (opened.fee as number) + (closed.fee as number),
      12,
    );
    expect(ledger.walletBalance).toBeCloseTo(
      10_000
      + (closed.realizedPnl as number)
      + (ledger.funding as number)
      - (ledger.fees as number),
      12,
    );
    expect(closingRow).toMatchObject({
      exitTax: expect.any(Number),
      commission: expect.any(Number),
    });
    expect(closingRow.exitTax).toBeCloseTo(expectedExitTax, 12);
    expect(closingRow.cost).toBeCloseTo(
      (closed.fee as number)
      + (closed.slippageCost as number)
      - (closed.funding as number),
      12,
    );
    const settlement = trades.terminalSettlement as UnknownRecord;
    const settlementLane = (settlement.lanes as UnknownRecord[])[0]!;
    expect(settlementLane.exitTax).toBeCloseTo(expectedExitTax, 12);
  });

  it("drains pre-expiry ingress before the ordered terminal boundary", async () => {
    const clock = new ScheduledClock();
    const close = vi.fn().mockResolvedValue(undefined);
    const streams: CryptoPublicStreams = {
      subscribe: vi.fn(async (_symbols, onEvent) => {
        for (const item of [
          ...riskPrelude(),
          { at: START + 100, event: finalKline(START + 100, true) },
          {
            at: START + 59_970,
            event: bookTicker(START + 59_970, 99.99, 100.01),
          },
          {
            at: START + 59_980,
            event: markPrice(START + 59_980, 100),
          },
        ]) {
          clock.schedule(item.at, () => onEvent(item.event));
        }
        clock.schedule(START + 59_999, () => {
          // Both callbacks run before the reducer resumes. The first trade was
          // actually ingressed inside the live window and must open the
          // position before the ordered expiry control closes that window.
          onEvent(aggTrade(START + 59_999, 100));
          clock.advance(1);
          onEvent(aggTrade(START + 60_002, 102));
        });
        return { close };
      }),
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
    });

    const result = await runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });

    const trades = artifact(result, "simulation-trades");
    const ledger = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord);
    expect(ledger.positions).toEqual([]);
    expect(ledger.fills).toEqual([
      expect.objectContaining({
        action: "open",
        executedAt: START + 59_999,
      }),
      expect.objectContaining({
        action: "reduce",
        reason: "terminal_settlement",
        decisionAt: START + 60_000,
        executedAt: START + 60_002,
      }),
    ]);
    expect(result.summary).toMatchObject({
      phase: "completed",
      settlementComplete: true,
    });
    expect(trades.terminalSettlement).toMatchObject({
      scheduling: "expiry_boundary_event",
      barrier: {
        eligibleAfterIngressSequence: expect.any(Number),
        requiresStrictlyLaterIngress: true,
      },
      fillBarrierEvent: {
        kind: "agg_trade",
        causalAt: new Date(START + 60_002).toISOString(),
      },
    });
  });

  it("settles at the next finalized-kline open and rejects delayed pre-expiry trades", async () => {
    const clock = new ScheduledClock();
    const delayedPreExpiryTrade = {
      ...aggTrade(START + 59_999, 150),
      receivedAt: START + 70_000,
    };
    const settlementBar = nextFinalKline(
      START + 120_000,
      START + 120_100,
    );
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 200, event: aggTrade(START + 200) },
      { at: START + 70_000, event: delayedPreExpiryTrade },
      { at: START + 120_100, event: settlementBar },
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
    const ledger = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord);
    expect(ledger.positions).toEqual([]);
    expect(ledger.fills).toEqual([
      expect.objectContaining({
        action: "open",
        executedAt: START + 200,
      }),
      expect.objectContaining({
        action: "reduce",
        reduceOnly: true,
        reason: "terminal_settlement",
        decisionAt: START + 60_000,
        executedAt: START + 120_000,
      }),
    ]);
    const settlement = trades.terminalSettlement as UnknownRecord;
    expect(settlement).toMatchObject({
      scheduling: "expiry_timeout",
      settlementComplete: true,
      status: "settled",
      graceDeadlineAt: new Date(START + 185_000).toISOString(),
      candidateEventsObserved: 2,
      rejectedAtOrBeforeExpiry: 1,
      boundaryTrigger: {
        kind: "kline",
        causalAt: new Date(START + 120_000).toISOString(),
        receivedAt: new Date(START + 120_100).toISOString(),
        observedPrice: 101,
        klineOpenTime: new Date(START + 120_000).toISOString(),
      },
      fillBarrierEvent: {
        kind: "final_kline_open",
        causalAt: new Date(START + 120_000).toISOString(),
        receivedAt: new Date(START + 120_100).toISOString(),
        observedPrice: 101,
      },
    });
    expect(settlement.lanes).toEqual([
      expect.objectContaining({
        lane: "kronos_base",
        status: "settled",
        fillEventKind: "final_kline_open",
        remainingQuantity: 0,
      }),
    ]);
  });

  it("preserves artifacts but fails closed when no causal terminal fill arrives", async () => {
    const clock = new ScheduledClock();
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 200, event: aggTrade(START + 200) },
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
    const ledger = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord);
    expect((ledger.fills as unknown[])).toHaveLength(1);
    expect((ledger.positions as unknown[])).toHaveLength(1);
    expect(trades).toMatchObject({ settlementComplete: false });
    expect(trades.terminalSettlement).toMatchObject({
      scheduling: "expiry_timeout",
      decisionAt: new Date(START + 60_000).toISOString(),
      graceDeadlineAt: new Date(START + 185_000).toISOString(),
      settlementComplete: false,
      status: "unsettled_fail_closed",
      lanes: [
        expect.objectContaining({
          lane: "kronos_base",
          status: "unsettled_fail_closed",
          unavailableReason: "terminal_settlement_unavailable",
          remainingQuantity: expect.any(Number),
        }),
      ],
    });
    expect((trades.terminalSettlement as UnknownRecord).fillBarrierEvent).toBeUndefined();
    expect(result.summary).toMatchObject({
      phase: "failed",
      settlementComplete: false,
    });
    expect((result.result as UnknownRecord).snapshot).toMatchObject({
      phase: "failed",
      progress: 0.999,
    });
    expect(result.terminalFailure).toEqual({
      code: "CRYPTO_TERMINAL_SETTLEMENT_INCOMPLETE",
      message: "Terminal settlement failed closed: terminal_settlement_no_causal_fill.",
      retryable: true,
    });
    expect(result.warnings).toContain("terminal_settlement_unavailable");
    expect(artifact(result, "simulation-comparison")).toMatchObject({
      outcome: "inconclusive",
      sameFillBarrier: false,
      lanes: [
        expect.objectContaining({
          id: "kronos_base",
          status: "partial",
          unavailableReason: "terminal_settlement_unavailable",
        }),
      ],
    });
    expect(artifact(result, "simulation-diagnostics")).toMatchObject({
      settlementComplete: false,
    });
    expect(artifact(result, "simulation-decisions").decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "reduce",
          reason: "terminal_settlement",
          status: "blocked",
          terminalSettlementFailureReason: "terminal_settlement_no_causal_fill",
        }),
      ]),
    );
  });

  it("fails the run with truthful diagnostics when the stream disconnects during settlement", async () => {
    const clock = new ScheduledClock();
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 200, event: aggTrade(START + 200) },
      { at: START + 60_010, disconnect: new Error("settlement socket closed") },
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

    expect(result.summary).toMatchObject({
      phase: "failed",
      settlementComplete: false,
    });
    expect(result.terminalFailure).toMatchObject({
      code: "CRYPTO_TERMINAL_SETTLEMENT_INCOMPLETE",
      retryable: true,
    });
    expect(artifact(result, "simulation-diagnostics")).toMatchObject({
      settlementComplete: false,
      streamDesync: true,
      marketDataHealthy: false,
      marketDataBlockReason: "stream_desync",
    });
    expect(artifact(result, "simulation-decisions").decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "reduce",
          reason: "terminal_settlement",
          status: "blocked",
          terminalSettlementFailureReason: "terminal_settlement_stream_desync",
        }),
      ]),
    );
  });

  it("reconciles an existing risk reduce superseded by post-expiry liquidation", async () => {
    const clock = new ScheduledClock();
    const wideSpreadCandidate = { ...candidate, spreadBps: 9 };
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 200, event: aggTrade(START + 200) },
      { at: START + 59_900, event: markPrice(START + 59_900, 95) },
      { at: START + 60_100, event: markPrice(START + 60_100, 0.1) },
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
      selected: wideSpreadCandidate,
      context: context().value,
    });

    const trades = artifact(result, "simulation-trades");
    const ledger = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord);
    const fills = ledger.fills as Array<UnknownRecord>;
    expect(fills).toHaveLength(2);
    expect(fills[1]).toMatchObject({
      action: "reduce",
      reason: "liquidation",
      executedAt: START + 60_100,
    });
    expect(ledger.positions).toEqual([]);
    expect(artifact(result, "simulation-decisions").decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "reduce",
          reason: "daily_loss_gate",
          decisionAt: new Date(START + 59_900).toISOString(),
          status: "skipped",
          terminalSettlementOutcome: "superseded_by_liquidation",
        }),
      ]),
    );
    const settlement = trades.terminalSettlement as UnknownRecord;
    expect(settlement).toMatchObject({
      settlementComplete: true,
      status: "settled",
      lanes: [
        expect.objectContaining({
          lane: "kronos_base",
          decisionSource: "existing_risk_reduce",
          status: "settled",
          settledBy: "liquidation",
          fillEventKind: "mark_price_liquidation",
          fillReceivedAt: new Date(START + 60_100).toISOString(),
          fillBarrierDigest: expect.any(String),
          remainingQuantity: 0,
        }),
      ],
    });
    const lane = (settlement.lanes as Array<UnknownRecord>)[0]!;
    expect(settlement.commonFillBarrierDigest).toBe(lane.fillBarrierDigest);
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

  it("closes a child sleeve reduce-only when its shared portfolio gate crosses", async () => {
    const clock = new ScheduledClock();
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
        kronos_base: laneClient("kronos_base", START + 150, longReturns, []),
      },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const sharedGate = new PortfolioDailyLossGate({
      lanes: ["kronos_base"],
      symbols: ["BTCUSDT", "ETHUSDT"],
      perSymbolInitialCash: 5_000,
      dailyLossLimitRate: 0.01,
      observedAt: START,
    });
    const childRequest: SimulationStartRequest = {
      ...simulationRequest(),
      initialCash: 5_000,
      selection: { mode: "manual", symbols: ["BTCUSDT"] },
      riskLimits: {
        riskPerTradeRate: 0.005,
        dailyLossLimitRate: 0.01,
        maximumLeverage: 15,
        grossExposureLimitRate: 1.5,
        marginUsageLimitRate: 0.2,
        liquidationBufferMultiple: 2,
      },
    };
    const runSingle = (
      runtime as unknown as {
        runSingle: (input: {
          request: SimulationStartRequest;
          snapshot: BinanceScannerSnapshot;
          selected: BinanceScannerCandidate;
          context: RunTaskContext;
          portfolioDailyLossGate: PortfolioDailyLossGate;
        }) => ReturnType<CryptoPaperRuntime["run"]>;
      }
    ).runSingle.bind(runtime);

    const result = await runSingle({
      request: childRequest,
      snapshot: scannerSnapshot,
      selected: wideSpreadCandidate,
      context: context().value,
      portfolioDailyLossGate: sharedGate,
    });
    const trades = artifact(result, "simulation-trades");
    const ledger = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord);
    const fills = ledger.fills as Array<UnknownRecord>;
    expect(sharedGate.state("kronos_base").blocked).toBe(true);
    expect(fills[1]).toMatchObject({
      action: "reduce",
      reduceOnly: true,
      reason: "daily_loss_gate",
      executedAt: START + 400,
    });
    expect(ledger.positions).toEqual([]);
  });

  it("does not reopen from a forecast that predates a protective close", async () => {
    const clock = new ScheduledClock();
    const secondWorker = deferred<unknown>();
    const requests: AiForecastRequest[] = [];
    const client: CryptoAiLaneClient = {
      request: vi.fn((request: AiForecastRequest) => {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          return Promise.resolve(response(
            "kronos_base",
            request,
            START + 150,
            longReturns,
          ));
        }
        return secondWorker.promise;
      }),
    };
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      { at: START + 200, event: aggTrade(START + 200) },
      ...riskPrelude(START + 60_020, 100),
      {
        at: START + 60_100,
        event: nextFinalKline(START, START + 60_100),
      },
      { at: START + 60_200, event: markPrice(START + 60_200, 99) },
      { at: START + 60_300, event: aggTrade(START + 60_300, 99) },
      // A stale pre-stop forecast must not create a new pending open for this.
      { at: START + 60_500, event: aggTrade(START + 60_500, 99) },
    ]);
    clock.schedule(START + 60_400, () => {
      const request = requests[1];
      if (!request) throw new Error("second worker request was not observed");
      secondWorker.resolve(response(
        "kronos_base",
        request,
        START + 60_400,
        longReturns,
      ));
    });
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
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

    const trades = artifact(result, "simulation-trades");
    const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord).fills as UnknownRecord[];
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      action: "open",
      executedAt: START + 200,
    });
    expect(fills[1]).toMatchObject({
      action: "reduce",
      reduceOnly: true,
      reason: "protection",
      executedAt: START + 60_300,
    });
    const decisions = artifact(result, "simulation-decisions").decisions as UnknownRecord[];
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        originAt: new Date(START + 59_999).toISOString(),
        status: "blocked",
        reason: "position_changed_during_inference",
      }),
    ]));
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
    const worker = deferred<unknown>();
    let notifyStarted: (() => void) | undefined;
    let workerRequest: AiForecastRequest | undefined;
    let workerSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const client: CryptoAiLaneClient = {
      request: vi.fn((request, signal) => {
        workerRequest = structuredClone(request);
        workerSignal = signal;
        notifyStarted?.();
        return worker.promise;
      }),
    };
    const snapshots: CryptoPaperRuntimeSnapshot[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams: {
        subscribe: async (_symbols, onEvent) => {
          for (const item of [
            ...riskPrelude(),
            { at: START + 100, event: finalKline(START + 100, true) },
          ]) {
            clock.schedule(item.at, () => onEvent(item.event));
          }
          return { close };
        },
      },
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
      onSnapshot: (_runId, snapshot) => {
        snapshots.push(snapshot);
      },
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
    expect(workerSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    const snapshotsAfterReturn = snapshots.length;
    worker.resolve(response(
      "kronos_base",
      workerRequest!,
      START + 200,
      longReturns,
    ));
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots).toHaveLength(snapshotsAfterReturn);
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
      coalescedMarkPrices: 0,
      overflowCount: 0,
    });
  });

  it("preserves a wide pre-fill spread across a post-fill recovery quote", async () => {
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
        emit?.(bookTicker(START + 180, 99, 101));
        emit?.(aggTrade(START + 200, 100));
        emit?.(bookTicker(START + 210, 99.99, 100.01));
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
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      action: "open",
      executedAt: START + 200,
    });
    expect(fills[0]!.notional as number).toBeLessThan(3_000);
    const decisions = artifact(result, "simulation-decisions").decisions as UnknownRecord[];
    expect(decisions[0]!.protectiveStopPrice as number).toBeLessThanOrEqual(98.1);
    expect(artifact(result, "simulation-diagnostics").marketEventQueue).toMatchObject({
      coalescedBookTickers: 0,
      overflowCount: 0,
    });
  });

  it("uses later same-event-time book ingress despite a receivedAt rollback", async () => {
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
        emit?.({
          ...bookTicker(START + 300, 99, 101),
          receivedAt: START + 350,
        });
        emit?.({
          ...bookTicker(START + 300, 99.99, 100.01),
          receivedAt: START + 340,
        });
        emit?.(aggTrade(START + 400, 100));
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
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 400 });
    const terminal = (result.result as UnknownRecord).snapshot as CryptoPaperRuntimeSnapshot;
    expect(terminal.futuresRisk.riskStreams.bookTicker.lastObservedAt).toBe(
      new Date(START + 340).toISOString(),
    );
    expect(artifact(result, "simulation-diagnostics").marketEventQueue).toMatchObject({
      coalescedBookTickers: 1,
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

  it.each([
    "recorded_before_reconnect",
    "scheduled_across_reconnect",
  ] as const)(
    "preserves one canonical funding settlement through $case",
    async (fundingCase) => {
      const clock = new ScheduledClock();
      const marketRest = rest();
      const fundingEventAt = START + 400;
      const fundingRate = 0.001;
      const settlementMarkPrice = 110;
      let emit: ((event: BinanceMarketEvent) => void) | undefined;
      let emitState: (state: {
        status: "reconnecting" | "connected";
        generation: number;
        reconnectAttempt: number;
      }) => void = () => undefined;
      let fillInjected = false;
      let reconnectInjected = false;
      const streams: CryptoPublicStreams = {
        subscribe: async (_symbols, onEvent, _onDisconnect, onState) => {
          emit = onEvent;
          emitState = (state) => onState?.(state);
          for (const item of [
            ...riskPrelude(),
            { at: START + 100, event: finalKline(START + 100, true) },
          ]) {
            clock.schedule(item.at, () => onEvent(item.event));
          }
          return { close: vi.fn().mockResolvedValue(undefined) };
        },
      };
      const fundingSpy = vi.spyOn(FuturesPaperLedger.prototype, "applyFunding");
      try {
        const runtime = new CryptoPaperRuntime({
          rest: marketRest,
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
            if (reconnectInjected || snapshot.futuresPositions.length === 0) return;
            reconnectInjected = true;
            emit?.({
              ...markPrice(START + 300, settlementMarkPrice),
              fundingRate,
              nextFundingTime: fundingEventAt,
            });
            if (fundingCase === "recorded_before_reconnect") {
              emit?.({
                ...markPrice(fundingEventAt, 111),
                fundingRate: 0.009,
                nextFundingTime: fundingEventAt + 8 * 60 * 60_000,
              });
            }
            emitState({
              status: "reconnecting",
              generation: 1,
              reconnectAttempt: 1,
            });
            emitState({
              status: "connected",
              generation: 2,
              reconnectAttempt: 1,
            });
            emit?.(bookTicker(START + 500, 110.99, 111.01));
            emit?.({
              ...markPrice(START + 500, 111),
              fundingRate: 0.009,
              nextFundingTime: fundingEventAt + 8 * 60 * 60_000,
            });
            // A later mark revisits the retained bounded journal and proves
            // the already consumed eventId cannot be charged twice.
            emit?.(markPrice(START + 600, 111));
          },
        });
        const result = await runtime.run({
          request: simulationRequest(),
          snapshot: scannerSnapshot,
          selected: candidate,
          context: context().value,
        });

        expect(marketRest.klines).toHaveBeenCalledTimes(2);
        expect(fundingSpy).toHaveBeenCalledTimes(1);
        expect(fundingSpy).toHaveBeenCalledWith({
          eventId: `funding:BTCUSDT:${fundingEventAt}`,
          symbol: "BTCUSDT",
          rate: fundingRate,
          eventAt: fundingEventAt,
        });
        const trades = artifact(result, "simulation-trades");
        const ledger = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
          .ledger as UnknownRecord);
        const fills = ledger.fills as UnknownRecord[];
        expect(fills).toHaveLength(1);
        const expectedFunding = -settlementMarkPrice
          * (fills[0]!.quantity as number)
          * fundingRate;
        expect(ledger.funding).toBeCloseTo(expectedFunding, 12);
        expect(artifact(result, "simulation-diagnostics").marketEventQueue).toMatchObject({
          overflowCount: 0,
        });
      } finally {
        fundingSpy.mockRestore();
      }
    },
  );

  it.each([
    { receiptOrder: "exact tie", laterReceivedAt: START + 350 },
    { receiptOrder: "clock rollback", laterReceivedAt: START + 340 },
  ])(
    "lets a later same-event-time liquidation mark win on $receiptOrder",
    async ({ laterReceivedAt }) => {
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
            emit?.({
              ...markPrice(START + 300, 100),
              receivedAt: START + 350,
            });
            emit?.({
              ...markPrice(START + 300, 0.1),
              receivedAt: laterReceivedAt,
            });
            emit?.(markPrice(START + 360, 100));
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
    },
  );

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

  it("preserves one bounded prospective stop mark after a queued open fill", async () => {
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
        const pending = snapshot.decisions.find((decision) => decision.status === "pending");
        if (injected || pending?.protectiveStopPrice === undefined) return;
        injected = true;
        emit?.(aggTrade(START + 200, 110));
        const prospectiveAdverseMark = pending.protectiveStopPrice + 5;
        for (let index = 0; index < 1_000; index += 1) {
          emit?.(markPrice(
            START + 210 + index,
            prospectiveAdverseMark - (index % 2) * 0.01,
          ));
        }
        emit?.(markPrice(START + 1_300, 110));
        clock.schedule(START + 2_000, () => emit?.(aggTrade(START + 2_000, 104)));
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
    expect(fills[0]).toMatchObject({
      action: "open",
      executedAt: START + 200,
      price: 110.1,
    });
    expect(fills[1]).toMatchObject({
      action: "reduce",
      reduceOnly: true,
      reason: "protection",
      executedAt: START + 2_000,
    });
    const queue = artifact(result, "simulation-diagnostics").marketEventQueue as UnknownRecord;
    expect(queue).toMatchObject({
      preservedCriticalMarkPrices: 1,
      overflowCount: 0,
    });
    expect(queue.maximumDepth as number).toBeLessThanOrEqual(4);
    expect(queue.coalescedMarkPrices as number).toBeGreaterThan(900);
  });

  it("does not let a stale crossing mark consume the prospective risk barrier", async () => {
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
        const pending = snapshot.decisions.find((decision) => decision.status === "pending");
        if (injected || pending?.protectiveStopPrice === undefined) return;
        injected = true;
        emit?.(aggTrade(START + 200, 100));
        emit?.({
          ...markPrice(START + 15, pending.protectiveStopPrice - 0.1),
          receivedAt: START + 210,
        });
        emit?.(markPrice(START + 220, pending.protectiveStopPrice - 0.1));
        emit?.(markPrice(START + 230, 100));
        clock.schedule(START + 400, () => emit?.(aggTrade(START + 400, 99)));
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
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 200 });
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

  it("does not seed a fill barrier from a delayed pre-decision aggregate trade", async () => {
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
        const pending = snapshot.decisions.find((decision) => decision.status === "pending");
        if (injected || pending?.protectiveStopPrice === undefined) return;
        injected = true;
        emit?.({
          ...aggTrade(START + 120, 100),
          receivedAt: START + 200,
        });
        emit?.(aggTrade(START + 210, 110));
        emit?.(markPrice(START + 220, pending.protectiveStopPrice + 5));
        emit?.(markPrice(START + 230, 110));
        clock.schedule(START + 400, () => emit?.(aggTrade(START + 400, 104)));
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
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      action: "open",
      price: 110.1,
      executedAt: START + 210,
    });
    expect(fills[1]).toMatchObject({
      action: "reduce",
      reason: "protection",
      executedAt: START + 400,
    });
  });

  it("seeds prospective risk from a gap-priced finalized-kline fill", async () => {
    const clock = new ScheduledClock();
    let decisionProtectiveStop: number | undefined;
    const close = vi.fn().mockResolvedValue(undefined);
    const streams: CryptoPublicStreams = {
      subscribe: async (_symbols, onEvent) => {
        for (const item of [
          ...riskPrelude(),
          { at: START + 100, event: finalKline(START + 100, true) },
          ...riskPrelude(START + 60_020, 110),
          {
            at: START + 60_100,
            event: nextFinalKline(START, START + 60_100),
          },
          ...riskPrelude(START + 120_020, 110),
        ]) {
          clock.schedule(item.at, () => onEvent(item.event));
        }
        clock.schedule(START + 120_100, () => {
          onEvent({
            ...(nextFinalKline(
              START + 60_000,
              START + 120_100,
            ) as Extract<BinanceMarketEvent, { kind: "kline" }>),
            open: 110,
            high: 110.5,
            low: 109.5,
            close: 110,
          });
          onEvent(markPrice(START + 120_110, decisionProtectiveStop! + 9));
          onEvent(markPrice(START + 120_120, 110));
        });
        clock.schedule(
          START + 120_200,
          () => onEvent(aggTrade(START + 120_200, 108)),
        );
        return { close };
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
      rest: rest(),
      streams,
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
      onSnapshot: (_runId, snapshot) => {
        const pending = snapshot.decisions.find((decision) => decision.status === "pending");
        if (pending?.protectiveStopPrice !== undefined) {
          decisionProtectiveStop ??= pending.protectiveStopPrice;
        }
      },
    });
    const result = await runtime.run({
      request: { ...simulationRequest(), durationMinutes: 3 },
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });

    const trades = artifact(result, "simulation-trades");
    const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord).fills as UnknownRecord[];
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      action: "open",
      price: 110.1,
      executedAt: START + 60_000,
    });
    expect(fills[1]).toMatchObject({
      action: "reduce",
      reason: "protection",
      executedAt: START + 120_200,
    });
  });

  it("sizes a finalized-kline fallback only from its causal open and decision spread", async () => {
    const runScenario = async (useReceiptTimeLookahead: boolean) => {
      const clock = new ScheduledClock();
      const fillBar = {
        ...(nextFinalKline(
          START + 60_000,
          START + 120_100,
        ) as Extract<BinanceMarketEvent, { kind: "kline" }>),
        open: 110,
        high: 110.5,
        low: 109.5,
        close: 110,
      };
      const receiptBook = useReceiptTimeLookahead
        ? bookTicker(START + 119_880, 1, 199)
        : bookTicker(START + 119_880, 109.99, 110.01);
      const receiptMark = markPrice(
        START + 119_900,
        useReceiptTimeLookahead ? 1_000 : 110,
      );
      const streams = new ScheduledStreams(clock, [
        ...riskPrelude(),
        { at: START + 100, event: finalKline(START + 100, true) },
        ...riskPrelude(START + 60_020, 110),
        {
          at: START + 60_100,
          event: nextFinalKline(START, START + 60_100),
        },
        { at: START + 119_880, event: receiptBook },
        { at: START + 119_900, event: receiptMark },
        { at: START + 120_100, event: fillBar },
      ]);
      const client: CryptoAiLaneClient = {
        request: vi.fn(async (request: AiForecastRequest) => response(
          "kronos_base",
          request,
          Math.max(clock.now(), Date.parse(request.series[0]!.input_end_at)),
          longReturns,
        )),
      };
      const runtime = new CryptoPaperRuntime({
        rest: rest(),
        streams,
        laneClients: { kronos_base: client },
        instrumentRules: rules,
        clock,
        contextBars: 64,
      });
      const result = await runtime.run({
        request: { ...simulationRequest(), durationMinutes: 3 },
        snapshot: scannerSnapshot,
        selected: candidate,
        context: context().value,
      });
      const trades = artifact(result, "simulation-trades");
      return ((((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
        .ledger as UnknownRecord).fills as UnknownRecord[]);
    };

    const controlFills = await runScenario(false);
    const lookaheadFills = await runScenario(true);
    expect(controlFills).toHaveLength(1);
    expect(lookaheadFills).toHaveLength(1);
    expect(lookaheadFills[0]).toMatchObject({
      action: "open",
      price: 110.1,
      executedAt: START + 60_000,
      quantity: controlFills[0]!.quantity,
      leverage: controlFills[0]!.leverage,
    });
  });

  it.each([
    {
      label: "single lane",
      lanes: ["kronos_base"] as ["kronos_base"],
    },
    {
      label: "two lanes",
      lanes: ["kronos_base", "fincast"] as ["kronos_base", "fincast"],
    },
  ])(
    "replays one canonical pre-receipt funding settlement for $label",
    async ({ lanes }) => {
      const clock = new ScheduledClock();
      const fundingEventAt = START + 90_000;
      const fundingRate = 0.001;
      const settlementMarkPrice = 110;
      const fundingSeed = {
        ...markPrice(START + 70_000, settlementMarkPrice),
        fundingRate,
        nextFundingTime: fundingEventAt,
      };
      const fundingTrigger = {
        ...markPrice(fundingEventAt, settlementMarkPrice),
        // The canonical rate must come from the preceding scheduled
        // observation, not whichever coalesced mark triggers settlement.
        fundingRate: 0.009,
        nextFundingTime: fundingEventAt + 8 * 60 * 60_000,
        // This callback precedes the final callback even though the local
        // timestamp rolls backward at final ingress.
        receivedAt: START + 120_150,
      };
      const fillBar = {
        ...(nextFinalKline(
          START + 60_000,
          START + 120_100,
        ) as Extract<BinanceMarketEvent, { kind: "kline" }>),
        open: 110,
        high: 110.5,
        low: 109.5,
        close: 110,
      };
      const streams = new ScheduledStreams(clock, [
        ...riskPrelude(),
        { at: START + 100, event: finalKline(START + 100, true) },
        ...riskPrelude(START + 60_020, settlementMarkPrice),
        {
          at: START + 60_100,
          event: nextFinalKline(START, START + 60_100),
        },
        { at: START + 70_000, event: fundingSeed },
        { at: fundingEventAt, event: fundingTrigger },
        {
          at: START + 119_880,
          event: bookTicker(START + 119_880, 109.99, 110.01),
        },
        {
          at: START + 119_900,
          event: markPrice(START + 119_900, settlementMarkPrice),
        },
        { at: START + 120_100, event: fillBar },
        // Once the retro lane is an ordinary live position, revisiting the
        // bounded journal must not consume the same eventId a second time.
        {
          at: START + 120_200,
          event: markPrice(START + 120_200, settlementMarkPrice),
        },
      ]);
      const laneClients: Partial<Record<SimulationModelLane, CryptoAiLaneClient>> = {};
      for (const lane of lanes) {
        laneClients[lane] = {
          request: vi.fn(async (request: AiForecastRequest) => response(
            lane,
            request,
            Math.max(clock.now(), Date.parse(request.series[0]!.input_end_at)),
            longReturns,
          )),
        };
      }
      const fundingSpy = vi.spyOn(FuturesPaperLedger.prototype, "applyFunding");
      try {
        const runtime = new CryptoPaperRuntime({
          rest: rest(),
          streams,
          laneClients,
          instrumentRules: rules,
          clock,
          contextBars: 64,
        });
        const result = await runtime.run({
          request: { ...simulationRequest(lanes), durationMinutes: 3 },
          snapshot: scannerSnapshot,
          selected: candidate,
          context: context().value,
        });

        expect(fundingSpy).toHaveBeenCalledTimes(lanes.length);
        expect(fundingSpy.mock.calls.map(([input]) => input)).toEqual(
          lanes.map(() => ({
            eventId: `funding:BTCUSDT:${fundingEventAt}`,
            symbol: "BTCUSDT",
            rate: fundingRate,
            eventAt: fundingEventAt,
          })),
        );
        const trades = artifact(result, "simulation-trades");
        for (const lane of lanes) {
          const ledger = (((trades.lanes as UnknownRecord)[lane] as UnknownRecord)
            .ledger as UnknownRecord);
          const fills = ledger.fills as UnknownRecord[];
          expect(fills).toHaveLength(1);
          expect(fills[0]).toMatchObject({
            action: "open",
            executedAt: START + 60_000,
          });
          const expectedFunding = -settlementMarkPrice
            * (fills[0]!.quantity as number)
            * fundingRate;
          expect(ledger.funding).toBeCloseTo(expectedFunding, 12);
          expect(ledger.walletBalance).toBeCloseTo(
            10_000 - (ledger.fees as number) + expectedFunding,
            12,
          );
          expect(ledger.equity).toBeCloseTo(
            (ledger.walletBalance as number) + (ledger.unrealizedPnl as number),
            12,
          );
        }
        const terminal = (result.result as UnknownRecord)
          .snapshot as CryptoPaperRuntimeSnapshot;
        const executionLedger = (((trades.lanes as UnknownRecord)[lanes[0]!] as UnknownRecord)
          .ledger as UnknownRecord);
        expect(terminal.futuresRisk.dailyLossRatio).toBeCloseTo(
          Math.max(0, 1 - (executionLedger.equity as number) / 10_000),
          12,
        );
      } finally {
        fundingSpy.mockRestore();
      }
    },
  );

  it.each([
    {
      severity: "protection" as const,
      expectedExecutedAt: START + 120_200,
    },
    {
      severity: "liquidation" as const,
      expectedExecutedAt: START + 120_020,
    },
  ])(
    "replays bounded pre-receipt $severity evidence after a finalized-kline open fill",
    async ({ severity, expectedExecutedAt }) => {
      const clock = new ScheduledClock();
      let decisionProtectiveStop: number | undefined;
      const close = vi.fn().mockResolvedValue(undefined);
      const streams: CryptoPublicStreams = {
        subscribe: async (_symbols, onEvent) => {
          for (const item of [
            ...riskPrelude(),
            { at: START + 100, event: finalKline(START + 100, true) },
            ...riskPrelude(START + 60_020, 110),
            {
              at: START + 60_100,
              event: nextFinalKline(START, START + 60_100),
            },
          ]) {
            clock.schedule(item.at, () => onEvent(item.event));
          }
          clock.schedule(
            START + 119_880,
            () => onEvent(bookTicker(START + 119_880, 109.99, 110.01)),
          );
          clock.schedule(START + 119_900, () => {
            onEvent({
              ...markPrice(START + 119_900, decisionProtectiveStop! + 9),
              // Callback order is authoritative even when Date.now rolls
              // backward before the later final-kline callback.
              receivedAt: START + 120_150,
            });
          });
          if (severity === "liquidation") {
            clock.schedule(
              START + 120_020,
              () => onEvent(markPrice(START + 120_020, 0.1)),
            );
          }
          clock.schedule(
            severity === "liquidation" ? START + 120_040 : START + 119_940,
            () => onEvent(markPrice(
              severity === "liquidation" ? START + 120_040 : START + 119_940,
              110,
            )),
          );
          clock.schedule(START + 120_100, () => {
            onEvent({
              ...(nextFinalKline(
                START + 60_000,
                START + 120_100,
              ) as Extract<BinanceMarketEvent, { kind: "kline" }>),
              open: 110,
              high: 110.5,
              low: 109.5,
              close: 110,
            });
            // These arrive after the final event was enqueued and roll the
            // bounded live buffer forward by more than three minutes. The
            // pre-final evidence must survive in the event's frozen snapshot.
            for (let index = 0; index < 4; index += 1) {
              const at = START + (index + 3) * 60_000 + 10;
              onEvent(markPrice(at, 110));
            }
          });
          if (severity === "protection") {
            clock.schedule(
              START + 120_200,
              () => onEvent(aggTrade(START + 120_200, 108)),
            );
          }
          return { close };
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
        rest: rest(),
        streams,
        laneClients: { kronos_base: client },
        instrumentRules: rules,
        clock,
        contextBars: 64,
        onSnapshot: (_runId, snapshot) => {
          const pending = snapshot.decisions.find((decision) => decision.status === "pending");
          if (pending?.protectiveStopPrice !== undefined) {
            decisionProtectiveStop ??= pending.protectiveStopPrice;
          }
        },
      });
      const result = await runtime.run({
        request: { ...simulationRequest(), durationMinutes: 3 },
        snapshot: scannerSnapshot,
        selected: candidate,
        context: context().value,
      });

      const trades = artifact(result, "simulation-trades");
      const fills = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
        .ledger as UnknownRecord).fills as UnknownRecord[];
      expect(fills).toHaveLength(2);
      expect(fills[0]).toMatchObject({
        action: "open",
        price: 110.1,
        executedAt: START + 60_000,
      });
      expect(fills[1]).toMatchObject({
        action: "reduce",
        reason: severity,
        executedAt: expectedExecutedAt,
      });
      const queue = artifact(result, "simulation-diagnostics").marketEventQueue as UnknownRecord;
      expect(queue.overflowCount).toBe(0);
      expect(queue.maximumDepth as number).toBeLessThanOrEqual(4);
    },
  );

  it("fails closed when bounded risk evidence was evicted before final-kline ingress", async () => {
    const clock = new ScheduledClock();
    const delayedFillBar = {
      ...(nextFinalKline(
        START + 60_000,
        START + 300_100,
      ) as Extract<BinanceMarketEvent, { kind: "kline" }>),
      open: 110,
      high: 110.5,
      low: 109.5,
      close: 110,
    };
    const streams = new ScheduledStreams(clock, [
      ...riskPrelude(),
      { at: START + 100, event: finalKline(START + 100, true) },
      ...riskPrelude(START + 60_020, 110),
      {
        at: START + 60_100,
        event: nextFinalKline(START, START + 60_100),
      },
      { at: START + 120_010, event: markPrice(START + 120_010, 110) },
      { at: START + 180_010, event: markPrice(START + 180_010, 110) },
      { at: START + 240_010, event: markPrice(START + 240_010, 110) },
      {
        at: START + 300_000,
        event: bookTicker(START + 300_000, 109.99, 110.01),
      },
      { at: START + 300_010, event: markPrice(START + 300_010, 110) },
      { at: START + 300_100, event: delayedFillBar },
    ]);
    const client: CryptoAiLaneClient = {
      request: vi.fn(async (request: AiForecastRequest) => response(
        "kronos_base",
        request,
        Math.max(clock.now(), Date.parse(request.series[0]!.input_end_at)),
        longReturns,
      )),
    };
    const runtime = new CryptoPaperRuntime({
      rest: rest(),
      streams,
      laneClients: { kronos_base: client },
      instrumentRules: rules,
      clock,
      contextBars: 64,
    });
    const result = await runtime.run({
      request: { ...simulationRequest(), durationMinutes: 6 },
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    });

    const trades = artifact(result, "simulation-trades");
    const ledger = (((trades.lanes as UnknownRecord).kronos_base as UnknownRecord)
      .ledger as UnknownRecord);
    expect(ledger.fills).toEqual([]);
    const decisions = artifact(result, "simulation-decisions").decisions as UnknownRecord[];
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "open_long",
        status: "blocked",
        reason: "final_kline_risk_evidence_incomplete",
      }),
    ]));
  });

  it("does not apply a later-ingressed aggregate trade from before the queued fill", async () => {
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
        emit?.(aggTrade(START + 300, 100));
        emit?.({
          ...aggTrade(START + 200, 1),
          receivedAt: START + 310,
        });
        clock.schedule(START + 400, () => emit?.(aggTrade(START + 400, 100)));
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
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      action: "open",
      executedAt: START + 300,
    });
    const decisions = artifact(result, "simulation-decisions").decisions as UnknownRecord[];
    expect(decisions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "reduce", reason: "protection" }),
    ]));
  });

  it("ignores a mark from before the queued fill without consuming the valid stop barrier", async () => {
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
        const pending = snapshot.decisions.find((decision) => decision.status === "pending");
        if (injected || pending?.protectiveStopPrice === undefined) return;
        injected = true;
        emit?.(aggTrade(START + 300, 100));
        emit?.({
          ...markPrice(START + 200, 0.1),
          receivedAt: START + 310,
        });
        emit?.(markPrice(START + 320, pending.protectiveStopPrice - 0.1));
        emit?.(markPrice(START + 330, 100));
        clock.schedule(START + 400, () => emit?.(aggTrade(START + 400, 99)));
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
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 300 });
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

  it("does not let a stale mark consume an already-open position risk barrier", async () => {
    const clock = new ScheduledClock();
    let emit: ((event: BinanceMarketEvent) => void) | undefined;
    let openInjected = false;
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
        if (!openInjected
          && snapshot.decisions.some((decision) => decision.status === "pending")) {
          openInjected = true;
          emit?.(aggTrade(START + 300, 100));
          return;
        }
        const position = snapshot.futuresPositions[0] as
          | { protectiveStopPrice?: number }
          | undefined;
        if (marksInjected || position?.protectiveStopPrice === undefined) return;
        marksInjected = true;
        emit?.({
          ...markPrice(START + 200, 0.1),
          receivedAt: START + 310,
        });
        emit?.(markPrice(START + 320, position.protectiveStopPrice - 0.1));
        emit?.(markPrice(START + 330, 100));
        clock.schedule(START + 400, () => emit?.(aggTrade(START + 400, 99)));
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
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 300 });
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

  it("preserves a liquidation escalation after a stop-only mark in the same burst", async () => {
    const clock = new ScheduledClock();
    let emit: ((event: BinanceMarketEvent) => void) | undefined;
    let openInjected = false;
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
        if (!openInjected
          && snapshot.decisions.some((decision) => decision.status === "pending")) {
          openInjected = true;
          emit?.(aggTrade(START + 300, 100));
          return;
        }
        const position = snapshot.futuresPositions[0] as
          | { protectiveStopPrice?: number; liquidationPrice?: number }
          | undefined;
        if (marksInjected
          || position?.protectiveStopPrice === undefined
          || position.liquidationPrice === undefined) return;
        marksInjected = true;
        const stopOnlyPrice = (
          position.protectiveStopPrice + position.liquidationPrice
        ) / 2;
        emit?.(markPrice(START + 310, stopOnlyPrice));
        emit?.(markPrice(START + 320, position.liquidationPrice - 0.1));
        emit?.(markPrice(START + 330, 100));
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
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ action: "open", executedAt: START + 300 });
    expect(fills[1]).toMatchObject({
      action: "reduce",
      reason: "liquidation",
      executedAt: START + 320,
    });
    const queue = artifact(result, "simulation-diagnostics").marketEventQueue as UnknownRecord;
    expect(queue).toMatchObject({
      preservedCriticalMarkPrices: 2,
      overflowCount: 0,
    });
    expect(queue.maximumDepth as number).toBeLessThanOrEqual(3);
  });

  it.each(["completion_first", "disconnect_first"] as const)(
    "discards deferred inference when %s races a stream disconnect",
    async (order) => {
      const clock = new ScheduledClock();
      const worker = deferred<unknown>();
      let workerRequest: AiForecastRequest | undefined;
      const snapshots: CryptoPaperRuntimeSnapshot[] = [];
      const close = vi.fn().mockResolvedValue(undefined);
      const streams: CryptoPublicStreams = {
        subscribe: async (_symbols, onEvent, onDisconnect) => {
          for (const item of [
            ...riskPrelude(),
            { at: START + 100, event: finalKline(START + 100, true) },
          ]) {
            clock.schedule(item.at, () => onEvent(item.event));
          }
          clock.schedule(START + 1_000, () => {
            const complete = () => worker.resolve(response(
              "kronos_base",
              workerRequest!,
              START + 1_000,
              longReturns,
            ));
            const disconnect = () => onDisconnect?.(new Error("socket raced completion"));
            if (order === "completion_first") {
              complete();
              disconnect();
            } else {
              disconnect();
              complete();
            }
          });
          return { close };
        },
      };
      const runtime = new CryptoPaperRuntime({
        rest: rest(),
        streams,
        laneClients: {
          kronos_base: {
            request: vi.fn((request) => {
              workerRequest = structuredClone(request);
              return worker.promise;
            }),
          },
        },
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
      expect(close).toHaveBeenCalledTimes(1);
      expect(snapshots.at(-1)?.phase).toBe("failed");
      expect(snapshots.flatMap((snapshot) => snapshot.decisions)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "executed" }),
        ]),
      );
    },
  );

  it("cannot lose a disconnect control event when the market queue is full", async () => {
    const clock = new ScheduledClock();
    const close = vi.fn().mockResolvedValue(undefined);
    const streams: CryptoPublicStreams = {
      subscribe: async (_symbols, onEvent, onDisconnect) => {
        clock.schedule(START + 100, () => {
          // One event resolves the active waiter and 256 fill the bounded
          // queue, so the following disconnect exercises the overflow path.
          for (let index = 0; index < 257; index += 1) {
            onEvent(finalKline(START + 100 + index, true));
          }
          onDisconnect?.(new Error("socket closed with a full queue"));
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

    await expect(runtime.run({
      request: simulationRequest(),
      snapshot: scannerSnapshot,
      selected: candidate,
      context: context().value,
    })).rejects.toMatchObject({
      name: "CryptoPaperRuntimeError",
      code: "stream_desync",
    } satisfies Partial<CryptoPaperRuntimeError>);
    expect(close).toHaveBeenCalledTimes(1);
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
