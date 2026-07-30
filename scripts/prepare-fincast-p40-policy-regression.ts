import { createHash, randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  OfficialBinanceUsdmRestMarketData,
} from "../server/crypto/binance-market-data.js";
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
};

async function atomicWrite(path: string, payload: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function writeMarketDataArtifact(input: {
  output: string;
  captures: Awaited<ReturnType<typeof loadCryptoReplayRawContexts>>[];
  rawInputManifestSha256: string;
  durationHours: number;
  endExclusive: number;
}): Promise<{
  manifestPath: string;
  manifestSha256: string;
  barsSha256: string;
  recordCount: number;
}> {
  const bars = input.captures
    .flatMap((capture) => capture.marketBars)
    .sort((left, right) => (
      left.symbol.localeCompare(right.symbol)
      || left.openTime - right.openTime
    ));
  const barsPayload = bars.map((bar) => JSON.stringify({
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
    final: bar.final,
  })).join("\n") + "\n";
  const barsSha256 = createHash("sha256").update(barsPayload).digest("hex");
  const barsPath = join(input.output, "market-bars.jsonl");
  await atomicWrite(barsPath, barsPayload);
  const manifest = {
    schema_version: "fincast-replay-market-data/v1",
    source: "Binance USD-M public finalized 1m klines",
    duration_hours: input.durationHours,
    end_exclusive_at: new Date(input.endExclusive).toISOString(),
    origin_stride_minutes: 15,
    outcome_tail_minutes: 60,
    symbols: input.captures.map((capture) => capture.symbol).sort(),
    raw_input_manifest_sha256: input.rawInputManifestSha256,
    files: {
      bars: {
        name: "market-bars.jsonl",
        size_bytes: Buffer.byteLength(barsPayload),
        sha256: barsSha256,
        record_count: bars.length,
      },
    },
  };
  const manifestPayload = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = join(input.output, "market-data.json");
  await atomicWrite(manifestPath, manifestPayload);
  return {
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestPayload).digest("hex"),
    barsSha256,
    recordCount: bars.length,
  };
}

function parseArguments(argv: readonly string[]): Arguments {
  let output: string | undefined;
  let endExclusive: number | undefined;
  let durationHours = 48;
  let modelSeed = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${name} requires a value.`);
    if (name === "--output") output = value;
    else if (name === "--end-exclusive") endExclusive = Date.parse(value);
    else if (name === "--duration-hours") durationHours = Number(value);
    else if (name === "--model-seed") modelSeed = Number(value);
    else throw new Error(`Unknown argument: ${name}`);
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
  if (!Number.isSafeInteger(modelSeed) || modelSeed < 0) {
    throw new Error("--model-seed must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(durationHours) || durationHours < 1 || durationHours > 840) {
    throw new Error("--duration-hours must be an integer in 1..840.");
  }
  return {
    output,
    endExclusive: endExclusive!,
    durationHours,
    modelSeed,
  };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const rest = new OfficialBinanceUsdmRestMarketData(30_000);
  const symbols = ["BTCUSDT", "ETHUSDT"] as const;
  const captures = [];
  for (const symbol of symbols) {
    captures.push(await loadCryptoReplayRawContexts({
      rest,
      symbol,
      durationHours: arguments_.durationHours,
      endExclusive: arguments_.endExclusive,
    }));
  }
  const rows: FinCastRawInputRow[] = captures
    .flatMap((capture) => capture.rows)
    .sort((left, right) => (
      Date.parse(left.origin) - Date.parse(right.origin)
      || left.instrumentKey.localeCompare(right.instrumentKey)
    ));
  const artifact = await writeFinCastRawInputArtifact({
    directory: arguments_.output,
    cadenceSeconds: 60,
    modelSeed: arguments_.modelSeed,
    rows,
    metadata: {
      purpose: `fincast-p40-${arguments_.durationHours}h-btc-eth-policy-regression`,
      source: "Binance USD-M public 1m klines",
      symbols: [...symbols],
      durationHours: arguments_.durationHours,
      endExclusiveAt: new Date(arguments_.endExclusive).toISOString(),
      originStrideMinutes: 15,
      rowsPerSymbol: Object.fromEntries(
        captures.map((capture) => [capture.symbol, capture.rows.length]),
      ),
      inputBarCountPerSymbol: Object.fromEntries(
        captures.map((capture) => [capture.symbol, capture.inputBarCount]),
      ),
    },
  });
  const marketData = await writeMarketDataArtifact({
    output: arguments_.output,
    captures,
    rawInputManifestSha256: artifact.manifestSha256,
    durationHours: arguments_.durationHours,
    endExclusive: arguments_.endExclusive,
  });
  process.stdout.write(`${JSON.stringify({
    schema_version: "fincast-p40-policy-regression-input/v1",
    manifest_path: artifact.manifestPath,
    manifest_sha256: artifact.manifestSha256,
    artifact_digest_components: artifact.manifest.files,
    row_count: artifact.manifest.row_count,
    duration_hours: arguments_.durationHours,
    symbols,
    end_exclusive_at: new Date(arguments_.endExclusive).toISOString(),
    market_data: {
      manifest_path: marketData.manifestPath,
      manifest_sha256: marketData.manifestSha256,
      bars_sha256: marketData.barsSha256,
      record_count: marketData.recordCount,
    },
  })}\n`);
}

await main();
