import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  HighVolatilityScannerSettingsSchema,
  type SimulationCase,
  type SimulationModelPlanEntry,
} from "../server/simulation/contracts.js";
import {
  runHistoricalSimulationBacktest,
  type HistoricalBacktestResult,
  type HistoricalDecisionOrigin,
} from "../server/simulation/historical-backtest.js";
import {
  scanHighVolatilityUniverse,
  type HighVolatilityCandidateObservation,
  type HighVolatilityScannerSnapshot,
} from "../server/simulation/high-volatility-scanner.js";
import {
  ModelEvidenceSchema,
  normalizeModelEvidence,
  type ModelEvidence,
} from "../server/simulation/model-evidence.js";
import {
  evaluateEtfSessionGate,
  fitPairReturnMapper,
  type PairReturnObservation,
} from "../server/simulation/pair-return-mapper.js";
import { getPairCatalogEntry } from "../server/simulation/pair-catalog.js";
import type { RustMarketEvidenceV2 } from "../server/simulation/technical-indicator-evidence.js";

const gzipAsync = promisify(gzip);
const RUN_SCHEMA_VERSION = "unified-simulation-backtest-run/v1" as const;
const STATUS_SCHEMA_VERSION = "unified-simulation-backtest-status/v1" as const;
const SEED = 20260728;
const FIVE_MINUTES_MS = 5 * 60_000;
const CHRONOS2_ID = "amazon/chronos-2";
const CHRONOS2_REVISION = "254b5357164a84326913b0695216f690752ac55d";
const FINCAST_ID = "Vincent05R/FinCast";
const FINCAST_REVISION = "2d7d90b159db8961d27c2cf165d51195902ef92b";
const COST_STRESS_MULTIPLIERS = [0.75, 1, 1.5, 2] as const;

type CliArguments = {
  simulationCase: SimulationCase | "all";
  runDirectory: string;
  resume: boolean;
  from: string;
  to: string;
  smoke: boolean;
  force: boolean;
};

type HistoricalBar = {
  symbol: string;
  openAt: string;
  closeAt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteAmount: number;
  tradeCount: number | null;
  takerBuyQuoteAmount: number | null;
  finalized: true;
  source: "binance_usdm_klines" | "yahoo_chart" | "deterministic_smoke";
};

type PredictionCache = {
  directory: string | null;
  evidence: Map<string, ModelEvidence[]>;
  fileHashes: Record<string, string>;
  rejectedRecords: number;
};

type ChunkWork = {
  id: string;
  simulationCase: SimulationCase;
  symbol: string;
  origins: HistoricalDecisionOrigin[];
  scannerSnapshots?: HighVolatilityScannerSnapshot[];
  dataHashes: Record<string, string>;
  dataRows: Record<string, number>;
  limitations: string[];
};

type Status = {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  state: "preparing" | "running" | "completed" | "failed";
  pid: number;
  command: string;
  startedAt: string;
  heartbeatAt: string;
  completedAt: string | null;
  completedChunks: number;
  totalChunks: number;
  currentCase: SimulationCase | null;
  currentSymbol: string | null;
  error: string | null;
  logPath: string;
  resultArtifactPath: string;
  configurationManifestPath: string;
  progressPath: string;
};

type ChunkSummary = {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  chunkId: string;
  simulationCase: SimulationCase;
  symbol: string;
  originCount: number;
  firstOriginAt: string | null;
  lastOriginAt: string | null;
  costScenarios: Array<{
    spreadSlippageMultiplier: number;
    lanes: HistoricalBacktestResult["lanes"];
    modelMetrics: HistoricalBacktestResult["modelMetrics"];
    scannerSelectionStability: number | null;
    throughputOriginsPerSecond: number;
  }>;
  evaluationSegments: Array<{
    id: "development" | "walk_forward_oos";
    classification: "development" | "chronological_oos_diagnostic";
    originCount: number;
    firstOriginAt: string | null;
    lastOriginAt: string | null;
    lanes: HistoricalBacktestResult["lanes"];
    modelMetrics: HistoricalBacktestResult["modelMetrics"];
    scannerSelectionStability: number | null;
  }>;
  detailArtifact: string;
  scannerArtifact: string | null;
  dataHashes: Record<string, string>;
  limitations: string[];
  completedAt: string;
};

const BTC_ETH_PLAN: SimulationModelPlanEntry[] = [
  { symbol: "BTCUSDT", modelLane: "chronos2", role: "primary", required: true, preferredHorizonsMinutes: [30, 60, 15] },
  { symbol: "BTCUSDT", modelLane: "fincast", role: "veto", required: true, preferredHorizonsMinutes: [30, 60, 15] },
  { symbol: "ETHUSDT", modelLane: "fincast", role: "primary", required: true, preferredHorizonsMinutes: [15, 30, 60] },
  { symbol: "ETHUSDT", modelLane: "chronos2", role: "shadow", required: false, preferredHorizonsMinutes: [15, 30, 60] },
];
const HIGH_VOL_PLAN: SimulationModelPlanEntry[] = [
  { symbol: "*", modelLane: "chronos2", role: "primary", required: true, preferredHorizonsMinutes: [15, 30, 60] },
  { symbol: "*", modelLane: "fincast", role: "veto", required: true, preferredHorizonsMinutes: [15, 30, 60] },
];
const ETF_PLAN: SimulationModelPlanEntry[] = [
  { symbol: "*", modelLane: "chronos2", role: "primary", required: true, preferredHorizonsMinutes: [15, 30, 60] },
  { symbol: "*", modelLane: "fincast", role: "shadow", required: false, preferredHorizonsMinutes: [15, 30, 60] },
];

const DEFAULT_SCANNER_SETTINGS = HighVolatilityScannerSettingsSchema.parse({
  symbolCount: 2,
  minimumListingDays: 90,
  minimumTradingAmountUsd: 25_000_000,
  maximumSpreadBps: 12,
  depthRangeBps: 10,
  minimumDepthUsd: 250_000,
  maximumMissingRate: 0.02,
  rescanIntervalMinutes: 30,
  riskAppetite: "balanced",
});

function isoDateArgument(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} must be YYYY-MM-DD.`);
  }
  return value;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const today = new Date();
  const defaultTo = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  )).toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.parse(`${defaultTo}T00:00:00Z`) - 28 * 86_400_000)
    .toISOString().slice(0, 10);
  let simulationCase: CliArguments["simulationCase"] = "all";
  let runDirectory = path.resolve("data/simulation-backtests", `unified-${Date.now()}`);
  let resume = false;
  let from = defaultFrom;
  let to = defaultTo;
  let smoke = false;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    const value = argv[index + 1];
    if (name === "--case" && value) {
      if (!["btc_eth", "high_vol_crypto", "us_etf_pair", "all"].includes(value)) {
        throw new Error("--case must be btc_eth|high_vol_crypto|us_etf_pair|all.");
      }
      simulationCase = value as CliArguments["simulationCase"];
      index += 1;
    } else if (name === "--run-dir" && value) {
      runDirectory = path.resolve(value);
      index += 1;
    } else if (name === "--from" && value) {
      from = isoDateArgument(value, "--from");
      index += 1;
    } else if (name === "--to" && value) {
      to = isoDateArgument(value, "--to");
      index += 1;
    } else if (name === "--resume") {
      resume = true;
    } else if (name === "--smoke") {
      smoke = true;
    } else if (name === "--force") {
      force = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${name}`);
    }
  }
  if (Date.parse(`${to}T00:00:00Z`) <= Date.parse(`${from}T00:00:00Z`)) {
    throw new Error("--to must be after --from.");
  }
  return { simulationCase, runDirectory, resume, from, to, smoke, force };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(filePath: string, payload: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, payload);
  await rename(temporary, filePath);
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function finite(value: unknown, name: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`${name} must be finite.`);
  }
  return parsed;
}

function clamp(value: number, minimum = -1, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function average(values: readonly number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function percentile(values: readonly number[], probability: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * probability)]!;
}

function ema(values: readonly number[], period: number): number {
  if (!values.length) return 0;
  const alpha = 2 / (period + 1);
  return values.slice(1).reduce(
    (current, value) => current + alpha * (value - current),
    values[0]!,
  );
}

function modelKey(evidence: Pick<ModelEvidence, "symbol" | "originAt">): string {
  return `${evidence.symbol.toUpperCase()}|${evidence.originAt}`;
}

function expectedIdentity(evidence: ModelEvidence): boolean {
  if (evidence.modelLane === "chronos2") {
    return evidence.modelId === CHRONOS2_ID && evidence.modelRevision === CHRONOS2_REVISION;
  }
  if (evidence.modelLane === "fincast") {
    return evidence.modelId === FINCAST_ID && evidence.modelRevision === FINCAST_REVISION;
  }
  return true;
}

async function loadPredictionCache(): Promise<PredictionCache> {
  const configured = process.env.SIMULATION_PREDICTION_CACHE_DIR?.trim();
  if (!configured) {
    return { directory: null, evidence: new Map(), fileHashes: {}, rejectedRecords: 0 };
  }
  const directory = path.resolve(configured);
  const files = ["predictions.jsonl", "model-evidence.jsonl"];
  const evidence = new Map<string, ModelEvidence[]>();
  const fileHashes: Record<string, string> = {};
  let rejectedRecords = 0;
  for (const filename of files) {
    const filePath = path.join(directory, filename);
    if (!await exists(filePath)) continue;
    const payload = await readFile(filePath, "utf8");
    fileHashes[filePath] = sha256(payload);
    for (const line of payload.split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = ModelEvidenceSchema.parse(JSON.parse(line));
        if (!expectedIdentity(parsed) || parsed.inputOrigin !== "prediction_cache") {
          rejectedRecords += 1;
          continue;
        }
        const key = modelKey(parsed);
        const records = evidence.get(key) ?? [];
        records.push(parsed);
        evidence.set(key, records);
      } catch {
        rejectedRecords += 1;
      }
    }
  }
  return { directory, evidence, fileHashes, rejectedRecords };
}

function deterministicEvidence(
  simulationCase: SimulationCase,
  symbol: string,
  originAt: string,
  modelPlan: readonly SimulationModelPlanEntry[],
): ModelEvidence[] {
  const costs = simulationCase === "us_etf_pair"
    ? { commissionBps: 2, spreadBps: 3, slippageBps: 2, fundingBps: 0, safetyMarginBps: 2 }
    : { commissionBps: 4, spreadBps: 3, slippageBps: 3, fundingBps: 1, safetyMarginBps: 2 };
  return modelPlan
    .filter((plan) => plan.symbol === "*" || plan.symbol === symbol)
    .flatMap((plan) => (plan.preferredHorizonsMinutes ?? [15, 30]).slice(0, 2).map(
      (horizonMinutes) => {
        const primaryLike = plan.role !== "veto";
        const center = primaryLike ? 0.006 : 0.003;
        const laneIdentity = plan.modelLane === "chronos2"
          ? { modelId: CHRONOS2_ID, modelRevision: CHRONOS2_REVISION }
          : { modelId: FINCAST_ID, modelRevision: FINCAST_REVISION };
        return normalizeModelEvidence({
          modelLane: plan.modelLane,
          ...laneIdentity,
          role: plan.role,
          symbol,
          originAt,
          horizonMinutes,
          quantiles: plan.modelLane === "chronos2"
            ? {
                0.01: -0.025,
                0.05: -0.015,
                0.1: -0.009,
                0.5: center,
                0.9: 0.021,
                0.95: 0.029,
                0.99: 0.045,
              }
            : { 0.1: -0.008, 0.5: center, 0.9: 0.02 },
          calibrationId: `${plan.modelLane}:${symbol}:${horizonMinutes}m:smoke`,
          calibrationStatus: "ready",
          calibrationAge: 20,
          featureProfile: "compact_causal_v1",
          dataQuality: {
            status: "ok",
            finalizedOnly: true,
            stale: false,
            missingRate: 0,
            unavailableFeatures: [],
            warnings: ["DETERMINISTIC_TEST_ADAPTER"],
          },
          generatedAt: originAt,
          latencyMs: 1,
          inputOrigin: "deterministic_test",
          costs,
        });
      },
    ));
}

function smokeBars(symbol: string, market: "crypto" | "etf"): HistoricalBar[] {
  const count = 300;
  const start = market === "etf"
    ? Date.UTC(2026, 6, 6, 13, 30)
    : Date.UTC(2026, 6, 6, 0, 0);
  const base = [...symbol].reduce((sum, value) => sum + value.charCodeAt(0), 0);
  return Array.from({ length: count }, (_, index) => {
    const openAt = market === "etf"
      ? start + Math.floor(index / 78) * 86_400_000 + (index % 78) * FIVE_MINUTES_MS
      : start + index * FIVE_MINUTES_MS;
    const trend = index * (0.00008 + (base % 7) * 0.00001);
    const wave = Math.sin((index + base) * 0.13) * 0.004;
    const close = (50 + base % 500) * (1 + trend + wave);
    const priorWave = Math.sin((index - 1 + base) * 0.13) * 0.004;
    const open = (50 + base % 500) * (1 + Math.max(0, index - 1) * (0.00008 + (base % 7) * 0.00001) + priorWave);
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    const volume = 1_000_000 + (index % 23) * 50_000;
    return {
      symbol,
      openAt: new Date(openAt).toISOString(),
      closeAt: new Date(openAt + FIVE_MINUTES_MS - 1).toISOString(),
      open,
      high,
      low,
      close,
      volume,
      quoteAmount: volume * close,
      tradeCount: 10_000 + index,
      takerBuyQuoteAmount: volume * close * (0.48 + (index % 5) * 0.01),
      finalized: true,
      source: "deterministic_smoke",
    };
  });
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "toss-portfolio-lens-historical-backtest/1.0",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url.host} HTTP ${response.status}`);
  return response.json();
}

async function fetchBinanceBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<HistoricalBar[]> {
  const rows: HistoricalBar[] = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "5m");
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(toMs - 1));
    url.searchParams.set("limit", "1500");
    const payload = await fetchJson(url);
    if (!Array.isArray(payload) || payload.length === 0) break;
    let latest = cursor;
    for (const item of payload) {
      if (!Array.isArray(item) || item.length < 11) continue;
      const openAtMs = finite(item[0], "binance.openAt");
      const closeAtMs = finite(item[6], "binance.closeAt");
      if (closeAtMs >= Date.now()) continue;
      rows.push({
        symbol,
        openAt: new Date(openAtMs).toISOString(),
        closeAt: new Date(closeAtMs).toISOString(),
        open: finite(item[1], "binance.open"),
        high: finite(item[2], "binance.high"),
        low: finite(item[3], "binance.low"),
        close: finite(item[4], "binance.close"),
        volume: finite(item[5], "binance.volume"),
        quoteAmount: finite(item[7], "binance.quoteAmount"),
        tradeCount: finite(item[8], "binance.tradeCount"),
        takerBuyQuoteAmount: finite(item[10], "binance.takerBuyQuoteAmount"),
        finalized: true,
        source: "binance_usdm_klines",
      });
      latest = Math.max(latest, openAtMs + FIVE_MINUTES_MS);
    }
    if (latest <= cursor || payload.length < 1500) break;
    cursor = latest;
  }
  return rows;
}

async function fetchYahooBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<HistoricalBar[]> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
  url.searchParams.set("period1", String(Math.floor(fromMs / 1_000)));
  url.searchParams.set("period2", String(Math.floor(toMs / 1_000)));
  url.searchParams.set("interval", "5m");
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits");
  const payload = await fetchJson(url) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }> };
      }>;
    };
  };
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp || !quote) return [];
  return result.timestamp.flatMap((seconds, index): HistoricalBar[] => {
    const values = [
      quote.open?.[index],
      quote.high?.[index],
      quote.low?.[index],
      quote.close?.[index],
      quote.volume?.[index],
    ];
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return [];
    const [open, high, low, close, volume] = values as number[];
    const openAt = seconds * 1_000;
    if (openAt + FIVE_MINUTES_MS > Date.now()) return [];
    return [{
      symbol,
      openAt: new Date(openAt).toISOString(),
      closeAt: new Date(openAt + FIVE_MINUTES_MS - 1).toISOString(),
      open,
      high,
      low,
      close,
      volume,
      quoteAmount: volume * close,
      tradeCount: null,
      takerBuyQuoteAmount: null,
      finalized: true,
      source: "yahoo_chart",
    }];
  });
}

async function loadBars(
  arguments_: CliArguments,
  symbol: string,
  market: "crypto" | "etf",
): Promise<{ bars: HistoricalBar[]; hash: string; path: string }> {
  const safeSymbol = symbol.replace(/[^A-Z0-9._-]/gi, "_");
  const filePath = path.join(
    arguments_.runDirectory,
    "inputs",
    `${market}-${safeSymbol}-${arguments_.from}-${arguments_.to}.json`,
  );
  if (arguments_.resume && await exists(filePath)) {
    const payload = await readFile(filePath, "utf8");
    return { bars: JSON.parse(payload) as HistoricalBar[], hash: sha256(payload), path: filePath };
  }
  const fromMs = Date.parse(`${arguments_.from}T00:00:00Z`);
  const toMs = Date.parse(`${arguments_.to}T00:00:00Z`);
  const bars = arguments_.smoke
    ? smokeBars(symbol, market)
    : market === "crypto"
      ? await fetchBinanceBars(symbol, fromMs, toMs)
      : await fetchYahooBars(symbol, fromMs, toMs);
  if (bars.length < 80) {
    throw new Error(`${symbol} has insufficient finalized 5-minute bars (${bars.length}).`);
  }
  const payload = `${JSON.stringify(bars)}\n`;
  await atomicWrite(filePath, payload);
  return { bars, hash: sha256(payload), path: filePath };
}

function barWindow(bars: readonly HistoricalBar[], index: number, size: number): HistoricalBar[] {
  return bars.slice(Math.max(0, index - size + 1), index + 1);
}

function causalRustEvidence(
  bars: readonly HistoricalBar[],
  index: number,
  smoke: boolean,
): RustMarketEvidenceV2 {
  const bar = bars[index]!;
  const window = barWindow(bars, index, 64);
  const closes = window.map((item) => item.close);
  const returns = closes.slice(1).map((value, row) => Math.log(value / closes[row]!));
  const ema9 = ema(closes.slice(-36), 9);
  const ema21 = ema(closes.slice(-64), 21);
  const trueRanges = window.slice(1).map((item, row) => Math.max(
    item.high - item.low,
    Math.abs(item.high - window[row]!.close),
    Math.abs(item.low - window[row]!.close),
  ));
  const atr = average(trueRanges.slice(-14));
  const normalizedAtr = atr / Math.max(bar.close, Number.EPSILON);
  const realizedVolatility = Math.sqrt(
    returns.slice(-12).reduce((sum, value) => sum + value ** 2, 0),
  );
  const recent20 = window.slice(-20);
  const meanClose = average(recent20.map((item) => item.close));
  const standardClose = Math.sqrt(average(recent20.map((item) => (item.close - meanClose) ** 2)));
  const width = meanClose > 0 ? 4 * standardClose / meanClose : 0;
  const previous20 = window.slice(-40, -20);
  const priorMean = average(previous20.map((item) => item.close));
  const priorStandard = Math.sqrt(average(previous20.map((item) => (item.close - priorMean) ** 2)));
  const priorWidth = priorMean > 0 ? 4 * priorStandard / priorMean : width;
  const bollingerWidthExpansion = priorWidth > 0 ? width / priorWidth - 1 : 0;
  const volumes = window.slice(-20).map((item) => item.volume);
  const relativeVolume = bar.volume / Math.max(average(volumes.slice(0, -1)), 1);
  const donchian = window.slice(-21, -1);
  const donchianHigh = Math.max(...donchian.map((item) => item.high));
  const donchianLow = Math.min(...donchian.map((item) => item.low));
  const breakoutScore = bar.close > donchianHigh
    ? 1
    : bar.close < donchianLow ? -1 : 0;
  const trendScore = clamp((ema9 / Math.max(ema21, Number.EPSILON) - 1) / Math.max(normalizedAtr, 0.0001));
  const momentumScore = clamp(
    (bar.close / Math.max(window.at(-6)?.close ?? bar.close, Number.EPSILON) - 1)
      / Math.max(normalizedAtr * 2, 0.0001),
  );
  const chopRows = window.slice(-14);
  const chopRange = Math.max(...chopRows.map((item) => item.high))
    - Math.min(...chopRows.map((item) => item.low));
  const choppiness = chopRange > 0
    ? Math.max(0, 100 * Math.log10(
        trueRanges.slice(-14).reduce((sum, value) => sum + value, 0) / chopRange,
      ) / Math.log10(14))
    : 100;
  const dayRows = window.slice(-Math.min(64, window.length));
  const dayRangeRatio = (
    Math.max(...dayRows.map((item) => item.high))
    - Math.min(...dayRows.map((item) => item.low))
  ) / Math.max(bar.close, Number.EPSILON);
  const tradingAmount = window.slice(-Math.min(288, window.length))
    .reduce((sum, item) => sum + item.quoteAmount, 0);
  const sessionVwapDenominator = window.reduce((sum, item) => sum + item.volume, 0);
  const sessionVwap = sessionVwapDenominator > 0
    ? window.reduce((sum, item) => sum + item.close * item.volume, 0) / sessionVwapDenominator
    : null;
  const unavailableFields = smoke
    ? []
    : ["spreadBps", "orderbookDepth", "orderbookImbalance", "executionStrength", "quoteFreshnessMs"];
  return {
    schemaVersion: "rust-market-evidence/v2",
    trendScore,
    momentumScore,
    breakoutScore,
    choppiness,
    normalizedAtr,
    realizedVolatility,
    dayRangeRatio,
    bollingerWidthExpansion,
    relativeVolume,
    tradingAmount,
    spreadBps: smoke ? 2 : null,
    orderbookDepth: smoke ? 1_000_000 : null,
    orderbookImbalance: smoke ? 0.1 : null,
    executionStrength: smoke ? 0.6 : null,
    liquidityQuality: smoke ? 0.9 : 0,
    exitRisk: clamp(choppiness / 100, 0, 1),
    sessionVwap,
    openingRange5: window.at(-2)
      ? Math.abs(window.at(-2)!.high / window.at(-2)!.low - 1)
      : null,
    openingRange15: window.length >= 3
      ? Math.max(...window.slice(-3).map((item) => item.high))
        / Math.min(...window.slice(-3).map((item) => item.low)) - 1
      : null,
    openingRange30: window.length >= 6
      ? Math.max(...window.slice(-6).map((item) => item.high))
        / Math.min(...window.slice(-6).map((item) => item.low)) - 1
      : null,
    timeOfDayRelativeVolume: relativeVolume,
    benchmarkRelativeStrength: null,
    quoteFreshnessMs: smoke ? 0 : null,
    regime: choppiness < 45 ? "trending" : choppiness > 62 ? "choppy" : "balanced",
    passedGates: smoke ? ["FINALIZED_DATA", "LIQUIDITY", "QUOTE_FRESH"] : ["FINALIZED_DATA"],
    blockedGates: smoke ? [] : ["SPREAD_UNAVAILABLE", "ORDERBOOK_DEPTH_UNAVAILABLE"],
    unavailableFields,
    originAt: bar.closeAt,
    observedAt: bar.closeAt,
  };
}

function actualReturns(
  bars: readonly HistoricalBar[],
  index: number,
): Partial<Record<5 | 15 | 30 | 60, number>> {
  const result: Partial<Record<5 | 15 | 30 | 60, number>> = {};
  for (const horizon of [5, 15, 30, 60] as const) {
    const future = bars[index + horizon / 5];
    if (future) result[horizon] = future.close / bars[index]!.close - 1;
  }
  return result;
}

function baselineDirection(rust: RustMarketEvidenceV2, etf = false) {
  const score = average([rust.trendScore ?? 0, rust.momentumScore ?? 0]);
  if (Math.abs(score) < 0.08) return "cash" as const;
  if (etf) return score > 0 ? "bull" as const : "bear" as const;
  return score > 0 ? "long" as const : "short" as const;
}

function cachedEvidence(
  cache: PredictionCache,
  symbol: string,
  originAt: string,
  smoke: boolean,
  simulationCase: SimulationCase,
  modelPlan: readonly SimulationModelPlanEntry[],
): ModelEvidence[] {
  return smoke
    ? deterministicEvidence(simulationCase, symbol, originAt, modelPlan)
    : cache.evidence.get(`${symbol}|${originAt}`) ?? [];
}

function cryptoOrigins(
  simulationCase: "btc_eth" | "high_vol_crypto",
  symbol: string,
  bars: readonly HistoricalBar[],
  cache: PredictionCache,
  smoke: boolean,
  scannerByOrigin: ReadonlyMap<string, HighVolatilityScannerSnapshot> = new Map(),
): HistoricalDecisionOrigin[] {
  const modelPlan = simulationCase === "btc_eth" ? BTC_ETH_PLAN : HIGH_VOL_PLAN;
  const origins: HistoricalDecisionOrigin[] = [];
  for (let index = 64; index < bars.length - 13; index += 3) {
    const bar = bars[index]!;
    const fill = bars[index + 1]!;
    const rust = causalRustEvidence(bars, index, smoke);
    origins.push({
      originAt: bar.closeAt,
      fillAt: fill.openAt,
      signalSymbol: symbol,
      executionSymbols: { long: symbol, short: symbol },
      pricesAtFill: { [symbol]: fill.open },
      modelPlan,
      modelEvidence: cachedEvidence(cache, symbol, bar.closeAt, smoke, simulationCase, modelPlan),
      rustEvidence: rust,
      costs: { commissionBps: 4, spreadBps: 3, slippageBps: 3, fundingBps: 1, safetyMarginBps: 2 },
      baselineDirection: baselineDirection(rust),
      actualTargetReturns: actualReturns(bars, index),
      ...(simulationCase === "high_vol_crypto"
        ? { scannerSelectedSymbols: scannerByOrigin.get(bar.closeAt)?.selectedSymbols ?? [] }
        : {}),
      circuit: {
        missingData: !smoke,
        referenceSpreadBps: smoke ? 2 : undefined,
        referenceDepth: smoke ? 1_000_000 : undefined,
        realizedVolatilityBaseline: rust.realizedVolatility ?? undefined,
      },
    });
  }
  return origins;
}

function latestBarAt(
  bars: readonly HistoricalBar[],
  originMs: number,
): { bar: HistoricalBar; index: number } | undefined {
  let left = 0;
  let right = bars.length - 1;
  let found = -1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (Date.parse(bars[middle]!.closeAt) <= originMs) {
      found = middle;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return found >= 64 ? { bar: bars[found]!, index: found } : undefined;
}

function scannerObservation(
  symbol: string,
  bars: readonly HistoricalBar[],
  index: number,
  originAt: string,
  listingAt: string,
  smoke: boolean,
): HighVolatilityCandidateObservation {
  const bar = bars[index]!;
  const rust = causalRustEvidence(bars, index, smoke);
  const recent = barWindow(bars, index, 288);
  const expected = Math.max(1, Math.round(
    (Date.parse(recent.at(-1)!.openAt) - Date.parse(recent[0]!.openAt)) / FIVE_MINUTES_MS,
  ) + 1);
  const missingRate = Math.max(0, 1 - recent.length / expected);
  const closeValues = recent.map((item) => item.close);
  return {
    symbol,
    observedAt: bar.closeAt,
    listingAt,
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
    missingRate,
    tradingAmountUsd: recent.reduce((sum, item) => sum + item.quoteAmount, 0),
    tradeCount: recent.reduce((sum, item) => sum + (item.tradeCount ?? 0), 0),
    medianSpreadBps: smoke ? 2 : 0,
    p95SpreadBps: smoke ? 3 : 0,
    depthUsd: smoke ? 1_000_000 : 0,
    staleQuote: Date.parse(originAt) - Date.parse(bar.closeAt) > 10 * 60_000,
    abnormalGap: recent.slice(1).some((item, row) => (
      Math.abs(item.open / recent[row]!.close - 1) > 0.08
    )),
    halted: false,
    fundingRate: null,
    basisRate: null,
    realizedVolatility: rust.realizedVolatility ?? 0,
    normalizedAtr: rust.normalizedAtr ?? 0,
    rollingRange: Math.max(...closeValues) / Math.min(...closeValues) - 1,
    bollingerWidthExpansion: rust.bollingerWidthExpansion ?? 0,
    relativeVolume: rust.relativeVolume ?? 0,
    liquidityQuality: rust.liquidityQuality ?? 0,
    featureAvailability: {
      finalizedOhlcv: true,
      tradeCount: bar.tradeCount !== null,
      spread: smoke,
      spreadHistory: smoke,
      orderbookDepth: smoke,
      funding: false,
      basis: false,
      openInterest: false,
      longShortRatio: false,
      liquidationVolume: false,
    },
  };
}

function scannerSnapshots(
  barsBySymbol: ReadonlyMap<string, HistoricalBar[]>,
  listingAtBySymbol: ReadonlyMap<string, string>,
  smoke: boolean,
): {
  snapshots: HighVolatilityScannerSnapshot[];
  byOrigin: Map<string, HighVolatilityScannerSnapshot>;
} {
  const allOrigins = [...new Set(
    [...barsBySymbol.values()].flatMap((bars) => (
      bars.slice(64, -13).filter((_, index) => index % 6 === 0).map((bar) => bar.closeAt)
    )),
  )].sort();
  const snapshots: HighVolatilityScannerSnapshot[] = [];
  for (const originAt of allOrigins) {
    const originMs = Date.parse(originAt);
    const observations = [...barsBySymbol.entries()].flatMap(([symbol, bars]) => {
      const latest = latestBarAt(bars, originMs);
      return latest
        ? [scannerObservation(
            symbol,
            bars,
            latest.index,
            originAt,
            listingAtBySymbol.get(symbol) ?? new Date(originMs - 365 * 86_400_000).toISOString(),
            smoke,
          )]
        : [];
    });
    snapshots.push(scanHighVolatilityUniverse(observations, originAt, DEFAULT_SCANNER_SETTINGS));
  }
  const byOrigin = new Map<string, HighVolatilityScannerSnapshot>();
  let active: HighVolatilityScannerSnapshot | undefined;
  const decisionOrigins = [...new Set(
    [...barsBySymbol.values()].flatMap((bars) => (
      bars.slice(64, -13).filter((_, index) => index % 3 === 0).map((bar) => bar.closeAt)
    )),
  )].sort();
  let scanIndex = 0;
  for (const origin of decisionOrigins) {
    while (
      snapshots[scanIndex]
      && Date.parse(snapshots[scanIndex]!.originAt) <= Date.parse(origin)
    ) {
      active = snapshots[scanIndex];
      scanIndex += 1;
    }
    if (active) byOrigin.set(origin, active);
  }
  return { snapshots, byOrigin };
}

function newYorkSessionPosition(originAt: string): {
  marketCalendarStatus: "regular" | "closed" | "unknown";
  minutesFromOpen: number | null;
  minutesToClose: number | null;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(originAt));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const weekday = read("weekday");
  const hour = Number(read("hour"));
  const minute = Number(read("minute"));
  if (!weekday || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { marketCalendarStatus: "unknown", minutesFromOpen: null, minutesToClose: null };
  }
  if (weekday === "Sat" || weekday === "Sun") {
    return { marketCalendarStatus: "closed", minutesFromOpen: null, minutesToClose: null };
  }
  const minutes = hour * 60 + minute;
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  if (minutes < open || minutes >= close) {
    return { marketCalendarStatus: "closed", minutesFromOpen: null, minutesToClose: null };
  }
  return {
    marketCalendarStatus: "regular",
    minutesFromOpen: minutes - open,
    minutesToClose: close - minutes,
  };
}

function synchronizedIndex(
  bars: readonly HistoricalBar[],
): Map<string, HistoricalBar> {
  return new Map(bars.map((bar) => [bar.openAt, bar]));
}

function etfOrigins(
  pairId: "qqq-tqqq-sqqq" | "semiconductor-soxl-soxs" | "spy-spxl-spxs",
  barsBySymbol: ReadonlyMap<string, HistoricalBar[]>,
  cache: PredictionCache,
  smoke: boolean,
): HistoricalDecisionOrigin[] {
  const pair = getPairCatalogEntry(pairId);
  const target = barsBySymbol.get(pair.modelTargetSymbol)!;
  const maps = new Map(
    [...barsBySymbol.entries()].map(([symbol, bars]) => [symbol, synchronizedIndex(bars)]),
  );
  const mappingHistory: PairReturnObservation[] = [];
  const origins: HistoricalDecisionOrigin[] = [];
  for (let index = 64; index < target.length - 13; index += 3) {
    const bar = target[index]!;
    const nextAt = target[index + 1]!.openAt;
    const fillRows = Object.fromEntries(
      [...barsBySymbol.entries()].flatMap(([symbol]) => {
        const row = maps.get(symbol)?.get(nextAt);
        return row ? [[symbol, row.open] as const] : [];
      }),
    );
    if (
      !fillRows[pair.bull.executionSymbol]
      || !fillRows[pair.bear.executionSymbol]
    ) continue;
    const modelEvidence = cachedEvidence(
      cache,
      pair.modelTargetSymbol,
      bar.closeAt,
      smoke,
      "us_etf_pair",
      ETF_PLAN,
    );
    const primary = modelEvidence
      .filter((evidence) => evidence.role === "primary")
      .sort((left, right) => left.horizonMinutes - right.horizonMinutes)[0];
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(bar.closeAt));
    const pairMapping = primary
      ? fitPairReturnMapper({
          originAt: bar.closeAt,
          pair,
          targetQuantiles: {
            0.1: primary.q10Return,
            0.5: primary.q50Return,
            0.9: primary.q90Return,
          },
          targetExpectedReturn: primary.expectedReturn,
          history: mappingHistory,
          timeOfDayBucket: hour,
          volatilityRegime: "normal",
          bullCosts: { commissionBps: 2, spreadBps: 3, slippageBps: 2, fundingBps: 0, safetyMarginBps: 2 },
          bearCosts: { commissionBps: 2, spreadBps: 5, slippageBps: 3, fundingBps: 0, safetyMarginBps: 2 },
          minimumSamples: smoke ? 20 : 60,
        })
      : undefined;
    const sessionPosition = newYorkSessionPosition(bar.closeAt);
    const gate = evaluateEtfSessionGate({
      originAt: bar.closeAt,
      ...sessionPosition,
      quoteObservedAt: smoke ? bar.closeAt : null,
      quoteSpreadBps: smoke ? 2 : null,
      maximumSpreadBps: pair.maxSpreadBps,
      flattenBeforeClose: true,
    });
    const rust = causalRustEvidence(target, index, smoke);
    origins.push({
      originAt: bar.closeAt,
      fillAt: target[index + 1]!.openAt,
      signalSymbol: pair.modelTargetSymbol,
      executionSymbols: {
        long: pair.bull.executionSymbol,
        short: pair.bear.executionSymbol,
        bull: pair.bull.executionSymbol,
        bear: pair.bear.executionSymbol,
      },
      pricesAtFill: fillRows,
      modelPlan: ETF_PLAN,
      modelEvidence,
      rustEvidence: rust,
      costs: { commissionBps: 2, spreadBps: 4, slippageBps: 3, fundingBps: 0, safetyMarginBps: 2 },
      baselineDirection: baselineDirection(rust, true),
      pairMapping,
      etfSessionGate: gate,
      actualTargetReturns: actualReturns(target, index),
      circuit: { missingData: !smoke },
    });
    const previousTarget = target[index - 1];
    const bullNow = maps.get(pair.bull.executionSymbol)?.get(bar.openAt);
    const bullPrevious = previousTarget
      ? maps.get(pair.bull.executionSymbol)?.get(previousTarget.openAt)
      : undefined;
    const bearNow = maps.get(pair.bear.executionSymbol)?.get(bar.openAt);
    const bearPrevious = previousTarget
      ? maps.get(pair.bear.executionSymbol)?.get(previousTarget.openAt)
      : undefined;
    if (previousTarget && bullNow && bullPrevious && bearNow && bearPrevious) {
      mappingHistory.push({
        observedAt: previousTarget.closeAt,
        targetReturn: bar.close / previousTarget.close - 1,
        bullReturn: bullNow.close / bullPrevious.close - 1,
        bearReturn: bearNow.close / bearPrevious.close - 1,
        timeOfDayBucket: hour,
        volatilityRegime: "normal",
      });
    }
  }
  return origins;
}

async function currentHighVolUniverse(smoke: boolean): Promise<Array<{
  symbol: string;
  listingAt: string;
}>> {
  if (smoke) {
    return ["SOLUSDT", "DOGEUSDT", "XRPUSDT"].map((symbol) => ({
      symbol,
      listingAt: "2020-01-01T00:00:00.000Z",
    }));
  }
  const exchangeInfo = await fetchJson(
    new URL("https://fapi.binance.com/fapi/v1/exchangeInfo"),
  ) as { symbols?: Array<Record<string, unknown>> };
  const tickers = await fetchJson(
    new URL("https://fapi.binance.com/fapi/v1/ticker/24hr"),
  );
  const volumes = new Map(
    (Array.isArray(tickers) ? tickers : []).flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const source = row as Record<string, unknown>;
      return typeof source.symbol === "string"
        ? [[source.symbol, finite(source.quoteVolume ?? 0, "quoteVolume")] as const]
        : [];
    }),
  );
  return (exchangeInfo.symbols ?? [])
    .filter((source) => (
      source.quoteAsset === "USDT"
      && source.contractType === "PERPETUAL"
      && source.status === "TRADING"
      && typeof source.symbol === "string"
      && !["BTCUSDT", "ETHUSDT"].includes(source.symbol)
      && !/(USDC|BUSD|FDUSD|USDE|DAI|TUSD|USDP|USD1)USDT$/.test(source.symbol)
    ))
    .sort((left, right) => (
      (volumes.get(right.symbol as string) ?? 0)
      - (volumes.get(left.symbol as string) ?? 0)
    ))
    .slice(0, 12)
    .map((source) => ({
      symbol: source.symbol as string,
      listingAt: new Date(finite(source.onboardDate, "onboardDate")).toISOString(),
    }));
}

async function prepareChunks(
  arguments_: CliArguments,
  cache: PredictionCache,
  updateCurrent: (simulationCase: SimulationCase, symbol: string) => Promise<void>,
): Promise<ChunkWork[]> {
  const chunks: ChunkWork[] = [];
  const requested = arguments_.simulationCase === "all"
    ? ["btc_eth", "high_vol_crypto", "us_etf_pair"] as const
    : [arguments_.simulationCase];
  if (requested.includes("btc_eth")) {
    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      await updateCurrent("btc_eth", symbol);
      const loaded = await loadBars(arguments_, symbol, "crypto");
      chunks.push({
        id: `btc_eth-${symbol.toLowerCase()}`,
        simulationCase: "btc_eth",
        symbol,
        origins: cryptoOrigins("btc_eth", symbol, loaded.bars, cache, arguments_.smoke),
        dataHashes: { [loaded.path]: loaded.hash },
        dataRows: { [loaded.path]: loaded.bars.length },
        limitations: arguments_.smoke || cache.directory
          ? []
          : ["MODEL_UNAVAILABLE: validated prediction cache is not configured; primary policy is fail-closed."],
      });
    }
  }
  if (requested.includes("high_vol_crypto")) {
    await updateCurrent("high_vol_crypto", "universe_discovery");
    const universe = await currentHighVolUniverse(arguments_.smoke);
    const barsBySymbol = new Map<string, HistoricalBar[]>();
    const hashes: Record<string, string> = {};
    const dataRows: Record<string, number> = {};
    for (const candidate of universe) {
      await updateCurrent("high_vol_crypto", candidate.symbol);
      try {
        const loaded = await loadBars(arguments_, candidate.symbol, "crypto");
        barsBySymbol.set(candidate.symbol, loaded.bars);
        hashes[loaded.path] = loaded.hash;
        dataRows[loaded.path] = loaded.bars.length;
      } catch (error) {
        await log(`high_vol candidate skipped ${candidate.symbol}: ${String(error)}`);
      }
    }
    if (!barsBySymbol.size) throw new Error("No high-volatility candidate has sufficient data.");
    const scans = scannerSnapshots(
      barsBySymbol,
      new Map(universe.map((candidate) => [candidate.symbol, candidate.listingAt])),
      arguments_.smoke,
    );
    for (const [symbol, bars] of barsBySymbol) {
      chunks.push({
        id: `high_vol_crypto-${symbol.toLowerCase()}`,
        simulationCase: "high_vol_crypto",
        symbol,
        origins: cryptoOrigins(
          "high_vol_crypto",
          symbol,
          bars,
          cache,
          arguments_.smoke,
          scans.byOrigin,
        ),
        scannerSnapshots: scans.snapshots,
        dataHashes: hashes,
        dataRows,
        limitations: arguments_.smoke
          ? []
          : [
              "Historical Binance order-book spread/depth coverage is unavailable; scanner hard gate records SPREAD_UNAVAILABLE/DEPTH_UNAVAILABLE and selects no symbol.",
              "Current exchangeInfo bounds the discoverable universe, so delisted contracts absent from that endpoint cannot be reconstructed.",
              ...(cache.directory ? [] : ["MODEL_UNAVAILABLE: validated prediction cache is not configured."]),
            ],
      });
    }
  }
  if (requested.includes("us_etf_pair")) {
    for (const pairId of [
      "qqq-tqqq-sqqq",
      "semiconductor-soxl-soxs",
      "spy-spxl-spxs",
    ] as const) {
      const pair = getPairCatalogEntry(pairId);
      await updateCurrent("us_etf_pair", pairId);
      const symbols = [...new Set([
        pair.modelTargetSymbol,
        ...pair.auxiliarySymbols,
        pair.bull.executionSymbol,
        pair.bear.executionSymbol,
      ])];
      const barsBySymbol = new Map<string, HistoricalBar[]>();
      const hashes: Record<string, string> = {};
      const dataRows: Record<string, number> = {};
      for (const symbol of symbols) {
        await updateCurrent("us_etf_pair", symbol);
        const loaded = await loadBars(arguments_, symbol, "etf");
        barsBySymbol.set(symbol, loaded.bars);
        hashes[loaded.path] = loaded.hash;
        dataRows[loaded.path] = loaded.bars.length;
      }
      chunks.push({
        id: `us_etf_pair-${pairId}`,
        simulationCase: "us_etf_pair",
        symbol: pairId,
        origins: etfOrigins(pairId, barsBySymbol, cache, arguments_.smoke),
        dataHashes: hashes,
        dataRows,
        limitations: arguments_.smoke
          ? []
          : [
              "Yahoo 5-minute OHLCV has no historical quote spread; ETF session/liquidity policy records QUOTE_UNAVAILABLE/SPREAD_LIMIT and fails closed.",
              "Exchange holiday validation is limited to timestamps returned by the data source; ambiguous calendars remain unavailable.",
              ...(cache.directory ? [] : ["MODEL_UNAVAILABLE: validated prediction cache is not configured."]),
            ],
      });
    }
  }
  return chunks.filter((chunk) => chunk.origins.length > 0);
}

function gitValue(arguments_: string[]): string {
  const result = spawnSync("git", arguments_, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function sourceDigest(): string {
  return sha256([
    gitValue(["status", "--porcelain=v1"]),
    gitValue(["diff", "--binary", "--", "server", "src", "worker", "scripts", "package.json"]),
  ].join("\n"));
}

let logPath = "";
async function log(message: string): Promise<void> {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (logPath) {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, line);
  }
  process.stdout.write(line);
}

function stripDetails(result: HistoricalBacktestResult): Omit<
  HistoricalBacktestResult,
  "decisions" | "fills"
> {
  const { decisions: _decisions, fills: _fills, ...summary } = result;
  return summary;
}

async function executeChunk(
  arguments_: CliArguments,
  chunk: ChunkWork,
): Promise<ChunkSummary> {
  const chunkPath = path.join(arguments_.runDirectory, "chunks", `${chunk.id}.json`);
  if (arguments_.resume && await exists(chunkPath)) {
    return JSON.parse(await readFile(chunkPath, "utf8")) as ChunkSummary;
  }
  const results = COST_STRESS_MULTIPLIERS.map((multiplier) => (
    runHistoricalSimulationBacktest({
      simulationCase: chunk.simulationCase,
      symbol: chunk.symbol,
      seed: SEED,
      initialEquity: 10_000,
      origins: chunk.origins,
      costStressMultiplier: multiplier,
    })
  ));
  const base = results.find((result) => result.costStressMultiplier === 1)!;
  const splitIndex = Math.max(
    1,
    Math.min(chunk.origins.length - 1, Math.floor(chunk.origins.length * 0.8)),
  );
  const segmentInputs = [
    {
      id: "development" as const,
      classification: "development" as const,
      origins: chunk.origins.slice(0, splitIndex),
    },
    {
      id: "walk_forward_oos" as const,
      classification: "chronological_oos_diagnostic" as const,
      origins: chunk.origins.slice(splitIndex),
    },
  ];
  const evaluationSegments = segmentInputs.map((segment) => {
    const result = runHistoricalSimulationBacktest({
      simulationCase: chunk.simulationCase,
      symbol: chunk.symbol,
      seed: SEED,
      initialEquity: 10_000,
      origins: segment.origins,
      costStressMultiplier: 1,
    });
    return {
      id: segment.id,
      classification: segment.classification,
      originCount: result.originCount,
      firstOriginAt: result.firstOriginAt,
      lastOriginAt: result.lastOriginAt,
      lanes: result.lanes,
      modelMetrics: result.modelMetrics,
      scannerSelectionStability: result.scannerSelectionStability,
    };
  });
  const detailPath = path.join(
    arguments_.runDirectory,
    "artifacts",
    `${chunk.id}.decisions.json.gz`,
  );
  await atomicWrite(detailPath, await gzipAsync(Buffer.from(JSON.stringify({
    schemaVersion: RUN_SCHEMA_VERSION,
    chunkId: chunk.id,
    decisions: base.decisions,
    fills: base.fills,
  }))));
  let scannerArtifact: string | null = null;
  if (chunk.scannerSnapshots) {
    scannerArtifact = path.join(
      arguments_.runDirectory,
      "artifacts",
      `${chunk.id}.scanner.json.gz`,
    );
    await atomicWrite(
      scannerArtifact,
      await gzipAsync(Buffer.from(JSON.stringify(chunk.scannerSnapshots))),
    );
  }
  const summary: ChunkSummary = {
    schemaVersion: RUN_SCHEMA_VERSION,
    chunkId: chunk.id,
    simulationCase: chunk.simulationCase,
    symbol: chunk.symbol,
    originCount: base.originCount,
    firstOriginAt: base.firstOriginAt,
    lastOriginAt: base.lastOriginAt,
    costScenarios: results.map((result) => ({
      spreadSlippageMultiplier: result.costStressMultiplier,
      lanes: result.lanes,
      modelMetrics: result.modelMetrics,
      scannerSelectionStability: result.scannerSelectionStability,
      throughputOriginsPerSecond: result.offlineThroughputOriginsPerSecond,
    })),
    evaluationSegments,
    detailArtifact: detailPath,
    scannerArtifact,
    dataHashes: chunk.dataHashes,
    limitations: chunk.limitations,
    completedAt: new Date().toISOString(),
  };
  await atomicJson(chunkPath, summary);
  return summary;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  await mkdir(arguments_.runDirectory, { recursive: true });
  logPath = process.env.UNIFIED_BACKTEST_LOG_PATH?.trim()
    ? path.resolve(process.env.UNIFIED_BACKTEST_LOG_PATH)
    : path.join(arguments_.runDirectory, "run.log");
  const statusPath = path.join(arguments_.runDirectory, "status.json");
  const manifestPath = path.join(arguments_.runDirectory, "configuration-manifest.json");
  const resultPath = path.join(arguments_.runDirectory, "result-manifest.json");
  if (
    await exists(manifestPath)
    && !arguments_.resume
    && !arguments_.force
  ) {
    throw new Error("run directory already exists; use --resume or --force.");
  }
  const startedAt = new Date().toISOString();
  const previousManifest = arguments_.resume && await exists(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
    : undefined;
  const previousResult = arguments_.resume && await exists(resultPath)
    ? JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>
    : undefined;
  const previousDevelopmentReference = previousManifest?.developmentReference;
  const developmentArtifactPath =
    process.env.CHRONOS2_DEVELOPMENT_ARTIFACT?.trim()
    || (
      previousDevelopmentReference
      && typeof previousDevelopmentReference === "object"
      && typeof (previousDevelopmentReference as Record<string, unknown>).path === "string"
        ? (previousDevelopmentReference as Record<string, unknown>).path as string
        : null
    );
  const originalCreatedAt = typeof previousManifest?.createdAt === "string"
    ? previousManifest.createdAt
    : startedAt;
  const previousAttempts = previousManifest?.executionAttempts;
  const previousAttemptCount = previousAttempts
    && typeof previousAttempts === "object"
    && typeof (previousAttempts as Record<string, unknown>).count === "number"
    ? (previousAttempts as Record<string, unknown>).count as number
    : previousManifest ? 1 : 0;
  const currentGitCommitSha = gitValue(["rev-parse", "HEAD"]);
  const currentWorkingTreeDigest = sourceDigest();
  const originalGitCommitSha = typeof previousManifest?.gitCommitSha === "string"
    ? previousManifest.gitCommitSha
    : currentGitCommitSha;
  const originalWorkingTreeDigest = typeof previousManifest?.workingTreeDigest === "string"
    ? previousManifest.workingTreeDigest
    : currentWorkingTreeDigest;
  const status: Status = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    state: "preparing",
    pid: process.pid,
    command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)].join(" "),
    startedAt,
    heartbeatAt: startedAt,
    completedAt: null,
    completedChunks: 0,
    totalChunks: 0,
    currentCase: null,
    currentSymbol: null,
    error: null,
    logPath,
    resultArtifactPath: resultPath,
    configurationManifestPath: manifestPath,
    progressPath: statusPath,
  };
  const writeStatus = async () => {
    status.heartbeatAt = new Date().toISOString();
    await atomicJson(statusPath, status);
  };
  await writeStatus();
  const heartbeat = setInterval(() => {
    void writeStatus().catch(() => undefined);
  }, 5_000);
  heartbeat.unref();
  const cache = await loadPredictionCache();
  await atomicJson(manifestPath, {
    schemaVersion: RUN_SCHEMA_VERSION,
    arguments: arguments_,
    initialArguments: previousManifest?.initialArguments
      ?? previousManifest?.arguments
      ?? arguments_,
    seed: SEED,
    createdAt: originalCreatedAt,
    gitCommitSha: originalGitCommitSha,
    workingTreeDigest: originalWorkingTreeDigest,
    workingTreeDigestDefinition: "sha256(git status --porcelain + scoped git diff --binary)",
    executionAttempts: {
      count: previousAttemptCount + 1,
      lastStartedAt: startedAt,
      lastWasResume: arguments_.resume,
      latestGitCommitSha: currentGitCommitSha,
      latestWorkingTreeDigest: currentWorkingTreeDigest,
    },
    contracts: {
      request: "ai-paper-simulation/v9",
      historicalBacktest: "historical-simulation-backtest/v1",
      modelEvidence: "simulation-model-evidence/v1",
      pairCatalog: "scalping-pair-catalog/v4",
      rustMarketEvidence: "rust-market-evidence/v2",
      strategyPolicy: "simulation-strategy-policy/v2",
      scanner: "high-vol-scanner/v1",
      pairMapper: "pair-return-mapper/v1",
    },
    models: {
      chronos2: {
        modelId: CHRONOS2_ID,
        revision: CHRONOS2_REVISION,
        context: 1024,
        precision: "fp32",
        runtimeDownloadAllowed: false,
      },
      fincast: { modelId: FINCAST_ID, revision: FINCAST_REVISION },
    },
    predictionCache: {
      directory: cache.directory,
      fileHashes: cache.fileHashes,
      acceptedOriginCount: cache.evidence.size,
      rejectedRecords: cache.rejectedRecords,
      missingBehavior: "MODEL_UNAVAILABLE_FAIL_CLOSED",
    },
    execution: {
      finalizedDataOnly: true,
      decisionAtFinalizedBarClose: true,
      fillAtNextBarOpen: true,
      sameBarRetroactiveFill: false,
      costStressMultipliers: COST_STRESS_MULTIPLIERS,
      fixedSeed: SEED,
      modelCallsPlanned: 0,
      modelCallReason: arguments_.smoke
        ? "deterministic test evidence; no production model inference"
        : "prediction-cache-only replay; runtime model download and fallback are forbidden",
    },
    evaluationProtocol: {
      developmentFraction: 0.8,
      oosFraction: 0.2,
      split: "chronological_per_chunk",
      oosClassification: "walk_forward_oos_diagnostic_not_pristine_holdout",
      policyConfigurationFrozenBeforeReplay: true,
      perOriginTrainingCutoff: "observation timestamp <= decision origin",
      positionStateAtSegmentBoundary: "reset_for_segment_metric_isolation",
      note: "The latest data was exercised by smoke validation, so the final 20% is reported as a chronological OOS diagnostic rather than an untouched holdout.",
    },
    developmentReference: {
      path: developmentArtifactPath,
      classification: "compatibility_development_only_not_holdout",
      copiedIntoRun: false,
    },
  });
  try {
    const chunks = await prepareChunks(
      arguments_,
      cache,
      async (simulationCase, symbol) => {
        status.currentCase = simulationCase;
        status.currentSymbol = symbol;
        await writeStatus();
      },
    );
    status.totalChunks = chunks.length;
    status.state = "running";
    await writeStatus();
    const dataRows: Record<string, number> = {};
    for (const chunk of chunks) Object.assign(dataRows, chunk.dataRows);
    const totalInputBytes = (
      await Promise.all(Object.keys(dataRows).map(async (filePath) => (await stat(filePath)).size))
    ).reduce((sum, size) => sum + size, 0);
    await atomicJson(manifestPath, {
      ...JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>,
      estimate: {
        totalChunks: chunks.length,
        totalDecisionOrigins: chunks.reduce((sum, chunk) => sum + chunk.origins.length, 0),
        totalRows: Object.values(dataRows).reduce((sum, rows) => sum + rows, 0),
        totalInputBytes,
        modelCalls: 0,
        executionForm: "chunked resumable offline replay",
      },
      dataHashes: Object.assign({}, ...chunks.map((chunk) => chunk.dataHashes)),
    });
    const summaries: ChunkSummary[] = [];
    for (const chunk of chunks) {
      status.currentCase = chunk.simulationCase;
      status.currentSymbol = chunk.symbol;
      await writeStatus();
      await log(`chunk start ${chunk.id} origins=${chunk.origins.length}`);
      const summary = await executeChunk(arguments_, chunk);
      summaries.push(summary);
      status.completedChunks += 1;
      await writeStatus();
      await log(`chunk complete ${chunk.id}`);
    }
    const resultManifest = {
      schemaVersion: RUN_SCHEMA_VERSION,
      status: "completed",
      startedAt: originalCreatedAt,
      lastAttemptStartedAt: startedAt,
      executionAttemptCount: previousAttemptCount + 1,
      resumedFromCompletedResult: Boolean(
        arguments_.resume && previousResult?.status === "completed",
      ),
      completedAt: new Date().toISOString(),
      runDirectory: arguments_.runDirectory,
      smoke: arguments_.smoke,
      requestedCase: arguments_.simulationCase,
      chunks: summaries,
      artifacts: summaries.flatMap((summary) => [
        summary.detailArtifact,
        ...(summary.scannerArtifact ? [summary.scannerArtifact] : []),
      ]),
      limitations: [...new Set(summaries.flatMap((summary) => summary.limitations))],
      developmentReference: {
        chronos2FiveWeek: developmentArtifactPath,
        classification: "development_compatibility_not_holdout",
      },
    };
    await atomicJson(resultPath, resultManifest);
    status.state = "completed";
    status.completedAt = resultManifest.completedAt;
    status.currentCase = null;
    status.currentSymbol = null;
    await writeStatus();
    await log(`run complete chunks=${summaries.length} result=${resultPath}`);
  } catch (error) {
    status.state = "failed";
    status.error = error instanceof Error ? error.stack ?? error.message : String(error);
    status.completedAt = new Date().toISOString();
    await writeStatus();
    await log(`run failed ${status.error}`);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
