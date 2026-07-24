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

function kronosBaseForecastOutput(symbol, origin, basePrice) {
  const quantiles = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];
  const offsets = [-0.012, -0.008, -0.003, 0.004, 0.009, 0.015, 0.02];
  return {
    status: "available",
    signalSymbol: symbol,
    inputEndAt: origin,
    generatedAt: new Date(Date.parse(origin) + 320).toISOString(),
    provenance: {
      modelId: "NeoQuasar/Kronos-base",
      modelRevision: "ui-fixture",
      device: "cuda:0",
      deviceName: "Tesla P40",
    },
    rawOutput: {
      role: "kronos_base",
      expected_model_id: "NeoQuasar/Kronos-base",
      status: "available",
      model: {
        model_id: "NeoQuasar/Kronos-base",
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
  const active = phase !== "selecting" && !cancelled;
  const bars = Array.from({ length: 24 }, (_, index) => {
    const open = 67_000 + index * 18;
    const close = open + (index % 3 === 0 ? -32 : 44);
    return {
      timestamp: new Date(Date.parse("2026-07-24T00:00:00.000Z") + index * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + 25,
      low: Math.min(open, close) - 25,
      close,
      volume: 180 + index * 2,
      status: "final",
      indicatorValues: {},
    };
  });
  return {
    phase,
    startedAt: "2026-07-24T00:20:00.000Z",
    expiresAt: "2026-07-24T02:20:00.000Z",
    market: request.market,
    currency: "USDT",
    initialCash: request.initialCash,
    cash: active ? request.initialCash - 670 : request.initialCash,
    equity: cancelled ? request.initialCash + 12 : request.initialCash + 31.5,
    progress: cancelled ? 1 : phase === "selecting" ? 0.05 : 0.42,
    selection: request.selection,
    criterion: request.selection.criterion,
    preset: request.preset,
    riskTolerance: request.riskTolerance,
    selected: active ? [{
      symbol: "BTCUSDT",
      name: "Bitcoin perpetual",
      score: 0.91,
      upProbability: 0.68,
      predictedMedianReturn: 0.004,
      currentPrice: 67_418,
      priceObservedAt: "2026-07-24T00:23:12.345Z",
      model: { modelId: "NeoQuasar/Kronos-base", modelRevision: "ui-fixture", device: "cuda:0" },
    }] : [],
    positions: [],
    futuresPositions: active ? [{
      symbol: "BTCUSDT",
      side: "long",
      marginMode: "isolated",
      quantity: 0.015,
      leverage: 5,
      entryPrice: 67_100,
      markPrice: 67_418,
      notional: 1_011.27,
      initialMargin: 202.25,
      maintenanceMargin: 5.1,
      liquidationPrice: 54_190,
      liquidationBufferRatio: 0.196,
      protectiveStopPrice: 66_510,
      realizedPnl: 0,
      unrealizedPnl: 4.77,
      funding: -0.12,
      fees: 0.81,
      slippage: 0.2,
    }] : [],
    futuresRisk: {
      dailyLossRatio: -0.0012,
      dailyLossLimitRatio: 0.03,
      newEntriesBlocked: false,
      grossExposureRatio: 0.101,
      marginUsageRatio: 0.0202,
      riskPerTradeRatio: 0.005,
    },
    charts: active ? [{
      symbol: "BTCUSDT",
      name: "Bitcoin perpetual",
      currency: "USDT",
      bars,
      indicators: [],
      patterns: [],
      updatedAt: bars.at(-1).timestamp,
    }] : [],
    trades: active ? [{
      symbol: "BTCUSDT",
      side: "buy",
      positionSide: "long",
      reduceOnly: false,
      executedAt: "2026-07-24T00:10:15.000Z",
      signalEligibleAfter: "2026-07-24T00:10:00.000Z",
      price: 67_100,
      quantity: 0.015,
      amount: 1_006.5,
      cost: 0.6,
      totalCosts: 0.6,
      source: "next_valid_agg_trade",
    }] : [],
    decisions: active ? [{
      symbol: "BTCUSDT",
      action: "buy",
      direction: "long",
      decidedAt: "2026-07-24T00:10:00.000Z",
      eligibleAfter: "2026-07-24T00:10:00.001Z",
      reason: "quantile_cost_threshold · protected_liquidation_buffer",
      score: 0.91,
      upProbability: 0.68,
      chartPatterns: [],
      model: "NeoQuasar/Kronos-base · ui-fixture",
    }] : [],
    warnings: ["UI fixture · realOrder false"],
    capabilities: { realOrder: false, nextValidFillOnly: true },
    modelLanes: request.modelLanes,
    executionMode: "paper",
    modelComparison: {
      comparisonId: "ui-crypto-comparison",
      outcome: "inconclusive",
      sameOrigin: true,
      sameContext: true,
      sameCosts: true,
      sameFillBarrier: true,
      symbol: "BTCUSDT",
      lanes: request.modelLanes.map((id) => ({
        id,
        status: "completed",
        precision: id === "fincast" ? "fp16" : "fp32",
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
          peakVramMb: id === "fincast" ? 4_920 : 3_860,
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
  const symbols = request.selection.mode === "manual"
    ? request.selection.symbols
    : Array.from(
        { length: request.selection.symbolCount },
        (_, index) => index === 0 ? "SIM1" : "SIM2",
      );
  const selected = symbols.map((symbol, index) => ({
    symbol,
    name: index === 0 ? "가상 성장주" : "가상 모멘텀주",
    score: 0.81 - index * 0.08,
    upProbability: 0.64 - index * 0.03,
    predictedMedianReturn: 0.006 - index * 0.001,
    currentPrice: 50_600 + index * 100,
    priceObservedAt: "2026-07-24T00:23:12.345Z",
    model: {
      modelId: "NeoQuasar/Kronos-base",
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
      model: "NeoQuasar/Kronos-base · ui-fixture",
      ...(index === 0 ? {
        signalSymbol: decisionSymbol,
        modelOutputs: {
          kronos: kronosBaseForecastOutput(decisionSymbol, decidedAt, 50_220),
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
  return {
    phase,
    startedAt: "2026-07-24T00:20:00.000Z",
    expiresAt: "2026-07-24T01:05:00.000Z",
    marketCountry: "KR",
    currency: "KRW",
    initialCash: 2_500_000,
    cash: 1_482_000,
    equity: cancelled ? 2_525_000 : 2_536_000,
    progress: cancelled ? 1 : phase === "selecting" ? 0.05 : 0.42,
    selection: request.selection,
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
    marketCountry: "KR",
    initialCash: 2_500_000,
    durationMinutes: 45,
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
            kronosRustEnsemble: true,
            cryptoFutures: true,
          },
          cryptoFutures: {
            credentialsConfigured: true,
            signedReadSucceeded: true,
            executionGates: { paper: true, testnet: false, live: false },
            workers: {
              kronos_base: {
                lane: "kronos_base",
                status: "ready",
                available: true,
                modelId: "NeoQuasar/Kronos-base",
                precision: "fp32",
                latencyMs: 86,
              },
              fincast: {
                lane: "fincast",
                status: "ready",
                available: true,
                modelId: "Vincent05R/FinCast",
                precision: "fp16",
                latencyMs: 112,
              },
            },
          },
          pairStrategy: {
            enabled: true,
            catalogVersion: "scalping-pair-catalog/v2",
            pairs: [{
              pairId: "sndk-snxx-sndq",
              signalSymbol: "SNDK",
              bull: { executionSymbol: "SNXX", leverageMultiplier: 2 },
              bear: { executionSymbol: "SNDQ", leverageMultiplier: -2 },
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
          schemaVersion: "ai-paper-simulation/v7",
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
      state.active.set(runId, { body, cancelled: false });
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          runId,
          status: "running",
        }),
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
    await page.getByText("실주문 없음, 투자 지시 아님, 다음 유효 체결만.", { exact: true }).waitFor();
    const historyPanel = page.locator("[data-simulation-history]");
    await historyPanel.waitFor();
    await historyPanel.locator(`[data-simulation-history-item="${state.archivedRunId}"]`).waitFor();
    await historyPanel.locator(`[data-simulation-report="${state.archivedRunId}"]`).waitFor({ timeout: 10_000 });
    await historyPanel.getByText("실행 설정", { exact: true }).waitFor();
    await historyPanel.getByText("캔들·지표·패턴 근거", { exact: true }).waitFor();
    await historyPanel.locator("[data-ai-simulation-kronos-forecast-chart]").first().waitFor();
    await historyPanel.locator('[data-ai-simulation-kronos-origin-mark="exact-final"]').first().waitFor();
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
    check(state.starts.length === 0, "화면 진입만으로 시뮬레이션 run이 자동 시작됐습니다.");

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
    check(state.starts.length === 1, "시작 버튼 한 번에 정확히 하나의 run이 생성되지 않았습니다.");
    const firstRequest = state.starts[0];
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
    check(state.cancels.length === 1, "준비 단계 테스트 중단이 정확히 한 번 호출되지 않았습니다.");

    await startButton.waitFor();
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((item) => item.textContent?.includes("AI 시뮬레이션 시작"));
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await startButton.click();
    await page.locator("[data-simulation-run]").getByText("가상 원장을 준비하고 있습니다.", { exact: true }).waitFor({ timeout: 10_000 });
    check(state.starts.length === 2, "준비 단계 중단 후 새 테스트를 다시 시작하지 못했습니다.");
    check(
      JSON.stringify(state.starts[1]) === JSON.stringify(firstRequest),
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
    check(state.polls >= 1, "시작 후 run snapshot을 polling하지 않았습니다.");

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
    await chartGrid.locator('[data-ai-simulation-trade-marker="buy"]').first().waitFor();
    const liveForecastSection = currentRunPanel.locator("[data-ai-simulation-kronos-forecast-section]");
    await liveForecastSection.waitFor();
    await liveForecastSection.locator("[data-ai-simulation-kronos-forecast-chart]").first().waitFor();
    await liveForecastSection.locator('[data-ai-simulation-kronos-origin-mark="exact-final"]').first().waitFor();
    for (const horizon of [5, 15, 30, 60]) {
      await liveForecastSection.locator(`[data-ai-simulation-kronos-horizon="${horizon}"]`).waitFor();
    }
    const liveForecastCount = await liveForecastSection
      .locator("[data-ai-simulation-kronos-forecast-chart]")
      .count();
    check(liveForecastCount === 1, `Kronos-base 예측 그래프가 1개가 아니라 ${liveForecastCount}개입니다.`);

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
      "[data-ai-simulation-kronos-forecast-section]",
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
    check(state.cancels.length === 2, "각 테스트 중단이 정확히 한 번씩 cancel API를 호출하지 않았습니다.");
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
      cancels: state.cancels.length,
      zeroSize: zeroSize.length,
      overflow,
      errors,
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
