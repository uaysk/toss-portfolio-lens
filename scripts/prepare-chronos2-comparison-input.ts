import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  OfficialBinanceUsdmRestMarketData,
} from "../server/crypto/binance-market-data.js";
import {
  hasChronos2DerivativeMarketData,
  loadChronos2DerivativeCovariates,
  paceChronos2DerivativeMarketData,
} from "../server/crypto/chronos2-covariates.js";
import {
  loadCryptoReplayRawContexts,
} from "../server/crypto/crypto-model-replay.js";
import {
  writeFinCastRawInputArtifact,
  type FinCastRawInputRow,
} from "../server/crypto/fincast-raw-artifact.js";

type Arguments = {
  output: string;
  endExclusive: number;
  durationHours: number;
  modelSeed: number;
  contextBars: 512 | 1024 | 2048 | 4096 | 8192;
};

const DERIVATIVE_REQUEST_SPACING_MS = 250;
const DERIVATIVE_RATE_LIMIT_BACKOFF_MS = 60_000;
const DERIVATIVE_RATE_LIMIT_RETRIES = 2;

function sha256(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

async function atomicFile(path: string, payload: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function emptyDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("--output must be an absolute normalized path.");
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("comparison input directory must not traverse symlinks.");
  }
  if ((await readdir(path)).length !== 0) {
    throw new Error("comparison input directory must be empty.");
  }
  return path;
}

function requiredValue(args: readonly string[], index: number): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${args[index]} requires a value.`);
  return value;
}

function parseArguments(args: readonly string[]): Arguments {
  let output: string | undefined;
  let endExclusive: number | undefined;
  let durationHours = 48;
  let modelSeed = 0;
  let contextBars: Arguments["contextBars"] = 512;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--output") {
      output = requiredValue(args, index);
    } else if (name === "--end-exclusive") {
      endExclusive = Date.parse(requiredValue(args, index));
    } else if (name === "--duration-hours") {
      durationHours = Number(requiredValue(args, index));
    } else if (name === "--model-seed") {
      modelSeed = Number(requiredValue(args, index));
    } else if (name === "--context-bars") {
      contextBars = Number(requiredValue(args, index)) as Arguments["contextBars"];
    } else {
      throw new Error(`Unknown argument: ${name ?? ""}`);
    }
    index += 1;
  }
  if (!output || !isAbsolute(output) || resolve(output) !== output) {
    throw new Error("--output must be an absolute normalized path.");
  }
  if (
    !Number.isSafeInteger(endExclusive)
    || endExclusive! <= 0
    || endExclusive! % 60_000 !== 0
  ) {
    throw new Error("--end-exclusive must be an exact UTC minute.");
  }
  if (!Number.isSafeInteger(durationHours) || durationHours < 1 || durationHours > 840) {
    throw new Error("--duration-hours must be an integer in 1..840.");
  }
  if (!Number.isSafeInteger(modelSeed) || modelSeed < 0) {
    throw new Error("--model-seed must be a non-negative safe integer.");
  }
  if (![512, 1024, 2048, 4096, 8192].includes(contextBars)) {
    throw new Error("--context-bars must be one of 512/1024/2048/4096/8192.");
  }
  return {
    output,
    endExclusive: endExclusive!,
    durationHours,
    modelSeed,
    contextBars,
  };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const output = await emptyDirectory(arguments_.output);
  const rest = new OfficialBinanceUsdmRestMarketData(30_000);
  if (!hasChronos2DerivativeMarketData(rest)) {
    throw new Error("The configured Binance REST provider lacks Chronos-2 derivative history methods.");
  }
  const derivativeRest = paceChronos2DerivativeMarketData(rest, {
    minimumSpacingMs: DERIVATIVE_REQUEST_SPACING_MS,
    rateLimitBackoffMs: DERIVATIVE_RATE_LIMIT_BACKOFF_MS,
    maximumRateLimitRetries: DERIVATIVE_RATE_LIMIT_RETRIES,
  });
  const symbols = ["BTCUSDT", "ETHUSDT"] as const;
  const captures = [];
  const derivative = [];
  for (const symbol of symbols) {
    const capture = await loadCryptoReplayRawContexts({
      rest,
      symbol,
      durationHours: arguments_.durationHours,
      endExclusive: arguments_.endExclusive,
      contextBars: arguments_.contextBars,
    });
    captures.push(capture);
    derivative.push(
      await loadChronos2DerivativeCovariates(derivativeRest, capture.marketBars),
    );
  }
  const rows: FinCastRawInputRow[] = captures
    .flatMap((capture) => capture.rows)
    .sort((left, right) => (
      Date.parse(left.origin) - Date.parse(right.origin)
      || left.instrumentKey.localeCompare(right.instrumentKey)
    ));
  const fincastDirectory = join(output, "fincast-input");
  const fincast = await writeFinCastRawInputArtifact({
    directory: fincastDirectory,
    cadenceSeconds: 60,
    modelSeed: arguments_.modelSeed,
    rows: rows.map((row) => ({
      ...row,
      closes: row.closes.slice(-512),
    })),
    metadata: {
      purpose: "chronos2-vs-fincast-aligned-comparison",
      source: "Binance USD-M public finalized 1m klines",
      durationHours: arguments_.durationHours,
      endExclusiveAt: new Date(arguments_.endExclusive).toISOString(),
      contextBars: 512,
      sourceContextBars: arguments_.contextBars,
      symbols: [...symbols],
      originStrideMinutes: 15,
      derivativeCoverageDigests: Object.fromEntries(
        derivative.map((value) => [value.symbol, value.digest]),
      ),
      derivativeRequestPolicy: {
        minimumSpacingMs: DERIVATIVE_REQUEST_SPACING_MS,
        rateLimitBackoffMs: DERIVATIVE_RATE_LIMIT_BACKOFF_MS,
        maximumRateLimitRetries: DERIVATIVE_RATE_LIMIT_RETRIES,
      },
    },
  });
  const bars = derivative
    .flatMap((coverage) => coverage.bars)
    .sort((left, right) => (
      left.symbol.localeCompare(right.symbol)
      || left.openTime - right.openTime
    ));
  const marketPayload = Buffer.from(
    `${bars.map((bar) => JSON.stringify({
      symbol: bar.symbol,
      interval: bar.interval,
      open_time: bar.openTime,
      close_time: bar.closeTime,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      quote_volume: bar.quoteVolume,
      trade_count: bar.tradeCount,
      taker_buy_volume: bar.takerBuyVolume,
      taker_buy_quote_volume: bar.takerBuyQuoteVolume,
      mark_price: bar.markPrice,
      index_price: bar.indexPrice,
      premium_index: bar.premiumIndex,
      funding_rate: bar.fundingRate,
      final: bar.final,
    })).join("\n")}\n`,
    "utf8",
  );
  const marketPath = join(output, "market-bars.jsonl");
  await atomicFile(marketPath, marketPayload);
  const marketDataManifest = {
    schema_version: "fincast-replay-market-data/v1",
    generated_at: new Date().toISOString(),
    raw_input_manifest_sha256: fincast.manifestSha256,
    symbols,
    duration_hours: arguments_.durationHours,
    end_exclusive_at: new Date(arguments_.endExclusive).toISOString(),
    context_bars: arguments_.contextBars,
    context_prefetch_bar_count: arguments_.contextBars - 1,
    files: {
      bars: {
        name: "market-bars.jsonl",
        size_bytes: marketPayload.byteLength,
        sha256: sha256(marketPayload),
        record_count: bars.length,
      },
    },
  };
  const marketDataManifestPayload = Buffer.from(
    `${JSON.stringify(marketDataManifest, null, 2)}\n`,
    "utf8",
  );
  const marketDataManifestPath = join(output, "market-manifest.json");
  await atomicFile(marketDataManifestPath, marketDataManifestPayload);
  const manifest = {
    schema_version: "chronos2-fincast-comparison-source/v1",
    generated_at: new Date().toISOString(),
    source: "Binance USD-M public market-data endpoints",
    symbols,
    duration_hours: arguments_.durationHours,
    end_exclusive_at: new Date(arguments_.endExclusive).toISOString(),
    context_bars: arguments_.contextBars,
    context_prefetch_bar_count: arguments_.contextBars - 1,
    origin_stride_minutes: 15,
    row_count: rows.length,
    fincast_input: {
      manifest: "fincast-input/manifest.json",
      manifest_sha256: fincast.manifestSha256,
      origins: "fincast-input/origins.jsonl",
      origins_sha256: fincast.manifest.files.origins.sha256,
    },
    market_bars: {
      name: "market-bars.jsonl",
      size_bytes: marketPayload.byteLength,
      sha256: sha256(marketPayload),
      row_count: bars.length,
      fields: [
        "OHLCV",
        "quote_volume",
        "trade_count",
        "taker_buy_volume",
        "taker_buy_quote_volume",
        "mark_price",
        "index_price",
        "premium_index",
        "causally_forward_filled_funding_rate",
      ],
    },
    market_data_manifest: {
      name: "market-manifest.json",
      size_bytes: marketDataManifestPayload.byteLength,
      sha256: sha256(marketDataManifestPayload),
      schema_version: marketDataManifest.schema_version,
    },
    derivative_coverage: derivative.map((value) => ({
      symbol: value.symbol,
      start_at: value.startAt,
      end_exclusive_at: value.endExclusiveAt,
      row_count: value.rowCount,
      funding_observation_count: value.fundingObservationCount,
      causal_funding_policy: value.causalFundingPolicy,
      digest: value.digest,
    })),
    derivative_request_policy: {
      minimum_spacing_ms: DERIVATIVE_REQUEST_SPACING_MS,
      rate_limit_backoff_ms: DERIVATIVE_RATE_LIMIT_BACKOFF_MS,
      maximum_rate_limit_retries: DERIVATIVE_RATE_LIMIT_RETRIES,
    },
  };
  const manifestPayload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestPath = join(output, "source-manifest.json");
  await atomicFile(manifestPath, manifestPayload);
  process.stdout.write(`${JSON.stringify({
    schema_version: manifest.schema_version,
    manifest_path: manifestPath,
    manifest_sha256: sha256(manifestPayload),
    fincast_manifest_path: fincast.manifestPath,
    market_bars_path: marketPath,
    market_data_manifest_path: marketDataManifestPath,
    row_count: rows.length,
    market_bar_count: bars.length,
    symbols,
    duration_hours: arguments_.durationHours,
    end_exclusive_at: new Date(arguments_.endExclusive).toISOString(),
    context_bars: arguments_.contextBars,
  })}\n`);
}

await main();
