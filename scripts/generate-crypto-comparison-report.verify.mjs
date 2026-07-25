import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  normalizeReportInputs,
  pendingReportData,
  renderCryptoComparisonReport,
  renderReportFromInputs,
} from "./generate-crypto-comparison-report.mjs";

const execFileAsync = promisify(execFile);
const MARKET = {
  kind: "crypto_futures",
  venue: "BINANCE_USDM",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
};
const QUANTILES = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];
const SECRET_SENTINEL = "SECRET_SENTINEL_DO_NOT_LEAK";
const RAW_PATH_SENTINEL = "/models/private/checkpoint-v1.pth";
const PINNED_MODELS = {
  kronos_base: {
    modelId: "NeoQuasar/Kronos-base",
    modelRevision: "2b554741eca47781b64468546e77fef3e85130e6",
    sourceRevision: "67b630e67f6a18c9e9be918d9b4337c960db1e9a",
    loaderVersion: "kronos-source-67b630e",
    license: "MIT",
    tokenizerId: "NeoQuasar/Kronos-Tokenizer-base",
    tokenizerRevision: "0e0117387f39004a9016484a186a908917e22426",
  },
  fincast: {
    modelId: "Vincent05R/FinCast",
    modelRevision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
    sourceRevision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
    loaderVersion: "fincast-source-488b19d",
    license: "Apache-2.0",
    tokenizerId: null,
    tokenizerRevision: null,
  },
};

function pinnedProvenance(id) {
  const fincast = id === "fincast";
  return {
    ...PINNED_MODELS[id],
    loaded: true,
    device: "cuda",
    deviceName: "Tesla P40",
    cudaCapability: "6.1",
    attentionBackend: "math",
    precision: fincast ? "fp16" : "fp32",
    precisionValidation: fincast ? "passed" : "not_required",
    precisionFallbackUsed: false,
    peakVramBytes: fincast ? 5_368_709_120 : 2_147_483_648,
    peakVramMeasurement: "cuda_allocated_or_reserved",
    peakVramMb: fincast ? 5_120 : 2_048,
    memoryStatus: "ok",
    quantileTailPolicy: fincast ? "tail_clamped_q10_q90" : "native",
    precisionFailureReasons: [],
  };
}

function replayMetrics(scale) {
  return [5, 15, 30, 60].map((horizonMinutes, horizonIndex) => ({
    horizonMinutes,
    count: 100 - horizonIndex,
    meanPinballLoss: scale * (horizonIndex + 1) * 0.0001,
    medianReturnMae: scale * (horizonIndex + 1) * 0.0002,
    directionAccuracy: 0.55 + horizonIndex * 0.01,
    quantiles: QUANTILES.map((quantile) => {
      const observedCoverage = Math.min(1, quantile + (horizonIndex - 1) * 0.001);
      return {
        quantile,
        pinballLoss: scale * (horizonIndex + 1) * (quantile + 0.1) * 0.0001,
        observedCoverage,
        calibrationError: observedCoverage - quantile,
      };
    }),
  }));
}

function replayFixture() {
  const inputDigest = "1".repeat(64);
  return {
    schemaVersion: "crypto-model-comparison-replay/v1",
    generatedAt: "2026-07-25T03:00:00.000Z",
    market: MARKET,
    symbol: "BTCUSDT",
    window: {
      startAt: "2026-07-18T00:00:00.000Z",
      endExclusiveAt: "2026-07-25T00:00:00.000Z",
      completeUtcDays: 7,
      barCount: 10_080,
      contextPrefetchBarCount: 511,
      outcomeTailBarCount: 60,
      inputBarCount: 10_651,
      originCount: 672,
      originStrideMinutes: 15,
      futureBarsPerOrigin: 60,
    },
    requestId: SECRET_SENTINEL,
    inputDigest,
    costAssumptions: {
      commission_bps_per_side: 4,
      tax_bps_on_exit: 0,
      spread_bps_round_trip: 2,
      slippage_bps_per_side: 1,
    },
    lanes: {
      kronos_base: {
        lane: "kronos_base",
        expectedModelId: "NeoQuasar/Kronos-base",
        observedModelId: "NeoQuasar/Kronos-base",
        availability: "available",
        identityVerified: true,
        inputDigest,
        recordDigest: "2".repeat(64),
        effectiveContextDigest: "7".repeat(64),
        effectiveContextBars: 512,
        provenance: pinnedProvenance("kronos_base"),
        latencyMs: 312.5,
        fallbackUsed: false,
        metrics: replayMetrics(1),
        ignoredApiKey: SECRET_SENTINEL,
      },
      fincast: {
        lane: "fincast",
        expectedModelId: "Vincent05R/FinCast",
        observedModelId: "Vincent05R/FinCast",
        availability: "available",
        identityVerified: true,
        inputDigest,
        recordDigest: "2".repeat(64),
        effectiveContextDigest: "7".repeat(64),
        effectiveContextBars: 512,
        provenance: pinnedProvenance("fincast"),
        latencyMs: 281.25,
        fallbackUsed: false,
        metrics: replayMetrics(0.9),
        signature: SECRET_SENTINEL,
      },
    },
    comparison: {
      identitiesVerified: true,
      sameInputDigest: true,
      sameRecords: true,
      sameOrigin: true,
      sameContext: true,
      sameCosts: true,
      sameFillBarrier: true,
      automaticWinner: null,
      outcome: "review_required",
    },
    credentials: {
      apiKey: SECRET_SENTINEL,
      secretKey: SECRET_SENTINEL,
    },
  };
}

function laneMetrics(multiplier) {
  return {
    pinballLoss: multiplier * 0.00012,
    medianReturnMae: multiplier * 0.00031,
    directionAccuracy: 0.58,
    quantileCoverage: 0.81,
    calibrationError: 0.02,
    netPnl: multiplier * 18.25,
    profitFactor: 1.42,
    winRate: 0.56,
    maxDrawdown: 0.014,
    turnover: 2.7,
    funding: -0.42,
    fees: 5.15,
    latencyMs: multiplier * 145,
    availabilityRatio: 0.99,
    timeoutCount: 1,
    peakVramMb: multiplier * 5_120,
    leverageDistribution: [2, 3, 3, 5],
  };
}

function shadowFixture() {
  const timestamps = [
    "2026-07-25T03:00:59.999Z",
    "2026-07-25T03:01:59.999Z",
    "2026-07-25T03:02:59.999Z",
    "2026-07-25T03:03:59.999Z",
  ];
  return {
    schemaVersion: "crypto-comparison-shadow/v1",
    generatedAt: "2026-07-25T05:05:00.000Z",
    phase: "completed",
    market: MARKET,
    symbol: "BTCUSDT",
    durationMinutes: 120,
    executionMode: "paper",
    executionLane: "kronos_base",
    realOrder: false,
    settlementComplete: true,
    scanner: {
      scannerSnapshotId: "a".repeat(64),
      criterion: "volatility",
      candidates: [
        {
          rank: 1,
          symbol: "BTCUSDT",
          score: 0.94,
          quoteVolume: 2_500_000_000,
          relativeVolume: 1.8,
          realizedVolatility60m: 0.012,
          priceChangePercent24h: 4.2,
          atrPercent14: 0.009,
          spreadBps: 1.25,
          dataQuality: { status: "available" },
          unknownBalance: SECRET_SENTINEL,
        },
        {
          rank: 2,
          symbol: "ETHUSDT",
          score: 0.88,
          quoteVolume: 1_900_000_000,
          relativeVolume: 1.55,
          realizedVolatility60m: 0.01,
          priceChangePercent24h: 3.1,
          atrPercent14: 0.008,
          spreadBps: 1.5,
          dataQuality: { status: "available" },
        },
      ],
    },
    candles: timestamps.map((timestamp, index) => {
      const open = 60_000 + index * 20;
      const close = open + (index % 2 ? -12 : 15);
      return {
        timestamp,
        open,
        high: Math.max(open, close) + 8,
        low: Math.min(open, close) - 7,
        close,
        volume: 100 + index,
        secret: SECRET_SENTINEL,
      };
    }),
    fills: [
      {
        timestamp: timestamps[1],
        lane: "kronos_base",
        action: "open",
        side: "buy",
        price: 60_018,
        quantity: 0.01,
        cost: 0.9,
        fee: 0.5,
        slippage: 0.4,
        funding: 0,
        realizedPnl: 0,
      },
      {
        timestamp: timestamps[2],
        lane: "fincast",
        action: "open",
        side: "sell",
        price: 60_035,
        quantity: 0.01,
        cost: 0.95,
        fee: 0.5,
        slippage: 0.45,
        funding: 0,
        realizedPnl: 0,
      },
    ],
    equityByLane: {
      kronos_base: timestamps.map((timestamp, index) => ({
        timestamp,
        equity: 10_000 + index * 4,
        drawdown: index === 2 ? 0.001 : 0,
      })),
      fincast: timestamps.map((timestamp, index) => ({
        timestamp,
        equity: 10_000 + index * 3,
        drawdown: index === 1 ? 0.0005 : 0,
      })),
    },
    comparison: {
      outcome: "review_required",
      sameOrigin: true,
      sameContext: true,
      sameCosts: true,
      sameFillBarrier: true,
      lanes: [
        {
          id: "kronos_base",
          status: "completed",
          precision: "fp32",
          metrics: laneMetrics(1),
          provenance: {
            ...pinnedProvenance("kronos_base"),
            modelDigest: `sha256:${"3".repeat(64)}`,
            imageDigest: `sha256:${"4".repeat(64)}`,
            attempts: 120,
            successes: 119,
          },
          errors: ["worker_timeout"],
        },
        {
          id: "fincast",
          status: "completed",
          precision: "fp16",
          metrics: laneMetrics(0.82),
          provenance: {
            ...pinnedProvenance("fincast"),
            modelDigest: `sha256:${"5".repeat(64)}`,
            imageDigest: `sha256:${"6".repeat(64)}`,
            attempts: 120,
            successes: 120,
          },
          errors: [SECRET_SENTINEL, RAW_PATH_SENTINEL],
        },
      ],
    },
    evidence: {
      onlyFinalKlinesTriggerInference: true,
      fillRequiresStrictlyLaterEvent: true,
      realOrder: false,
      settlementComplete: true,
    },
    apiKey: SECRET_SENTINEL,
    secretKey: SECRET_SENTINEL,
    signature: SECRET_SENTINEL,
    balance: SECRET_SENTINEL,
    unknown: {
      nested: SECRET_SENTINEL,
    },
  };
}

function finalV7PayloadFixture() {
  const safe = shadowFixture();
  return {
    summary: {
      schemaVersion: "ai-paper-simulation/v7",
      phase: "completed",
      market: MARKET,
      settlementComplete: true,
      realOrderApiUsed: false,
      unknownAccountBalance: SECRET_SENTINEL,
    },
    result: {
      snapshot: {
        schemaVersion: "ai-paper-simulation/v7",
        phase: "completed",
        expiresAt: safe.generatedAt,
        market: MARKET,
        selected: safe.scanner.candidates,
        charts: [{ symbol: safe.symbol, bars: safe.candles }],
        trades: safe.fills,
        executionMode: "paper",
        executionLane: safe.executionLane,
        capabilities: { paper: true, realOrder: false },
        modelComparison: safe.comparison,
        terminalSettlement: { settlementComplete: true },
      },
      report: {
        configuration: {
          market: MARKET,
          durationMinutes: safe.durationMinutes,
          execution: { mode: "paper" },
          executionLane: safe.executionLane,
        },
        selected: safe.scanner.candidates,
        trades: safe.fills,
        equity: safe.equityByLane.kronos_base,
        modelComparison: safe.comparison,
        settlementComplete: true,
        evidence: {
          scannerSnapshotId: safe.scanner.scannerSnapshotId,
          onlyFinalKlinesTriggerInference: true,
          fillRequiresStrictlyLaterEvent: true,
          realOrder: false,
        },
      },
    },
    artifacts: [
      {
        type: "simulation-selection",
        content: {
          scannerSnapshotId: safe.scanner.scannerSnapshotId,
          criterion: safe.scanner.criterion,
          rankedCandidates: safe.scanner.candidates,
          realOrder: false,
        },
      },
      {
        type: "simulation-equity",
        content: { lanes: safe.equityByLane },
      },
      {
        type: "simulation-provenance",
        content: {
          modelLanes: safe.comparison.lanes.map((lane) => ({
            lane: lane.id,
            ...lane.provenance,
            precision: lane.precision,
            peakVramMb: lane.metrics.peakVramMb,
            errors: lane.errors,
          })),
          rawSignedResponse: SECRET_SENTINEL,
        },
      },
    ],
    credentials: { apiKey: SECRET_SENTINEL },
  };
}

function assertSafeStandaloneHtml(html) {
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<script[^>]+\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link[^>]+\bhref\s*=/i);
  assert.doesNotMatch(html, /\bfetch\s*\(/i);
  assert.doesNotMatch(html, /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/);
  assert.doesNotMatch(html, /placeholder/i);
  assert.doesNotMatch(html, new RegExp(SECRET_SENTINEL, "i"));
  assert.doesNotMatch(html, new RegExp(RAW_PATH_SENTINEL.replaceAll("/", "\\/"), "i"));
  assert.doesNotMatch(html, /"automaticWinner"/);
}

test("deterministically renders a complete whitelist-only standalone report", () => {
  const replay = replayFixture();
  const shadow = shadowFixture();
  const first = renderReportFromInputs(replay, shadow);
  const second = renderReportFromInputs(structuredClone(replay), structuredClone(shadow));

  assert.equal(first, second);
  assertSafeStandaloneHtml(first);
  assert.doesNotMatch(first, /검증 대기|실제 비교 결과 생성 전/);
  for (const label of [
    "SCANNER SNAPSHOT",
    "확정 candle",
    "Paper equity",
    "Drawdown",
    "동일 origin",
    "동일 context",
    "동일 비용",
    "공통 fill barrier",
    "Pinball loss",
    "Median-return MAE",
    "방향 정확도",
    "Quantile coverage",
    "비용 후 PnL",
    "Profit factor",
    "Win rate",
    "Precision",
    "Inference latency",
    "Peak VRAM",
    "Errors",
    "PROVENANCE",
    "LIMITATIONS",
    "review_required",
  ]) {
    assert.match(first, new RegExp(label, "i"), `missing label: ${label}`);
  }
  assert.deepEqual(
    [...first.matchAll(/data-flow-step="(\d)"/g)].map((match) => match[1]),
    ["1", "2", "3", "4"],
  );
  assert.match(first, /redacted_error/);
});

test("CLI writes the same deterministic document from JSON inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crypto-report-generator-"));
  const replayPath = join(directory, "replay.json");
  const shadowPath = join(directory, "shadow.json");
  const outputPath = join(directory, "report.html");
  const replay = replayFixture();
  const shadow = shadowFixture();
  await writeFile(replayPath, JSON.stringify(replay), "utf8");
  await writeFile(shadowPath, JSON.stringify(shadow), "utf8");

  await execFileAsync(process.execPath, [
    resolve("scripts/generate-crypto-comparison-report.mjs"),
    "--replay",
    replayPath,
    "--shadow",
    shadowPath,
    "--output",
    outputPath,
  ], { cwd: resolve(".") });

  const html = await readFile(outputPath, "utf8");
  assert.equal(html, renderReportFromInputs(replay, shadow));
  assertSafeStandaloneHtml(html);
});

test("accepts the final v7 runtime payload shape without copying artifact unknowns", () => {
  const html = renderReportFromInputs(replayFixture(), finalV7PayloadFixture());
  assertSafeStandaloneHtml(html);
  assert.match(html, /BTCUSDT/);
  assert.match(html, /worker_timeout/);
  assert.match(html, /review_required/);
  assert.doesNotMatch(html, new RegExp(SECRET_SENTINEL, "i"));
});

test("preserves the exact replay window, context evidence, and pinned provenance", () => {
  const normalized = normalizeReportInputs(replayFixture(), shadowFixture());
  assert.deepEqual(normalized.replay.window, {
    startAt: "2026-07-18T00:00:00.000Z",
    endExclusiveAt: "2026-07-25T00:00:00.000Z",
    completeUtcDays: 7,
    barCount: 10_080,
    originCount: 672,
    originStrideMinutes: 15,
    futureBarsPerOrigin: 60,
    contextPrefetchBarCount: 511,
    outcomeTailBarCount: 60,
    inputBarCount: 10_651,
  });
  assert.equal(normalized.models.kronos_base.provenance.effectiveContextBars, 512);
  assert.equal(
    normalized.models.kronos_base.provenance.effectiveContextDigest,
    "7".repeat(64),
  );
  assert.deepEqual(
    {
      modelId: normalized.models.fincast.provenance.modelId,
      modelRevision: normalized.models.fincast.provenance.modelRevision,
      sourceRevision: normalized.models.fincast.provenance.sourceRevision,
      loaderVersion: normalized.models.fincast.provenance.loaderVersion,
      device: normalized.models.fincast.provenance.device,
      deviceName: normalized.models.fincast.provenance.deviceName,
      cudaCapability: normalized.models.fincast.provenance.cudaCapability,
      precision: normalized.models.fincast.provenance.precision,
      precisionValidation: normalized.models.fincast.provenance.precisionValidation,
    },
    {
      modelId: "Vincent05R/FinCast",
      modelRevision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
      sourceRevision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
      loaderVersion: "fincast-source-488b19d",
      device: "cuda",
      deviceName: "Tesla P40",
      cudaCapability: "6.1",
      precision: "fp16",
      precisionValidation: "passed",
    },
  );
});

test("rejects replay window and effective-context evidence that are not exact", () => {
  for (const [field, value] of [
    ["contextPrefetchBarCount", 510],
    ["outcomeTailBarCount", 59],
    ["inputBarCount", 10_650],
    ["originCount", 671],
  ]) {
    const replay = replayFixture();
    replay.window[field] = value;
    assert.throws(
      () => normalizeReportInputs(replay, shadowFixture()),
      /Replay window must contain seven complete UTC days/,
      field,
    );
  }

  const replay = replayFixture();
  replay.lanes.fincast.effectiveContextBars = 511;
  assert.throws(
    () => normalizeReportInputs(replay, shadowFixture()),
    /effective context must contain exactly 512 bars/,
  );

  const mismatchedContext = replayFixture();
  mismatchedContext.lanes.fincast.effectiveContextDigest = "8".repeat(64);
  assert.throws(
    () => normalizeReportInputs(mismatchedContext, shadowFixture()),
    /context comparison conflicts with lane evidence/,
  );
});

test("rejects valid but divergent replay and shadow precision provenance", () => {
  const shadow = shadowFixture();
  const fincast = shadow.comparison.lanes.find((lane) => lane.id === "fincast");
  fincast.precision = "fp32";
  fincast.provenance.precision = "fp32";
  fincast.provenance.precisionValidation = "fallback_fp32";
  fincast.provenance.precisionFallbackUsed = true;
  fincast.provenance.precisionFailureReasons = ["mixed_unsupported_operation"];
  assert.throws(
    () => normalizeReportInputs(replayFixture(), shadow),
    /Replay and shadow fincast precision provenance must match/,
  );
});

test("rejects unknown or unsafe structured provenance instead of rendering it", () => {
  const unknownPrecision = shadowFixture();
  unknownPrecision.comparison.lanes[1].precision = "unknown";
  unknownPrecision.comparison.lanes[1].provenance.precision = "unknown";
  assert.throws(
    () => renderReportFromInputs(replayFixture(), unknownPrecision),
    /Shadow fincast precision is invalid/,
  );

  const unsafeRevision = replayFixture();
  unsafeRevision.lanes.fincast.provenance.modelRevision = RAW_PATH_SENTINEL;
  assert.throws(
    () => renderReportFromInputs(unsafeRevision, shadowFixture()),
    /model revision does not match the pinned provenance/,
  );
});

test("rejects shadow payloads that omit terminal phase or settlement evidence", () => {
  const missingPhase = shadowFixture();
  delete missingPhase.phase;
  assert.throws(
    () => normalizeReportInputs(replayFixture(), missingPhase),
    /terminal simulation payload/,
  );

  const missingSettlement = shadowFixture();
  delete missingSettlement.settlementComplete;
  delete missingSettlement.evidence.settlementComplete;
  assert.throws(
    () => normalizeReportInputs(replayFixture(), missingSettlement),
    /terminal settlement evidence is missing/,
  );

  const conflictingPhase = finalV7PayloadFixture();
  conflictingPhase.result.snapshot.phase = "failed";
  assert.throws(
    () => normalizeReportInputs(replayFixture(), conflictingPhase),
    /terminal phase evidence conflicts/,
  );

  const conflictingSettlement = finalV7PayloadFixture();
  conflictingSettlement.result.snapshot.terminalSettlement.settlementComplete = false;
  assert.throws(
    () => normalizeReportInputs(replayFixture(), conflictingSettlement),
    /terminal settlement evidence conflicts/,
  );
});

test("pending scaffold remains explicit and contains no synthetic result", () => {
  const html = renderCryptoComparisonReport(pendingReportData());
  assertSafeStandaloneHtml(html);
  assert.match(html, /검증 대기/);
  assert.match(html, /실제 비교 결과 생성 전/);
  assert.match(html, /inconclusive/);
  assert.doesNotMatch(html, /BTCUSDT|2026-07-25T05:05:00/);
});
