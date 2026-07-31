import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  decidePaperActions,
  resolvePaperPolicyProfile,
  selectAiForecastSeries,
  type PaperPolicyAction,
} from "../server/simulation/policy.js";
import type { SimulationPreset } from "../server/simulation/contracts.js";

const MAXIMUM_JSON_BYTES = 4 << 20;
const OUTPUT_COLUMNS = 10;
const HORIZON_COUNT = 4;
const CONTEXT_BARS = 512;
const HORIZONS = [5, 15, 30, 60] as const;
const NATIVE_QUANTILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
const FIXED_QUANTILES = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95] as const;
const PRESETS = [
  "trend",
  "breakout",
  "mean_reversion",
  "risk_management",
] as const satisfies readonly SimulationPreset[];
const RISK_TOLERANCES = [0, 25, 50, 75, 100] as const;
const ROUND_TRIP_COST_RATE = 0.0012;
const NORMAL_90 = 1.2815515655446004;
const MAXIMUM_MARKET_DATA_BYTES = 128 << 20;
const ECONOMIC_RETURN_DELTA_LIMIT = 0.0001;
const ECONOMIC_DRAWDOWN_DELTA_LIMIT = 0.0001;
const ECONOMIC_DECISION_MISMATCH_RATE_LIMIT = 0.001;
const QUALIFICATION_OBSERVATIONS = {
  row_count: 54_600,
  non_finite_value_count: 0,
  crossing_row_count: 1,
  crossing_adjacent_pair_count: 1,
  adjusted_row_count: 1,
  q50_adjustment_iqr_ratio_median: 0,
  q50_adjustment_iqr_ratio_p95: 0,
  q50_adjustment_iqr_ratio_max: 0,
  postprocessed_monotonic: true,
} as const;

type JsonObject = Record<string, unknown>;
type Origin = {
  row_id: number;
  instrument_key: string;
  origin: string;
  future_timestamps: string[];
  metadata: {
    symbol: string;
  };
};
type RawInput = {
  root: string;
  manifestPath: string;
  manifestSha256: string;
  artifactDigest: string;
  durationHours: number;
  manifest: JsonObject & {
    row_count: number;
    cadence_seconds: number;
    model_seed: number;
    files: {
      contexts: { name: string; size_bytes: number; sha256: string };
      origins: { name: string; size_bytes: number; sha256: string };
    };
  };
  contexts: Buffer;
  origins: Origin[];
};
type RawOutput = {
  directory: string;
  manifestSha256: string;
  outputDigest: string;
  backend: string;
  batchSize: number;
  predictions: Float32Array;
};
type MarketBar = {
  symbol: string;
  interval: "1m";
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
  trade_count: number;
  final: true;
};
type MarketData = {
  manifestPath: string;
  manifestSha256: string;
  barsSha256: string;
  bars: Map<string, MarketBar>;
  recordCount: number;
};

type ThresholdMarginRecord = {
  schema_version: "fincast-policy-threshold-margin/v1";
  origin_at: string;
  preset: SimulationPreset;
  risk_tolerance: number;
  scenario: "entry" | "exit";
  symbol: string;
  threshold_kind: "entry_up_probability" | "exit_up_probability";
  comparison: "greater_than_or_equal" | "greater_than";
  threshold: number;
  reference: {
    up_probability: number;
    signed_margin: number;
    absolute_margin: number;
    threshold_satisfied: boolean;
    action: string;
    reasons: string[];
  };
  candidate: {
    up_probability: number;
    signed_margin: number;
    absolute_margin: number;
    threshold_satisfied: boolean;
    action: string;
    reasons: string[];
  };
  candidate_probability_delta: number;
  threshold_crossed: boolean;
  action_mismatch: boolean;
  reason_mismatch: boolean;
};

class ThresholdMarginRecorder {
  private readonly temporaryPath: string;
  private readonly digest = createHash("sha256");
  private buffer = "";
  private bytes = 0;
  private count = 0;

  private constructor(
    readonly outputPath: string,
    temporaryPath: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
  ) {
    this.temporaryPath = temporaryPath;
  }

  static async create(outputPath: string): Promise<ThresholdMarginRecorder> {
    if (!isAbsolute(outputPath) || resolve(outputPath) !== outputPath) {
      throw new Error("--margins-output must be an absolute normalized path.");
    }
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    return new ThresholdMarginRecorder(outputPath, temporaryPath, handle);
  }

  async write(record: ThresholdMarginRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.buffer += line;
    this.digest.update(line);
    this.bytes += Buffer.byteLength(line);
    this.count += 1;
    if (this.buffer.length >= 1 << 20) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return;
    const payload = this.buffer;
    this.buffer = "";
    await this.handle.write(payload);
  }

  async finish(): Promise<{
    path: string;
    sha256: string;
    size_bytes: number;
    record_count: number;
  }> {
    await this.flush();
    await this.handle.sync();
    await this.handle.close();
    await rename(this.temporaryPath, this.outputPath);
    return {
      path: this.outputPath,
      sha256: this.digest.digest("hex"),
      size_bytes: this.bytes,
      record_count: this.count,
    };
  }
}

class DetailRecorder {
  private readonly temporaryPath: string;
  private readonly digest = createHash("sha256");
  private buffer = "";
  private bytes = 0;
  private count = 0;

  private constructor(
    readonly outputPath: string,
    temporaryPath: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
  ) {
    this.temporaryPath = temporaryPath;
  }

  static async create(outputPath: string): Promise<DetailRecorder> {
    if (!isAbsolute(outputPath) || resolve(outputPath) !== outputPath) {
      throw new Error("--details-output must be an absolute normalized path.");
    }
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    return new DetailRecorder(outputPath, temporaryPath, handle);
  }

  async write(record: JsonObject): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.buffer += line;
    this.digest.update(line);
    this.bytes += Buffer.byteLength(line);
    this.count += 1;
    if (this.buffer.length >= 1 << 20) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return;
    const payload = this.buffer;
    this.buffer = "";
    await this.handle.write(payload);
  }

  async finish(): Promise<{
    path: string;
    sha256: string;
    size_bytes: number;
    record_count: number;
  }> {
    await this.flush();
    await this.handle.sync();
    await this.handle.close();
    await rename(this.temporaryPath, this.outputPath);
    return {
      path: this.outputPath,
      sha256: this.digest.digest("hex"),
      size_bytes: this.bytes,
      record_count: this.count,
    };
  }
}

function sha256(payload: Uint8Array | string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonObject;
}

async function regularAbsolutePath(path: string, label: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path.`);
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error(`${label} must be a regular file without symlink traversal.`);
  }
}

async function boundedJson(path: string, label: string): Promise<{
  payload: Buffer;
  value: JsonObject;
}> {
  await regularAbsolutePath(path, label);
  const payload = await readFile(path);
  if (payload.length < 2 || payload.length > MAXIMUM_JSON_BYTES) {
    throw new Error(`${label} exceeds its bounded size.`);
  }
  return { payload, value: object(JSON.parse(payload.toString("utf8")), label) };
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is invalid.`);
  return value;
}

function integerField(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

async function verifiedPayload(
  root: string,
  spec: { name: string; size_bytes: number; sha256: string },
  label: string,
): Promise<Buffer> {
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(spec.name)) {
    throw new Error(`${label} has an unsafe filename.`);
  }
  const path = join(root, spec.name);
  await regularAbsolutePath(path, label);
  const payload = await readFile(path);
  if (payload.length !== spec.size_bytes || sha256(payload) !== spec.sha256) {
    throw new Error(`${label} size or SHA-256 differs from its manifest.`);
  }
  return payload;
}

async function loadInput(manifestPath: string): Promise<RawInput> {
  const { payload, value } = await boundedJson(manifestPath, "raw input manifest");
  if (value.schema_version !== "fincast-raw-input/v1") {
    throw new Error("raw input manifest schema is unsupported.");
  }
  const rowCount = integerField(value.row_count, "raw input row_count");
  const metadata = object(value.metadata, "raw input metadata");
  const durationHours = integerField(metadata.durationHours, "raw input durationHours");
  if (durationHours < 1 || durationHours > 840) {
    throw new Error("raw input durationHours must be in 1..840.");
  }
  const files = object(value.files, "raw input files");
  const contextsSpec = object(files.contexts, "contexts spec");
  const originsSpec = object(files.origins, "origins spec");
  const normalizedFiles = {
    contexts: {
      name: stringField(contextsSpec.name, "contexts name"),
      size_bytes: integerField(contextsSpec.size_bytes, "contexts size"),
      sha256: stringField(contextsSpec.sha256, "contexts SHA-256"),
    },
    origins: {
      name: stringField(originsSpec.name, "origins name"),
      size_bytes: integerField(originsSpec.size_bytes, "origins size"),
      sha256: stringField(originsSpec.sha256, "origins SHA-256"),
    },
  };
  const root = dirname(manifestPath);
  const contexts = await verifiedPayload(root, normalizedFiles.contexts, "contexts.f32");
  const originsPayload = await verifiedPayload(root, normalizedFiles.origins, "origins.jsonl");
  if (contexts.length !== rowCount * CONTEXT_BARS * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("raw contexts shape differs from [rows,512].");
  }
  const lines = originsPayload.toString("utf8").trimEnd().split("\n");
  if (lines.length !== rowCount) throw new Error("raw origins row count differs.");
  const origins = lines.map((line, rowId): Origin => {
    const origin = object(JSON.parse(line), `origin ${rowId}`) as unknown as Origin;
    if (
      origin.row_id !== rowId
      || typeof origin.instrument_key !== "string"
      || typeof origin.origin !== "string"
      || !Array.isArray(origin.future_timestamps)
      || origin.future_timestamps.length < 60
      || typeof origin.metadata?.symbol !== "string"
    ) {
      throw new Error(`origin ${rowId} is invalid.`);
    }
    return origin;
  });
  const manifestSha256 = sha256(payload);
  const artifactDigest = sha256(
    `fincast-raw-input/v1\0${manifestSha256}\0`
      + `${normalizedFiles.contexts.sha256}\0${normalizedFiles.origins.sha256}`,
  );
  return {
    root,
    manifestPath,
    manifestSha256,
    artifactDigest,
    durationHours,
    manifest: {
      ...value,
      row_count: rowCount,
      cadence_seconds: integerField(value.cadence_seconds, "raw cadence"),
      model_seed: integerField(value.model_seed, "raw model seed"),
      files: normalizedFiles,
    },
    contexts,
    origins,
  };
}

async function loadOutput(directory: string, input: RawInput): Promise<RawOutput> {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("raw output directory must be absolute and normalized.");
  }
  const manifestPath = join(directory, "manifest.json");
  const { payload, value } = await boundedJson(manifestPath, "raw output manifest");
  if (
    value.schema_version !== "fincast-raw-predictions/v1"
    || value.complete !== true
    || value.completed_rows !== input.manifest.row_count
    || value.input_manifest_sha256 !== input.manifestSha256
    || value.input_artifact_digest !== input.artifactDigest
    || value.cadence_seconds !== input.manifest.cadence_seconds
    || value.model_seed !== input.manifest.model_seed
  ) {
    throw new Error("raw output does not match the complete input artifact.");
  }
  const backend = stringField(value.backend, "raw output backend");
  const batchSize = integerField(value.batch_size, "raw output batch size");
  if (!Array.isArray(value.chunks) || value.chunks.length < 1) {
    throw new Error("raw output has no chunks.");
  }
  const predictions = new Float32Array(
    input.manifest.row_count * HORIZON_COUNT * OUTPUT_COLUMNS,
  );
  const outputHash = createHash("sha256");
  let nextRow = 0;
  for (const [chunkIndex, rawName] of value.chunks.entries()) {
    const name = stringField(rawName, `chunk ${chunkIndex} name`);
    if (!/^chunks\/chunk-\d{10}-\d{10}\.json$/.test(name)) {
      throw new Error(`chunk ${chunkIndex} path is unsafe.`);
    }
    const metadataPath = join(directory, name);
    const { value: metadata } = await boundedJson(metadataPath, `chunk ${chunkIndex}`);
    const startRow = integerField(metadata.start_row, `chunk ${chunkIndex} start`);
    const endRow = integerField(metadata.end_row, `chunk ${chunkIndex} end`);
    const output = object(metadata.output, `chunk ${chunkIndex} output`);
    if (
      startRow !== nextRow
      || endRow <= startRow
      || metadata.backend !== backend
      || metadata.batch_size !== batchSize
    ) {
      throw new Error(`chunk ${chunkIndex} breaks the contiguous output contract.`);
    }
    const binaryName = stringField(output.name, `chunk ${chunkIndex} binary`);
    if (!/^chunks\/chunk-\d{10}-\d{10}\.f32$/.test(binaryName)) {
      throw new Error(`chunk ${chunkIndex} binary path is unsafe.`);
    }
    const binaryPath = join(directory, binaryName);
    await regularAbsolutePath(binaryPath, `chunk ${chunkIndex} binary`);
    const binary = await readFile(binaryPath);
    const expectedBytes = (endRow - startRow)
      * HORIZON_COUNT * OUTPUT_COLUMNS * Float32Array.BYTES_PER_ELEMENT;
    if (
      binary.length !== expectedBytes
      || output.size_bytes !== expectedBytes
      || sha256(binary) !== output.sha256
    ) {
      throw new Error(`chunk ${chunkIndex} binary digest or shape differs.`);
    }
    for (let offset = 0; offset < binary.length; offset += 4) {
      predictions[startRow * HORIZON_COUNT * OUTPUT_COLUMNS + offset / 4] =
        binary.readFloatLE(offset);
    }
    outputHash.update(binary);
    nextRow = endRow;
  }
  if (nextRow !== input.manifest.row_count) {
    throw new Error("raw output chunks do not cover every row exactly once.");
  }
  return {
    directory,
    manifestSha256: sha256(payload),
    outputDigest: outputHash.digest("hex"),
    backend,
    batchSize,
    predictions,
  };
}

function finiteField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function positiveField(value: unknown, label: string): number {
  const parsed = finiteField(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function marketBarKey(symbol: string, closeTime: number): string {
  return `${symbol}\u0000${closeTime}`;
}

async function loadMarketData(manifestPath: string, input: RawInput): Promise<MarketData> {
  const { payload: manifestPayload, value: manifest } = await boundedJson(
    manifestPath,
    "market data manifest",
  );
  if (
    manifest.schema_version !== "fincast-replay-market-data/v1"
    || manifest.raw_input_manifest_sha256 !== input.manifestSha256
  ) {
    throw new Error("market data manifest does not match the raw input artifact.");
  }
  const files = object(manifest.files, "market data files");
  const barsSpec = object(files.bars, "market data bars spec");
  const name = stringField(barsSpec.name, "market data bars name");
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(name)) {
    throw new Error("market data bars filename is unsafe.");
  }
  const barsPath = join(dirname(manifestPath), name);
  await regularAbsolutePath(barsPath, "market data bars");
  const payload = await readFile(barsPath);
  const expectedSize = integerField(barsSpec.size_bytes, "market data bars size");
  const expectedCount = integerField(barsSpec.record_count, "market data bars count");
  const expectedSha256 = stringField(barsSpec.sha256, "market data bars SHA-256");
  if (
    payload.length !== expectedSize
    || payload.length > MAXIMUM_MARKET_DATA_BYTES
    || sha256(payload) !== expectedSha256
  ) {
    throw new Error("market data bars size, bound, or SHA-256 is invalid.");
  }
  const lines = payload.toString("utf8").split("\n").filter(Boolean);
  if (lines.length !== expectedCount) {
    throw new Error("market data bars record count differs from its manifest.");
  }
  const bars = new Map<string, MarketBar>();
  const previousBySymbol = new Map<string, MarketBar>();
  for (let index = 0; index < lines.length; index += 1) {
    const raw = object(JSON.parse(lines[index]!), `market data bar ${index}`);
    const symbol = stringField(raw.symbol, `market data bar ${index} symbol`);
    if (raw.interval !== "1m" || raw.final !== true) {
      throw new Error(`market data bar ${index} is not a finalized 1m bar.`);
    }
    const bar: MarketBar = {
      symbol,
      interval: "1m",
      open_time: integerField(raw.open_time, `market data bar ${index} open_time`),
      close_time: integerField(raw.close_time, `market data bar ${index} close_time`),
      open: positiveField(raw.open, `market data bar ${index} open`),
      high: positiveField(raw.high, `market data bar ${index} high`),
      low: positiveField(raw.low, `market data bar ${index} low`),
      close: positiveField(raw.close, `market data bar ${index} close`),
      volume: finiteField(raw.volume, `market data bar ${index} volume`),
      quote_volume: finiteField(
        raw.quote_volume,
        `market data bar ${index} quote_volume`,
      ),
      trade_count: integerField(
        raw.trade_count,
        `market data bar ${index} trade_count`,
      ),
      final: true,
    };
    if (
      bar.volume < 0
      || bar.quote_volume < 0
      || bar.close_time !== bar.open_time + 60_000 - 1
      || bar.high < Math.max(bar.open, bar.close)
      || bar.low > Math.min(bar.open, bar.close)
    ) {
      throw new Error(`market data bar ${index} has invalid OHLCV geometry.`);
    }
    const previous = previousBySymbol.get(symbol);
    if (previous && bar.open_time !== previous.open_time + 60_000) {
      throw new Error(`market data continuity failed for ${symbol}.`);
    }
    const key = marketBarKey(symbol, bar.close_time);
    if (bars.has(key)) throw new Error(`market data contains duplicate ${key}.`);
    bars.set(key, bar);
    previousBySymbol.set(symbol, bar);
  }
  for (const origin of input.origins) {
    const base = bars.get(marketBarKey(origin.metadata.symbol, Date.parse(origin.origin)));
    if (!base || Math.abs(base.close - contextClose(input, origin.row_id)) > Math.max(
      1e-6,
      Math.abs(base.close) * 2e-7,
    )) {
      throw new Error(`market data does not reproduce raw context row ${origin.row_id}.`);
    }
    for (const timestamp of origin.future_timestamps) {
      if (!bars.has(marketBarKey(origin.metadata.symbol, Date.parse(timestamp)))) {
        throw new Error(`market data is missing a future bar for row ${origin.row_id}.`);
      }
    }
  }
  return {
    manifestPath,
    manifestSha256: sha256(manifestPayload),
    barsSha256: expectedSha256,
    bars,
    recordCount: bars.size,
  };
}

function contextClose(input: RawInput, rowId: number): number {
  return input.contexts.readFloatLE(
    (rowId * CONTEXT_BARS + CONTEXT_BARS - 1) * Float32Array.BYTES_PER_ELEMENT,
  );
}

function predictionRow(output: RawOutput, rowId: number, horizonIndex = 0): number[] {
  const start = (rowId * HORIZON_COUNT + horizonIndex) * OUTPUT_COLUMNS;
  return Array.from(output.predictions.slice(start, start + OUTPUT_COLUMNS));
}

function projectedPoints(native: readonly number[]): Array<[number, number]> {
  if (native.length !== OUTPUT_COLUMNS) throw new Error("raw prediction row width is invalid.");
  const prices = [
    native[1]!,
    native[1]!,
    (native[2]! + native[3]!) / 2,
    native[5]!,
    (native[7]! + native[8]!) / 2,
    native[9]!,
    native[9]!,
  ];
  if (
    prices.some((value) => !Number.isFinite(value) || value <= 0)
    || prices.some((value, index) => index > 0 && value < prices[index - 1]!)
  ) {
    throw new Error("raw prediction cannot be projected into policy quantiles.");
  }
  return FIXED_QUANTILES.map((quantile, index) => [quantile, prices[index]!]);
}

function cdfProbability(points: ReadonlyArray<readonly [number, number]>, value: number): number {
  if (value < points[0]![1]) return 0;
  if (value >= points.at(-1)![1]) return 1;
  for (let index = 1; index < points.length; index += 1) {
    const [leftQ, leftValue] = points[index - 1]!;
    const [rightQ, rightValue] = points[index]!;
    if (value > rightValue) continue;
    if (rightValue === leftValue) return rightQ;
    return leftQ + (value - leftValue) / (rightValue - leftValue) * (rightQ - leftQ);
  }
  return 1;
}

function forecastResponse(
  input: RawInput,
  output: RawOutput,
  rowIds: readonly number[],
): unknown {
  const originAt = input.origins[rowIds[0]!]!.origin;
  return {
    schema_version: "scalping-ai/v2",
    request_id: `policy-regression:${originAt}`,
    mode: "forecast",
    status: "available",
    generated_at: originAt,
    model: {
      model_id: "Vincent05R/FinCast",
      model_revision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
      tokenizer_id: null,
      tokenizer_revision: null,
      source_revision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
      loader_version: "fincast-source-488b19d",
      license: "Apache-2.0",
      device: "cuda",
      device_name: "Tesla P40",
      cuda_capability: "6.1",
      dtype: "float32",
      attention_backend: "math",
      loaded: true,
      precision_validation: "fallback_fp32",
      peak_vram_bytes: 4_246_732_800,
      peak_vram_measurement: "cuda_allocated_or_reserved",
      memory_status: "ok",
      quantile_monotonicity_policy: "fp32_monotone_rearrangement_v1",
      fp32_quantile_observations: QUALIFICATION_OBSERVATIONS,
      mixed_quantile_observations: QUALIFICATION_OBSERVATIONS,
      quantile_tail_policy: "tail_clamped_q10_q90",
      precision_failure_reasons: ["signal_direction_agreement_below_99pct"],
    },
    series: rowIds.map((rowId) => {
      const origin = input.origins[rowId]!;
      const base = contextClose(input, rowId);
      const points = projectedPoints(predictionRow(output, rowId));
      const cdf = Math.min(1, Math.max(0, cdfProbability(points, base)));
      const q10 = points[1]![1];
      const q90 = points[5]![1];
      return {
        instrument_key: origin.metadata.symbol,
        input_end_at: origin.origin,
        status: "available",
        horizons: [{
          horizon_minutes: 5,
          target_timestamp: origin.future_timestamps[4],
          return_quantiles: points.map(([quantile, price]) => ({
            quantile,
            value: price / base - 1,
          })),
          up_probability: 1 - cdf,
          down_probability: cdf,
          flat_probability: 0,
          expected_volatility: Math.max(0, Math.log(q90 / q10) / (2 * NORMAL_90)),
          uncertainty_interval_width: (q90 - q10) / base,
          valid_path_count: 0,
          invalid_path_count: 0,
          target_stop: {
            status: "unavailable",
            reason: "marginal_quantiles_do_not_identify_first_passage_order",
          },
        }],
      };
    }),
  };
}

function technicalState(origin: Origin, kind: "entry" | "exit"): JsonObject {
  return {
    status: kind === "entry" ? "entry_candidate" : "exit_candidate",
    observedAt: origin.origin,
    signalOriginAt: origin.origin,
    calculationAt: origin.origin,
    technicalEvidenceAt: origin.origin,
    technical_signal: kind === "entry" ? 1 : -1,
    confidence: 1,
    chartPatternBias: kind === "entry" ? "bullish" : "bearish",
    chartPatternStrength: 1,
    signalDataQuality: { status: "good" },
    instrumentDataQuality: { status: "good" },
  };
}

function actionView(actions: readonly PaperPolicyAction[]): Array<{
  symbol: string;
  action: string;
  reasons: string[];
  targetAllocationRate: number | null;
}> {
  return actions.map((action) => ({
    symbol: action.symbol,
    action: action.action,
    reasons: [...action.reasons],
    targetAllocationRate: action.targetAllocationRate ?? null,
  }));
}

function actionMismatch(
  reference: ReturnType<typeof actionView>,
  candidate: ReturnType<typeof actionView>,
): {
  selection: boolean;
  kind: number;
  reasons: number;
  allocationMaximum: number;
} {
  let kind = 0;
  let reasons = 0;
  let allocationMaximum = 0;
  for (let index = 0; index < Math.max(reference.length, candidate.length); index += 1) {
    const left = reference[index];
    const right = candidate[index];
    if (!left || !right || left.symbol !== right.symbol || left.action !== right.action) kind += 1;
    if (!left || !right || JSON.stringify(left.reasons) !== JSON.stringify(right.reasons)) {
      reasons += 1;
    }
    if (
      left?.targetAllocationRate !== null
      && left?.targetAllocationRate !== undefined
      && right?.targetAllocationRate !== null
      && right?.targetAllocationRate !== undefined
    ) {
      allocationMaximum = Math.max(
        allocationMaximum,
        Math.abs(left.targetAllocationRate - right.targetAllocationRate),
      );
    } else if (left?.targetAllocationRate !== right?.targetAllocationRate) {
      allocationMaximum = Number.POSITIVE_INFINITY;
    }
  }
  return {
    selection: reference.map((item) => item.symbol).join("\0")
      !== candidate.map((item) => item.symbol).join("\0"),
    kind,
    reasons,
    allocationMaximum,
  };
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) throw new Error("percentile input is empty.");
  values.sort((left, right) => left - right);
  const position = (values.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower]!;
  return values[lower]! + (values[upper]! - values[lower]!) * (position - lower);
}

function minimum(values: readonly number[]): number {
  if (!values.length) throw new Error("minimum input is empty.");
  return values.reduce((result, value) => Math.min(result, value), Number.POSITIVE_INFINITY);
}

function maximum(values: readonly number[]): number {
  if (!values.length) throw new Error("maximum input is empty.");
  return values.reduce((result, value) => Math.max(result, value), Number.NEGATIVE_INFINITY);
}

function predictionGate(
  input: RawInput,
  reference: RawOutput,
  candidate: RawOutput,
): JsonObject {
  let finite = true;
  let monotonic = true;
  let directionMatches = 0;
  let comparisons = 0;
  const normalizedQ50Errors: number[] = [];
  for (let rowId = 0; rowId < input.manifest.row_count; rowId += 1) {
    const base = contextClose(input, rowId);
    for (let horizon = 0; horizon < HORIZON_COUNT; horizon += 1) {
      const offset = (rowId * HORIZON_COUNT + horizon) * OUTPUT_COLUMNS;
      const left = reference.predictions.subarray(offset, offset + OUTPUT_COLUMNS);
      const right = candidate.predictions.subarray(offset, offset + OUTPUT_COLUMNS);
      finite &&= [...right].every(Number.isFinite);
      for (let index = 2; index < OUTPUT_COLUMNS; index += 1) {
        monotonic &&= right[index]! >= right[index - 1]!;
      }
      const referenceQ25 = (left[2]! + left[3]!) / 2;
      const referenceQ50 = left[5]!;
      const referenceQ75 = (left[7]! + left[8]!) / 2;
      const candidateQ50 = right[5]!;
      directionMatches += Number(
        Math.sign(referenceQ50 - base) === Math.sign(candidateQ50 - base),
      );
      comparisons += 1;
      const iqr = Math.max(
        referenceQ75 - referenceQ25,
        Math.abs(base) * 1e-7,
        1e-12,
      );
      normalizedQ50Errors.push(Math.abs(candidateQ50 - referenceQ50) / iqr);
    }
  }
  const directionMatchRate = directionMatches / comparisons;
  const median = percentile([...normalizedQ50Errors], 0.5);
  const p95 = percentile([...normalizedQ50Errors], 0.95);
  return {
    passed: finite
      && monotonic
      && directionMatchRate >= 0.99
      && median <= 0.05
      && p95 <= 0.15,
    finite,
    quantile_monotonicity: monotonic,
    direction_match_rate: directionMatchRate,
    q50_error_over_iqr: { median, p95 },
    thresholds: {
      direction_match_rate_minimum: 0.99,
      q50_error_over_iqr_median_maximum: 0.05,
      q50_error_over_iqr_p95_maximum: 0.15,
    },
  };
}

function direction(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function mean(values: readonly number[]): number {
  if (!values.length) throw new Error("mean input is empty.");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

type ProbabilitySegment = {
  index: number;
  leftQuantile: number;
  rightQuantile: number;
  leftPrice: number;
  rightPrice: number;
  widthRate: number;
  baseOffsetRate: number;
};

function projectedProbability(native: readonly number[], base: number): {
  upProbability: number;
  downProbability: number;
  segment: ProbabilitySegment | null;
} {
  const points = projectedPoints(native);
  const downProbability = Math.min(1, Math.max(0, cdfProbability(points, base)));
  let segment: ProbabilitySegment | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const [leftQuantile, leftPrice] = points[index - 1]!;
    const [rightQuantile, rightPrice] = points[index]!;
    if (base < leftPrice || base > rightPrice) continue;
    segment = {
      index,
      leftQuantile,
      rightQuantile,
      leftPrice,
      rightPrice,
      widthRate: (rightPrice - leftPrice) / base,
      baseOffsetRate: (base - leftPrice) / base,
    };
    break;
  }
  return {
    upProbability: 1 - downProbability,
    downProbability,
    segment,
  };
}

export function reasonDifferenceCauseCodes(input: {
  scenario: "entry" | "exit";
  thresholdCrossed: boolean;
  referenceScore: number;
  candidateScore: number;
  selectionChanged: boolean;
  referenceSegment: ProbabilitySegment | null;
  candidateSegment: ProbabilitySegment | null;
  referenceProjectedPrices: readonly number[];
  candidateProjectedPrices: readonly number[];
  referenceReasons: readonly string[];
  candidateReasons: readonly string[];
  reasonMismatch: boolean;
  actionMismatch: boolean;
}): string[] {
  const causes: string[] = [];
  const referenceReasonSet = new Set(input.referenceReasons);
  const candidateReasonSet = new Set(input.candidateReasons);
  const changedReasons = new Set([
    ...input.referenceReasons.filter((reason) => !candidateReasonSet.has(reason)),
    ...input.candidateReasons.filter((reason) => !referenceReasonSet.has(reason)),
  ]);
  if (input.thresholdCrossed) {
    causes.push(`${input.scenario}_probability_threshold_crossing`);
  }
  if (changedReasons.has("model_down_probability_not_below_up_probability")) {
    causes.push("directional_probability_50pct_crossing");
  }
  if (
    (input.referenceScore > 0) !== (input.candidateScore > 0)
    || changedReasons.has("entry_score_threshold_not_met")
    || changedReasons.has("negative_risk_adjusted_score")
  ) {
    causes.push("risk_adjusted_score_sign_crossing");
  }
  if (input.selectionChanged) causes.push("selection_order_swap");
  if (input.referenceSegment?.index !== input.candidateSegment?.index) {
    causes.push("projected_cdf_segment_change");
  }
  const narrowSegment = [
    input.referenceSegment?.widthRate,
    input.candidateSegment?.widthRate,
  ].some((value) => value !== undefined && value <= 1e-5);
  const repeatedProjectedPrice = [
    input.referenceProjectedPrices,
    input.candidateProjectedPrices,
  ].some((prices) => prices.some((price, index) => (
    // q0=q10 and q90=q100 are intentional tail clamps. Only an interior
    // duplicate can amplify a threshold decision unexpectedly.
    index > 1 && index < prices.length - 1 && price === prices[index - 1]
  )));
  if (narrowSegment || repeatedProjectedPrice) {
    causes.push("interior_quantile_plateau_or_narrow_cdf_segment");
  }
  if (input.reasonMismatch && !input.actionMismatch) {
    causes.push("reason_only_no_action_change");
  }
  if (!causes.length) causes.push("numeric_drift_without_boundary_crossing");
  return [...new Set(causes)];
}

export function evaluateEconomicEquivalence(input: {
  maximumAbsoluteTotalReturnDelta: number;
  maximumAbsoluteDrawdownDelta: number;
  decisionMismatchCount: number;
  decisionCount: number;
}): {
  passed: boolean;
  decisionMismatchRate: number;
} {
  if (
    !Number.isFinite(input.maximumAbsoluteTotalReturnDelta)
    || !Number.isFinite(input.maximumAbsoluteDrawdownDelta)
    || !Number.isSafeInteger(input.decisionMismatchCount)
    || !Number.isSafeInteger(input.decisionCount)
    || input.decisionMismatchCount < 0
    || input.decisionCount <= 0
    || input.decisionMismatchCount > input.decisionCount
  ) {
    throw new Error("economic equivalence inputs are invalid.");
  }
  const decisionMismatchRate = input.decisionMismatchCount / input.decisionCount;
  return {
    passed: input.maximumAbsoluteTotalReturnDelta <= ECONOMIC_RETURN_DELTA_LIMIT
      && input.maximumAbsoluteDrawdownDelta <= ECONOMIC_DRAWDOWN_DELTA_LIMIT
      && decisionMismatchRate <= ECONOMIC_DECISION_MISMATCH_RATE_LIMIT,
    decisionMismatchRate,
  };
}

export function routingTraceReason(backend: string): string {
  return backend.startsWith("chronos2_")
    ? "Chronos-2 uses dense feed-forward blocks and has no MoE routing probabilities or expert indices"
    : "the qualified TensorRT engine exposes final predictions but not per-layer router probabilities or expert indices";
}

type AccuracyMetricAccumulator = {
  count: number;
  absoluteErrors: number[];
  squaredErrorSum: number;
  directionMatches: number;
  brierSum: number;
  intervalCovered: number;
  pinballLossByQuantile: number[];
};

function emptyAccuracyAccumulator(): AccuracyMetricAccumulator {
  return {
    count: 0,
    absoluteErrors: [],
    squaredErrorSum: 0,
    directionMatches: 0,
    brierSum: 0,
    intervalCovered: 0,
    pinballLossByQuantile: NATIVE_QUANTILES.map(() => 0),
  };
}

function accuracyKey(symbol: string, horizon: number): string {
  return `${symbol}:${horizon}`;
}

function accuracyView(value: AccuracyMetricAccumulator): JsonObject {
  if (!value.count) throw new Error("accuracy metric has no observations.");
  return {
    count: value.count,
    q50_return_mae: mean(value.absoluteErrors),
    q50_return_absolute_error_median: percentile([...value.absoluteErrors], 0.5),
    q50_return_absolute_error_p95: percentile([...value.absoluteErrors], 0.95),
    q50_return_rmse: Math.sqrt(value.squaredErrorSum / value.count),
    direction_accuracy: value.directionMatches / value.count,
    up_probability_brier: value.brierSum / value.count,
    q10_q90_interval_coverage: value.intervalCovered / value.count,
    mean_pinball_loss: mean(
      value.pinballLossByQuantile.map((loss) => loss / value.count),
    ),
    quantiles: Object.fromEntries(NATIVE_QUANTILES.map((quantile, index) => [
      `q${Math.round(quantile * 100)}`,
      {
        quantile,
        pinball_loss: value.pinballLossByQuantile[index]! / value.count,
      },
    ])),
  };
}

async function realizedAccuracy(input: {
  artifact: RawInput;
  market: MarketData;
  reference: RawOutput;
  candidate: RawOutput;
  details?: DetailRecorder;
}): Promise<JsonObject> {
  const accumulators = {
    reference: new Map<string, AccuracyMetricAccumulator>(),
    candidate: new Map<string, AccuracyMetricAccumulator>(),
  };
  const overall = {
    reference: emptyAccuracyAccumulator(),
    candidate: emptyAccuracyAccumulator(),
  };
  let q50ErrorWins = 0;
  let q50ErrorLosses = 0;
  let q50ErrorTies = 0;
  let directionDisagreements = 0;
  const probabilityDeltas: number[] = [];
  const q50ReturnDeltas: number[] = [];
  const nativeMaximumReturnDeltas: number[] = [];
  const projectionAmplifications: number[] = [];
  const probabilityOutlierCounts = {
    at_least_1pp: 0,
    at_least_5pp: 0,
    at_least_10pp: 0,
  };
  const probabilityOutliersBySymbolHorizon = new Map<string, number>();
  const outliers: JsonObject[] = [];
  for (const origin of input.artifact.origins) {
    const base = contextClose(input.artifact, origin.row_id);
    for (let horizonIndex = 0; horizonIndex < HORIZONS.length; horizonIndex += 1) {
      const horizon = HORIZONS[horizonIndex]!;
      const targetAt = origin.future_timestamps[horizon - 1]!;
      const target = input.market.bars.get(
        marketBarKey(origin.metadata.symbol, Date.parse(targetAt)),
      );
      if (!target) throw new Error(`missing realized target for row ${origin.row_id}.`);
      const actualReturn = target.close / base - 1;
      const values = {
        reference: predictionRow(input.reference, origin.row_id, horizonIndex),
        candidate: predictionRow(input.candidate, origin.row_id, horizonIndex),
      };
      const features = {} as Record<"reference" | "candidate", {
        q50Return: number;
        q10Return: number;
        q90Return: number;
        upProbability: number;
        absoluteError: number;
        segment: ReturnType<typeof projectedProbability>["segment"];
      }>;
      for (const backend of ["reference", "candidate"] as const) {
        const native = values[backend];
        const q50Return = native[5]! / base - 1;
        const q10Return = native[1]! / base - 1;
        const q90Return = native[9]! / base - 1;
        const probability = projectedProbability(native, base);
        const absoluteError = Math.abs(actualReturn - q50Return);
        const key = accuracyKey(origin.metadata.symbol, horizon);
        const metric = accumulators[backend].get(key) ?? emptyAccuracyAccumulator();
        for (const accumulator of [metric, overall[backend]]) {
          accumulator.count += 1;
          accumulator.absoluteErrors.push(absoluteError);
          accumulator.squaredErrorSum += (actualReturn - q50Return) ** 2;
          accumulator.directionMatches += Number(
            direction(actualReturn) === direction(q50Return),
          );
          accumulator.brierSum += (
            probability.upProbability - Number(actualReturn > 0)
          ) ** 2;
          accumulator.intervalCovered += Number(
            actualReturn >= q10Return && actualReturn <= q90Return,
          );
          for (let quantileIndex = 0; quantileIndex < NATIVE_QUANTILES.length;
            quantileIndex += 1) {
            const quantile = NATIVE_QUANTILES[quantileIndex]!;
            const predicted = native[quantileIndex + 1]! / base - 1;
            const error = actualReturn - predicted;
            accumulator.pinballLossByQuantile[quantileIndex] += Math.max(
              quantile * error,
              (quantile - 1) * error,
            );
          }
        }
        accumulators[backend].set(key, metric);
        features[backend] = {
          q50Return,
          q10Return,
          q90Return,
          upProbability: probability.upProbability,
          absoluteError,
          segment: probability.segment,
        };
      }
      const referenceError = features.reference.absoluteError;
      const candidateError = features.candidate.absoluteError;
      const errorDelta = candidateError - referenceError;
      if (Math.abs(errorDelta) <= 1e-12) q50ErrorTies += 1;
      else if (errorDelta < 0) q50ErrorWins += 1;
      else q50ErrorLosses += 1;
      directionDisagreements += Number(
        direction(features.reference.q50Return) !== direction(features.candidate.q50Return),
      );
      const probabilityDelta = features.candidate.upProbability
        - features.reference.upProbability;
      const absoluteProbabilityDelta = Math.abs(probabilityDelta);
      const nativeQuantileReturnDeltas = values.candidate.slice(1).map(
        (value, index) => (value - values.reference[index + 1]!) / base,
      );
      const nativeMaximumReturnDelta = maximum(
        nativeQuantileReturnDeltas.map((value) => Math.abs(value)),
      );
      const projectionAmplification = absoluteProbabilityDelta
        / Math.max(nativeMaximumReturnDelta, 1e-12);
      probabilityDeltas.push(absoluteProbabilityDelta);
      q50ReturnDeltas.push(Math.abs(
        features.candidate.q50Return - features.reference.q50Return,
      ));
      nativeMaximumReturnDeltas.push(nativeMaximumReturnDelta);
      projectionAmplifications.push(projectionAmplification);
      probabilityOutlierCounts.at_least_1pp += Number(absoluteProbabilityDelta >= 0.01);
      probabilityOutlierCounts.at_least_5pp += Number(absoluteProbabilityDelta >= 0.05);
      probabilityOutlierCounts.at_least_10pp += Number(absoluteProbabilityDelta >= 0.1);
      if (absoluteProbabilityDelta >= 0.01) {
        const key = accuracyKey(origin.metadata.symbol, horizon);
        probabilityOutliersBySymbolHorizon.set(
          key,
          (probabilityOutliersBySymbolHorizon.get(key) ?? 0) + 1,
        );
      }
      const detail: JsonObject = {
        schema_version: "fincast-backend-comparison-detail/v1",
        record_type: "prediction_accuracy",
        row_id: origin.row_id,
        symbol: origin.metadata.symbol,
        origin_at: origin.origin,
        horizon_minutes: horizon,
        target_at: targetAt,
        base_close: base,
        target_close: target.close,
        actual_return: actualReturn,
        reference: {
          native_prices: values.reference,
          ...features.reference,
        },
        candidate: {
          native_prices: values.candidate,
          ...features.candidate,
        },
        delta: {
          q50_return: features.candidate.q50Return - features.reference.q50Return,
          up_probability: probabilityDelta,
          q50_absolute_error: errorDelta,
          native_quantile_returns: nativeQuantileReturnDeltas,
          native_maximum_absolute_return: nativeMaximumReturnDelta,
          probability_per_native_return_amplification: projectionAmplification,
          q50_direction_changed:
            direction(features.reference.q50Return) !== direction(features.candidate.q50Return),
          projected_cdf_segment_changed:
            features.reference.segment?.index !== features.candidate.segment?.index,
        },
      };
      await input.details?.write(detail);
      outliers.push(detail);
      outliers.sort((left, right) => (
        Math.abs(Number(object(right.delta, "outlier delta").up_probability))
        - Math.abs(Number(object(left.delta, "outlier delta").up_probability))
      ));
      if (outliers.length > 20) outliers.pop();
    }
  }
  const bySymbolHorizon = Object.fromEntries(
    [...accumulators.reference.keys()].sort().map((key) => [
      key,
      {
        reference: accuracyView(accumulators.reference.get(key)!),
        candidate: accuracyView(accumulators.candidate.get(key)!),
      },
    ]),
  );
  return {
    schema_version: "fincast-realized-accuracy-comparison/v1",
    reference: accuracyView(overall.reference),
    candidate: accuracyView(overall.candidate),
    paired: {
      count: overall.reference.count,
      candidate_q50_error_wins: q50ErrorWins,
      candidate_q50_error_losses: q50ErrorLosses,
      q50_error_ties: q50ErrorTies,
      direction_disagreements: directionDisagreements,
      absolute_up_probability_delta: {
        median: percentile([...probabilityDeltas], 0.5),
        p95: percentile([...probabilityDeltas], 0.95),
        p99: percentile([...probabilityDeltas], 0.99),
        maximum: maximum(probabilityDeltas),
      },
      absolute_q50_return_delta: {
        median: percentile([...q50ReturnDeltas], 0.5),
        p95: percentile([...q50ReturnDeltas], 0.95),
        p99: percentile([...q50ReturnDeltas], 0.99),
        maximum: maximum(q50ReturnDeltas),
      },
    },
    outlier_diagnostics: {
      probability_delta_counts: probabilityOutlierCounts,
      probability_delta_rates: Object.fromEntries(
        Object.entries(probabilityOutlierCounts).map(([key, count]) => [
          key,
          count / overall.reference.count,
        ]),
      ),
      at_least_1pp_by_symbol_horizon: Object.fromEntries(
        [...probabilityOutliersBySymbolHorizon.entries()].sort(),
      ),
      native_maximum_absolute_return_delta: {
        median: percentile([...nativeMaximumReturnDeltas], 0.5),
        p95: percentile([...nativeMaximumReturnDeltas], 0.95),
        p99: percentile([...nativeMaximumReturnDeltas], 0.99),
        maximum: maximum(nativeMaximumReturnDeltas),
      },
      probability_per_native_return_amplification: {
        median: percentile([...projectionAmplifications], 0.5),
        p95: percentile([...projectionAmplifications], 0.95),
        p99: percentile([...projectionAmplifications], 0.99),
        maximum: maximum(projectionAmplifications),
      },
      routing_trace: {
        status: "unavailable",
        reason: routingTraceReason(input.candidate.backend),
      },
    },
    by_symbol_horizon: bySymbolHorizon,
    largest_probability_delta_samples: outliers,
    market_data: {
      manifest_sha256: input.market.manifestSha256,
      bars_sha256: input.market.barsSha256,
      record_count: input.market.recordCount,
    },
  };
}

type ReturnState = {
  equity: number;
  peak: number;
  maximumDrawdown: number;
  tradeCount: number;
  winningTrades: number;
  grossEquity: number;
  decisionSignature: ReturnType<typeof createHash>;
};

function returnState(): ReturnState {
  return {
    equity: 1,
    peak: 1,
    maximumDrawdown: 0,
    tradeCount: 0,
    winningTrades: 0,
    grossEquity: 1,
    decisionSignature: createHash("sha256"),
  };
}

function updateReturnState(
  state: ReturnState,
  originAt: string,
  symbols: readonly string[],
  targetAllocationRate: number,
  executionReturns: readonly number[],
): number {
  const grossPeriodReturn = executionReturns.length
    ? targetAllocationRate * mean(executionReturns)
    : 0;
  const netPeriodReturn = executionReturns.length
    ? targetAllocationRate * mean(
      executionReturns.map((value) => value - ROUND_TRIP_COST_RATE),
    )
    : 0;
  state.equity *= 1 + netPeriodReturn;
  state.grossEquity *= 1 + grossPeriodReturn;
  state.peak = Math.max(state.peak, state.equity);
  state.maximumDrawdown = Math.max(
    state.maximumDrawdown,
    state.peak > 0 ? 1 - state.equity / state.peak : 0,
  );
  state.tradeCount += executionReturns.length;
  state.winningTrades += executionReturns.filter(
    (value) => value - ROUND_TRIP_COST_RATE > 0,
  ).length;
  state.decisionSignature.update(JSON.stringify({ originAt, symbols }));
  return netPeriodReturn;
}

function returnStateView(state: ReturnState): JsonObject {
  return {
    total_return: state.equity - 1,
    gross_total_return: state.grossEquity - 1,
    cost_drag: state.grossEquity - state.equity,
    maximum_drawdown: state.maximumDrawdown,
    trade_count: state.tradeCount,
    winning_trade_rate: state.tradeCount ? state.winningTrades / state.tradeCount : null,
    terminal_equity: state.equity,
    decision_digest: state.decisionSignature.digest("hex"),
  };
}

async function modelSignalReturns(input: {
  artifact: RawInput;
  market: MarketData;
  reference: RawOutput;
  candidate: RawOutput;
  byOrigin: ReadonlyMap<string, number[]>;
  details?: DetailRecorder;
}): Promise<JsonObject> {
  const profiles: JsonObject[] = [];
  let maximumReturnDelta = 0;
  let maximumDrawdownDelta = 0;
  let maximumCurveDelta = 0;
  let totalDecisions = 0;
  let decisionMismatches = 0;
  let activeProfileCount = 0;
  let referenceTradeCount = 0;
  let candidateTradeCount = 0;
  for (const preset of PRESETS) {
    for (const riskTolerance of RISK_TOLERANCES) {
      const profile = resolvePaperPolicyProfile(preset, riskTolerance);
      const states = {
        reference: returnState(),
        candidate: returnState(),
      };
      let profileDecisions = 0;
      let profileMismatches = 0;
      let profileMaximumCurveDelta = 0;
      for (const [originAt, unsortedRowIds] of [...input.byOrigin.entries()].sort()) {
        const rowIds = [...unsortedRowIds].sort((left, right) => (
          input.artifact.origins[left]!.metadata.symbol.localeCompare(
            input.artifact.origins[right]!.metadata.symbol,
          )
        ));
        const responses = {
          reference: forecastResponse(input.artifact, input.reference, rowIds),
          candidate: forecastResponse(input.artifact, input.candidate, rowIds),
        };
        const decisions = {} as Record<"reference" | "candidate", {
          symbols: string[];
          executionReturns: number[];
          periodReturn: number;
          candidates: JsonObject[];
        }>;
        for (const backend of ["reference", "candidate"] as const) {
          const selection = selectAiForecastSeries(responses[backend], {
            symbolCount: 2,
            roundTripCostRate: ROUND_TRIP_COST_RATE,
            riskPenalty: profile.riskPenalty,
            notBeforeMs: Date.parse(originAt),
            modelLane: "fincast",
          });
          if (selection.status !== "available") {
            throw new Error(`return selection unavailable at ${originAt}.`);
          }
          const selected = selection.selected.filter(
            (candidate) => candidate.upProbability >= profile.entryUpProbability,
          );
          const symbols = selected.map((candidate) => candidate.symbol).sort();
          const executionReturns = symbols.map((symbol) => {
            const rowId = rowIds.find((candidateRowId) => (
              input.artifact.origins[candidateRowId]!.metadata.symbol === symbol
            ));
            if (rowId === undefined) throw new Error(`return row missing for ${symbol}.`);
            const origin = input.artifact.origins[rowId]!;
            const next = input.market.bars.get(
              marketBarKey(symbol, Date.parse(origin.future_timestamps[0]!)),
            );
            const target = input.market.bars.get(
              marketBarKey(symbol, Date.parse(origin.future_timestamps[4]!)),
            );
            if (!next || !target) throw new Error(`return bars missing for ${symbol}.`);
            return target.close / next.open - 1;
          });
          const periodReturn = updateReturnState(
            states[backend],
            originAt,
            symbols,
            profile.targetAllocationRate,
            executionReturns,
          );
          decisions[backend] = {
            symbols,
            executionReturns,
            periodReturn,
            candidates: selection.selected.map((candidate) => ({
              symbol: candidate.symbol,
              score: candidate.score,
              up_probability: candidate.upProbability,
              entry_threshold: profile.entryUpProbability,
              selected_for_trade: symbols.includes(candidate.symbol),
            })),
          };
        }
        const mismatch = decisions.reference.symbols.join("\0")
          !== decisions.candidate.symbols.join("\0");
        profileDecisions += 1;
        profileMismatches += Number(mismatch);
        profileMaximumCurveDelta = Math.max(
          profileMaximumCurveDelta,
          Math.abs(states.candidate.equity - states.reference.equity),
        );
        if (mismatch) {
          await input.details?.write({
            schema_version: "fincast-backend-comparison-detail/v1",
            record_type: "probability_threshold_return_decision_mismatch",
            origin_at: originAt,
            preset,
            risk_tolerance: riskTolerance,
            target_allocation_rate: profile.targetAllocationRate,
            reference: decisions.reference,
            candidate: decisions.candidate,
            terminal_equity_after: {
              reference: states.reference.equity,
              candidate: states.candidate.equity,
            },
          });
        }
      }
      const referenceView = returnStateView(states.reference);
      const candidateView = returnStateView(states.candidate);
      const returnDelta = Number(candidateView.total_return)
        - Number(referenceView.total_return);
      const drawdownDelta = Number(candidateView.maximum_drawdown)
        - Number(referenceView.maximum_drawdown);
      maximumReturnDelta = Math.max(maximumReturnDelta, Math.abs(returnDelta));
      maximumDrawdownDelta = Math.max(maximumDrawdownDelta, Math.abs(drawdownDelta));
      maximumCurveDelta = Math.max(maximumCurveDelta, profileMaximumCurveDelta);
      totalDecisions += profileDecisions;
      decisionMismatches += profileMismatches;
      const profileReferenceTrades = Number(referenceView.trade_count);
      const profileCandidateTrades = Number(candidateView.trade_count);
      referenceTradeCount += profileReferenceTrades;
      candidateTradeCount += profileCandidateTrades;
      activeProfileCount += Number(
        profileReferenceTrades > 0 || profileCandidateTrades > 0,
      );
      profiles.push({
        preset,
        risk_tolerance: riskTolerance,
        entry_up_probability: profile.entryUpProbability,
        target_allocation_rate: profile.targetAllocationRate,
        reference: referenceView,
        candidate: candidateView,
        delta: {
          total_return: returnDelta,
          maximum_drawdown: drawdownDelta,
          maximum_equity_curve: profileMaximumCurveDelta,
          decision_mismatch_count: profileMismatches,
          decision_mismatch_rate: profileMismatches / profileDecisions,
        },
      });
    }
  }
  const equivalence = evaluateEconomicEquivalence({
    maximumAbsoluteTotalReturnDelta: maximumReturnDelta,
    maximumAbsoluteDrawdownDelta: maximumDrawdownDelta,
    decisionMismatchCount: decisionMismatches,
    decisionCount: totalDecisions,
  });
  return {
    schema_version: "fincast-model-signal-return-comparison/v1",
    strategy: {
      id: "probability-threshold-fixed-5m-long-only/v1",
      origin_stride_minutes: 15,
      entry_fill: "next_finalized_1m_open_after_origin",
      exit_fill: "5m_target_finalized_close",
      entry_rule: "up_probability >= profile.entry_up_probability",
      score_gate: "not_applied",
      overlapping_positions: false,
      compounding: true,
      symbols: ["BTCUSDT", "ETHUSDT"],
      round_trip_cost_rate: ROUND_TRIP_COST_RATE,
      technical_state: "not_applied",
      limitation: "This isolates backend forecast economics and is not a production-policy return claim.",
    },
    gate: {
      passed: equivalence.passed && activeProfileCount > 0,
      economically_equivalent: equivalence.passed,
      non_vacuous: activeProfileCount > 0,
      active_profile_count: activeProfileCount,
      total_profile_count: profiles.length,
      reference_trade_count: referenceTradeCount,
      candidate_trade_count: candidateTradeCount,
      maximum_absolute_total_return_delta: maximumReturnDelta,
      maximum_absolute_total_return_delta_limit: ECONOMIC_RETURN_DELTA_LIMIT,
      maximum_absolute_drawdown_delta: maximumDrawdownDelta,
      maximum_absolute_drawdown_delta_limit: ECONOMIC_DRAWDOWN_DELTA_LIMIT,
      maximum_absolute_equity_curve_delta: maximumCurveDelta,
      decision_mismatch_count: decisionMismatches,
      decision_count: totalDecisions,
      decision_mismatch_rate: equivalence.decisionMismatchRate,
      decision_mismatch_rate_limit: ECONOMIC_DECISION_MISMATCH_RATE_LIMIT,
    },
    profiles,
  };
}

export async function comparePolicyRegression(input: {
  manifestPath: string;
  referenceDirectory: string;
  candidateDirectory: string;
  marketDataManifestPath?: string;
  marginsOutputPath?: string;
  detailsOutputPath?: string;
}): Promise<JsonObject> {
  const artifact = await loadInput(input.manifestPath);
  const reference = await loadOutput(input.referenceDirectory, artifact);
  const candidate = await loadOutput(input.candidateDirectory, artifact);
  const market = input.marketDataManifestPath
    ? await loadMarketData(input.marketDataManifestPath, artifact)
    : undefined;
  const marginRecorder = input.marginsOutputPath
    ? await ThresholdMarginRecorder.create(input.marginsOutputPath)
    : undefined;
  const detailRecorder = input.detailsOutputPath
    ? await DetailRecorder.create(input.detailsOutputPath)
    : undefined;
  const numericalPredictionGate = predictionGate(artifact, reference, candidate);
  const byOrigin = new Map<string, number[]>();
  for (const origin of artifact.origins) {
    const group = byOrigin.get(origin.origin) ?? [];
    group.push(origin.row_id);
    byOrigin.set(origin.origin, group);
  }
  if (
    [...byOrigin.values()].some((rows) => (
      rows.length !== 2
      || new Set(rows.map((row) => artifact.origins[row]!.metadata.symbol)).size !== 2
    ))
  ) {
    throw new Error("policy regression requires one BTC and one ETH row at each origin.");
  }
  const realizedAccuracyResult = market
    ? await realizedAccuracy({
        artifact,
        market,
        reference,
        candidate,
        ...(detailRecorder ? { details: detailRecorder } : {}),
      })
    : null;

  let scenarioCount = 0;
  let actionCount = 0;
  let selectionOrderMismatches = 0;
  let actionKindMismatches = 0;
  let reasonMismatches = 0;
  let maximumAllocationDelta = 0;
  let thresholdCrossings = 0;
  let symbolAlignedActionMismatches = 0;
  let symbolAlignedReasonMismatches = 0;
  let symbolAlignedAllocationMaximum = 0;
  const referenceAbsoluteMargins: number[] = [];
  const candidateAbsoluteMargins: number[] = [];
  const probabilityDeltas: number[] = [];
  const closestThresholdSamples: ThresholdMarginRecord[] = [];
  const reasonMismatchSamples: JsonObject[] = [];
  const reasonCauseCounts = new Map<string, number>();
  const reasonAddedToCandidateCounts = new Map<string, number>();
  const reasonRemovedFromCandidateCounts = new Map<string, number>();
  const thresholdCrossingCounts = new Map<string, number>();
  const referenceSignature = createHash("sha256");
  const candidateSignature = createHash("sha256");
  const perPreset = Object.fromEntries(PRESETS.map((preset) => [
    preset,
    { scenarios: 0, actionKindMismatches: 0, reasonMismatches: 0 },
  ])) as Record<string, {
    scenarios: number;
    actionKindMismatches: number;
    reasonMismatches: number;
  }>;

  for (const [originAt, rowIds] of [...byOrigin.entries()].sort()) {
    rowIds.sort((left, right) => (
      artifact.origins[left]!.metadata.symbol.localeCompare(
        artifact.origins[right]!.metadata.symbol,
      )
    ));
    const responses = {
      reference: forecastResponse(artifact, reference, rowIds),
      candidate: forecastResponse(artifact, candidate, rowIds),
    };
    for (const preset of PRESETS) {
      for (const riskTolerance of RISK_TOLERANCES) {
        const profile = resolvePaperPolicyProfile(preset, riskTolerance);
        const selections = {
          reference: selectAiForecastSeries(responses.reference, {
            symbolCount: 2,
            roundTripCostRate: ROUND_TRIP_COST_RATE,
            riskPenalty: profile.riskPenalty,
            notBeforeMs: Date.parse(originAt),
            modelLane: "fincast",
          }),
          candidate: selectAiForecastSeries(responses.candidate, {
            symbolCount: 2,
            roundTripCostRate: ROUND_TRIP_COST_RATE,
            riskPenalty: profile.riskPenalty,
            notBeforeMs: Date.parse(originAt),
            modelLane: "fincast",
          }),
        };
        if (
          selections.reference.status !== "available"
          || selections.candidate.status !== "available"
          || selections.reference.selected.length !== 2
          || selections.candidate.selected.length !== 2
        ) {
          throw new Error(
            `paper-policy selection unavailable at ${originAt}/${preset}/${riskTolerance}: `
              + `${selections.reference.reason ?? "reference_unknown"}/`
              + `${selections.candidate.reason ?? "candidate_unknown"}`,
          );
        }
        for (const scenario of ["entry", "exit"] as const) {
          const technicalStates = Object.fromEntries(rowIds.map((rowId) => {
            const origin = artifact.origins[rowId]!;
            return [origin.metadata.symbol, technicalState(origin, scenario)];
          }));
          const heldSymbols = scenario === "exit"
            ? rowIds.map((rowId) => artifact.origins[rowId]!.metadata.symbol)
            : [];
          const referencePolicyActions = decidePaperActions({
            selection: selections.reference,
            profile,
            technicalStates,
            heldSymbols,
            modelLane: "fincast",
          });
          const candidatePolicyActions = decidePaperActions({
            selection: selections.candidate,
            profile,
            technicalStates,
            heldSymbols,
            modelLane: "fincast",
          });
          const referenceActions = actionView(referencePolicyActions);
          const candidateActions = actionView(candidatePolicyActions);
          const mismatch = actionMismatch(referenceActions, candidateActions);
          scenarioCount += 1;
          actionCount += Math.max(referenceActions.length, candidateActions.length);
          selectionOrderMismatches += Number(mismatch.selection);
          actionKindMismatches += mismatch.kind;
          reasonMismatches += mismatch.reasons;
          const referenceBySymbol = new Map(
            referencePolicyActions.map((action) => [action.symbol, action]),
          );
          const candidateBySymbol = new Map(
            candidatePolicyActions.map((action) => [action.symbol, action]),
          );
          const threshold = scenario === "entry"
            ? profile.entryUpProbability
            : profile.exitUpProbability;
          const symbols = [...new Set([
            ...referenceBySymbol.keys(),
            ...candidateBySymbol.keys(),
          ])].sort();
          for (const symbol of symbols) {
            const left = referenceBySymbol.get(symbol);
            const right = candidateBySymbol.get(symbol);
            if (!left || !right) {
              throw new Error(`policy action disappeared from threshold audit for ${symbol}.`);
            }
            const referenceMargin = left.upProbability - threshold;
            const candidateMargin = right.upProbability - threshold;
            const referenceSatisfied = scenario === "entry"
              ? referenceMargin >= 0
              : referenceMargin > 0;
            const candidateSatisfied = scenario === "entry"
              ? candidateMargin >= 0
              : candidateMargin > 0;
            const record: ThresholdMarginRecord = {
              schema_version: "fincast-policy-threshold-margin/v1",
              origin_at: originAt,
              preset,
              risk_tolerance: riskTolerance,
              scenario,
              symbol,
              threshold_kind: scenario === "entry"
                ? "entry_up_probability"
                : "exit_up_probability",
              comparison: scenario === "entry"
                ? "greater_than_or_equal"
                : "greater_than",
              threshold,
              reference: {
                up_probability: left.upProbability,
                signed_margin: referenceMargin,
                absolute_margin: Math.abs(referenceMargin),
                threshold_satisfied: referenceSatisfied,
                action: left.action,
                reasons: [...left.reasons],
              },
              candidate: {
                up_probability: right.upProbability,
                signed_margin: candidateMargin,
                absolute_margin: Math.abs(candidateMargin),
                threshold_satisfied: candidateSatisfied,
                action: right.action,
                reasons: [...right.reasons],
              },
              candidate_probability_delta: right.upProbability - left.upProbability,
              threshold_crossed: referenceSatisfied !== candidateSatisfied,
              action_mismatch: left.action !== right.action,
              reason_mismatch: JSON.stringify(left.reasons) !== JSON.stringify(right.reasons),
            };
            symbolAlignedActionMismatches += Number(record.action_mismatch);
            symbolAlignedReasonMismatches += Number(record.reason_mismatch);
            if (record.threshold_crossed) {
              const crossingKey = `${scenario}:${record.threshold_kind}:${symbol}`;
              thresholdCrossingCounts.set(
                crossingKey,
                (thresholdCrossingCounts.get(crossingKey) ?? 0) + 1,
              );
            }
            if (
              left.targetAllocationRate !== undefined
              && right.targetAllocationRate !== undefined
            ) {
              symbolAlignedAllocationMaximum = Math.max(
                symbolAlignedAllocationMaximum,
                Math.abs(left.targetAllocationRate - right.targetAllocationRate),
              );
            } else if (left.targetAllocationRate !== right.targetAllocationRate) {
              symbolAlignedAllocationMaximum = Number.POSITIVE_INFINITY;
            }
            if (record.reason_mismatch || record.action_mismatch || record.threshold_crossed) {
              const rowId = rowIds.find((candidateRowId) => (
                artifact.origins[candidateRowId]!.metadata.symbol === symbol
              ));
              if (rowId === undefined) {
                throw new Error(`reason detail row disappeared for ${symbol}.`);
              }
              const base = contextClose(artifact, rowId);
              const referenceNative = predictionRow(reference, rowId);
              const candidateNative = predictionRow(candidate, rowId);
              const referenceProbability = projectedProbability(referenceNative, base);
              const candidateProbability = projectedProbability(candidateNative, base);
              const referenceReasonSet = new Set(left.reasons);
              const candidateReasonSet = new Set(right.reasons);
              const reasonsAddedToCandidate = right.reasons.filter(
                (reason) => !referenceReasonSet.has(reason),
              );
              const reasonsRemovedFromCandidate = left.reasons.filter(
                (reason) => !candidateReasonSet.has(reason),
              );
              for (const reason of reasonsAddedToCandidate) {
                reasonAddedToCandidateCounts.set(
                  reason,
                  (reasonAddedToCandidateCounts.get(reason) ?? 0) + 1,
                );
              }
              for (const reason of reasonsRemovedFromCandidate) {
                reasonRemovedFromCandidateCounts.set(
                  reason,
                  (reasonRemovedFromCandidateCounts.get(reason) ?? 0) + 1,
                );
              }
              const referencePosition = referenceActions.findIndex(
                (action) => action.symbol === symbol,
              );
              const candidatePosition = candidateActions.findIndex(
                (action) => action.symbol === symbol,
              );
              const causeCodes = reasonDifferenceCauseCodes({
                scenario,
                thresholdCrossed: record.threshold_crossed,
                referenceScore: left.score,
                candidateScore: right.score,
                selectionChanged: referencePosition !== candidatePosition,
                referenceSegment: referenceProbability.segment,
                candidateSegment: candidateProbability.segment,
                referenceProjectedPrices: projectedPoints(referenceNative).map((point) => point[1]),
                candidateProjectedPrices: projectedPoints(candidateNative).map((point) => point[1]),
                referenceReasons: left.reasons,
                candidateReasons: right.reasons,
                reasonMismatch: record.reason_mismatch,
                actionMismatch: record.action_mismatch,
              });
              for (const cause of causeCodes) {
                reasonCauseCounts.set(cause, (reasonCauseCounts.get(cause) ?? 0) + 1);
              }
              const origin = artifact.origins[rowId]!;
              const realized = market
                ? Object.fromEntries(HORIZONS.map((horizon) => {
                    const target = market.bars.get(
                      marketBarKey(symbol, Date.parse(origin.future_timestamps[horizon - 1]!)),
                    );
                    if (!target) throw new Error(`reason realized bar missing for ${symbol}.`);
                    return [`${horizon}m`, target.close / base - 1];
                  }))
                : null;
              await detailRecorder?.write({
                schema_version: "fincast-backend-comparison-detail/v1",
                record_type: "policy_reason_difference",
                row_id: rowId,
                origin_at: originAt,
                symbol,
                preset,
                risk_tolerance: riskTolerance,
                scenario,
                cause_codes: causeCodes,
                reason_delta: {
                  added_to_candidate: reasonsAddedToCandidate,
                  removed_from_candidate: reasonsRemovedFromCandidate,
                },
                base_close: base,
                realized_returns: realized,
                threshold,
                reference: {
                  action: left.action,
                  reasons: left.reasons,
                  score: left.score,
                  up_probability: left.upProbability,
                  signed_margin: referenceMargin,
                  raw_native_5m_prices: referenceNative,
                  projected_quantiles: projectedPoints(referenceNative),
                  cdf_segment: referenceProbability.segment,
                },
                candidate: {
                  action: right.action,
                  reasons: right.reasons,
                  score: right.score,
                  up_probability: right.upProbability,
                  signed_margin: candidateMargin,
                  raw_native_5m_prices: candidateNative,
                  projected_quantiles: projectedPoints(candidateNative),
                  cdf_segment: candidateProbability.segment,
                },
                delta: {
                  up_probability: right.upProbability - left.upProbability,
                  score: right.score - left.score,
                  target_allocation_rate:
                    (right.targetAllocationRate ?? 0) - (left.targetAllocationRate ?? 0),
                },
              });
            }
            referenceAbsoluteMargins.push(record.reference.absolute_margin);
            candidateAbsoluteMargins.push(record.candidate.absolute_margin);
            probabilityDeltas.push(Math.abs(record.candidate_probability_delta));
            thresholdCrossings += Number(record.threshold_crossed);
            closestThresholdSamples.push(record);
            closestThresholdSamples.sort((first, second) => (
              Math.min(
                first.reference.absolute_margin,
                first.candidate.absolute_margin,
              ) - Math.min(
                second.reference.absolute_margin,
                second.candidate.absolute_margin,
              )
            ));
            if (closestThresholdSamples.length > 20) closestThresholdSamples.pop();
            await marginRecorder?.write(record);
          }
          if (mismatch.reasons > 0 && reasonMismatchSamples.length < 20) {
            reasonMismatchSamples.push({
              origin_at: originAt,
              preset,
              risk_tolerance: riskTolerance,
              scenario,
              reference_actions: referenceActions,
              candidate_actions: candidateActions,
            });
          }
          maximumAllocationDelta = Math.max(
            maximumAllocationDelta,
            mismatch.allocationMaximum,
          );
          perPreset[preset]!.scenarios += 1;
          perPreset[preset]!.actionKindMismatches += mismatch.kind;
          perPreset[preset]!.reasonMismatches += mismatch.reasons;
          const key = JSON.stringify({
            originAt,
            preset,
            riskTolerance,
            scenario,
            actions: referenceActions,
          });
          referenceSignature.update(key);
          candidateSignature.update(JSON.stringify({
            originAt,
            preset,
            riskTolerance,
            scenario,
            actions: candidateActions,
          }));
        }
      }
    }
  }
  const returnComparison = market
    ? await modelSignalReturns({
        artifact,
        market,
        reference,
        candidate,
        byOrigin,
        ...(detailRecorder ? { details: detailRecorder } : {}),
      })
    : null;
  const passed = selectionOrderMismatches === 0
    && actionKindMismatches === 0
    && reasonMismatches === 0
    && actionCount === scenarioCount * 2
    && Number.isFinite(maximumAllocationDelta)
    && maximumAllocationDelta <= 1e-6;
  const marginArtifact = await marginRecorder?.finish();
  const detailArtifact = await detailRecorder?.finish();
  const economicGate = returnComparison
    ? object(returnComparison.gate, "model signal return gate")
    : null;
  const offlineEconomicallyAcceptable = numericalPredictionGate.passed === true
    && symbolAlignedActionMismatches === 0
    && Number.isFinite(symbolAlignedAllocationMaximum)
    && symbolAlignedAllocationMaximum <= 1e-6
    && economicGate?.passed === true;
  const reasonAssessment = {
    classification: offlineEconomicallyAcceptable
      ? "conditionally_acceptable_for_offline_raw_generation"
      : "not_acceptable",
    acceptable_for_offline_raw_generation: offlineEconomicallyAcceptable,
    acceptable_for_live_service_replacement: false,
    live_replacement_blockers: [
      "actual_rust_technical_state_replay_not_in_this_model_signal_return_test",
      ...(symbolAlignedReasonMismatches > 0
        ? ["policy_reason_digest_not_exact"] : []),
      ...(thresholdCrossings > 0 ? ["probability_threshold_crossings_observed"] : []),
      ...(economicGate?.passed === true
        ? []
        : ["probability_threshold_economic_equivalence_gate_failed"]),
    ],
    rationale: offlineEconomicallyAcceptable
      ? "Symbol-aligned actions and the active probability-threshold economics remain within the conservative limits; reason drift still requires actual technical-state replay before live replacement."
      : "One or more prediction, symbol-aligned action/allocation, or economic-equivalence limits failed.",
  };
  return {
    schema_version: "fincast-p40-policy-regression/v1",
    status: passed ? "passed" : "rejected",
    policy_version: "ai-paper-policy/v3",
    prediction_gate: numericalPredictionGate,
    gate: {
      passed,
      selection_order_mismatches: selectionOrderMismatches,
      action_kind_mismatches: actionKindMismatches,
      reason_mismatches: reasonMismatches,
      reason_mismatch_samples: reasonMismatchSamples,
      maximum_target_allocation_delta: maximumAllocationDelta,
      maximum_target_allocation_delta_limit: 1e-6,
      symbol_aligned: {
        action_kind_mismatches: symbolAlignedActionMismatches,
        reason_mismatches: symbolAlignedReasonMismatches,
        reason_mismatch_rate: symbolAlignedReasonMismatches / actionCount,
        maximum_target_allocation_delta: symbolAlignedAllocationMaximum,
      },
    },
    reason_difference_analysis: {
      schema_version: "fincast-reason-difference-analysis/v1",
      cause_counts: Object.fromEntries(
        [...reasonCauseCounts.entries()].sort((left, right) => (
          right[1] - left[1] || left[0].localeCompare(right[0])
        )),
      ),
      reason_code_deltas: {
        added_to_candidate: Object.fromEntries(
          [...reasonAddedToCandidateCounts.entries()].sort((left, right) => (
            right[1] - left[1] || left[0].localeCompare(right[0])
          )),
        ),
        removed_from_candidate: Object.fromEntries(
          [...reasonRemovedFromCandidateCounts.entries()].sort((left, right) => (
            right[1] - left[1] || left[0].localeCompare(right[0])
          )),
        ),
      },
      assessment: reasonAssessment,
      detail_artifact: detailArtifact ?? null,
    },
    threshold_margin_audit: {
      schema_version: "fincast-policy-threshold-margin-audit/v1",
      record_count: referenceAbsoluteMargins.length,
      threshold_crossing_count: thresholdCrossings,
      threshold_crossing_counts: Object.fromEntries(
        [...thresholdCrossingCounts.entries()].sort((left, right) => (
          right[1] - left[1] || left[0].localeCompare(right[0])
        )),
      ),
      reference_absolute_margin: {
        minimum: minimum(referenceAbsoluteMargins),
        p05: percentile([...referenceAbsoluteMargins], 0.05),
        median: percentile([...referenceAbsoluteMargins], 0.5),
        p95: percentile([...referenceAbsoluteMargins], 0.95),
      },
      candidate_absolute_margin: {
        minimum: minimum(candidateAbsoluteMargins),
        p05: percentile([...candidateAbsoluteMargins], 0.05),
        median: percentile([...candidateAbsoluteMargins], 0.5),
        p95: percentile([...candidateAbsoluteMargins], 0.95),
      },
      absolute_probability_delta: {
        maximum: maximum(probabilityDeltas),
        median: percentile([...probabilityDeltas], 0.5),
        p95: percentile([...probabilityDeltas], 0.95),
        p99: percentile([...probabilityDeltas], 0.99),
      },
      closest_threshold_samples: closestThresholdSamples,
      artifact: marginArtifact ?? null,
    },
    probability_only_near_threshold: {
      schema_version: "fincast-probability-only-near-threshold/v1",
      passed: thresholdCrossings === 0,
      semantics:
        "all non-probability policy conditions are assumed satisfied; entry uses >= entry threshold and held exit uses > exit threshold",
      decision_count: referenceAbsoluteMargins.length,
      action_mismatch_count: thresholdCrossings,
      action_mismatch_rate: thresholdCrossings / referenceAbsoluteMargins.length,
      mismatch_counts: Object.fromEntries(
        [...thresholdCrossingCounts.entries()].sort((left, right) => (
          right[1] - left[1] || left[0].localeCompare(right[0])
        )),
      ),
    },
    coverage: {
      symbols: ["BTCUSDT", "ETHUSDT"],
      duration_hours: artifact.durationHours,
      origin_count: byOrigin.size,
      row_count: artifact.manifest.row_count,
      presets: [...PRESETS],
      risk_tolerances: [...RISK_TOLERANCES],
      scenarios: ["bullish_entry", "bearish_held_exit"],
      scenario_count: scenarioCount,
      action_count: actionCount,
      round_trip_cost_rate: ROUND_TRIP_COST_RATE,
    },
    per_preset: perPreset,
    realized_accuracy: realizedAccuracyResult,
    model_signal_returns: returnComparison,
    input: {
      manifest_sha256: artifact.manifestSha256,
      artifact_digest: artifact.artifactDigest,
    },
    reference: {
      backend: reference.backend,
      batch_size: reference.batchSize,
      manifest_sha256: reference.manifestSha256,
      output_digest: reference.outputDigest,
      policy_signature: referenceSignature.digest("hex"),
    },
    candidate: {
      backend: candidate.backend,
      batch_size: candidate.batchSize,
      manifest_sha256: candidate.manifestSha256,
      output_digest: candidate.outputDigest,
      policy_signature: candidateSignature.digest("hex"),
    },
  };
}

async function atomicJson(path: string, value: JsonObject): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("--output must be an absolute normalized path.");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function argumentsFrom(argv: readonly string[]): {
  manifestPath: string;
  referenceDirectory: string;
  candidateDirectory: string;
  outputPath: string;
  marketDataManifestPath?: string;
  marginsOutputPath?: string;
  detailsOutputPath?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("invalid command arguments.");
    values.set(name, value);
  }
  const manifestPath = values.get("--job");
  const referenceDirectory = values.get("--reference");
  const candidateDirectory = values.get("--candidate");
  const outputPath = values.get("--output");
  if (!manifestPath || !referenceDirectory || !candidateDirectory || !outputPath) {
    throw new Error("--job, --reference, --candidate, and --output are required.");
  }
  return {
    manifestPath,
    referenceDirectory,
    candidateDirectory,
    outputPath,
    ...(values.get("--market-data")
      ? { marketDataManifestPath: values.get("--market-data") }
      : {}),
    ...(values.get("--margins-output")
      ? { marginsOutputPath: values.get("--margins-output") }
      : {}),
    ...(values.get("--details-output")
      ? { detailsOutputPath: values.get("--details-output") }
      : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const arguments_ = argumentsFrom(process.argv.slice(2));
  const result = await comparePolicyRegression({
    manifestPath: arguments_.manifestPath,
    referenceDirectory: arguments_.referenceDirectory,
    candidateDirectory: arguments_.candidateDirectory,
    ...(arguments_.marketDataManifestPath
      ? { marketDataManifestPath: arguments_.marketDataManifestPath }
      : {}),
    ...(arguments_.marginsOutputPath
      ? { marginsOutputPath: arguments_.marginsOutputPath }
      : {}),
    ...(arguments_.detailsOutputPath
      ? { detailsOutputPath: arguments_.detailsOutputPath }
      : {}),
  });
  await atomicJson(arguments_.outputPath, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
