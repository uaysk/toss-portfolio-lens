#!/usr/bin/env -S node --import tsx

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  CryptoRustTechnicalAnalyzer,
  type CryptoRustComputePort,
  type CryptoRustTechnicalAnalysis,
} from "../server/crypto/crypto-rust-technical.js";
import type { BinanceKline } from "../server/crypto/binance-market-data.js";
import {
  type SimulationModelPlanEntry,
} from "../server/simulation/contracts.js";
import {
  runHistoricalSimulationBacktest,
  type HistoricalBacktestInput,
  type HistoricalBacktestResult,
  type HistoricalDecisionOrigin,
} from "../server/simulation/historical-backtest.js";
import {
  scanHighVolatilityUniverse,
  type HighVolatilityCandidateObservation,
} from "../server/simulation/high-volatility-scanner.js";
import {
  normalizeModelEvidence,
  totalDirectionalCostRate,
  type EvidenceCostBreakdown,
  type ModelEvidence,
} from "../server/simulation/model-evidence.js";
import {
  HIGH_VOLATILITY_STACK_POLICY_VERSION,
  assessHighVolatilityHorizons,
  classifyCausalVolatilityRegime,
  fitVetoProbabilityCalibration,
  scoreHighVolatilityRustQuality,
  selectHighVolatilityCandidates,
  type HighVolatilityCandidateSelection,
  type HighVolatilityDirection,
  type HighVolatilityHorizon,
  type HighVolatilityRegime,
  type VetoProbabilityCalibrationSample,
} from "../server/simulation/high-volatility-stack-policy.js";
import {
  applyConformalScale,
  fitRollingConformalCalibration,
  type ConformalCalibration,
  type ConformalResidual,
} from "../server/simulation/rolling-conformal-calibration.js";
import type { RustMarketEvidenceV2 } from "../server/simulation/technical-indicator-evidence.js";
import { RustComputeClient } from "../server/worker/rust-client.js";
import {
  boundedConcurrency,
  parseRecoverableJsonLines,
  processInOrderedBatches,
} from "./high-vol-rust-concurrency.js";

const SCHEMA_VERSION = "high-vol-model-stack-backtest/v2" as const;
const INITIAL_EQUITY = 1_000_000;
const SEED = 17;
const MINUTE_MS = 60_000;
const RUST_CONTEXT_BARS = 7 * 24 * 60;
const COST_STRESSES = [0.75, 1, 1.5, 2] as const;
type ConformalResidualIndex = ReadonlyMap<string, readonly ConformalResidual[]>;

type SourceManifest = {
  schemaVersion: "high-vol-stack-source/v1" | "high-vol-stack-source/v2";
  evaluationStart: string;
  evaluationEndExclusive: string;
  calibrationStart: string;
  candidateUniverse: string[];
  models: Record<"chronos2" | "fincast", {
    modelId: string;
    modelRevision: string;
    contextBars: number;
    cadenceSeconds: number;
  }>;
  featureProfile: string;
  seed: number;
  microstructure: Record<string, unknown>;
  sourceHashes: Record<string, string>;
  smoke: boolean;
  calibrationDays?: number;
  scannerRecordedTopCount?: number;
  modelSelectorCandidateCount?: number;
  executionSymbolCount?: number;
};

type SourceBar = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  tradeCount: number;
  takerBuyVolume: number;
  takerBuyQuoteVolume: number;
  markPrice?: number | null;
  indexPrice?: number | null;
  premiumIndex?: number | null;
  fundingRate?: number | null;
  openInterest?: number | null;
  longShortRatio?: number | null;
};

type RawHorizon = {
  horizonMinutes: 5 | 15 | 30 | 60;
  targetTimestamp: string;
  fixedQuantiles: Record<string, number>;
  nativeQuantiles: Record<string, number>;
  upProbability: number | null;
  downProbability: number | null;
  flatProbability: number | null;
};

type RawForecast = {
  schemaVersion: "high-vol-stack-model-forecast/v1";
  lane: "chronos2" | "fincast";
  symbol: string;
  originAt: string;
  modelId: string;
  modelRevision: string;
  generatedAt: string;
  latencyMs: number;
  inputDigest: string;
  contextBars: number;
  cadenceSeconds: 60;
  horizons: RawHorizon[];
};

type Microstructure = {
  depth: {
    observedAtMs: number;
    bidNotional: number;
    askNotional: number;
    depthUsd: number;
    imbalance: number;
    rangeBps: number;
  } | null;
  bookTicker?: {
    observedAtMs: number;
    bidPrice: number;
    bidQuantity: number;
    askPrice: number;
    askQuantity: number;
  } | null;
  spreadBps: number;
  spreadMethod: string;
  directHistoricalBookTicker?: boolean;
  depthMethod: string;
  buyVolume: number;
  sellVolume: number;
  fundingRate: number | null;
  basisRate: number | null;
  openInterest: number | null;
  longShortRatio: number | null;
  realizedVolatility: number;
  referenceSpreadBps: number;
  referenceDepth: number | null;
  priceGapRate: number;
};

type SourceCandidate = {
  symbol: string;
  scannerRank: number | null;
  scannerScore: number | null;
  originClose: number;
  actualTargetReturns: Record<"5" | "15" | "30" | "60", number>;
  microstructure: Microstructure;
  models: {
    chronos2?: RawForecast | null;
    fincast?: RawForecast | null;
  };
};

type SourceOrigin = {
  originAt: string;
  originMs: number;
  fillAt: string;
  phase: "calibration" | "evaluation";
  selectedSymbol: string | null;
  candidateSymbols?: string[];
  scannerOriginAt: string | null;
  scannerTopFive: Array<Record<string, unknown>>;
  scannerEligibleCount: number;
  pricesAtFill: Record<string, number>;
  originClose?: number;
  actualTargetReturns?: Record<"5" | "15" | "30" | "60", number>;
  microstructure?: Microstructure;
  candidates?: SourceCandidate[];
  models: {
    chronos2?: RawForecast | null;
    fincast?: RawForecast | null;
  };
};

type ScannerSnapshot = {
  originAt: string;
  settings: {
    symbolCount: 1 | 2;
    minimumTradingAmountUsd: number;
    maximumSpreadBps: number;
    depthRangeBps: number;
    rescanIntervalMinutes: number;
    riskAppetite: "conservative" | "balanced" | "aggressive";
    minimumListingDays: number;
    maximumMissingRate: number;
    minimumDepthUsd: number;
  };
  selectedSymbols: string[];
  observations: HighVolatilityCandidateObservation[];
};

type RustCacheRow = {
  originAt: string;
  symbol: string;
  analysis: CryptoRustTechnicalAnalysis;
  historicalMicrostructure: {
    depthSource: string;
    spreadSource: string;
    directHistoricalBookTicker: boolean;
    projectedTopOfBook: boolean;
  };
};

function sourceCandidates(origin: SourceOrigin): SourceCandidate[] {
  if (origin.candidates?.length) return origin.candidates;
  if (
    !origin.selectedSymbol
    || origin.originClose === undefined
    || !origin.actualTargetReturns
    || !origin.microstructure
  ) return [];
  return [{
    symbol: origin.selectedSymbol,
    scannerRank: 1,
    scannerScore: 1,
    originClose: origin.originClose,
    actualTargetReturns: origin.actualTargetReturns,
    microstructure: origin.microstructure,
    models: origin.models,
  }];
}

function candidateKey(symbol: string, originAt: string): string {
  return `${symbol.toUpperCase()}|${originAt}`;
}

function rustEvidenceAtDecisionBoundary(
  origin: SourceOrigin,
  row: RustCacheRow,
): RustMarketEvidenceV2 {
  const contractOriginMs = Date.parse(row.analysis.marketEvidence.originAt);
  const decisionOriginMs = Date.parse(origin.originAt);
  const boundaryDeltaMs = contractOriginMs - decisionOriginMs;
  if (
    !Number.isFinite(contractOriginMs)
    || !Number.isFinite(decisionOriginMs)
    || (boundaryDeltaMs !== 0 && boundaryDeltaMs !== 1)
  ) {
    throw new Error(
      `Rust/model origin mismatch for ${row.symbol}: `
      + `${row.analysis.marketEvidence.originAt} vs ${origin.originAt}.`,
    );
  }
  // Binance represents a finalized one-minute bar with an inclusive close
  // timestamp ending in .999Z.  The Rust interval contract represents the
  // exact same boundary as the following whole minute.  Rebase only that
  // one-millisecond representation difference; the raw Rust timestamps remain
  // preserved in rust-evidence.jsonl for provenance.
  return boundaryDeltaMs === 0
    ? row.analysis.marketEvidence
    : {
        ...row.analysis.marketEvidence,
        originAt: origin.originAt,
        observedAt: origin.originAt,
      };
}

type CliArguments = {
  runDir: string;
  rustBinary: string;
  rustConcurrency: number;
  rustSocket?: string;
  diagnosticFrom?: string;
  holdoutFrom?: string;
};

function parseArguments(values: readonly string[]): CliArguments {
  let runDir: string | undefined;
  let rustBinary = resolve("worker/rust/target/debug/portfolio-lens-worker");
  let rustConcurrency = 1;
  let rustSocket: string | undefined;
  let diagnosticFrom: string | undefined;
  let holdoutFrom: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--run-dir") {
      runDir = values[++index];
    } else if (value === "--rust-binary") {
      rustBinary = values[++index] ?? "";
    } else if (value === "--rust-socket") {
      rustSocket = values[++index] ?? "";
    } else if (value === "--rust-concurrency") {
      rustConcurrency = boundedConcurrency(Number(values[++index]));
    } else if (value === "--diagnostic-from") {
      diagnosticFrom = values[++index] ?? "";
    } else if (value === "--holdout-from") {
      holdoutFrom = values[++index] ?? "";
    } else {
      throw new Error(`Unknown argument: ${value ?? ""}`);
    }
  }
  if (!runDir || !isAbsolute(runDir)) {
    throw new Error("--run-dir must be an absolute path.");
  }
  if (!isAbsolute(rustBinary)) {
    throw new Error("--rust-binary must be an absolute path.");
  }
  if (rustSocket !== undefined && !isAbsolute(rustSocket)) {
    throw new Error("--rust-socket must be an absolute path.");
  }
  for (const [name, value] of [
    ["--diagnostic-from", diagnosticFrom],
    ["--holdout-from", holdoutFrom],
  ] as const) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) {
      throw new Error(`${name} must be an ISO timestamp.`);
    }
  }
  return {
    runDir: resolve(runDir),
    rustBinary: resolve(rustBinary),
    rustConcurrency,
    ...(rustSocket === undefined ? {} : { rustSocket: resolve(rustSocket) }),
    ...(diagnosticFrom === undefined ? {} : { diagnosticFrom }),
    ...(holdoutFrom === undefined ? {} : { holdoutFrom }),
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await writeFile(path, await readFile(temporary), { mode: 0o600 });
  await rm(temporary);
}

async function atomicJsonLines(path: string, values: readonly unknown[]): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(
      values.map((value) => JSON.stringify(value)).join("\n") + "\n",
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await writeFile(path, await readFile(temporary), { mode: 0o600 });
  await rm(temporary);
}

function parseJsonLines<T>(source: string): T[] {
  return source.split("\n").flatMap((line) => (
    line.trim() ? [JSON.parse(line) as T] : []
  ));
}

async function loadScannerSnapshots(runDir: string, smoke: boolean): Promise<ScannerSnapshot[]> {
  if (smoke) {
    return JSON.parse(
      await readFile(join(runDir, "scanner-snapshots-smoke.json"), "utf8"),
    ) as ScannerSnapshot[];
  }
  const loaded = parseJsonLines<ScannerSnapshot>(
    await readFile(join(runDir, "scanner-snapshots.jsonl"), "utf8"),
  );
  return [...new Map(
    loaded.map((snapshot) => [snapshot.originAt, snapshot]),
  ).values()];
}

async function verifyScannerParity(
  snapshots: readonly ScannerSnapshot[],
): Promise<{ checked: number; mismatches: number }> {
  let mismatches = 0;
  for (const snapshot of snapshots) {
    const actual = scanHighVolatilityUniverse(
      snapshot.observations,
      snapshot.originAt,
      snapshot.settings,
    );
    if (JSON.stringify(actual.selectedSymbols) !== JSON.stringify(snapshot.selectedSymbols)) {
      mismatches += 1;
    }
  }
  if (mismatches > 0) {
    throw new Error(`Python/TypeScript scanner parity failed for ${mismatches} snapshots.`);
  }
  return { checked: snapshots.length, mismatches };
}

async function loadBars(
  runDir: string,
  symbols: readonly string[],
): Promise<Map<string, SourceBar[]>> {
  const values = new Map<string, SourceBar[]>();
  for (const symbol of symbols) {
    const compressed = await readFile(
      join(runDir, "prepared", "bars", `${symbol}.json.gz`),
    );
    const bars = JSON.parse(gunzipSync(compressed).toString("utf8")) as SourceBar[];
    for (let index = 1; index < bars.length; index += 1) {
      if (
        bars[index]!.openTime - bars[index - 1]!.openTime !== MINUTE_MS
        || bars[index]!.closeTime <= bars[index - 1]!.closeTime
      ) {
        throw new Error(`${symbol} contains a non-contiguous finalized bar.`);
      }
    }
    values.set(symbol, bars);
  }
  return values;
}

function asBinanceKline(symbol: string, value: SourceBar): BinanceKline {
  return {
    symbol,
    interval: "1m",
    openTime: value.openTime,
    closeTime: value.closeTime,
    open: value.open,
    high: value.high,
    low: value.low,
    close: value.close,
    volume: value.volume,
    quoteVolume: value.quoteVolume,
    tradeCount: value.tradeCount,
    takerBuyVolume: value.takerBuyVolume,
    takerBuyQuoteVolume: value.takerBuyQuoteVolume,
    final: true,
  };
}

function sliceBarsAt(
  values: readonly SourceBar[],
  originMs: number,
  maximum: number,
): SourceBar[] {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle]!.closeTime <= originMs) left = middle + 1;
    else right = middle;
  }
  const output = values.slice(Math.max(0, left - maximum), left);
  if (output.at(-1)?.closeTime !== originMs) {
    throw new Error(`No finalized one-minute bar at ${new Date(originMs).toISOString()}.`);
  }
  return output;
}

async function waitForSocket(path: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Rust worker exited before socket readiness (${child.exitCode}).`);
    }
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error("Rust worker socket did not become ready.");
}

function microstructureOrderbook(
  originAt: string,
  originMs: number,
  originClose: number,
  market: Microstructure,
): {
  observedAt: string;
  bidPrice: number;
  bidQuantity: number;
  askPrice: number;
  askQuantity: number;
} | undefined {
  const direct = market.bookTicker;
  if (
    direct
    && direct.observedAtMs <= originMs
    && originMs - direct.observedAtMs <= 60_000
    && direct.bidPrice > 0
    && direct.askPrice >= direct.bidPrice
    && direct.bidQuantity >= 0
    && direct.askQuantity >= 0
  ) {
    return {
      observedAt: new Date(direct.observedAtMs).toISOString(),
      bidPrice: direct.bidPrice,
      bidQuantity: direct.bidQuantity,
      askPrice: direct.askPrice,
      askQuantity: direct.askQuantity,
    };
  }
  const depth = market?.depth;
  const midpoint = originClose;
  if (
    !depth
    || !Number.isFinite(midpoint)
    || midpoint <= 0
    || !Number.isFinite(market.spreadBps)
    || market.spreadBps < 0
    || depth.depthUsd <= 0
    || depth.observedAtMs > originMs
  ) return undefined;
  const halfRate = market.spreadBps / 20_000;
  const bidPrice = midpoint * (1 - halfRate);
  const askPrice = midpoint * (1 + halfRate);
  return {
    observedAt: new Date(depth.observedAtMs).toISOString() || originAt,
    bidPrice,
    bidQuantity: depth.bidNotional / bidPrice,
    askPrice,
    askQuantity: depth.askNotional / askPrice,
  };
}

function causalSourceVolatilityRegimes(
  origins: readonly SourceOrigin[],
): Map<string, HighVolatilityRegime> {
  const output = new Map<string, HighVolatilityRegime>();
  const history = new Map<string, number[]>();
  for (const origin of [...origins].sort(
    (left, right) => left.originMs - right.originMs,
  )) {
    for (const candidate of sourceCandidates(origin)) {
      const values = history.get(candidate.symbol) ?? [];
      const current = candidate.microstructure.realizedVolatility;
      output.set(
        candidateKey(candidate.symbol, origin.originAt),
        classifyCausalVolatilityRegime(values.slice(-7 * 96), current),
      );
      if (Number.isFinite(current) && current >= 0) {
        values.push(current);
        history.set(candidate.symbol, values);
      }
    }
  }
  return output;
}

function residualsFromOrigins(
  origins: readonly SourceOrigin[],
  regimes: ReadonlyMap<string, HighVolatilityRegime>,
): ConformalResidual[] {
  const output: ConformalResidual[] = [];
  for (const origin of origins) {
    for (const candidate of sourceCandidates(origin)) {
      for (const lane of ["chronos2", "fincast"] as const) {
        const forecast = candidate.models[lane];
        if (!forecast) continue;
        for (const horizon of forecast.horizons) {
          const q10 = horizon.fixedQuantiles["0.1"];
          const q90 = horizon.fixedQuantiles["0.9"];
          const actual = candidate.actualTargetReturns[String(
            horizon.horizonMinutes,
          ) as keyof SourceCandidate["actualTargetReturns"]];
          if (
            q10 === undefined
            || q90 === undefined
            || actual === undefined
          ) continue;
          output.push({
            modelLane: lane,
            symbol: candidate.symbol,
            horizonMinutes: horizon.horizonMinutes,
            volatilityRegime: regimes.get(
              candidateKey(candidate.symbol, origin.originAt),
            ),
            originAt: origin.originAt,
            resolvedAt: horizon.targetTimestamp,
            predictedQ10: q10,
            predictedQ90: q90,
            actualReturn: actual,
          });
        }
      }
    }
  }
  return output;
}

function residualIndex(
  residuals: readonly ConformalResidual[],
): ConformalResidualIndex {
  const output = new Map<string, ConformalResidual[]>();
  for (const residual of residuals) {
    const key = [
      residual.modelLane,
      residual.symbol.toUpperCase(),
      residual.horizonMinutes,
    ].join("|");
    const values = output.get(key) ?? [];
    values.push(residual);
    output.set(key, values);
  }
  return output;
}

function conformalFor(
  source: RawForecast,
  candidate: SourceCandidate,
  origin: SourceOrigin,
  horizonMinutes: HighVolatilityHorizon,
  volatilityRegime: HighVolatilityRegime,
  residuals: ConformalResidualIndex,
): ConformalCalibration {
  const input = {
    modelLane: source.lane,
    symbol: candidate.symbol,
    horizonMinutes,
    originAt: origin.originAt,
  };
  const indexed = residuals.get([
    source.lane,
    candidate.symbol.toUpperCase(),
    horizonMinutes,
  ].join("|")) ?? [];
  const exact = fitRollingConformalCalibration(indexed, input, {
    minimumSamples: 12,
    maximumSamples: 500,
    maximumAgeMinutes: 24 * 60,
    coverage: 0.8,
    volatilityRegime,
  });
  return exact.status === "ready"
    ? exact
    : fitRollingConformalCalibration(indexed, input, {
        minimumSamples: 30,
        maximumSamples: 500,
        maximumAgeMinutes: 24 * 60,
        coverage: 0.8,
      });
}

function evidenceFor(
  source: RawForecast,
  role: "primary" | "veto",
  origin: SourceOrigin,
  candidate: SourceCandidate,
  rust: RustMarketEvidenceV2 | undefined,
  volatilityRegime: HighVolatilityRegime,
  residuals: ConformalResidualIndex,
  costs: EvidenceCostBreakdown,
  qualityRequired = true,
): ModelEvidence[] {
  return source.horizons.map((horizon) => {
    const calibration = conformalFor(
      source,
      candidate,
      origin,
      horizon.horizonMinutes,
      volatilityRegime,
      residuals,
    );
    const quantiles = Object.fromEntries(
      Object.entries(horizon.nativeQuantiles).map(([probability, value]) => [
        Number(probability),
        value,
      ]),
    );
    const qualityOk = !qualityRequired || (
      rust !== undefined
      && rust.blockedGates.length === 0
      && rust.quoteFreshnessMs !== null
      && rust.quoteFreshnessMs <= 60_000
    );
    const directBookTicker =
      candidate.microstructure.directHistoricalBookTicker === true;
    return normalizeModelEvidence({
      modelLane: source.lane,
      modelId: source.modelId,
      modelRevision: source.modelRevision,
      role,
      symbol: candidate.symbol,
      originAt: origin.originAt,
      horizonMinutes: horizon.horizonMinutes,
      quantiles: applyConformalScale(quantiles, calibration),
      calibrationId: calibration.calibrationId,
      calibrationStatus: calibration.status,
      calibrationAge: calibration.ageMinutes,
      featureProfile: source.lane === "chronos2"
        ? "compact_causal_v1"
        : "fincast-native/v1",
      dataQuality: {
        status: qualityOk ? "ok" : "degraded",
        finalizedOnly: true,
        stale: !qualityOk,
        missingRate: 0,
        unavailableFeatures: [
          "liquidation_volume",
          ...(directBookTicker ? [] : ["direct_historical_book_ticker"]),
        ],
        warnings: [
          ...(directBookTicker
            ? ["historical_spread_uses_direct_book_ticker"]
            : ["historical_spread_uses_causal_roll_estimator"]),
          "book_depth_is_direct_20bps_snapshot",
        ],
      },
      generatedAt: source.generatedAt,
      latencyMs: source.latencyMs,
      inputOrigin: "historical",
      costs,
    });
  });
}

function ema(values: readonly number[], period: number): number {
  const weight = 2 / (period + 1);
  let current = values[0] ?? 0;
  for (const value of values.slice(1)) current = value * weight + current * (1 - weight);
  return current;
}

function baselineDirection(
  values: readonly SourceBar[],
  originMs: number,
): "long" | "short" | "cash" {
  const closes = sliceBarsAt(values, originMs, 30).map((value) => value.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  if (Math.abs(fast / slow - 1) < 0.0005) return "cash";
  return fast > slow ? "long" : "short";
}

function originCosts(market: Microstructure | undefined): EvidenceCostBreakdown {
  const fundingRate = market?.fundingRate ?? 0;
  return {
    commissionBps: 8,
    spreadBps: Math.max(2, market?.spreadBps ?? 2),
    slippageBps: 2,
    // Funding is charged every eight hours.  Use a fixed 30-minute expected
    // hold for the common execution cost; horizon-specific model distributions
    // remain otherwise unchanged.
    fundingBps: fundingRate * 10_000 * 30 / (8 * 60),
    safetyMarginBps: 1,
  };
}

function adxFromAnalysis(analysis: CryptoRustTechnicalAnalysis): number | null {
  const calculation = analysis.calculations.find(
    (value) => value.kind === "adx_dmi",
  );
  const adx = calculation?.latest?.values.adx;
  return typeof adx === "number" && Number.isFinite(adx) ? adx : null;
}

function vetoCalibrationSamples(
  origins: readonly SourceOrigin[],
  regimes: ReadonlyMap<string, HighVolatilityRegime>,
  residuals: ConformalResidualIndex,
): VetoProbabilityCalibrationSample[] {
  const output: VetoProbabilityCalibrationSample[] = [];
  for (const origin of origins) {
    for (const candidate of sourceCandidates(origin)) {
      const forecast = candidate.models.fincast;
      if (!forecast) continue;
      const costs = originCosts(candidate.microstructure);
      const directionalCosts = totalDirectionalCostRate(costs);
      const regime = regimes.get(candidateKey(candidate.symbol, origin.originAt))
        ?? "normal";
      const modelEvidence = evidenceFor(
        forecast,
        "veto",
        origin,
        candidate,
        undefined,
        regime,
        residuals,
        costs,
        false,
      );
      for (const evidence of modelEvidence) {
        const actual = candidate.actualTargetReturns[
          String(evidence.horizonMinutes) as keyof SourceCandidate["actualTargetReturns"]
        ];
        const forecastHorizon = forecast.horizons.find(
          (value) => value.horizonMinutes === evidence.horizonMinutes,
        );
        if (actual === undefined || !forecastHorizon) continue;
        output.push(
          {
            modelLane: "fincast",
            symbol: candidate.symbol,
            horizonMinutes: evidence.horizonMinutes,
            volatilityRegime: regime,
            direction: "long",
            originAt: origin.originAt,
            resolvedAt: forecastHorizon.targetTimestamp,
            rawProbability: evidence.pNetLong,
            outcome: actual > directionalCosts.long ? 1 : 0,
          },
          {
            modelLane: "fincast",
            symbol: candidate.symbol,
            horizonMinutes: evidence.horizonMinutes,
            volatilityRegime: regime,
            direction: "short",
            originAt: origin.originAt,
            resolvedAt: forecastHorizon.targetTimestamp,
            rawProbability: evidence.pNetShort,
            outcome: actual < -directionalCosts.short ? 1 : 0,
          },
        );
      }
    }
  }
  return output;
}

function historicalOrigin(
  source: SourceOrigin,
  selected: SourceCandidate | undefined,
  variant: "chronos2_rust" | "chronos2_fincast_veto_rust",
  rustRow: RustCacheRow | undefined,
  realizedVolatilityBaseline: number | undefined,
  residuals: ConformalResidualIndex,
  vetoSamples: readonly VetoProbabilityCalibrationSample[],
  volatilityRegime: HighVolatilityRegime,
  bars: ReadonlyMap<string, readonly SourceBar[]>,
  lastSelectedSymbol: string,
): HistoricalDecisionOrigin {
  const symbol = selected?.symbol ?? lastSelectedSymbol;
  const rust = rustRow
    ? rustEvidenceAtDecisionBoundary(source, rustRow)
    : undefined;
  const costs = originCosts(selected?.microstructure);
  const primaryPlan: SimulationModelPlanEntry = {
    symbol: "*",
    modelLane: "chronos2",
    role: "primary",
    required: true,
    preferredHorizonsMinutes: [15, 30, 60],
  };
  const vetoPlan: SimulationModelPlanEntry = {
    symbol: "*",
    modelLane: "fincast",
    role: "veto",
    required: true,
    preferredHorizonsMinutes: [15, 30, 60],
  };
  const modelPlan = variant === "chronos2_rust"
    ? [primaryPlan]
    : [primaryPlan, vetoPlan];
  const primaryEvidence = selected && rust && selected.models.chronos2
    ? evidenceFor(
        selected.models.chronos2,
        "primary",
        source,
        selected,
        rust,
        volatilityRegime,
        residuals,
        costs,
      )
    : [];
  const vetoEvidence = selected
    && rust
    && variant === "chronos2_fincast_veto_rust"
    && selected.models.fincast
    ? evidenceFor(
        selected.models.fincast,
        "veto",
        source,
        selected,
        rust,
        volatilityRegime,
        residuals,
        costs,
      )
    : [];
  const modelEvidence = selected && rust
    ? [
        ...primaryEvidence,
        ...vetoEvidence,
      ]
    : [];
  const horizonAssessments = rust && selected
    ? assessHighVolatilityHorizons({
        rustEvidence: rust,
        adx: rustRow ? adxFromAnalysis(rustRow.analysis) : null,
        fundingRate: selected.microstructure.fundingRate,
        basisRate: selected.microstructure.basisRate,
      })
    : {};
  const vetoCalibrationByHorizon = variant === "chronos2_fincast_veto_rust"
    ? Object.fromEntries(primaryEvidence.flatMap((primary) => {
        const veto = vetoEvidence.find(
          (value) => value.horizonMinutes === primary.horizonMinutes,
        );
        if (!veto || !selected) return [];
        const primaryDirection: HighVolatilityDirection =
          primary.pNetLong >= primary.pNetShort ? "long" : "short";
        const oppositeDirection: HighVolatilityDirection =
          primaryDirection === "long" ? "short" : "long";
        const rawProbability = oppositeDirection === "long"
          ? veto.pNetLong
          : veto.pNetShort;
        return [[
          primary.horizonMinutes,
          fitVetoProbabilityCalibration(vetoSamples, {
            modelLane: "fincast",
            symbol: selected.symbol,
            horizonMinutes: primary.horizonMinutes,
            volatilityRegime,
            direction: oppositeDirection,
            originAt: source.originAt,
            rawProbability,
          }),
        ]];
      }))
    : {};
  const selectedBars = bars.get(symbol);
  return {
    originAt: source.originAt,
    fillAt: source.fillAt,
    signalSymbol: symbol,
    executionSymbols: selected
      ? { long: symbol, short: symbol }
      : {},
    pricesAtFill: source.pricesAtFill,
    modelPlan,
    modelEvidence,
    ...(rust ? { rustEvidence: rust } : {}),
    ...(rust && selected
      ? {
          highVolatility: {
            policyVersion: HIGH_VOLATILITY_STACK_POLICY_VERSION,
            volatilityRegime,
            rustQuality: scoreHighVolatilityRustQuality(rust),
            horizonAssessments,
            ...(variant === "chronos2_fincast_veto_rust"
              ? { vetoCalibrationByHorizon }
              : {}),
          },
        }
      : {}),
    costs,
    baselineDirection: selectedBars
      ? baselineDirection(selectedBars, source.originMs)
      : "cash",
    scannerSelectedSymbols: source.candidateSymbols
      ?? sourceCandidates(source).map((value) => value.symbol),
    ...(selected
      ? {
          actualTargetReturns: {
            5: selected.actualTargetReturns["5"],
            15: selected.actualTargetReturns["15"],
            30: selected.actualTargetReturns["30"],
            60: selected.actualTargetReturns["60"],
          },
        }
      : {}),
    circuit: {
      dailyLossRate: 0,
      consecutiveLosses: 0,
      ...(selected?.microstructure.referenceSpreadBps === undefined
        ? {}
        : { referenceSpreadBps: selected.microstructure.referenceSpreadBps }),
      ...(selected?.microstructure.referenceDepth === null
        || selected?.microstructure.referenceDepth === undefined
        ? {}
        : { referenceDepth: selected.microstructure.referenceDepth }),
      ...(realizedVolatilityBaseline === undefined
        ? {}
        : { realizedVolatilityBaseline }),
      ...(selected?.microstructure.priceGapRate === undefined
        ? {}
        : { priceGapRate: selected.microstructure.priceGapRate }),
      missingData: !selected || !rust,
    },
  };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function causalRustVolatilityBaselines(
  origins: readonly SourceOrigin[],
  evidenceByKey: ReadonlyMap<string, RustMarketEvidenceV2>,
): Map<string, number> {
  const output = new Map<string, number>();
  const globalHistory: number[] = [];
  const historyBySymbol = new Map<string, number[]>();
  for (const origin of origins) {
    for (const candidate of sourceCandidates(origin)) {
      const key = candidateKey(candidate.symbol, origin.originAt);
      const evidence = evidenceByKey.get(key);
      const current = evidence?.realizedVolatility;
      if (current === null || current === undefined) continue;
      const symbolHistory = historyBySymbol.get(candidate.symbol) ?? [];
      const reference = symbolHistory.length >= 8
        ? symbolHistory.slice(-96)
        : globalHistory.length >= 16
          ? globalHistory.slice(-96)
          : [];
      const baseline = median(reference);
      if (baseline !== undefined && baseline > 0) {
        output.set(key, baseline);
      }
      symbolHistory.push(current);
      historyBySymbol.set(candidate.symbol, symbolHistory);
      globalHistory.push(current);
    }
  }
  return output;
}

function stripDetails(
  result: HistoricalBacktestResult,
): Omit<HistoricalBacktestResult, "decisions" | "fills"> {
  const { decisions: _decisions, fills: _fills, ...summary } = result;
  return summary;
}

function counts(values: readonly string[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(output).sort((left, right) => right[1] - left[1]),
  );
}

function resultDiagnostics(result: HistoricalBacktestResult) {
  const decisions = result.decisions.filter((value) => value.lane === "final_policy");
  return {
    directionCounts: counts(decisions.map((value) => value.direction)),
    reasonCounts: counts(decisions.flatMap((value) => value.reasons)),
    horizonCounts: counts(decisions.flatMap((value) => (
      value.unifiedDecision?.selectedHorizonMinutes === null
      || value.unifiedDecision?.selectedHorizonMinutes === undefined
        ? []
        : [String(value.unifiedDecision.selectedHorizonMinutes)]
    ))),
    vetoReasonCounts: counts(decisions.flatMap((value) => (
      value.unifiedDecision?.veto.reasons ?? []
    ))),
    activeCircuitCounts: counts(decisions.flatMap((value) => (
      value.unifiedDecision?.circuitBreaker.triggers ?? []
    ))),
  };
}

async function run(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const manifest = JSON.parse(
    await readFile(join(arguments_.runDir, "run-manifest.json"), "utf8"),
  ) as SourceManifest;
  const sourceOrigins = JSON.parse(
    await readFile(join(arguments_.runDir, "origins.json"), "utf8"),
  ) as SourceOrigin[];
  const scannerSnapshots = await loadScannerSnapshots(
    arguments_.runDir,
    manifest.smoke,
  );
  const scannerParity = await verifyScannerParity(scannerSnapshots);
  const symbols = [...new Set([
    "BTCUSDT",
    "ETHUSDT",
    ...manifest.candidateUniverse,
  ])];
  const bars = await loadBars(arguments_.runDir, symbols);
  const volatilityRegimes = causalSourceVolatilityRegimes(sourceOrigins);
  const residualValues = residualsFromOrigins(sourceOrigins, volatilityRegimes);
  const residuals = residualIndex(residualValues);
  const vetoSamples = vetoCalibrationSamples(
    sourceOrigins,
    volatilityRegimes,
    residuals,
  );
  const evaluationOrigins = sourceOrigins.filter((value) => value.phase === "evaluation");
  if (evaluationOrigins.length === 0) {
    throw new Error("No evaluation origins were materialized.");
  }

  const rustCachePath = join(arguments_.runDir, "rust-evidence.jsonl");
  const existingRust = await readFile(rustCachePath, "utf8")
    .then(parseRecoverableJsonLines<RustCacheRow>)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const rustByKey = new Map(
    existingRust.map((value) => [`${value.symbol}|${value.originAt}`, value]),
  );
  const socketDirectory = arguments_.rustSocket
    ? undefined
    : await mkdtemp(join(tmpdir(), "tpl-high-vol-rust-"));
  const socketPath = arguments_.rustSocket
    ?? join(socketDirectory!, "compute.sock");
  const worker = arguments_.rustSocket
    ? undefined
    : spawn(arguments_.rustBinary, [
        "serve",
        "--socket",
        socketPath,
        "--max-active",
        String(arguments_.rustConcurrency),
        "--max-connections",
        String(arguments_.rustConcurrency),
      ], {
        stdio: ["ignore", "ignore", "pipe"],
      });
  let rustStderr = "";
  worker?.stderr?.setEncoding("utf8");
  worker?.stderr?.on("data", (chunk: string) => {
    rustStderr = `${rustStderr}${chunk}`.slice(-8_000);
  });
  const client = new RustComputeClient({
    socketPath,
    poolSize: arguments_.rustConcurrency,
    timeoutMs: 300_000,
  });
  const debugRequestPath = join(arguments_.runDir, "debug-rust-request.json");
  let rustRequestCapture: Promise<void> | undefined;
  try {
    await access(debugRequestPath);
    rustRequestCapture = Promise.resolve();
  } catch {
    rustRequestCapture = undefined;
  }
  const debugPort: CryptoRustComputePort = {
    compute: async <T>(
      kind: "scalping_analysis",
      payload: Record<string, unknown>,
      options?: {
        includeArtifacts?: boolean;
        signal?: AbortSignal;
      },
    ) => {
      rustRequestCapture ??= atomicJson(debugRequestPath, { kind, payload });
      await rustRequestCapture;
      return client.compute<T>(kind, payload, options);
    },
  };
  const analyzer = new CryptoRustTechnicalAnalyzer(debugPort);
  const rustTasks = evaluationOrigins.flatMap((origin) => (
    sourceCandidates(origin).map((candidate) => ({ origin, candidate }))
  ));
  const pendingRustTasks = rustTasks.flatMap((task, taskIndex) => {
    const key = candidateKey(task.candidate.symbol, task.origin.originAt);
    return rustByKey.has(key) ? [] : [{ ...task, key, taskIndex }];
  });
  let completedRustTasks = rustTasks.length - pendingRustTasks.length;
  try {
    await waitForSocket(socketPath, worker);
    await processInOrderedBatches(
      pendingRustTasks,
      arguments_.rustConcurrency,
      async ({ origin, candidate, key, taskIndex }) => {
        const symbolBars = bars.get(candidate.symbol);
        if (!symbolBars) throw new Error(`Missing bars for ${candidate.symbol}.`);
        const inputBars = sliceBarsAt(
          symbolBars,
          origin.originMs,
          RUST_CONTEXT_BARS,
        ).map((value) => asBinanceKline(candidate.symbol, value));
        const market = candidate.microstructure;
        const orderbook = microstructureOrderbook(
          origin.originAt,
          origin.originMs,
          candidate.originClose,
          market,
        );
        const analysis = await analyzer.analyze({
          symbol: candidate.symbol,
          bars: inputBars,
          preset: "breakout",
          ...(orderbook ? { orderbook } : {}),
          ...(market
            && Number.isFinite(market.buyVolume)
            && Number.isFinite(market.sellVolume)
            ? {
                tradeStats: {
                  observedAt: origin.originAt,
                  buyVolume: market.buyVolume,
                  sellVolume: market.sellVolume,
                },
              }
            : {}),
        });
        const row: RustCacheRow = {
          originAt: origin.originAt,
          symbol: candidate.symbol,
          analysis,
          historicalMicrostructure: {
            depthSource: market?.depthMethod ?? "unavailable",
            spreadSource: market?.spreadMethod ?? "unavailable",
            directHistoricalBookTicker:
              market.directHistoricalBookTicker === true,
            projectedTopOfBook:
              market.directHistoricalBookTicker !== true,
          },
        };
        return { key, row, taskIndex };
      },
      async (batch) => {
        await appendFile(
          rustCachePath,
          batch.map(({ value }) => JSON.stringify(value.row)).join("\n") + "\n",
          { encoding: "utf8", mode: 0o600 },
        );
        for (const { value } of batch) rustByKey.set(value.key, value.row);
        completedRustTasks += batch.length;
        const current = batch.at(-1)!.value;
        await atomicJson(join(arguments_.runDir, "backtest-progress.json"), {
          schemaVersion: "high-vol-stack-backtest-progress/v1",
          status: "rust_evidence",
          pid: process.pid,
          heartbeatAt: new Date().toISOString(),
          completedOrigins: completedRustTasks,
          totalOrigins: rustTasks.length,
          currentSymbol: current.row.symbol,
          currentOriginAt: current.row.originAt,
          rustConcurrency: arguments_.rustConcurrency,
        });
      },
    );
    await atomicJsonLines(
      rustCachePath,
      [...rustByKey.values()].sort((left, right) => (
        left.originAt.localeCompare(right.originAt)
        || left.symbol.localeCompare(right.symbol)
      )),
    );
  } finally {
    client.close();
    if (worker) {
      worker.kill("SIGTERM");
      await new Promise((resolveExit) => {
        if (worker.exitCode !== null) resolveExit(undefined);
        else {
          worker.once("exit", resolveExit);
          setTimeout(resolveExit, 2_000);
        }
      });
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
    if (socketDirectory) {
      await rm(socketDirectory, { recursive: true, force: true });
    }
  }
  if (worker?.exitCode && worker.exitCode !== 0 && rustStderr) {
    throw new Error(`Rust worker failed: ${rustStderr}`);
  }

  const sharedRust = new Map<string, RustMarketEvidenceV2>();
  for (const origin of evaluationOrigins) {
    for (const candidate of sourceCandidates(origin)) {
      const key = candidateKey(candidate.symbol, origin.originAt);
      const cached = rustByKey.get(key);
      if (cached) {
        sharedRust.set(
          key,
          rustEvidenceAtDecisionBoundary(origin, cached),
        );
      }
    }
  }
  const rustVolatilityBaselines = causalRustVolatilityBaselines(
    evaluationOrigins,
    sharedRust,
  );
  await atomicJson(join(arguments_.runDir, "backtest-progress.json"), {
    schemaVersion: "high-vol-stack-backtest-progress/v1",
    status: "selector",
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
    completedOrigins: 0,
    totalOrigins: evaluationOrigins.length,
    currentSymbol: null,
    currentOriginAt: null,
  });
  const selectorByOrigin = new Map<string, {
    selection: HighVolatilityCandidateSelection;
    selected: SourceCandidate | undefined;
  }>();
  const selectorArtifacts: unknown[] = [];
  for (const [originIndex, origin] of evaluationOrigins.entries()) {
    const candidates = sourceCandidates(origin);
    const selection = selectHighVolatilityCandidates(
      candidates.flatMap((candidate) => {
        const key = candidateKey(candidate.symbol, origin.originAt);
        const rust = sharedRust.get(key);
        const forecast = candidate.models.chronos2;
        if (!rust || !forecast) return [];
        const regime = volatilityRegimes.get(key) ?? "normal";
        return [{
          symbol: candidate.symbol,
          scannerRank: candidate.scannerRank ?? Number.MAX_SAFE_INTEGER,
          scannerScore: candidate.scannerScore ?? 0,
          primaryEvidence: evidenceFor(
            forecast,
            "primary",
            origin,
            candidate,
            rust,
            regime,
            residuals,
            originCosts(candidate.microstructure),
          ),
          rustEvidence: rust,
          adx: adxFromAnalysis(rustByKey.get(key)!.analysis),
          fundingRate: candidate.microstructure.fundingRate,
          basisRate: candidate.microstructure.basisRate,
        }];
      }),
      2,
    );
    const selected = candidates.find(
      (candidate) => candidate.symbol === selection.selectedSymbols[0],
    );
    selectorByOrigin.set(origin.originAt, { selection, selected });
    selectorArtifacts.push({
      schemaVersion: "high-volatility-selector-decision/v1",
      originAt: origin.originAt,
      scannerOriginAt: origin.scannerOriginAt,
      rawScannerTopSymbol: origin.selectedSymbol,
      inferredCandidates: candidates.map((candidate) => candidate.symbol),
      recommendedSymbols: selection.selectedSymbols,
      executionSymbol: selected?.symbol ?? null,
      selection,
    });
    if (originIndex % 32 === 0 || originIndex === evaluationOrigins.length - 1) {
      await atomicJson(join(arguments_.runDir, "backtest-progress.json"), {
        schemaVersion: "high-vol-stack-backtest-progress/v1",
        status: "selector",
        pid: process.pid,
        heartbeatAt: new Date().toISOString(),
        completedOrigins: originIndex + 1,
        totalOrigins: evaluationOrigins.length,
        currentSymbol: selected?.symbol ?? null,
        currentOriginAt: origin.originAt,
      });
    }
  }
  await atomicJsonLines(
    join(arguments_.runDir, "selector-decisions.jsonl"),
    selectorArtifacts,
  );
  const variants = [
    "chronos2_rust",
    "chronos2_fincast_veto_rust",
  ] as const;
  const inputFor = (
    variant: (typeof variants)[number],
  ): HistoricalBacktestInput => {
      let selected = manifest.candidateUniverse[0]!;
      const origins = evaluationOrigins.map((origin) => {
        const selectedAtOrigin = selectorByOrigin.get(origin.originAt);
        const candidate = selectedAtOrigin?.selected;
        if (candidate) selected = candidate.symbol;
        const key = candidate
          ? candidateKey(candidate.symbol, origin.originAt)
          : undefined;
        return historicalOrigin(
          origin,
          candidate,
          variant,
          key ? rustByKey.get(key) : undefined,
          key ? rustVolatilityBaselines.get(key) : undefined,
          residuals,
          vetoSamples,
          key ? volatilityRegimes.get(key) ?? "normal" : "normal",
          bars,
          selected,
        );
      });
      return {
        simulationCase: "high_vol_crypto",
        symbol: `POINT_IN_TIME_MODEL_SELECTOR_TOP3:${variant}`,
        seed: SEED,
        initialEquity: INITIAL_EQUITY,
        origins,
        costStressMultiplier: 1,
      };
  };
  const historicalInputs: Record<
    (typeof variants)[number],
    HistoricalBacktestInput
  > = {
    chronos2_rust: inputFor("chronos2_rust"),
    chronos2_fincast_veto_rust: inputFor(
      "chronos2_fincast_veto_rust",
    ),
  };

  await atomicJson(join(arguments_.runDir, "backtest-progress.json"), {
    schemaVersion: "high-vol-stack-backtest-progress/v1",
    status: "policy-backtest",
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
    completedOrigins: 0,
    totalOrigins: evaluationOrigins.length * variants.length,
    currentSymbol: null,
    currentOriginAt: null,
  });
  const baseResults = Object.fromEntries(
    variants.map((variant) => [
      variant,
      runHistoricalSimulationBacktest(historicalInputs[variant]),
    ]),
  ) as Record<(typeof variants)[number], HistoricalBacktestResult>;
  await atomicJson(join(arguments_.runDir, "backtest-progress.json"), {
    schemaVersion: "high-vol-stack-backtest-progress/v1",
    status: "aggregate",
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
    completedOrigins: evaluationOrigins.length * variants.length,
    totalOrigins: evaluationOrigins.length * variants.length,
    currentSymbol: null,
    currentOriginAt: null,
  });
  const evaluationStartMs = Date.parse(manifest.evaluationStart);
  const evaluationEndMs = Date.parse(manifest.evaluationEndExclusive);
  const diagnosticFromMs = arguments_.diagnosticFrom
    ? Date.parse(arguments_.diagnosticFrom)
    : undefined;
  const holdoutFromMs = arguments_.holdoutFrom
    ? Date.parse(arguments_.holdoutFrom)
    : undefined;
  if (
    diagnosticFromMs !== undefined
    && (
      diagnosticFromMs <= evaluationStartMs
      || diagnosticFromMs >= evaluationEndMs
    )
  ) throw new Error("--diagnostic-from must fall inside the evaluation interval.");
  if (
    holdoutFromMs !== undefined
    && (
      holdoutFromMs <= (diagnosticFromMs ?? evaluationStartMs)
      || holdoutFromMs >= evaluationEndMs
    )
  ) throw new Error("--holdout-from must follow diagnostic start and precede evaluation end.");
  const segmentDefinitions = [
    ...(diagnosticFromMs === undefined
      ? []
      : [{
          id: "walk_forward_development",
          startMs: evaluationStartMs,
          endMs: diagnosticFromMs,
          contamination: "policy_development",
        }]),
    ...(diagnosticFromMs === undefined || holdoutFromMs === undefined
      ? []
      : [{
          id: "prior_research_diagnostic",
          startMs: diagnosticFromMs,
          endMs: holdoutFromMs,
          contamination: "previously_observed_not_holdout",
        }]),
    ...(holdoutFromMs === undefined
      ? []
      : [{
          id: "untouched_holdout",
          startMs: holdoutFromMs,
          endMs: evaluationEndMs,
          contamination: "untouched_after_policy_lock",
        }]),
  ];
  const segmentResults = Object.fromEntries(segmentDefinitions.map((segment) => [
    segment.id,
    {
      start: new Date(segment.startMs).toISOString(),
      endExclusive: new Date(segment.endMs).toISOString(),
      contamination: segment.contamination,
      variants: Object.fromEntries(variants.map((variant) => {
        const origins = historicalInputs[variant].origins.filter((origin) => {
          const originMs = Date.parse(origin.originAt);
          return originMs >= segment.startMs && originMs < segment.endMs;
        });
        return [
          variant,
          origins.length === 0
            ? null
            : stripDetails(runHistoricalSimulationBacktest({
                ...historicalInputs[variant],
                origins,
              })),
        ];
      })),
    },
  ]));
  const stressResults = Object.fromEntries(
    variants.map((variant) => [
      variant,
      Object.fromEntries(COST_STRESSES.map((stress) => [
        String(stress),
        stripDetails(runHistoricalSimulationBacktest({
          ...historicalInputs[variant],
          costStressMultiplier: stress,
        })),
      ])),
    ]),
  );
  for (const variant of variants) {
    await atomicJson(
      join(arguments_.runDir, `result-${variant}.json`),
      baseResults[variant],
    );
  }
  const a = baseResults.chronos2_rust.lanes.final_policy;
  const b = baseResults.chronos2_fincast_veto_rust.lanes.final_policy;
  const selectedSequence = evaluationOrigins.map(
    (value) => selectorByOrigin.get(value.originAt)?.selected?.symbol ?? null,
  );
  const selectionChanges = selectedSequence.slice(1).filter(
    (value, index) => value !== selectedSequence[index],
  ).length;
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    status: "complete",
    completedAt: new Date().toISOString(),
    sourceManifest: manifest,
    scannerParity,
    evaluation: {
      start: manifest.evaluationStart,
      endExclusive: manifest.evaluationEndExclusive,
      originCount: evaluationOrigins.length,
      selectedOriginCount: selectedSequence.filter(Boolean).length,
      scannerSelectionChanges: selectionChanges,
      rawScannerSymbolCounts: counts(evaluationOrigins.flatMap((value) => (
        value.selectedSymbol ? [value.selectedSymbol] : []
      ))),
      selectedSymbolCounts: counts(selectedSequence.flatMap((value) => (
        value ? [value] : []
      ))),
      selectorChangedRawTopCount: evaluationOrigins.filter((value) => {
        const selectedSymbol = selectorByOrigin.get(
          value.originAt,
        )?.selected?.symbol;
        return selectedSymbol !== undefined
          && selectedSymbol !== value.selectedSymbol;
      }).length,
      selectorArtifact: join(arguments_.runDir, "selector-decisions.jsonl"),
    },
    rust: {
      evidenceCount: sharedRust.size,
      engine: "worker/rust actual scalping_analysis via UDS",
      contextBars: RUST_CONTEXT_BARS,
      executionOptimizationVersion: "rust-ordered-batch/v1",
      concurrency: arguments_.rustConcurrency,
      directHistoricalBookTickerCount: [...rustByKey.values()].filter(
        (value) => value.historicalMicrostructure.directHistoricalBookTicker,
      ).length,
      spreadEstimator:
        "direct_bookTicker_when_available_else_max_exchange_tick_roll_effective_spread_v1",
      depthSource: "Binance bookDepth ±20bps 30s",
      originBoundaryNormalization:
        "binance_inclusive_close_999_to_rust_interval_boundary_000_v1",
      volatilityBaseline:
        "causal_per_symbol_rolling_median_96_origins_global_warmup_fallback_v1",
    },
    variants: {
      chronos2_rust: {
        metrics: a,
        modelMetrics: baseResults.chronos2_rust.modelMetrics,
        diagnostics: resultDiagnostics(baseResults.chronos2_rust),
      },
      chronos2_fincast_veto_rust: {
        metrics: b,
        modelMetrics: baseResults.chronos2_fincast_veto_rust.modelMetrics,
        diagnostics: resultDiagnostics(
          baseResults.chronos2_fincast_veto_rust,
        ),
      },
    },
    deltaBMinusA: {
      grossReturn: b.grossReturn - a.grossReturn,
      netReturn: b.netReturn - a.netReturn,
      costDrag: b.costDrag - a.costDrag,
      maximumDrawdown: b.maximumDrawdown - a.maximumDrawdown,
      sharpe: b.sharpe === null || a.sharpe === null ? null : b.sharpe - a.sharpe,
      turnover: b.turnover - a.turnover,
      tradeCount: b.tradeCount - a.tradeCount,
      vetoCount: b.vetoCount - a.vetoCount,
      cashRatio: b.cashRatio - a.cashRatio,
    },
    costStress: stressResults,
    segments: segmentResults,
    limitations: [
      "Candidate universe is a predeclared liquid USDT-perpetual research universe, not every historical Binance listing.",
      "Binance public archives do not provide bookTicker for every date; the artifact records direct coverage and otherwise uses the causal Roll estimator without fabricating quotes.",
      "The scanner hard-gate/rank is followed by a top-three Chronos-2 pNet/tail and non-directional Rust quality selector; only its first recommendation is executed.",
      "FinCast veto probabilities use only resolved prior outcomes at model × symbol × horizon and prefer an exact volatility-regime bucket before a causal all-regime fallback.",
      "Daily-loss and consecutive-loss circuit observations remain zero because historical-backtest/v1 does not yet derive lane-specific rolling loss state.",
    ],
  };
  await atomicJson(join(arguments_.runDir, "comparison-summary.json"), summary);
  await writeFile(
    join(arguments_.runDir, "COMPLETE"),
    `${summary.completedAt}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await atomicJson(join(arguments_.runDir, "backtest-progress.json"), {
    schemaVersion: "high-vol-stack-backtest-progress/v1",
    status: "complete",
    pid: process.pid,
    heartbeatAt: summary.completedAt,
    completedOrigins: evaluationOrigins.length,
    totalOrigins: evaluationOrigins.length,
    currentSymbol: null,
    currentOriginAt: null,
    summaryPath: join(arguments_.runDir, "comparison-summary.json"),
  });
  process.stdout.write(`${JSON.stringify({
    status: "complete",
    runDir: arguments_.runDir,
    netReturn: {
      chronos2Rust: a.netReturn,
      chronos2FincastVetoRust: b.netReturn,
    },
  })}\n`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`high-vol-stack-backtest-error: ${message}\n`);
  process.exitCode = 1;
});
