import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDirectory = process.env.SIMULATION_UI_SCREENSHOT_DIR
  ? path.resolve(process.env.SIMULATION_UI_SCREENSHOT_DIR)
  : "/tmp/toss-portfolio-lens-simulation-ui";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function portfolio() {
  const account = {
    id: "simulation-ui",
    name: "시뮬레이션 UI 검증",
    label: "시뮬레이션 UI 검증",
    type: "STOCK",
  };
  return {
    asOf: "2026-07-24T00:20:00.000Z",
    accounts: [account],
    selectedAccountId: account.id,
    account,
    summary: {
      evaluationAmount: { KRW: 0, USD: 0 },
      purchaseAmount: { KRW: 0, USD: 0 },
      profitLoss: { KRW: 0, USD: 0 },
      dailyProfitLoss: { KRW: 0, USD: 0 },
      profitRate: 0,
      dailyProfitRate: 0,
      positionCount: 0,
    },
    holdings: [],
  };
}

function chronos2ForecastOutput(symbol, origin, basePrice) {
  const quantiles = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];
  const offsets = [-0.012, -0.008, -0.003, 0.004, 0.009, 0.015, 0.02];
  return {
    status: "available",
    signalSymbol: symbol,
    inputEndAt: origin,
    generatedAt: new Date(Date.parse(origin) + 320).toISOString(),
    provenance: {
      modelId: "amazon/chronos-2",
      modelRevision: "ui-fixture",
      device: "cuda:0",
      deviceName: "Tesla P40",
    },
    rawOutput: {
      role: "chronos2",
      expected_model_id: "amazon/chronos-2",
      status: "available",
      model: {
        model_id: "amazon/chronos-2",
        model_revision: "ui-fixture",
        device: "cuda:0",
        device_name: "Tesla P40",
        loaded: true,
      },
      raw_series: [{
        instrument_key: symbol,
        status: "available",
        input_end_at: origin,
        horizons: [5, 15, 30, 60].map((minutes, horizonIndex) => ({
          horizon_minutes: minutes,
          target_timestamp: new Date(Date.parse(origin) + minutes * 60_000).toISOString(),
          price_quantiles: quantiles.map((quantile, quantileIndex) => ({
            quantile,
            value: basePrice * (1 + offsets[quantileIndex] + horizonIndex * 0.001),
          })),
          up_probability: 0.64 + horizonIndex * 0.02,
        })),
      }],
    },
  };
}

function cryptoSnapshot({ phase, request, cancelled = false }) {
  const hasResults = phase !== "selecting";
  const symbols = request.selection.mode === "manual"
    ? request.selection.symbols
    : ["BTCUSDT", "ETHUSDT"].slice(0, request.selection.symbolCount);
  const modelIdentity = {
    chronos2: {
      modelId: "amazon/chronos-2",
      modelRevision: "254b5357164a84326913b0695216f690752ac55d",
      sourceRevision: "chronos-forecasting-v2.3.1",
      loaderVersion: "chronos-forecasting-2.3.1",
      precision: "fp32",
      latencyMs: 138,
      peakVramMb: 5_120,
    },
    fincast: {
      modelId: "Vincent05R/FinCast",
      modelRevision: "fincast-ui-revision",
      sourceRevision: "fincast-source-revision",
      loaderVersion: "fincast-loader-v1",
      precision: "fp16",
      latencyMs: 112,
      peakVramMb: 4_920,
    },
  };
  const resolvedModelPlan = request.simulationCase === "btc_eth"
    ? symbols.flatMap((symbol) => symbol === "ETHUSDT"
      ? [{
          symbol,
          modelLane: "fincast",
          role: "primary",
          required: true,
          preferredHorizonsMinutes: [15, 30, 60],
        }, {
          symbol,
          modelLane: "chronos2",
          role: "shadow",
          required: false,
          preferredHorizonsMinutes: [15, 30, 60],
        }]
      : [{
          symbol,
          modelLane: "chronos2",
          role: "primary",
          required: true,
          preferredHorizonsMinutes: [30, 60, 15],
        }, {
          symbol,
          modelLane: "fincast",
          role: "veto",
          required: true,
          preferredHorizonsMinutes: [30, 60, 15],
        }])
    : [{
        symbol: "*",
        modelLane: "chronos2",
        role: "primary",
        required: true,
        preferredHorizonsMinutes: [15, 30, 60],
      }, {
        symbol: "*",
        modelLane: "fincast",
        role: "veto",
        required: true,
        preferredHorizonsMinutes: [15, 30, 60],
      }];
  const modelLanes = [...new Set(resolvedModelPlan.map(({ modelLane }) => modelLane))];
  const barsBySymbol = new Map(symbols.map((symbol, symbolIndex) => {
    const basePrice = symbol === "ETHUSDT" ? 3_470 : 67_000;
    const priceStep = symbol === "ETHUSDT" ? 1.8 : 18;
    const movement = symbol === "ETHUSDT" ? 4.4 : 44;
    const wick = symbol === "ETHUSDT" ? 2.5 : 25;
    const bars = Array.from({ length: 24 }, (_, index) => {
      const open = basePrice + index * priceStep * (symbolIndex ? -0.3 : 1);
      const close = open + (index % 3 === 0 ? -movement * 0.72 : movement);
      return {
        timestamp: new Date(Date.parse("2026-07-24T00:00:00.000Z") + index * 60_000).toISOString(),
        open,
        high: Math.max(open, close) + wick,
        low: Math.min(open, close) - wick,
        close,
        volume: 180 + index * 2 + symbolIndex * 30,
        status: "final",
        indicatorValues: {
          "trend-ema:value": close - (symbolIndex ? -movement * 0.35 : movement * 0.35),
          "session-vwap:session_vwap": close - (symbolIndex ? -movement * 0.2 : movement * 0.2),
        },
      };
    });
    return [symbol, bars];
  }));
  const selected = symbols.map((symbol, index) => {
    const lane = resolvedModelPlan.find((entry) => (
      entry.symbol === symbol && entry.role === "primary"
    ))?.modelLane ?? "chronos2";
    const model = modelIdentity[lane];
    const bars = barsBySymbol.get(symbol);
    return {
      symbol,
      name: symbol === "ETHUSDT" ? "Ethereum perpetual" : "Bitcoin perpetual",
      score: 0.91 - index * 0.07,
      upProbability: index === 0 ? 0.68 : 0.31,
      predictedMedianReturn: index === 0 ? 0.004 : -0.003,
      currentPrice: bars.at(-1).close,
      priceObservedAt: "2026-07-24T00:23:12.345Z",
      model: {
        modelId: model.modelId,
        modelRevision: model.modelRevision,
        device: "cuda:0",
      },
    };
  });
  const futuresPositions = symbols.map((symbol, index) => {
    const bars = barsBySymbol.get(symbol);
    const entryPrice = bars[10].close;
    const markPrice = bars.at(-1).close;
    const quantity = symbol === "ETHUSDT" ? 0.3 : 0.015;
    const notional = markPrice * quantity;
    const side = index === 0 ? "long" : "short";
    const leverage = Math.min(request.riskLimits.maximumLeverage, 5 + index);
    return {
      symbol,
      side,
      marginMode: "isolated",
      quantity,
      leverage,
      entryPrice,
      markPrice,
      notional,
      initialMargin: notional / leverage,
      maintenanceMargin: notional * 0.005,
      liquidationPrice: side === "long" ? entryPrice * 0.81 : entryPrice * 1.17,
      liquidationBufferRatio: side === "long" ? 0.196 : 0.172,
      protectiveStopPrice: side === "long" ? entryPrice * 0.991 : entryPrice * 1.009,
      realizedPnl: 0,
      unrealizedPnl: side === "long"
        ? (markPrice - entryPrice) * quantity
        : (entryPrice - markPrice) * quantity,
      funding: index === 0 ? -0.12 : 0.06,
      fees: index === 0 ? 0.81 : 0.67,
      slippage: index === 0 ? 0.2 : 0.16,
    };
  });
  const charts = symbols.map((symbol, index) => {
    const bars = barsBySymbol.get(symbol);
    return {
      symbol,
      name: symbol === "ETHUSDT" ? "Ethereum perpetual" : "Bitcoin perpetual",
      currency: "USDT",
      bars,
      indicators: [{
        id: "trend-ema",
        kind: "ema",
        status: "available",
        values: { value: bars.at(-1).indicatorValues["trend-ema:value"] },
      }, {
        id: "momentum-rsi",
        kind: "rsi",
        status: "available",
        values: { value: index === 0 ? 63.4 : 38.1 },
      }],
      patterns: [{
        detectedAt: bars.at(-2).timestamp,
        name: index === 0 ? "bullish_engulfing" : "bearish_engulfing",
        bias: index === 0 ? "bullish" : "bearish",
        strength: 0.82 - index * 0.06,
      }],
      updatedAt: bars.at(-1).timestamp,
    };
  });
  const trades = symbols.flatMap((symbol, index) => {
    const bars = barsBySymbol.get(symbol);
    const position = futuresPositions[index];
    const openSide = index === 0 ? "buy" : "sell";
    const reduceSide = index === 0 ? "sell" : "buy";
    return [{
      symbol,
      side: openSide,
      positionSide: position.side,
      reduceOnly: false,
      executedAt: "2026-07-24T00:10:15.000Z",
      signalEligibleAfter: "2026-07-24T00:10:00.000Z",
      price: bars[10].close,
      quantity: position.quantity,
      amount: bars[10].close * position.quantity,
      cost: index === 0 ? 0.6 : 0.52,
      totalCosts: index === 0 ? 0.6 : 0.52,
      source: "next_valid_agg_trade",
    }, {
      symbol,
      side: reduceSide,
      positionSide: position.side,
      reduceOnly: true,
      executedAt: "2026-07-24T00:18:15.000Z",
      signalEligibleAfter: "2026-07-24T00:18:00.000Z",
      price: bars[18].close,
      quantity: position.quantity / 3,
      amount: bars[18].close * position.quantity / 3,
      cost: index === 0 ? 0.2 : 0.17,
      totalCosts: index === 0 ? 0.2 : 0.17,
      source: "next_valid_agg_trade",
    }];
  });
  const decisions = symbols.map((symbol, index) => ({
    id: `crypto-decision-${index + 1}`,
    lane: resolvedModelPlan.find((entry) => (
      entry.symbol === symbol && entry.role === "primary"
    ))?.modelLane ?? "chronos2",
    symbol,
    originAt: "2026-07-24T00:10:00.000Z",
    decisionAt: "2026-07-24T00:10:00.250Z",
    fillEligibleAfter: "2026-07-24T00:10:00.250Z",
    action: index === 0 ? "open_long" : "open_short",
    direction: index === 0 ? "long" : "short",
    confidence: index === 0 ? 0.73 : 0.7,
    probabilityAboveCost: index === 0 ? 0.68 : 0.69,
    reason: index === 0
      ? "quantile_cost_threshold · protected_liquidation_buffer"
      : "downside_quantile_cost_threshold · protected_liquidation_buffer",
    technicalState: index === 0 ? "trend:long" : "trend:short",
    chartPatternBias: index === 0 ? "bullish" : "bearish",
    chartPatterns: [index === 0 ? "bullish_engulfing" : "bearish_engulfing"],
    components: { confidence: index === 0 ? 0.73 : 0.7, minimumConfidence: 0.55 },
    model: selected[index].model,
  }));
  const modelForecasts = symbols.flatMap((symbol, symbolIndex) => {
    const bars = barsBySymbol.get(symbol);
    const origin = bars.at(-1).timestamp;
    const originPrice = bars.at(-1).close;
    return modelLanes.map((lane, laneIndex) => {
      const model = modelIdentity[lane];
      const direction = symbolIndex === 0 ? 1 : -1;
      return {
        lane,
        signalSymbol: symbol,
        status: "available",
        origin,
        inputOrigin: origin,
        originPrice,
        priceObservedAt: origin,
        projectionPolicy: "native_input_origin",
        generatedAt: new Date(Date.parse(origin) + model.latencyMs).toISOString(),
        modelId: model.modelId,
        modelRevision: model.modelRevision,
        points: [5, 15, 30, 60].map((horizonMinutes, horizonIndex) => {
          const drift = direction * (horizonIndex + 1) * (0.0018 + laneIndex * 0.0002);
          return {
            horizonMinutes,
            targetTimestamp: new Date(Date.parse(origin) + horizonMinutes * 60_000).toISOString(),
            q10Price: originPrice * (1 + drift - 0.006),
            medianPrice: originPrice * (1 + drift),
            q90Price: originPrice * (1 + drift + 0.006),
            upProbability: symbolIndex === 0 ? 0.64 + horizonIndex * 0.02 : 0.36 - horizonIndex * 0.02,
          };
        }),
      };
    });
  });
  return {
    schemaVersion: "ai-paper-simulation/v9",
    simulationCase: request.simulationCase,
    resolvedModelPlan,
    phase,
    startedAt: "2026-07-24T00:20:00.000Z",
    expiresAt: "2026-07-24T02:20:00.000Z",
    market: request.market,
    currency: "USDT",
    initialCash: request.initialCash,
    cash: hasResults ? request.initialCash - 670 : request.initialCash,
    equity: cancelled ? request.initialCash + 12 : request.initialCash + 31.5,
    progress: cancelled ? 1 : phase === "selecting" ? 0.05 : 0.42,
    selection: request.selection,
    criterion: request.selection.mode === "auto" ? request.selection.criterion : "volatility",
    preset: request.preset,
    riskTolerance: request.riskTolerance,
    decisionCadence: {
      trigger: "finalized_one_minute_bar",
      triggeredEvents: hasResults ? decisions.length : 0,
      coalescedEvents: 0,
      duplicateEvents: 0,
      inFlight: false,
      lastTriggeredAt: "2026-07-24T00:23:00.000Z",
      lastStartedAt: "2026-07-24T00:23:00.020Z",
      lastFinishedAt: "2026-07-24T00:23:00.250Z",
    },
    selected: hasResults ? selected : [],
    positions: hasResults ? futuresPositions : [],
    futuresPositions: hasResults ? futuresPositions : [],
    futuresRisk: {
      dailyLossRatio: -0.0012,
      dailyLossLimitRatio: request.riskLimits.dailyLossLimitRate,
      newEntriesBlocked: false,
      grossExposureRatio: 0.18,
      grossExposureLimitRatio: request.riskLimits.grossExposureLimitRate,
      marginUsageRatio: 0.036,
      marginUsageLimitRatio: request.riskLimits.marginUsageLimitRate,
      riskPerTradeRatio: request.riskLimits.riskPerTradeRate,
      maximumLeverage: request.riskLimits.maximumLeverage,
      liquidationBufferMultiple: request.riskLimits.liquidationBufferMultiple,
    },
    charts: hasResults ? charts : [],
    trades: hasResults ? trades : [],
    decisions: hasResults ? decisions : [],
    modelForecasts: hasResults ? modelForecasts : [],
    warnings: ["UI fixture · realOrder false"],
    capabilities: { realOrder: false, nextValidFillOnly: true },
    modelLanes,
    executionMode: "paper",
    modelComparison: {
      comparisonId: "ui-crypto-comparison",
      outcome: "inconclusive",
      sameOrigin: true,
      sameContext: true,
      sameCosts: true,
      sameFillBarrier: true,
      symbol: symbols.join(","),
      lanes: modelLanes.map((id) => ({
        id,
        status: "completed",
        precision: modelIdentity[id].precision,
        provenance: {
          modelId: modelIdentity[id].modelId,
          modelRevision: modelIdentity[id].modelRevision,
          sourceRevision: modelIdentity[id].sourceRevision,
          loaderVersion: modelIdentity[id].loaderVersion,
          loaded: true,
          device: "cuda:0",
          deviceName: "Tesla P40",
          cudaCapability: "6.1",
          attentionBackend: "sdpa",
          precisionValidation: id === "fincast" ? "passed" : "not_required",
          memoryStatus: "ok",
          peakVramMb: modelIdentity[id].peakVramMb,
          precisionFailureReasons: [],
        },
        metrics: {
          pinballLoss: id === "fincast" ? 0.008 : 0.009,
          medianReturnMae: 0.004,
          directionAccuracy: 0.61,
          quantileCoverage: 0.89,
          netPnl: id === "fincast" ? 29.8 : 31.5,
          profitFactor: 1.18,
          winRate: 0.54,
          maxDrawdown: 0.012,
          turnover: 2.4,
          latencyMs: id === "fincast" ? 112 : 86,
          availabilityRatio: 1,
          peakVramMb: modelIdentity[id].peakVramMb,
        },
      })),
    },
  };
}

function snapshot({
  phase,
  request,
  cancelled = false,
}) {
  if (request.market?.kind === "crypto_futures") {
    return cryptoSnapshot({ phase, request, cancelled });
  }
  const pairSymbols = {
    "qqq-tqqq-sqqq": ["QQQ", "TQQQ", "SQQQ"],
    "semiconductor-soxl-soxs": ["SOXX", "SOXL", "SOXS"],
    "spy-spxl-spxs": ["SPY", "SPXL", "SPXS"],
    "smh-soxl-soxs": ["SMH", "SOXL", "SOXS"],
  };
  const symbols = request.strategy?.mode === "pair"
    ? pairSymbols[request.strategy.pairId] ?? [
      request.strategy.pairId.split("-")[0].toUpperCase(),
      request.strategy.pairId.split("-")[1].toUpperCase(),
      request.strategy.pairId.split("-")[2].toUpperCase(),
    ]
    : request.selection.mode === "manual"
      ? request.selection.symbols
      : Array.from(
          { length: request.selection.symbolCount },
          (_, index) => index === 0 ? "SIM1" : "SIM2",
        );
  const resolvedModelPlan = [{
    symbol: "*",
    modelLane: "chronos2",
    role: "primary",
    required: true,
    preferredHorizonsMinutes: [15, 30, 60],
  }, {
    symbol: "*",
    modelLane: "fincast",
    role: "shadow",
    required: false,
    preferredHorizonsMinutes: [15, 30, 60],
  }];
  const selected = symbols.map((symbol, index) => ({
    symbol,
    name: index === 0 ? "가상 성장주" : "가상 모멘텀주",
    score: 0.81 - index * 0.08,
    upProbability: 0.64 - index * 0.03,
    predictedMedianReturn: 0.006 - index * 0.001,
    currentPrice: 50_600 + index * 100,
    priceObservedAt: "2026-07-24T00:23:12.345Z",
    model: {
      modelId: "amazon/chronos-2",
      modelRevision: "ui-fixture",
      device: "cuda",
    },
  }));
  const historyCount = phase === "selecting" ? 0 : 28;
  const trades = Array.from({ length: historyCount }, (_, index) => {
    const symbol = symbols[index % symbols.length];
    const side = index % 2 === 0 ? "buy" : "sell";
    const executedAt = new Date(Date.parse("2026-07-24T00:22:05.000Z") + index * 1_000).toISOString();
    const price = 50_000 + index * 5;
    const quantity = index % 3 + 1;
    return {
      symbol,
      side,
      executedAt,
      signalEligibleAfter: new Date(Date.parse(executedAt) - 1_000).toISOString(),
      price,
      quantity,
      amount: price * quantity,
      cost: 2_000,
      totalCosts: 2_000,
      source: "next_valid_quote",
    };
  });
  const decisions = Array.from({ length: historyCount }, (_, index) => {
    const decidedAt = new Date(Date.parse("2026-07-24T00:21:00.000Z") + index * 1_000).toISOString();
    const decisionSymbol = symbols[index % symbols.length];
    return {
      symbol: decisionSymbol,
      action: index % 2 === 0 ? "buy" : "hold",
      decidedAt,
      eligibleAfter: new Date(Date.parse(decidedAt) + 1_000).toISOString(),
      inputEndAt: decidedAt,
      reason: index === 0
        ? "positive_risk_adjusted_score · entry_probability_threshold"
        : `event_driven_final_bar · fixture_${index}`,
      score: 0.81 - index * 0.001,
      upProbability: 0.64,
      chartPatternBias: index % 3 === 0 ? "bullish" : "neutral",
      chartPatterns: index % 3 === 0 ? ["bullish_engulfing"] : ["inside_bar"],
      model: "amazon/chronos-2 · ui-fixture",
      ...(index === 0 ? {
        signalSymbol: decisionSymbol,
        modelOutputs: {
          chronos2: chronos2ForecastOutput(
            decisionSymbol,
            "2026-07-24T00:22:00.000Z",
            50_220,
          ),
        },
      } : {}),
    };
  });
  const charts = symbols.map((symbol, symbolIndex) => ({
    symbol,
    name: symbolIndex === 0 ? "가상 성장주" : "가상 모멘텀주",
    currency: "KRW",
    bars: [
      {
        timestamp: "2026-07-24T00:20:00.000Z",
        open: 49_800,
        high: 50_050,
        low: 49_700,
        close: 50_000,
        volume: 12_000,
        status: "final",
        indicatorValues: {
          "trend-ema:value": 49_900,
          "session-vwap:session_vwap": 49_880,
          "anchored-vwap:anchored_vwap": 49_850,
        },
      },
      {
        timestamp: "2026-07-24T00:21:00.000Z",
        open: 50_000,
        high: 50_300,
        low: 49_950,
        close: 50_220,
        volume: 15_000,
        status: "final",
        indicatorValues: {
          "trend-ema:value": 50_060,
          "session-vwap:session_vwap": 49_990,
          "anchored-vwap:anchored_vwap": 49_940,
        },
      },
      {
        timestamp: "2026-07-24T00:22:00.000Z",
        open: 50_220,
        high: 50_650,
        low: 50_150,
        close: 50_550,
        volume: 18_000,
        status: "final",
        indicatorValues: {
          "trend-ema:value": 50_240,
          "session-vwap:session_vwap": 50_160,
          "anchored-vwap:anchored_vwap": 50_050,
        },
      },
      {
        timestamp: "2026-07-24T00:23:00.000Z",
        open: 50_550,
        high: 50_700,
        low: 50_400,
        close: 50_600,
        volume: 8_000,
        status: "forming",
        indicatorValues: {
          "trend-ema:value": 50_400,
          "session-vwap:session_vwap": 50_250,
          "anchored-vwap:anchored_vwap": 50_120,
        },
      },
    ],
    indicators: [{
      id: "trend-ema",
      kind: "ema",
      status: "available",
      values: { value: 50_400 },
    }, {
      id: "momentum-rsi",
      kind: "rsi",
      status: "available",
      values: { value: 61.25 },
    }],
    patterns: [{
      detectedAt: "2026-07-24T00:22:00.000Z",
      name: "bullish_engulfing",
      bias: "bullish",
      strength: 0.82,
    }],
    updatedAt: "2026-07-24T00:23:00.000Z",
  }));
  const modelForecasts = phase === "selecting" ? [] : charts.map((chart, index) => {
    const originBar = chart.bars.findLast((bar) => bar.status === "final");
    const origin = originBar.timestamp;
    const originPrice = originBar.close;
    return {
      lane: "chronos2",
      signalSymbol: chart.symbol,
      status: "available",
      origin,
      inputOrigin: origin,
      originPrice,
      priceObservedAt: origin,
      projectionPolicy: "native_input_origin",
      generatedAt: new Date(Date.parse(origin) + 320 + index).toISOString(),
      modelId: "amazon/chronos-2",
      modelRevision: "ui-fixture",
      points: [5, 15, 30, 60].map((horizonMinutes, horizonIndex) => ({
        horizonMinutes,
        targetTimestamp: new Date(
          Date.parse(origin) + horizonMinutes * 60_000,
        ).toISOString(),
        q10Price: originPrice * (1 - 0.006 + horizonIndex * 0.001),
        medianPrice: originPrice * (1 + 0.002 + horizonIndex * 0.001),
        q90Price: originPrice * (1 + 0.008 + horizonIndex * 0.001),
        upProbability: 0.61 + horizonIndex * 0.02,
      })),
    };
  });
  return {
    schemaVersion: "ai-paper-simulation/v9",
    simulationCase: request.simulationCase,
    market: request.market,
    modelLanes: ["chronos2", "fincast"],
    resolvedModelPlan,
    phase,
    startedAt: "2026-07-24T00:20:00.000Z",
    expiresAt: "2026-07-24T01:05:00.000Z",
    currency: "USD",
    initialCash: request.initialCash,
    cash: request.initialCash - 1_018_000,
    equity: cancelled ? request.initialCash + 25_000 : request.initialCash + 36_000,
    progress: cancelled ? 1 : phase === "selecting" ? 0.05 : 0.42,
    selection: request.selection,
    strategy: request.strategy,
    criterion: request.selection.mode === "auto" ? request.selection.criterion : "trading_amount",
    preset: request.preset,
    riskTolerance: request.riskTolerance,
    policyProfile: {
      targetAllocationRate: request.riskTolerance / 125,
      cashReserveRate: 1 - request.riskTolerance / 125,
      technicalConfirmation: request.riskTolerance <= 50 ? "entry_candidate" : "non_exit",
      patternConfirmation: request.riskTolerance <= 50 ? "bullish" : "non_bearish",
    },
    decisionCadence: {
      trigger: "finalized_one_minute_bar",
      triggeredEvents: historyCount,
      coalescedEvents: 1,
      duplicateEvents: 2,
      inFlight: false,
      lastTriggeredAt: "2026-07-24T00:22:00.000Z",
      lastStartedAt: "2026-07-24T00:22:00.050Z",
      lastFinishedAt: "2026-07-24T00:22:00.400Z",
    },
    selected: phase === "selecting" ? [] : selected,
    positions: phase === "selecting" || cancelled ? [] : [{
      symbol: symbols[0],
      quantity: 20,
      averagePrice: 50_000,
      marketPrice: 50_900,
      unrealizedPnl: 18_000,
    }],
    charts: phase === "selecting" ? [] : charts,
    trades,
    decisions,
    modelForecasts,
    warnings: ["UI fixture는 실제 주문을 생성하지 않습니다."],
    capabilities: {
      realOrder: false,
      mcp: false,
      nextValidFillOnly: true,
      eventDrivenDecisions: true,
    },
  };
}

export async function routeSimulationUiApi(page) {
  const archivedRequest = {
    contractVersion: "ai-paper-simulation/v9",
    simulationCase: "us_etf_pair",
    market: { kind: "stock", country: "US" },
    initialCash: 2_500_000,
    durationMinutes: 45,
    strategy: { mode: "pair", pairId: "qqq-tqqq-sqqq", allowDegradedMode: false },
    preset: "breakout",
    riskTolerance: 91,
    selection: {
      mode: "auto",
      criterion: "volatility",
      symbolCount: 2,
    },
    costs: {
      commissionBpsPerSide: 1.5,
      taxBpsOnExit: 18,
      spreadBpsRoundTrip: 5,
      slippageBpsPerSide: 2,
    },
    fincastCandleSeconds: 60,
    execution: { mode: "paper" },
  };
  const archivedRuns = Array.from({ length: 22 }, (_, index) => ({
    runId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    body: archivedRequest,
    status: "completed",
    startedAt: new Date(Date.parse("2026-07-23T20:00:00.000Z") - index * 60_000).toISOString(),
    finishedAt: new Date(Date.parse("2026-07-23T20:45:00.000Z") - index * 60_000).toISOString(),
  }));
  const state = {
    starts: [],
    polls: 0,
    streams: 0,
    terminalStreams: 0,
    cancels: [],
    searches: [],
    active: new Map(),
    historyRequests: 0,
    reportRequests: 0,
    archivedRunId: archivedRuns[0].runId,
    failNextCryptoStart: false,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/session") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true }),
      });
    }
    if (url.pathname === "/api/portfolio") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(portfolio()),
      });
    }
    if (url.pathname === "/api/portfolio/simulation/status") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          limits: {
            minInitialCash: 100_000,
            maxInitialCash: 10_000_000_000,
            minDurationMinutes: 1,
            maxDurationMinutes: 390,
          },
          capabilities: {
            realOrder: false,
            orderApiDependency: false,
            mcp: false,
            autonomousPaperTrading: true,
            manualSymbolSelection: true,
            deterministicChartPatterns: true,
            eventDrivenDecisions: true,
            pairStrategy: true,
            chronos2RustEnsemble: true,
            cryptoFutures: true,
          },
          cryptoFutures: {
            schemaVersion: "ai-paper-simulation/v9",
            credentials: {
              configured: true,
              signedReadSucceeded: true,
            },
            executionGates: { paper: true, testnet: false, live: false },
            workers: {
              chronos2: {
                status: "healthy",
                precision: "fp32",
              },
              fincast: {
                status: "healthy",
                precision: "fp16",
              },
            },
          },
          pairStrategy: {
            enabled: true,
            catalogVersion: "scalping-pair-catalog/v4",
            pairs: [{
              pairId: "qqq-tqqq-sqqq",
              displaySignalSymbol: "QQQ",
              modelTargetSymbol: "QQQ",
              auxiliarySymbols: [],
              bull: { executionSymbol: "TQQQ", leverageMultiplier: 3 },
              bear: { executionSymbol: "SQQQ", leverageMultiplier: -3 },
            }, {
              pairId: "semiconductor-soxl-soxs",
              displaySignalSymbol: "SMH",
              modelTargetSymbol: "SOXX",
              auxiliarySymbols: ["SMH", "QQQ"],
              bull: { executionSymbol: "SOXL", leverageMultiplier: 3 },
              bear: { executionSymbol: "SOXS", leverageMultiplier: -3 },
            }, {
              pairId: "spy-spxl-spxs",
              displaySignalSymbol: "SPY",
              modelTargetSymbol: "SPY",
              auxiliarySymbols: [],
              bull: { executionSymbol: "SPXL", leverageMultiplier: 3 },
              bear: { executionSymbol: "SPXS", leverageMultiplier: -3 },
            }],
          },
          costProfiles: {
            version: "toss-securities-simulation-costs/v1",
            KR: {
              profileVersion: "toss-securities-simulation-costs/v1",
              profileId: "toss-kr-krx-equity-2026",
              broker: "Toss Securities",
              marketCountry: "KR",
              currency: "KRW",
              venue: "KRX",
              verifiedAt: "2026-07-25",
              commissionBpsPerSide: 1.5,
              sellTaxBps: 20,
              sellRegulatoryBps: 0,
              sellRegulatoryFeePerShare: 0,
              spreadBpsRoundTrip: 5,
              slippageBpsPerSide: 2,
              fxConversionIncluded: false,
              alternativeVenues: [{ venue: "NXT", commissionBpsPerSide: 1.4 }],
              scopeNotes: ["KRX 일반주식"],
              sources: [{
                label: "토스증권 Open API 거래 수수료",
                url: "https://home.tossinvest.com/ko/open-api",
              }],
            },
            US: {
              profileVersion: "toss-securities-simulation-costs/v1",
              profileId: "toss-us-equity-2026",
              broker: "Toss Securities",
              marketCountry: "US",
              currency: "USD",
              venue: "US",
              verifiedAt: "2026-07-25",
              commissionBpsPerSide: 10,
              commissionFreeGrossAmountMaximum: 10,
              sellTaxBps: 0,
              sellRegulatoryBps: 0.206,
              sellRegulatoryFeePerShare: 0.000195,
              sellRegulatoryFeeMaximum: 9.79,
              spreadBpsRoundTrip: 5,
              slippageBpsPerSide: 2,
              fxConversionIncluded: false,
              alternativeVenues: [],
              scopeNotes: ["USD 원장"],
              sources: [{
                label: "토스증권 Open API 거래 수수료",
                url: "https://home.tossinvest.com/ko/open-api",
              }],
            },
          },
          policy: {
            initialPortfolio: "cash_only_zero_holdings",
            cadence: "event_driven_immediately_after_each_new_finalized_one_minute_bar",
          },
          limitations: ["가상 체결만 생성합니다."],
        }),
      });
    }
    if (url.pathname === "/api/portfolio/simulation/candidates" && request.method() === "GET") {
      const criterion = url.searchParams.get("criterion") ?? "volatility";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "ai-paper-simulation/v9",
          snapshotId: "crypto-ui-snapshot-001",
          scannerSnapshotId: "crypto-ui-snapshot-001",
          generatedAt: "2026-07-24T00:24:00.000Z",
          expiresAt: "2026-07-24T00:25:00.000Z",
          criterion,
          evidence: [{ summary: "UI fixture · 공개 시장 데이터 schema" }],
          candidates: [{
            symbol: "BTCUSDT",
            rank: 1,
            price: 67_418,
            volume: 24_120,
            quoteVolume: 1_626_000_000,
            relativeVolume: 1.42,
            spreadBps: 0.8,
            realizedVolatility60m: 0.018,
            priceChangePercent24h: 0.034,
            atrPercent14: 0.012,
            volatilityScore: 0.91,
            score: 0.91,
            scoreComponents: { realizedVolatility60m: 0.5, priceChangePercent24h: 0.3, atrPercent14: 0.2 },
            eligible: true,
            dataQuality: {
              status: "complete",
              finalBars: 1024,
              missingFields: [],
              observedAt: "2026-07-24T00:24:00.000Z",
            },
          }, {
            symbol: "ETHUSDT",
            rank: 2,
            price: 3_470,
            quoteVolume: 812_000_000,
            spreadBps: 1.1,
            realizedVolatility60m: 0.016,
            priceChangePercent24h: 0.029,
            atrPercent14: 0.011,
            score: 0.84,
            scoreComponents: {},
            eligible: true,
            dataQuality: { status: "complete", finalBars: 1024, missingFields: [] },
          }],
        }),
      });
    }
    if (url.pathname === "/api/portfolio/tools/search_instruments" && request.method() === "POST") {
      const body = request.postDataJSON();
      state.searches.push(body);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          result: {
            instruments: [
              { symbol: "SIM1", name: "가상 성장주", market: "KRX", currency: "KRW" },
              { symbol: "SIM2", name: "가상 모멘텀주", market: "KRX", currency: "KRW" },
            ],
          },
        }),
      });
    }
    if (url.pathname === "/api/portfolio/simulation/runs/current" && request.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run: null, snapshot: null }),
      });
    }
    if (url.pathname === "/api/portfolio/simulation/runs" && request.method() === "GET") {
      state.historyRequests += 1;
      const activeItems = [...state.active.entries()].map(([runId, active], index) => {
        const current = snapshot({
          phase: active.cancelled ? "cancelled" : "monitoring",
          request: active.body,
          cancelled: active.cancelled,
        });
        return {
          runId,
          status: active.cancelled ? "cancelled" : "running",
          startedAt: new Date(Date.parse("2026-07-24T00:20:00.000Z") + index * 1_000).toISOString(),
          market: active.body.market,
          marketCountry: active.body.marketCountry,
          preset: active.body.preset,
          riskTolerance: active.body.riskTolerance,
          selection: active.body.selection,
          selected: current.selected,
          currency: current.currency,
          initialCash: current.initialCash,
          finalEquity: current.equity,
          cash: current.cash,
          netProfitLoss: current.equity - current.initialCash,
          returnRatio: (current.equity - current.initialCash) / current.initialCash,
          tradeCount: current.trades.length,
          decisionCount: current.decisions.length,
          model: current.selected[0]?.model,
          warnings: current.warnings,
        };
      });
      const archivedItems = archivedRuns.map((item, index) => {
        const current = snapshot({ phase: "completed", request: item.body });
        return {
          runId: item.runId,
          status: item.status,
          startedAt: item.startedAt,
          finishedAt: item.finishedAt,
          marketCountry: item.body.marketCountry,
          preset: item.body.preset,
          riskTolerance: item.body.riskTolerance,
          selection: item.body.selection,
          selected: current.selected,
          currency: current.currency,
          initialCash: current.initialCash,
          finalEquity: current.equity + index * 100,
          cash: current.cash,
          netProfitLoss: current.equity + index * 100 - current.initialCash,
          returnRatio: (current.equity + index * 100 - current.initialCash) / current.initialCash,
          realizedPnl: 18_000,
          unrealizedPnl: 18_000,
          totalCosts: 56_000,
          tradeCount: current.trades.length,
          decisionCount: current.decisions.length,
          model: current.selected[0]?.model,
          warnings: current.warnings,
        };
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "ai-trading-simulation-v3",
          items: [...activeItems, ...archivedItems],
          page: { limit: 20, returned: activeItems.length + archivedItems.length },
        }),
      });
    }
    if (url.pathname === "/api/portfolio/simulation/runs" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (state.failNextCryptoStart && body.market?.kind === "crypto_futures") {
        state.failNextCryptoStart = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "fixture-risk-bracket-unavailable",
              message: "fixture risk bracket unavailable",
            },
          }),
        });
      }
      const runId = `00000000-0000-4000-8000-${String(state.starts.length + 1).padStart(12, "0")}`;
      state.starts.push(body);
      state.active.set(runId, { body, cancelled: false, revision: 0 });
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          runId,
          status: "running",
        }),
      });
    }
    const eventsMatch = url.pathname.match(
      /^\/api\/portfolio\/simulation\/runs\/([^/]+)\/events$/,
    );
    if (eventsMatch && request.method() === "GET") {
      const runId = decodeURIComponent(eventsMatch[1]);
      const active = state.active.get(runId);
      if (!active) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "fixture stream not found" } }),
        });
      }
      active.revision += 1;
      state.streams += 1;
      if (active.cancelled) state.terminalStreams += 1;
      const status = active.cancelled ? "cancelled" : "running";
      const type = active.cancelled ? "terminal" : "snapshot";
      const event = {
        schemaVersion: 1,
        runId,
        revision: active.revision,
        emittedAt: new Date(
          Date.parse("2026-07-24T00:20:00.000Z") + active.revision * 1_000,
        ).toISOString(),
        type,
        payload: {
          runId,
          status,
          snapshot: snapshot({
            phase: active.cancelled ? "cancelled" : "monitoring",
            request: active.body,
            cancelled: active.cancelled,
          }),
        },
      };
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: {
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
        body: `id: ${event.revision}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`,
      });
    }
    const reportMatch = url.pathname.match(/^\/api\/portfolio\/simulation\/runs\/([^/]+)\/report$/);
    if (reportMatch && request.method() === "GET") {
      state.reportRequests += 1;
      const runId = decodeURIComponent(reportMatch[1]);
      const archived = archivedRuns.find((item) => item.runId === runId);
      const active = state.active.get(runId);
      const body = active?.body ?? archived?.body;
      if (!body) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "fixture report not found" } }),
        });
      }
      const status = active ? (active.cancelled ? "cancelled" : "running") : "completed";
      const current = snapshot({
        phase: status,
        request: body,
        cancelled: status === "cancelled",
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "ai-trading-simulation-v3",
          generatedAt: "2026-07-24T00:46:00.000Z",
          run: {
            runId,
            status,
            startedAt: archived?.startedAt ?? current.startedAt,
            finishedAt: archived?.finishedAt,
          },
          report: {
            configuration: {
              ...body,
              decisionCadence: current.decisionCadence,
            },
            selection: body.selection,
            selectionResult: { selected: current.selected },
            selected: current.selected,
            performance: {
              currency: current.currency,
              initialCash: current.initialCash,
              finalEquity: current.equity,
              cash: current.cash,
              netProfitLoss: current.equity - current.initialCash,
              returnRatio: (current.equity - current.initialCash) / current.initialCash,
              realizedPnl: 18_000,
              unrealizedPnl: current.positions.reduce((total, item) => total + item.unrealizedPnl, 0),
              totalCosts: current.trades.reduce((total, item) => total + item.cost, 0),
              tradeCount: current.trades.length,
              decisionCount: current.decisions.length,
              positionCount: current.positions.length,
            },
            cadence: current.decisionCadence,
            decisions: current.decisions,
            trades: current.trades,
            positions: current.positions,
            equity: [{
              timestamp: "2026-07-24T00:20:00.000Z",
              equity: current.initialCash,
              cash: current.initialCash,
            }, {
              timestamp: "2026-07-24T00:45:00.000Z",
              equity: current.equity,
              cash: current.cash,
            }],
            charts: current.charts,
            modelProvenance: current.selected.map((item) => ({ ...item.model, symbols: [item.symbol] })),
            evidence: {
              selection: { criterion: body.selection.criterion, selected: current.selected },
              chartPatternCount: current.charts.reduce((total, chart) => total + chart.patterns.length, 0),
              artifacts: [
                { type: "simulation-decisions", rowCount: current.decisions.length },
                { type: "simulation-trades", rowCount: current.trades.length },
              ],
            },
            warnings: current.warnings,
            limits: {
              decisions: { total: current.decisions.length, returned: current.decisions.length, maximum: 500, truncated: false },
              trades: { total: current.trades.length, returned: current.trades.length, maximum: 500, truncated: false },
              equity: { total: 2, returned: 2, maximum: 1_000, truncated: false },
              charts: { maximum: 2, barsPerChart: 180, patternsPerChart: 120, indicatorsPerChart: 64 },
              modelProvenance: { maximum: 16, returned: current.selected.length },
            },
          },
          snapshot: current,
        }),
      });
    }
    const match = url.pathname.match(/^\/api\/portfolio\/simulation\/runs\/([^/]+)(\/cancel)?$/);
    if (match) {
      const runId = decodeURIComponent(match[1]);
      const active = state.active.get(runId);
      if (!active) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "fixture run not found" } }),
        });
      }
      if (match[2] === "/cancel" && request.method() === "POST") {
        active.cancelled = true;
        state.cancels.push(runId);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            run: { id: runId, status: "cancel_requested" },
            snapshot: snapshot({
              phase: "cancel_requested",
              request: active.body,
            }),
          }),
        });
      }
      if (!match[2] && request.method() === "GET") {
        state.polls += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            run: { id: runId, status: active.cancelled ? "cancelled" : "running" },
            snapshot: snapshot({
              phase: active.cancelled ? "cancelled" : "monitoring",
              request: active.body,
              cancelled: active.cancelled,
            }),
          }),
        });
      }
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: `unhandled ${request.method()} ${url.pathname}` } }),
    });
  });
  return state;
}

async function verify(browser, baseUrl, viewport, theme) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript(({ selectedTheme }) => {
    window.localStorage.setItem("portfolio-theme", selectedTheme);
    history.scrollRestoration = "manual";
    let fixtureVisibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => fixtureVisibility,
    });
    window.__setSimulationFixtureVisibility = (visibility) => {
      fixtureVisibility = visibility;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    window.__simulationEventSourceStats = { opened: 0, closed: 0 };
    class FixtureEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;

      constructor(url) {
        super();
        this.url = String(url);
        this.withCredentials = false;
        this.readyState = FixtureEventSource.CONNECTING;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.controller = new AbortController();
        window.__simulationEventSourceStats.opened += 1;
        void this.connect();
      }

      async connect() {
        try {
          const response = await fetch(this.url, {
            headers: { Accept: "text/event-stream" },
            signal: this.controller.signal,
          });
          if (!response.ok) throw new Error(`fixture EventSource HTTP ${response.status}`);
          const body = await response.text();
          if (this.readyState === FixtureEventSource.CLOSED) return;
          this.readyState = FixtureEventSource.OPEN;
          const openEvent = new Event("open");
          this.dispatchEvent(openEvent);
          this.onopen?.call(this, openEvent);
          for (const block of body.trim().split(/\n\n+/)) {
            let type = "message";
            let lastEventId = "";
            const data = [];
            for (const line of block.split(/\n/)) {
              if (line.startsWith("event:")) type = line.slice(6).trim();
              else if (line.startsWith("id:")) lastEventId = line.slice(3).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            }
            const message = new MessageEvent(type, {
              data: data.join("\n"),
              lastEventId,
              origin: window.location.origin,
            });
            this.dispatchEvent(message);
            if (type === "message") this.onmessage?.call(this, message);
          }
        } catch (error) {
          if (this.readyState === FixtureEventSource.CLOSED) return;
          const event = new Event("error");
          this.dispatchEvent(event);
          this.onerror?.call(this, event);
        }
      }

      close() {
        if (this.readyState === FixtureEventSource.CLOSED) return;
        this.readyState = FixtureEventSource.CLOSED;
        this.controller.abort();
        window.__simulationEventSourceStats.closed += 1;
      }
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: FixtureEventSource,
    });
  }, { selectedTheme: theme });
  const page = await context.newPage();
  const errors = { console: [], page: [], request: [], response: [] };
  page.on("console", (message) => {
    if (message.type() === "error") errors.console.push(message.text());
  });
  page.on("pageerror", (error) => errors.page.push(error.message));
  page.on("requestfailed", (request) => errors.request.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.response.push(`${response.status()} ${response.url()}`);
  });
  const state = await routeSimulationUiApi(page);
  const selectionMode = viewport.width >= 1_000 ? "auto" : "manual";
  const requestedSymbolCount = selectionMode === "auto" ? 2 : 1;
  const requestedRiskTolerance = selectionMode === "auto" ? 73 : 27;
  let cryptoSetupScreenshot;
  let cryptoResultScreenshot;
  let inlineForecastScreenshot;
  let pairLayoutScreenshot;
  let selectedCount = 0;
  let chartCount = 0;
  let liveForecastCount = 0;
  let scrollMetrics = {};
  let zeroSize = [];
  let overflow = 0;
  try {
    await page.goto(`${baseUrl}/?simulation-ui=${viewport.width}#simulation`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const actualViewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    check(
      actualViewport.width === viewport.width && actualViewport.height === viewport.height,
      `viewport 불일치: ${JSON.stringify(actualViewport)}`,
    );
    await page.getByRole("heading", { name: "시뮬레이션", exact: true }).waitFor();
    await page.locator("[data-ai-simulation]").waitFor();
    await page.getByText("선물 paper 전용 · 실주문 capability false", { exact: true }).waitFor();
    const historyDisclosure = page.locator("[data-simulation-history-disclosure]");
    await historyDisclosure.waitFor();
    check(state.historyRequests === 0, "기록을 펼치기 전에 시뮬레이션 기록 API가 호출됐습니다.");
    check(state.reportRequests === 0, "실행을 선택하기 전에 시뮬레이션 보고서 API가 호출됐습니다.");
    await historyDisclosure.locator("[data-simulation-history-toggle]").click();
    const historyPanel = page.locator("[data-simulation-history]");
    await historyPanel.waitFor();
    const archivedHistoryItem = historyPanel.locator(
      `[data-simulation-history-item="${state.archivedRunId}"]`,
    );
    await archivedHistoryItem.waitFor();
    check(state.reportRequests === 0, "기록 목록만 펼쳤는데 첫 보고서 API가 자동 호출됐습니다.");
    await archivedHistoryItem.click();
    await historyPanel.locator(`[data-simulation-report="${state.archivedRunId}"]`).waitFor({ timeout: 10_000 });
    await historyPanel.getByText("실행 설정", { exact: true }).waitFor();
    await historyPanel.getByText("캔들·지표·패턴 근거", { exact: true }).waitFor();
    await historyPanel.locator("[data-ai-simulation-model-forecast-overlay]").first().waitFor();
    await historyPanel.locator(
      '[data-ai-simulation-model-forecast="chronos2"][data-ai-simulation-model-forecast-origin="exact-final"]',
    ).first().waitFor();
    const historyScroll = historyPanel.locator("[data-simulation-history-scroll]");
    const historyScrollMetrics = await historyScroll.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      tabIndex: element.tabIndex,
    }));
    check(
      historyScrollMetrics.scrollHeight > historyScrollMetrics.clientHeight,
      `시뮬레이션 기록 목록이 내부 스크롤 영역을 만들지 않았습니다: ${JSON.stringify(historyScrollMetrics)}`,
    );
    check(historyScrollMetrics.tabIndex === 0, "시뮬레이션 기록 스크롤 영역을 키보드로 탐색할 수 없습니다.");
    check(state.historyRequests >= 1, "시뮬레이션 기록 API가 호출되지 않았습니다.");
    check(state.reportRequests >= 1, "시뮬레이션 결과 보고서 API가 호출되지 않았습니다.");
    const actualTheme = await page.evaluate(() => (
      document.documentElement.classList.contains("dark") ? "dark" : "light"
    ));
    check(actualTheme === theme, `${viewport.width}px 테마가 ${theme}가 아니라 ${actualTheme}입니다.`);

    const assetClassControl = page.getByRole("tablist", { name: "시뮬레이션 전략 케이스" });
    const caseTabs = assetClassControl.getByRole("tab");
    check(await caseTabs.count() === 3, "시뮬레이션 최상위 전략 케이스가 3개가 아닙니다.");
    await assetClassControl.getByRole("tab", { name: /BTC·ETH/ }).waitFor();
    await assetClassControl.getByRole("tab", { name: /고변동성 암호화폐/ }).waitFor();
    await assetClassControl.getByRole("tab", { name: /미국 ETF 페어/ }).waitFor();
    await assetClassControl.getByRole("tab", { name: /BTC·ETH/ }).focus();
    await page.keyboard.press("ArrowRight");
    await assetClassControl.getByRole("tab", { name: /고변동성 암호화폐/ })
      .waitFor({ state: "attached" });
    check(
      await assetClassControl.getByRole("tab", { name: /고변동성 암호화폐/ })
        .getAttribute("aria-selected") === "true",
      "전략 케이스 탭의 ArrowRight 키보드 전환이 동작하지 않습니다.",
    );
    await page.keyboard.press("ArrowLeft");
    await page.getByRole("radiogroup", { name: "BTC ETH 실행 종목" }).waitFor();
    await page.getByRole("combobox", { name: "암호화폐 판단 프리셋" }).waitFor();
    await page.getByRole("slider", { name: "암호화폐 공격 방어 성향" }).waitFor();
    await page.getByText("서버가 v9 canonical plan을 확정합니다", { exact: true }).waitFor();
    const cryptoRiskLabels = [
      "암호화폐 거래당 위험",
      "암호화폐 UTC 일손실 중단선",
      "암호화폐 최대 레버리지",
      "암호화폐 Gross exposure 상한",
      "암호화폐 증거금 사용률 상한",
      "암호화폐 청산 buffer / 손절",
    ];
    for (const label of cryptoRiskLabels) {
      const input = page.getByRole("spinbutton", { name: label, exact: true });
      await input.waitFor();
      check(await input.isEnabled(), `${label} 입력을 편집할 수 없습니다.`);
    }
    const cryptoRiskPerTrade = page.getByRole("spinbutton", {
      name: "암호화폐 거래당 위험",
      exact: true,
    });
    const cryptoMaximumLeverage = page.getByRole("spinbutton", {
      name: "암호화폐 최대 레버리지",
      exact: true,
    });
    const cryptoMarginUsageLimit = page.getByRole("spinbutton", {
      name: "암호화폐 증거금 사용률 상한",
      exact: true,
    });
    await cryptoRiskPerTrade.fill("0.4");
    await cryptoMaximumLeverage.fill("12");
    await cryptoMarginUsageLimit.fill("100");
    check(
      await cryptoRiskPerTrade.inputValue() === "0.4",
      "암호화폐 거래당 위험 변경값이 제어 상태에 반영되지 않았습니다.",
    );
    check(
      await cryptoMaximumLeverage.inputValue() === "12",
      "암호화폐 최대 레버리지 변경값이 제어 상태에 반영되지 않았습니다.",
    );
    check(
      await cryptoMarginUsageLimit.getAttribute("max") === "100"
      && await cryptoMarginUsageLimit.inputValue() === "100",
      "암호화폐 증거금 사용률 상한을 100%까지 설정할 수 없습니다.",
    );
    await mkdir(screenshotDirectory, { recursive: true });
    cryptoSetupScreenshot = path.join(
      screenshotDirectory,
      `${viewport.width}x${viewport.height}-${theme}-crypto-setup.png`,
    );
    await page.locator("[data-crypto-simulation-setup]").screenshot({
      path: cryptoSetupScreenshot,
      animations: "disabled",
    });
    const cryptoStartButton = page.locator("[data-crypto-simulation-start]");
    await cryptoStartButton.waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector("[data-crypto-simulation-start]");
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await cryptoStartButton.click();
    await page.locator("[data-simulation-run]").waitFor({ timeout: 10_000 });
    check(state.starts.length === 1, "암호화폐 시작 한 번에 정확히 하나의 run이 생성되지 않았습니다.");
    const cryptoRequest = state.starts[0];
    const cryptoRunId = [...state.active.keys()][0];
    check(Boolean(cryptoRunId), "암호화폐 run ID가 fixture에 보존되지 않았습니다.");
    check(
      JSON.stringify(cryptoRequest?.market) === JSON.stringify({
        kind: "crypto_futures",
        venue: "BINANCE_USDM",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
      }),
      "암호화폐 v8 market union이 요청 body에 보존되지 않았습니다.",
    );
    check(cryptoRequest?.contractVersion === "ai-paper-simulation/v9", "암호화폐 요청이 v9이 아닙니다.");
    check(cryptoRequest?.simulationCase === "btc_eth", "BTC·ETH simulationCase가 누락됐습니다.");
    check(!("marketCountry" in cryptoRequest), "암호화폐 요청에 legacy marketCountry가 포함됐습니다.");
    check(cryptoRequest?.initialCash === 10_000, "암호화폐 시작 USDT가 요청 body에 보존되지 않았습니다.");
    check(cryptoRequest?.durationMinutes === 120, "암호화폐 shadow 기간이 요청 body에 보존되지 않았습니다.");
    check(
      JSON.stringify(cryptoRequest?.selection) === JSON.stringify({
        mode: "manual",
        symbols: ["BTCUSDT", "ETHUSDT"],
      }),
      "BTC·ETH 2계약 직접 선택 설정이 요청 body에 보존되지 않았습니다.",
    );
    check(!("modelLanes" in cryptoRequest), "암호화폐 요청에 서버 소유 modelLanes가 포함됐습니다.");
    check(!("modelPlan" in cryptoRequest), "암호화폐 요청에 서버 소유 modelPlan이 포함됐습니다.");
    check(cryptoRequest?.execution?.mode === "paper", "암호화폐 실행 mode가 paper가 아닙니다.");
    check(
      JSON.stringify(cryptoRequest?.riskLimits) === JSON.stringify({
        riskPerTradeRate: 0.004,
        dailyLossLimitRate: 0.03,
        maximumLeverage: 12,
        grossExposureLimitRate: 1.5,
        marginUsageLimitRate: 1,
        liquidationBufferMultiple: 2,
      }),
      `암호화폐 hard-envelope 위험 한도가 요청 body와 다릅니다: ${JSON.stringify(cryptoRequest?.riskLimits)}`,
    );

    const cryptoRunPanel = page.locator(`[data-simulation-run="${cryptoRunId}"]`);
    await cryptoRunPanel.getByText("시뮬레이션 진행", { exact: true }).waitFor({ timeout: 10_000 });
    check(
      await cryptoRunPanel.locator("[data-simulation-selected] article").count() === 2,
      "암호화폐 실행 결과에 BTC·ETH 2계약이 표시되지 않았습니다.",
    );
    await cryptoRunPanel.locator("[data-futures-position]").first().waitFor();
    check(
      await cryptoRunPanel.locator("[data-futures-position]").count() === 2,
      "암호화폐 실행 결과에 롱·숏 선물 포지션 2개가 표시되지 않았습니다.",
    );
    await cryptoRunPanel.locator('[data-futures-position="BTCUSDT"][data-futures-position-side="long"]').waitFor();
    await cryptoRunPanel.locator('[data-futures-position="ETHUSDT"][data-futures-position-side="short"]').waitFor();
    await cryptoRunPanel.getByText("BTCUSDT · 롱 진입", { exact: true }).waitFor();
    await cryptoRunPanel.getByText("ETHUSDT · 숏 진입", { exact: true }).waitFor();
    await cryptoRunPanel.locator('[data-model-lane="chronos2"]').waitFor();
    await cryptoRunPanel.locator('[data-model-lane="fincast"]').waitFor();
    await cryptoRunPanel.locator('[data-model-lane-provenance="chronos2"]').waitFor();
    await cryptoRunPanel.locator('[data-model-lane-provenance="fincast"]').waitFor();
    await cryptoRunPanel.getByText("Vincent05R/FinCast", { exact: false }).first().waitFor();
    await cryptoRunPanel.locator(
      '[data-ai-simulation-trade-marker="buy"][data-ai-simulation-trade-color="red"]',
    ).first().waitFor();
    await cryptoRunPanel.locator(
      '[data-ai-simulation-trade-marker="sell"][data-ai-simulation-trade-color="blue"]',
    ).first().waitFor();
    const cryptoCharts = cryptoRunPanel.locator("[data-simulation-charts] [data-ai-simulation-chart]");
    check(await cryptoCharts.count() === 2, "암호화폐 BTC·ETH 분봉 차트가 각각 표시되지 않았습니다.");
    await cryptoRunPanel.locator(
      '[data-simulation-charts][data-simulation-chart-layout="crypto-full-width"]',
    ).waitFor();
    const cryptoChartWidths = await cryptoRunPanel.locator("[data-simulation-charts]")
      .evaluate((grid) => {
        const gridWidth = grid.getBoundingClientRect().width;
        return Array.from(grid.querySelectorAll("[data-ai-simulation-chart]")).map(
          (chart) => chart.getBoundingClientRect().width / gridWidth,
        );
      });
    check(
      cryptoChartWidths.every((ratio) => ratio > 0.98),
      `암호화폐 차트가 전체 폭을 사용하지 않습니다: ${JSON.stringify(cryptoChartWidths)}`,
    );
    await cryptoCharts.first().locator("[data-ai-simulation-hover-metrics]").waitFor();
    const hoverMetrics = cryptoCharts.first().locator("[data-ai-simulation-hover-metrics]");
    const hoverBefore = await hoverMetrics.textContent();
    const priceChartBox = await cryptoCharts.first().locator("[data-ai-simulation-price-chart]")
      .boundingBox();
    check(Boolean(priceChartBox), "암호화폐 차트 hover 검증 좌표를 계산하지 못했습니다.");
    await cryptoCharts.first().locator("[data-ai-simulation-price-chart]").evaluate((chart) => {
      const bounds = chart.getBoundingClientRect();
      chart.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: bounds.left + bounds.width * 0.15,
        clientY: bounds.top + bounds.height * 0.5,
      }));
    });
    await page.waitForFunction((previous) => (
      document.querySelector('[data-ai-simulation-chart="BTCUSDT"] [data-ai-simulation-hover-metrics]')
        ?.textContent !== previous
    ), hoverBefore);
    check(
      await cryptoCharts.first().locator(".recharts-tooltip-wrapper").evaluate(
        (element) => getComputedStyle(element).display === "none",
      ),
      "마우스 추적 tooltip이 차트 내부에 남아 있습니다.",
    );
    const expandButton = cryptoCharts.first().getByRole("button", {
      name: "BTCUSDT 차트 전체화면 확대",
    });
    await expandButton.click();
    await page.waitForFunction(() => (
      document.querySelector('[data-ai-simulation-chart="BTCUSDT"]')
        ?.getAttribute("data-ai-simulation-chart-expanded") === "true"
    ));
    await cryptoCharts.first().locator('[data-ai-simulation-indicator-badge="rsi"]').waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (
      document.querySelector('[data-ai-simulation-chart="BTCUSDT"]')
        ?.getAttribute("data-ai-simulation-chart-expanded") === "false"
    ));
    for (const lane of ["chronos2", "fincast"]) {
      await cryptoCharts.first().locator(
        `[data-ai-simulation-model-forecast="${lane}"][data-ai-simulation-model-forecast-origin="exact-final"]`,
      ).waitFor();
      for (const horizon of [5, 15, 30, 60]) {
        await cryptoCharts.first().locator(
          `[data-ai-simulation-model-forecast-horizon="${lane}:${horizon}"]`,
        ).waitFor();
      }
    }
    const cryptoForecastGeometry = await cryptoCharts.evaluateAll((charts, lanes) => (
      charts.flatMap((chart) => lanes.map((lane) => {
        const lineNode = chart.querySelector(`[data-ai-simulation-forecast-line="${lane}"]`);
        const linePath = lineNode?.matches("path")
          ? lineNode
          : lineNode?.querySelector("path");
        const bandNode = chart.querySelector(`[data-ai-simulation-forecast-band="${lane}"]`);
        const bandPath = bandNode?.matches("path")
          ? bandNode
          : bandNode?.querySelector("path");
        const originNode = chart.querySelector(`[data-ai-simulation-forecast-origin="${lane}"]`);
        const originLine = originNode?.matches("line")
          ? originNode
          : originNode?.querySelector("line");
        const lineLength = typeof linePath?.getTotalLength === "function"
          ? linePath.getTotalLength()
          : 0;
        const start = lineLength > 0 ? linePath.getPointAtLength(0) : undefined;
        const end = lineLength > 0 ? linePath.getPointAtLength(lineLength) : undefined;
        return {
          chart: chart.getAttribute("data-ai-simulation-chart"),
          lane,
          lineD: linePath?.getAttribute("d") ?? "",
          bandD: bandPath?.getAttribute("d") ?? "",
          originX: Number(originLine?.getAttribute("x1")),
          startX: start?.x,
          endX: end?.x,
        };
      }))
    ), ["chronos2", "fincast"]);
    for (const geometry of cryptoForecastGeometry) {
      check(
        geometry.lineD.trim().length > 0 && geometry.bandD.trim().length > 0,
        `암호화폐 ${geometry.chart} ${geometry.lane} 예측 SVG path가 비어 있습니다.`,
      );
      check(
        Number.isFinite(geometry.originX)
          && Number.isFinite(geometry.startX)
          && Math.abs(geometry.startX - geometry.originX) <= 2,
        `암호화폐 ${geometry.chart} ${geometry.lane} 예측선이 마지막 확정봉 origin에 붙지 않았습니다: ${JSON.stringify(geometry)}`,
      );
      check(
        Number.isFinite(geometry.endX) && geometry.endX > geometry.originX + 1,
        `암호화폐 ${geometry.chart} ${geometry.lane} 미래 예측이 마지막 캔들 오른쪽 x-domain으로 이어지지 않았습니다: ${JSON.stringify(geometry)}`,
      );
    }
    cryptoResultScreenshot = path.join(
      screenshotDirectory,
      `${viewport.width}x${viewport.height}-${theme}-crypto-result.png`,
    );
    await cryptoRunPanel.screenshot({
      path: cryptoResultScreenshot,
      animations: "disabled",
    });

    await page.locator("[data-crypto-simulation-stop]").click();
    await cryptoRunPanel.getByText("취소됨", { exact: true }).waitFor({ timeout: 10_000 });
    check(state.cancels.length === 1, "암호화폐 테스트 중단이 정확히 한 번 호출되지 않았습니다.");
    await historyPanel.getByRole("button", { name: "시뮬레이션 기록 새로고침" }).click();
    const cryptoHistoryItem = historyPanel.locator(`[data-simulation-history-item="${cryptoRunId}"]`);
    await cryptoHistoryItem.waitFor({ timeout: 10_000 });
    await cryptoHistoryItem.click();
    const cryptoHistoryReport = historyPanel.locator(`[data-simulation-report="${cryptoRunId}"]`);
    await cryptoHistoryReport.waitFor({ timeout: 10_000 });
    await cryptoHistoryReport.locator("[data-futures-ledger]").waitFor();
    await cryptoHistoryReport.locator('[data-model-lane-provenance="chronos2"]').waitFor();
    await cryptoHistoryReport.locator('[data-model-lane-provenance="fincast"]').waitFor();
    check(
      await cryptoHistoryReport.locator("[data-simulation-report-charts] [data-ai-simulation-chart]").count() === 2,
      "암호화폐 히스토리 보고서가 BTC·ETH 차트 2개를 복원하지 못했습니다.",
    );
    await cryptoHistoryReport.getByText("BTCUSDT · 롱 진입", { exact: true }).waitFor();
    await cryptoHistoryReport.getByText("ETHUSDT · 숏 진입", { exact: true }).waitFor();
    await cryptoHistoryReport.getByText(
      "Chronos-2 · Primary · FinCast · Main lane·판단 주기",
      { exact: true },
    ).waitFor();

    const runLegacySingleStockRegression = false;
    if (runLegacySingleStockRegression) {
    await assetClassControl.getByRole("radio", { name: /주식/ }).click();
    await page.locator('[data-simulation-asset-class="stock"]').waitFor();

    await page.locator("summary").filter({ hasText: "비용 가정 · bps" }).click();
    const strategyGroup = page.getByRole("radiogroup", {
      name: "시뮬레이션 전략 실행 방식",
    });
    await strategyGroup.getByRole("radio", { name: "페어 비교", exact: true }).click();
    const pairSelect = page.getByRole("combobox", { name: "미국 페어 카탈로그" });
    await pairSelect.waitFor();
    check(
      (await pairSelect.textContent())?.includes("샌디스크 SNDK"),
      "페어 모드의 기본 프리셋이 SNDK·SNXX·SNDQ가 아닙니다.",
    );
    check(
      await page.getByRole("spinbutton", { name: "토스 편도 수수료 bps" }).inputValue() === "10",
      "페어 모드 전환 시 토스 미국 수수료 기본값 10bps가 적용되지 않았습니다.",
    );
    check(
      await page.getByRole("spinbutton", { name: "매도 거래세 bps" }).inputValue() === "0",
      "페어 모드 전환 시 미국 매도 거래세 기본값 0bps가 적용되지 않았습니다.",
    );
    const pairStartButton = page.getByRole("button", { name: "AI 시뮬레이션 시작", exact: true });
    await pairStartButton.click();
    await page.locator("[data-simulation-run]")
      .getByText("시뮬레이션 진행", { exact: true })
      .waitFor({ timeout: 10_000 });
    const pairChartGrid = page.locator(
      '[data-simulation-charts][data-simulation-chart-layout="pair-primary-full-width"]',
    );
    await pairChartGrid.waitFor();
    const pairCharts = pairChartGrid.locator("[data-ai-simulation-chart]");
    check(await pairCharts.count() === 3, "SNDK 페어 차트 3개가 표시되지 않았습니다.");
    check(
      JSON.stringify(await pairCharts.evaluateAll((charts) => charts.map(
        (chart) => chart.getAttribute("data-ai-simulation-chart"),
      ))) === JSON.stringify(["SNDK", "SNXX", "SNDQ"]),
      "SNDK가 상단 첫 차트로 배치되지 않았습니다.",
    );
    const pairWidths = await pairChartGrid.evaluate((grid) => {
      const width = grid.getBoundingClientRect().width;
      return Array.from(grid.querySelectorAll("[data-ai-simulation-chart]")).map(
        (chart) => chart.getBoundingClientRect().width / width,
      );
    });
    check(pairWidths[0] > 0.98, `SNDK 상단 차트가 전체 폭이 아닙니다: ${JSON.stringify(pairWidths)}`);
    pairLayoutScreenshot = path.join(
      screenshotDirectory,
      `${viewport.width}x${viewport.height}-${theme}-pair-layout.png`,
    );
    await pairChartGrid.screenshot({ path: pairLayoutScreenshot, animations: "disabled" });
    await page.getByRole("button", { name: "테스트 중단", exact: true }).click();
    await page.locator("[data-simulation-run]")
      .getByText("취소됨", { exact: true })
      .waitFor({ timeout: 10_000 });

    const startsBeforeStock = state.starts.length;
    const cancelsBeforeStock = state.cancels.length;
    await strategyGroup.getByRole("radio", { name: "단일", exact: true }).click();
    await page.getByRole("combobox", { name: "시뮬레이션 대상 시장" }).click();
    await page.getByRole("option", { name: "국내", exact: true }).click();
    check(
      await page.getByRole("spinbutton", { name: "토스 편도 수수료 bps" }).inputValue() === "1.5",
      "국내 시장 복귀 시 토스 KRX 수수료 기본값 1.5bps가 적용되지 않았습니다.",
    );
    check(
      await page.getByRole("spinbutton", { name: "매도 거래세 bps" }).inputValue() === "20",
      "국내 시장 복귀 시 KRX 일반주식 매도세 기본값 20bps가 적용되지 않았습니다.",
    );
    await page.locator('[data-simulation-cost-profile="toss-kr-krx-equity-2026"]').waitFor();
    await page.getByText("토스증권 국내 KRX 일반주식 기준", { exact: false }).waitFor();

    const startButton = page.getByRole("button", { name: "AI 시뮬레이션 시작", exact: true });
    await startButton.waitFor();
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((item) => item.textContent?.includes("AI 시뮬레이션 시작"));
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await page.waitForTimeout(900);
    check(
      state.starts.length === startsBeforeStock,
      "주식 화면 전환만으로 시뮬레이션 run이 자동 시작됐습니다.",
    );

    await page.getByRole("spinbutton", { name: "시작 예수금" }).fill("2500000");
    await page.getByRole("spinbutton", { name: "테스트 기간" }).fill("45");

    const presetSelect = page.getByRole("combobox", { name: "AI 판단 프리셋" });
    await presetSelect.click();
    for (const presetLabel of ["추세 수익", "돌파 가속 · 최대 공격", "반등 수익", "방어 수익"]) {
      await page.getByRole("option", { name: presetLabel, exact: true }).waitFor();
    }
    await page.getByRole("option", { name: "돌파 가속 · 최대 공격", exact: true }).click();

    const riskSlider = page.getByRole("slider", { name: "공격 방어 성향" });
    await riskSlider.evaluate((element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("range input value setter unavailable");
      setter.call(element, String(value));
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, requestedRiskTolerance);
    check(
      await riskSlider.inputValue() === String(requestedRiskTolerance),
      "공격·방어 성향 slider 값이 반영되지 않았습니다.",
    );

    if (selectionMode === "auto") {
      await page.getByRole("combobox", { name: "AI 선정 종목 수" }).click();
      await page.getByRole("option", { name: "2종목" }).click();
      await page.getByRole("combobox", { name: "AI 종목 선정 기준" }).click();
      await page.getByRole("option", { name: "변동성", exact: true }).click();
    } else {
      await page.getByRole("combobox", { name: "시뮬레이션 종목 선택 방식" }).click();
      await page.getByRole("option", { name: "사용자가 직접 선택", exact: true }).click();
      await page.locator("[data-simulation-manual-selection]").waitFor();
      await page.getByRole("textbox", { name: "시뮬레이션 종목 검색" }).fill("SIM1");
      const result = page.locator("[data-simulation-instrument-results]")
        .getByRole("button", { name: /가상 성장주/ });
      await result.waitFor({ timeout: 10_000 });
      await result.click();
      await page.locator("[data-simulation-manual-symbols]").getByText(/SIM1/).waitFor();
      check(state.searches.length >= 1, "직접 종목 선택 검색 API가 호출되지 않았습니다.");
    }
    await startButton.click();
    await page.locator("[data-simulation-run]").getByText("가상 원장을 준비하고 있습니다.", { exact: true }).waitFor({ timeout: 10_000 });
    const stopButton = page.getByRole("button", { name: "테스트 중단", exact: true });
    await stopButton.waitFor();
    check(
      state.starts.length === startsBeforeStock + 1,
      "주식 시작 버튼 한 번에 정확히 하나의 run이 생성되지 않았습니다.",
    );
    const firstRequest = state.starts[startsBeforeStock];
    check(firstRequest?.initialCash === 2_500_000, "시작 예수금이 요청 body에 보존되지 않았습니다.");
    check(firstRequest?.durationMinutes === 45, "테스트 기간이 요청 body에 보존되지 않았습니다.");
    check(firstRequest?.marketCountry === "KR", "기본 국내 시장이 요청 body에 보존되지 않았습니다.");
    check(firstRequest?.preset === "breakout", "선택한 돌파 프리셋이 요청 body에 보존되지 않았습니다.");
    check(firstRequest?.riskTolerance === requestedRiskTolerance, "공격·방어 성향이 요청 body에 보존되지 않았습니다.");
    check(firstRequest?.selection?.mode === selectionMode, "종목 선택 방식이 nested selection에 보존되지 않았습니다.");
    if (selectionMode === "auto") {
      check(firstRequest.selection.symbolCount === requestedSymbolCount, "자동 선정 종목 수가 nested selection에 보존되지 않았습니다.");
      check(firstRequest.selection.criterion === "volatility", "자동 선정 기준이 nested selection에 보존되지 않았습니다.");
    } else {
      check(
        JSON.stringify(firstRequest.selection.symbols) === JSON.stringify(["SIM1"]),
        "직접 선택 종목이 nested selection에 보존되지 않았습니다.",
      );
    }
    check(!("symbolCount" in firstRequest), "legacy top-level symbolCount가 요청 body에 남아 있습니다.");
    check(!("criterion" in firstRequest), "legacy top-level criterion이 요청 body에 남아 있습니다.");

    await stopButton.click();
    await page.locator("[data-simulation-run]").getByText("취소됨", { exact: true }).waitFor({ timeout: 10_000 });
    check(
      state.cancels.length === cancelsBeforeStock + 1,
      "준비 단계 테스트 중단이 정확히 한 번 호출되지 않았습니다.",
    );

    await startButton.waitFor();
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((item) => item.textContent?.includes("AI 시뮬레이션 시작"));
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await startButton.click();
    await page.locator("[data-simulation-run]").getByText("가상 원장을 준비하고 있습니다.", { exact: true }).waitFor({ timeout: 10_000 });
    check(
      state.starts.length === startsBeforeStock + 2,
      "준비 단계 중단 후 새 테스트를 다시 시작하지 못했습니다.",
    );
    check(
      JSON.stringify(state.starts[startsBeforeStock + 1]) === JSON.stringify(firstRequest),
      "중단 후 재시작하면서 v3 설정 요청이 달라졌습니다.",
    );

    await page.locator("[data-simulation-run]").getByText("시뮬레이션 진행", { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByText("새 확정 1분봉 즉시", { exact: false }).waitFor({ timeout: 10_000 });
    await page.locator("[data-simulation-selected] article").first().waitFor();
    await page.locator("[data-simulation-selected-live-price]").first().waitFor();
    const selectedCount = await page.locator("[data-simulation-selected] article").count();
    check(
      selectedCount === requestedSymbolCount,
      `${viewport.width}px에서 AI 선택 종목이 ${requestedSymbolCount}개가 아니라 ${selectedCount}개입니다.`,
    );
    check(
      requestedSymbolCount === 1 || requestedSymbolCount === 2,
      "AI 선택 수는 1개 또는 2개여야 합니다.",
    );
    if (selectionMode === "manual") {
      await page.getByRole("heading", { name: "직접 선택 종목", exact: true }).waitFor();
    } else {
      await page.getByRole("heading", { name: "AI 선정 종목", exact: true }).waitFor();
    }
    const currentRunPanel = page.locator("[data-simulation-run]");
    await currentRunPanel.getByText("SIM1 · 가상 매수", { exact: true }).first().waitFor();
    await currentRunPanel.getByText("positive_risk_adjusted_score · entry_probability_threshold", { exact: true }).waitFor();
    await currentRunPanel.getByText(/next_valid_quote/).first().waitFor();
    check(state.streams >= 1, "시작 후 simulation SSE를 열지 않았습니다.");
    check(state.polls === 0, "정상 simulation SSE 중 run GET polling이 발생했습니다.");
    const streamStatsBeforeHidden = await page.evaluate(
      () => ({ ...window.__simulationEventSourceStats }),
    );
    await page.evaluate(() => window.__setSimulationFixtureVisibility("hidden"));
    await page.waitForFunction(
      (before) => window.__simulationEventSourceStats.closed > before.closed,
      streamStatsBeforeHidden,
    );
    const streamsWhileHidden = state.streams;
    await page.waitForTimeout(1_100);
    check(
      state.streams === streamsWhileHidden && state.polls === 0,
      "hidden tab에서 simulation 요청이 반복됐습니다.",
    );
    await page.evaluate(() => window.__setSimulationFixtureVisibility("visible"));
    await page.waitForFunction(
      (before) => window.__simulationEventSourceStats.opened > before.opened,
      streamStatsBeforeHidden,
    );
    await page.waitForTimeout(50);
    check(state.streams > streamsWhileHidden, "visible 복귀 후 simulation SSE를 재연결하지 않았습니다.");

    const chartGrid = page.locator("[data-simulation-charts]");
    await chartGrid.waitFor();
    const chartCount = await chartGrid.locator("[data-ai-simulation-chart]").count();
    check(
      chartCount === requestedSymbolCount,
      `시뮬레이션 캔들 차트가 ${requestedSymbolCount}개가 아니라 ${chartCount}개입니다.`,
    );
    await chartGrid.locator("[data-ai-simulation-price-chart]").first().waitFor();
    await chartGrid.locator('[data-ai-simulation-indicator-badge="rsi"]').first().waitFor();
    await chartGrid.locator('[data-ai-simulation-price-overlay="trend-ema:value"]').first().waitFor();
    await chartGrid.locator('[data-ai-simulation-pattern="bullish"]').first().waitFor();
    await chartGrid.locator(
      '[data-ai-simulation-trade-marker="buy"][data-ai-simulation-trade-color="red"]',
    ).first().waitFor();
    await chartGrid.locator(
      '[data-ai-simulation-trade-marker="sell"][data-ai-simulation-trade-color="blue"]',
    ).first().waitFor();
    const liveForecastOverlays = chartGrid.locator("[data-ai-simulation-model-forecast-overlay]");
    await liveForecastOverlays.first().waitFor();
    await chartGrid.locator(
      '[data-ai-simulation-model-forecast="chronos2"][data-ai-simulation-model-forecast-origin="exact-final"]',
    ).first().waitFor();
    for (const horizon of [5, 15, 30, 60]) {
      await chartGrid.locator(
        `[data-ai-simulation-model-forecast-horizon="chronos2:${horizon}"]`,
      ).waitFor();
    }
    const firstChartSeriesColors = await chartGrid.locator("[data-ai-simulation-chart]").first().evaluate((chart) => {
      const bySeries = new Map();
      for (const node of chart.querySelectorAll(
        "[data-ai-simulation-price-overlay-line], [data-ai-simulation-forecast-line]",
      )) {
        const key = node.getAttribute("data-ai-simulation-price-overlay-line")
          ?? node.getAttribute("data-ai-simulation-forecast-line");
        if (key) bySeries.set(key, getComputedStyle(node).stroke);
      }
      return [...bySeries.entries()];
    });
    check(firstChartSeriesColors.length >= 3, `일반 overlay와 모델 예측선 색상 검증 대상이 부족합니다: ${JSON.stringify(firstChartSeriesColors)}`);
    check(new Set(firstChartSeriesColors.map(([, color]) => color)).size === firstChartSeriesColors.length, `일반 overlay와 모델 예측선 색상이 충돌합니다: ${JSON.stringify(firstChartSeriesColors)}`);
    const liveForecastCount = await liveForecastOverlays.count();
    check(liveForecastCount === 1, `인라인 모델 예측 overlay가 1개가 아니라 ${liveForecastCount}개입니다.`);
    await mkdir(screenshotDirectory, { recursive: true });
    inlineForecastScreenshot = path.join(
      screenshotDirectory,
      `${viewport.width}x${viewport.height}-${theme}-inline-forecast.png`,
    );
    await page.mouse.move(0, 0);
    await chartGrid.locator("[data-ai-simulation-chart]").first().screenshot({
      path: inlineForecastScreenshot,
      animations: "disabled",
    });

    const scrollMetrics = {};
    for (const [name, selector] of [
      ["trades", "[data-simulation-trades-scroll]"],
      ["decisions", "[data-simulation-decisions-scroll]"],
    ]) {
      const scrollArea = page.locator(selector);
      await scrollArea.waitFor();
      const before = await scrollArea.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      }));
      check(
        before.scrollHeight > before.clientHeight,
        `${name} 기록이 페이지를 늘리는 대신 내부 스크롤 영역을 만들지 않았습니다: ${JSON.stringify(before)}`,
      );
      await scrollArea.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const after = await scrollArea.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      }));
      check(after.scrollTop > 0, `${name} 기록 내부 스크롤이 동작하지 않습니다.`);
      scrollMetrics[name] = after;
    }

    const measured = await page.locator([
      "[data-simulation-run]",
      "[data-simulation-selected]",
      "[data-simulation-positions]",
      "[data-simulation-charts]",
      "[data-ai-simulation-model-forecast-overlay]",
      "[data-simulation-trades]",
      "[data-simulation-decisions]",
    ].join(",")).evaluateAll((items) => items.map((item) => ({
      marker: Array.from(item.attributes).find((attribute) => attribute.name.startsWith("data-simulation"))?.name,
      width: item.getBoundingClientRect().width,
      height: item.getBoundingClientRect().height,
    })));
    const zeroSize = measured.filter(({ width, height }) => width <= 0 || height <= 0);
    check(zeroSize.length === 0, `${viewport.width}px에서 zero-size 시뮬레이션 요소가 있습니다: ${JSON.stringify(zeroSize)}`);

    const overflow = await page.evaluate(() => Math.max(
      0,
      document.documentElement.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
    ));
    check(overflow === 0, `${viewport.width}px에서 가로 overflow ${overflow}px`);

    await page.getByRole("button", { name: "테스트 중단", exact: true }).click();
    await page.locator("[data-simulation-run]").getByText("취소됨", { exact: true }).waitFor({ timeout: 10_000 });
    check(
      state.cancels.length === cancelsBeforeStock + 2,
      "각 주식 테스트 중단이 정확히 한 번씩 cancel API를 호출하지 않았습니다.",
    );
    }

    const startsBeforeEtf = state.starts.length;
    const cancelsBeforeEtf = state.cancels.length;
    await assetClassControl.getByRole("tab", { name: /미국 ETF 페어/ }).click();
    await page.getByText("실주문 없음, 투자 지시 아님, 다음 유효 체결만.", { exact: true }).waitFor();
    await page.locator('[data-model-role="primary"]').filter({ hasText: "Chronos-2" }).waitFor();
    await page.locator('[data-model-role="shadow"]').filter({ hasText: "FinCast" }).waitFor();
    const etfPairSelect = page.getByRole("combobox", { name: "미국 페어 카탈로그" });
    await etfPairSelect.waitFor();
    await etfPairSelect.click();
    for (const label of [
      "QQQ → TQQQ / SQQQ",
      "SMH/반도체 · SOXX → SOXL / SOXS",
      "SPY → SPXL / SPXS",
    ]) {
      await page.getByRole("option", { name: label, exact: true }).waitFor();
    }
    await page.getByRole("option", { name: "SPY → SPXL / SPXS", exact: true }).click();
    const spyMapping = page.locator('[data-etf-pair-mapping="spy-spxl-spxs"]');
    await spyMapping.waitFor();
    await spyMapping.getByText(/SPY \/ SPY/).waitFor();
    await spyMapping.getByText(/SPXL \/ SPXS/).waitFor();
    const etfStartButton = page.getByRole("button", {
      name: "AI 시뮬레이션 시작",
      exact: true,
    });
    await etfStartButton.click();
    await page.locator("[data-simulation-run]")
      .getByText("시뮬레이션 진행", { exact: true })
      .waitFor({ timeout: 10_000 });
    check(state.starts.length === startsBeforeEtf + 1, "ETF 시작이 정확히 한 run을 만들지 않았습니다.");
    const etfRequest = state.starts.at(-1);
    check(etfRequest?.contractVersion === "ai-paper-simulation/v9", "ETF 요청이 v9이 아닙니다.");
    check(etfRequest?.simulationCase === "us_etf_pair", "ETF simulationCase가 누락됐습니다.");
    check(etfRequest?.strategy?.pairId === "spy-spxl-spxs", "SPY 페어 선택이 payload에 없습니다.");
    check(!("modelLanes" in etfRequest), "ETF 요청에 서버 소유 modelLanes가 포함됐습니다.");
    check(!("modelPlan" in etfRequest), "ETF 요청에 서버 소유 modelPlan이 포함됐습니다.");
    const pairChartGrid = page.locator(
      '[data-simulation-charts][data-simulation-chart-layout="pair-primary-full-width"]',
    );
    await pairChartGrid.waitFor();
    const pairCharts = pairChartGrid.locator("[data-ai-simulation-chart]");
    chartCount = await pairCharts.count();
    selectedCount = await page.locator("[data-simulation-selected] article").count();
    check(chartCount === 3, "SPY 페어 차트가 3개가 아닙니다.");
    const pairChartSymbols = await pairCharts.evaluateAll((charts) => charts.map(
      (chart) => chart.getAttribute("data-ai-simulation-chart"),
    ));
    check(
      JSON.stringify(pairChartSymbols) === JSON.stringify(["SPY", "SPXL", "SPXS"]),
      `SPY model target과 execution leg 차트 순서가 다릅니다: ${JSON.stringify(pairChartSymbols)}`,
    );
    pairLayoutScreenshot = path.join(
      screenshotDirectory,
      `${viewport.width}x${viewport.height}-${theme}-pair-layout.png`,
    );
    await pairChartGrid.screenshot({ path: pairLayoutScreenshot, animations: "disabled" });
    const scrollSelectors = [
      ["trades", "[data-simulation-trades-scroll]"],
      ["decisions", "[data-simulation-decisions-scroll]"],
    ];
    for (const [name, selector] of scrollSelectors) {
      const area = page.locator(selector);
      await area.waitFor();
      scrollMetrics[name] = await area.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        tabIndex: element.tabIndex,
      }));
    }
    zeroSize = await page.locator([
      "[data-simulation-run]",
      "[data-simulation-selected]",
      "[data-simulation-charts]",
      "[data-simulation-trades]",
      "[data-simulation-decisions]",
    ].join(",")).evaluateAll((items) => items.map((item) => ({
      marker: Array.from(item.attributes)
        .find((attribute) => attribute.name.startsWith("data-simulation"))?.name,
      width: item.getBoundingClientRect().width,
      height: item.getBoundingClientRect().height,
    })).filter(({ width, height }) => width <= 0 || height <= 0));
    overflow = await page.evaluate(() => Math.max(
      0,
      document.documentElement.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
    ));
    check(zeroSize.length === 0, `ETF 화면에 zero-size 결과 요소가 있습니다: ${JSON.stringify(zeroSize)}`);
    check(overflow === 0, `${viewport.width}px ETF 화면 가로 overflow ${overflow}px`);
    await page.getByRole("button", { name: "테스트 중단", exact: true }).click();
    await page.locator("[data-simulation-run]")
      .getByText("취소됨", { exact: true })
      .waitFor({ timeout: 10_000 });
    check(state.cancels.length === cancelsBeforeEtf + 1, "ETF cancel API가 정확히 한 번 호출되지 않았습니다.");
    check(state.polls === 0, "terminal event 이후 run GET polling이 발생했습니다.");
    check(state.terminalStreams >= 1, "cancel terminal SSE가 전달되지 않았습니다.");
    check(
      Object.values(errors).every((items) => items.length === 0),
      `브라우저 오류: ${JSON.stringify(errors)}`,
    );

    await page.evaluate(() => window.scrollTo(0, 0));
    await mkdir(screenshotDirectory, { recursive: true });
    const screenshot = path.join(
      screenshotDirectory,
      `${viewport.width}x${viewport.height}-${theme}.png`,
    );
    await page.screenshot({ path: screenshot, animations: "disabled" });
    return {
      viewport: `${viewport.width}x${viewport.height}`,
      theme,
      manualStart: true,
      preparationStop: true,
      selectionMode,
      requestedSymbolCount,
      requestedRiskTolerance,
      selectedCount,
      chartCount,
      liveForecastCount,
      historyScrollMetrics,
      historyRequests: state.historyRequests,
      reportRequests: state.reportRequests,
      scrollMetrics,
      polls: state.polls,
      streams: state.streams,
      terminalStreams: state.terminalStreams,
      cancels: state.cancels.length,
      zeroSize: zeroSize.length,
      overflow,
      errors,
      cryptoSetupScreenshot,
      cryptoResultScreenshot,
      pairLayoutScreenshot,
      inlineForecastScreenshot,
      screenshot,
    };
  } finally {
    await context.close();
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address && typeof address === "object", "포트를 할당하지 못했습니다.");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 다음 후보를 확인한다.
    }
  }
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite preview 조기 종료\n${output.join("")}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // 준비될 때까지 대기한다.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite preview 준비 시간 초과\n${output.join("")}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let preview;
  let browser;
  try {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  preview = spawn(
    process.execPath,
    [
      path.join(projectRoot, "node_modules/vite/bin/vite.js"),
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  preview.stdout.on("data", (chunk) => output.push(chunk.toString()));
  preview.stderr.on("data", (chunk) => output.push(chunk.toString()));
  await waitForServer(baseUrl, preview, output);
  const executablePath = await firstExecutable([
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
  ]);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const results = [
    await verify(browser, baseUrl, { width: 1440, height: 1000 }, "dark"),
    await verify(browser, baseUrl, { width: 1920, height: 1080 }, "dark"),
    await verify(browser, baseUrl, { width: 390, height: 844 }, "light"),
  ];
  console.info(JSON.stringify({ ok: true, results }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    await stop(preview);
  }
}
