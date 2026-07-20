import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isHistoryDate } from "../history.js";
import { isArtifactType } from "../repositories/artifact-repository.js";
import type { MarketDataService, MarketSeriesResult } from "./market-data-service.js";
import type { ArtifactService } from "./artifact-service.js";
import type { RunService } from "./run-service.js";
import { canonicalJson } from "../worker/contracts.js";
import type { RustComputeClient } from "../worker/rust-client.js";
import { envelope, ServiceError } from "./service-envelope.js";
import {
  TECHNICAL_INDICATOR_ENGINE_VERSION,
  TECHNICAL_INDICATOR_KINDS,
  TECHNICAL_INDICATOR_PARAMETER_RULES,
  MAX_VOLUME_PROFILE_BUCKETS,
  MAX_VOLUME_PROFILE_OBSERVATIONS,
  TechnicalAnalysisWorkerResultSchema,
  type TechnicalIndicatorKind,
  type TechnicalIndicatorParameterRule,
} from "./technical-analysis-contract.js";
export {
  TECHNICAL_INDICATOR_ENGINE_VERSION,
  TECHNICAL_INDICATOR_KINDS,
  type TechnicalIndicatorKind,
} from "./technical-analysis-contract.js";

export const TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION = "technical-analysis-request/v1" as const;
const TECHNICAL_ANALYSIS_CACHE_SCHEMA_VERSION = "technical-analysis-cache/v1" as const;
const MAX_SYMBOLS = 50;
const MAX_INDICATORS = 64;
const MAX_PARAMETERS = 32;
const PRICE_FETCH_CONCURRENCY = 6;
const MAX_TECHNICAL_WORK_UNITS = 500_000;
const TECHNICAL_INDICATOR_KIND_SET = new Set<string>(TECHNICAL_INDICATOR_KINDS);
const VOLUME_INDICATOR_KINDS = new Set<TechnicalIndicatorKind>([
  "volume_sma",
  "relative_volume",
  "obv",
  "mfi",
  "cmf",
  "accumulation_distribution_line",
  "vwap_anchored_vwap",
  "volume_profile",
]);

export type TechnicalIndicatorPrimitive = string | number | boolean | null;

export type TechnicalIndicatorDefinition = {
  id: string;
  kind: TechnicalIndicatorKind;
  parameters?: Record<string, TechnicalIndicatorPrimitive>;
  instrumentKeys?: string[];
};

export type TechnicalAnalysisRequest = {
  symbols: string[];
  fromDate: string;
  toDate: string;
  interval: "1d" | "1w";
  adjusted: boolean;
  currencyMode: "local" | "KRW";
  responseMode: "full_series" | "latest_summary";
  indicators: TechnicalIndicatorDefinition[];
};

export type TechnicalAnalysisBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type TechnicalAnalysisWorkerInstrument = {
  key: string;
  symbol: string;
  market: string;
  currency: string;
  instrument_type: "stock" | "etf" | "index" | "fund" | "other";
  bars: TechnicalAnalysisBar[];
};

type TechnicalAnalysisWorkerIndicator = {
  id: string;
  kind: TechnicalIndicatorKind;
  parameters?: Record<string, TechnicalIndicatorPrimitive>;
  instrument_keys?: string[];
};

export type TechnicalAnalysisWorkerPayload = {
  technical_analysis: {
    schema_version: typeof TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION;
    response_mode: "full_series";
    adjustment_policy: "adjusted" | "unadjusted";
    instruments: TechnicalAnalysisWorkerInstrument[];
    indicators: TechnicalAnalysisWorkerIndicator[];
  };
};

function invalid(field: string, message: string): never {
  throw new ServiceError({
    code: "INVALID_TECHNICAL_ANALYSIS_REQUEST",
    message,
    retryable: false,
    field,
  });
}

function normalizeSymbol(value: unknown, field: string): string {
  if (typeof value !== "string") return invalid(field, "종목 코드는 문자열이어야 합니다.");
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,32}$/.test(symbol)) {
    return invalid(field, "종목 코드는 영문, 숫자, 마침표와 하이픈만 사용할 수 있습니다.");
  }
  return symbol;
}

function normalizedParameters(value: unknown, field: string): Record<string, TechnicalIndicatorPrimitive> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field, "지표 parameters는 객체여야 합니다.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PARAMETERS) return invalid(field, `지표 parameters는 최대 ${MAX_PARAMETERS}개까지 사용할 수 있습니다.`);
  const normalized: Array<[string, TechnicalIndicatorPrimitive]> = [];
  for (const [rawKey, item] of entries) {
    const key = rawKey.trim();
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return invalid(`${field}.${rawKey}`, "parameter 이름 형식이 올바르지 않습니다.");
    if (item === null || typeof item === "boolean") normalized.push([key, item]);
    else if (typeof item === "number" && Number.isFinite(item)) normalized.push([key, item]);
    else if (typeof item === "string" && item.length <= 256) normalized.push([key, item]);
    else return invalid(`${field}.${key}`, "parameter 값은 유한한 숫자, 문자열, boolean 또는 null이어야 합니다.");
  }
  return Object.fromEntries(normalized.sort(([left], [right]) => left.localeCompare(right)));
}

function validatedIndicatorParameters(
  kind: TechnicalIndicatorKind,
  parameters: Record<string, TechnicalIndicatorPrimitive> | undefined,
  field: string,
  instrumentKeys: ReadonlySet<string>,
): Record<string, TechnicalIndicatorPrimitive> | undefined {
  const rules = TECHNICAL_INDICATOR_PARAMETER_RULES[kind] as Readonly<Record<string, TechnicalIndicatorParameterRule>>;
  const normalized = { ...(parameters ?? {}) };
  for (const name of Object.keys(normalized)) {
    if (!Object.hasOwn(rules, name)) return invalid(`${field}.${name}`, `${kind}에서 지원하지 않는 parameter입니다.`);
  }
  for (const [name, rule] of Object.entries(rules)) {
    const value = normalized[name];
    if (value === undefined) {
      if (rule.required) return invalid(`${field}.${name}`, `${kind}에 필요한 parameter입니다.`);
      continue;
    }
    const parameterField = `${field}.${name}`;
    if (rule.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < rule.minimum || value > rule.maximum) {
        return invalid(parameterField, `${rule.minimum}~${rule.maximum} 범위의 정수여야 합니다.`);
      }
    } else if (rule.type === "number") {
      if (typeof value !== "number" || value < rule.minimum || value > rule.maximum) {
        return invalid(parameterField, `${rule.minimum}~${rule.maximum} 범위의 숫자여야 합니다.`);
      }
    } else if (rule.type === "enum") {
      if (typeof value !== "string" || !rule.values.includes(value)) {
        return invalid(parameterField, `지원 값은 ${rule.values.join(", ")}입니다.`);
      }
    } else if (rule.type === "instrument_key") {
      const key = normalizeSymbol(value, parameterField);
      if (!instrumentKeys.has(key)) return invalid(parameterField, "요청 종목에 없는 instrument key입니다.");
      normalized[name] = key;
    } else if (typeof value !== "string" || !isHistoryDate(value)) {
      return invalid(parameterField, "YYYY-MM-DD 형식의 유효한 날짜여야 합니다.");
    }
  }

  if (kind === "macd") {
    const fast = Number(normalized.fast_period ?? 12);
    const slow = Number(normalized.slow_period ?? 26);
    if (fast >= slow) return invalid(field, "MACD는 fast_period < slow_period여야 합니다.");
  }
  if (kind === "parabolic_sar") {
    const step = Number(normalized.step ?? 0.02);
    const maximum = Number(normalized.max_step ?? 0.2);
    if (step > maximum) return invalid(field, "Parabolic SAR는 step <= max_step이어야 합니다.");
  }
  if (kind === "vwap_anchored_vwap") {
    const anchor = String(normalized.anchor ?? "period_start");
    if ((anchor === "user_date" || anchor === "signal_date") && normalized.anchor_date === undefined) {
      return invalid(`${field}.anchor_date`, `${anchor} anchor에는 anchor_date가 필요합니다.`);
    }
    if (anchor !== "user_date" && anchor !== "signal_date" && normalized.anchor_date !== undefined) {
      return invalid(`${field}.anchor_date`, "anchor_date는 user_date 또는 signal_date anchor에서만 사용할 수 있습니다.");
    }
  }
  return Object.keys(normalized).length
    ? Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)))
    : undefined;
}

export function normalizeTechnicalAnalysisRequest(request: TechnicalAnalysisRequest): {
  publicRequest: TechnicalAnalysisRequest;
  workerIndicators: TechnicalAnalysisWorkerIndicator[];
  cacheConfig: Record<string, unknown>;
} {
  if (!request || typeof request !== "object") return invalid("request", "기술적 분석 요청이 필요합니다.");
  if (!Array.isArray(request.symbols) || request.symbols.length < 1 || request.symbols.length > MAX_SYMBOLS) {
    return invalid("symbols", `종목은 1~${MAX_SYMBOLS}개까지 입력할 수 있습니다.`);
  }
  const symbols = request.symbols.map((symbol, index) => normalizeSymbol(symbol, `symbols.${index}`));
  if (new Set(symbols).size !== symbols.length) return invalid("symbols", "중복 종목을 제거해 주세요.");
  symbols.sort((left, right) => left.localeCompare(right));
  if (!isHistoryDate(request.fromDate) || !isHistoryDate(request.toDate) || request.fromDate > request.toDate) {
    return invalid("fromDate", "가격 조회 시작일과 종료일을 확인해 주세요.");
  }
  if (request.interval !== "1d" && request.interval !== "1w") return invalid("interval", "interval은 1d 또는 1w여야 합니다.");
  if (typeof request.adjusted !== "boolean") return invalid("adjusted", "adjusted는 boolean이어야 합니다.");
  if (request.currencyMode !== "local" && request.currencyMode !== "KRW") return invalid("currencyMode", "currencyMode는 local 또는 KRW여야 합니다.");
  if (request.responseMode !== "full_series" && request.responseMode !== "latest_summary") {
    return invalid("responseMode", "responseMode는 full_series 또는 latest_summary여야 합니다.");
  }
  if (!Array.isArray(request.indicators) || request.indicators.length < 1 || request.indicators.length > MAX_INDICATORS) {
    return invalid("indicators", `지표는 1~${MAX_INDICATORS}개까지 입력할 수 있습니다.`);
  }
  const knownKeys = new Set(symbols);
  const ids = new Set<string>();
  const workerIndicators = request.indicators.map((indicator, index): TechnicalAnalysisWorkerIndicator => {
    if (!indicator || typeof indicator !== "object") return invalid(`indicators.${index}`, "지표 정의는 객체여야 합니다.");
    const id = typeof indicator.id === "string" ? indicator.id.trim() : "";
    const kind = typeof indicator.kind === "string" ? indicator.kind.trim().toLowerCase() : "";
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id)) return invalid(`indicators.${index}.id`, "지표 id 형식이 올바르지 않습니다.");
    if (!TECHNICAL_INDICATOR_KIND_SET.has(kind)) return invalid(`indicators.${index}.kind`, "지원하지 않는 지표 kind입니다.");
    if (ids.has(id)) return invalid("indicators", "지표 id는 중복될 수 없습니다.");
    ids.add(id);
    const parameterField = `indicators.${index}.parameters`;
    const requestedParameters = validatedIndicatorParameters(
      kind as TechnicalIndicatorKind,
      normalizedParameters(indicator.parameters, parameterField),
      parameterField,
      knownKeys,
    );
    let parameters = requestedParameters;
    if (kind === "fifty_two_week_high_low_position" && parameters?.period === undefined) {
      parameters = { ...(parameters ?? {}), period: request.interval === "1w" ? 52 : 252 };
    }
    if (kind === "historical_volatility" && parameters?.annualization === undefined) {
      parameters = { ...(parameters ?? {}), annualization: request.interval === "1w" ? 52 : 252 };
    }
    if (kind === "vwap_anchored_vwap") {
      parameters = {
        anchor: "period_start",
        lookback_period: 20,
        mode: "both",
        ...(parameters ?? {}),
      };
    }
    if (kind === "volume_profile") {
      parameters = {
        bucket_count: 24,
        price_source: "typical_price",
        value_area_percent: 70,
        ...(parameters ?? {}),
      };
    }
    let instrumentKeys: string[] | undefined;
    if (indicator.instrumentKeys !== undefined) {
      if (!Array.isArray(indicator.instrumentKeys) || !indicator.instrumentKeys.length) {
        return invalid(`indicators.${index}.instrumentKeys`, "instrumentKeys는 비어 있지 않은 배열이어야 합니다.");
      }
      instrumentKeys = indicator.instrumentKeys.map((key, keyIndex) => normalizeSymbol(key, `indicators.${index}.instrumentKeys.${keyIndex}`));
      if (new Set(instrumentKeys).size !== instrumentKeys.length) return invalid(`indicators.${index}.instrumentKeys`, "중복 instrument key를 제거해 주세요.");
      if (instrumentKeys.some((key) => !knownKeys.has(key))) return invalid(`indicators.${index}.instrumentKeys`, "요청 종목에 없는 instrument key가 있습니다.");
      instrumentKeys.sort((left, right) => left.localeCompare(right));
      if (instrumentKeys.length === symbols.length && instrumentKeys.every((key, keyIndex) => key === symbols[keyIndex])) {
        instrumentKeys = undefined;
      }
    }
    if (kind === "volume_profile") {
      if (symbols.length !== 1) {
        return invalid("symbols", "Volume Profile은 정확히 한 종목만 포함한 집중 분석 요청이어야 합니다.");
      }
      instrumentKeys ??= [symbols[0]!];
      if (instrumentKeys.length !== 1 || instrumentKeys[0] !== symbols[0]) {
        return invalid(`indicators.${index}.instrumentKeys`, "Volume Profile 대상은 요청의 단일 종목과 정확히 일치해야 합니다.");
      }
    }
    return {
      id,
      kind: kind as TechnicalIndicatorKind,
      ...(parameters ? { parameters } : {}),
      ...(instrumentKeys ? { instrument_keys: instrumentKeys } : {}),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const profileCount = workerIndicators.filter((indicator) => indicator.kind === "volume_profile").length;
  if (profileCount > 1) return invalid("indicators", "Volume Profile 정의는 요청당 하나만 사용할 수 있습니다.");
  if (profileCount === 1 && workerIndicators.length !== 1) {
    return invalid("indicators", "Volume Profile 집중 분석 요청은 지표 정의를 정확히 하나만 포함해야 합니다.");
  }
  const publicIndicators = workerIndicators.map((indicator) => ({
    id: indicator.id,
    kind: indicator.kind,
    ...(indicator.parameters ? { parameters: indicator.parameters } : {}),
    ...(indicator.instrument_keys ? { instrumentKeys: indicator.instrument_keys } : {}),
  }));
  const publicRequest: TechnicalAnalysisRequest = {
    symbols,
    fromDate: request.fromDate,
    toDate: request.toDate,
    interval: request.interval,
    adjusted: request.adjusted,
    currencyMode: request.currencyMode,
    responseMode: request.responseMode,
    indicators: publicIndicators,
  };
  const cacheConfig = {
    cacheSchemaVersion: TECHNICAL_ANALYSIS_CACHE_SCHEMA_VERSION,
    indicator_engine_version: TECHNICAL_INDICATOR_ENGINE_VERSION,
    symbols,
    fromDate: request.fromDate,
    toDate: request.toDate,
    interval: request.interval,
    adjusted: request.adjusted,
    currencyMode: request.currencyMode,
    indicators: publicIndicators,
  };
  return { publicRequest, workerIndicators, cacheConfig };
}

export type PreparedTechnicalAnalysis = {
  normalized: ReturnType<typeof normalizeTechnicalAnalysisRequest>;
  orderedSeries: MarketSeriesResult[];
  instruments: TechnicalAnalysisWorkerInstrument[];
  payload: TechnicalAnalysisWorkerPayload;
  dataRevision: string;
  marketWarnings: string[];
  workUnits: number;
  effectivePeriod?: { from: string; to: string };
};

export type TechnicalAnalysisPrepareOptions = {
  requireVolumeSymbols?: Iterable<string>;
};

function commonObservationDates(instruments: readonly TechnicalAnalysisWorkerInstrument[]): string[] {
  if (!instruments.length) return [];
  const remaining = instruments.slice(1).map((instrument) => new Set(instrument.bars.map((bar) => bar.date)));
  return instruments[0]!.bars
    .map((bar) => bar.date)
    .filter((date) => remaining.every((dates) => dates.has(date)))
    .sort((left, right) => left.localeCompare(right));
}

function instrumentType(assetType: string): TechnicalAnalysisWorkerInstrument["instrument_type"] {
  const value = assetType.trim().toUpperCase();
  if (value.includes("ETF")) return "etf";
  if (value.includes("INDEX")) return "index";
  if (value.includes("FUND")) return "fund";
  if (value.includes("STOCK") || value.includes("EQUITY")) return "stock";
  return "other";
}

function volume(point: unknown): number | null {
  if (!point || typeof point !== "object") return null;
  const value = (point as { volume?: unknown }).volume;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function workerInstrument(series: MarketSeriesResult): TechnicalAnalysisWorkerInstrument {
  return {
    key: series.instrument.symbol,
    symbol: series.instrument.symbol,
    market: series.instrument.market,
    currency: series.currency,
    instrument_type: instrumentType(series.instrument.assetType),
    bars: series.points.map((point) => ({
      date: point.date,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
      volume: volume(point),
    })).sort((left, right) => left.date.localeCompare(right.date)),
  };
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    () => worker(),
  ));
  return output;
}

function technicalWorkUnits(
  instruments: readonly TechnicalAnalysisWorkerInstrument[],
  indicators: readonly TechnicalAnalysisWorkerIndicator[],
): number {
  const observations = new Map(instruments.map((instrument) => [instrument.key, instrument.bars.length]));
  return indicators.reduce((total, indicator) => {
    const targets = indicator.instrument_keys ?? instruments.map((instrument) => instrument.key);
    return total + targets.reduce((sum, key) => sum + (observations.get(key) ?? 0), 0);
  }, 0);
}

export function technicalAnalysisDataRevision(instruments: readonly TechnicalAnalysisWorkerInstrument[]): string {
  const normalized = [...instruments]
    .map((instrument) => ({ ...instrument, bars: [...instrument.bars].sort((left, right) => left.date.localeCompare(right.date)) }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return createHash("sha256")
    .update(canonicalJson({ schema_version: "technical-analysis-data/v1", instruments: normalized }))
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Projects the canonical full-series Rust result without recalculating indicators.
 * The persisted result remains the sole cache entry for both response modes.
 */
export function projectTechnicalAnalysisLatest(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !Array.isArray(result.calculations)) {
    throw new ServiceError({
      code: "INVALID_TECHNICAL_ANALYSIS_RESULT",
      message: "저장된 기술적 분석 full-series 결과 형식이 올바르지 않습니다.",
      retryable: false,
    });
  }
  const calculations = result.calculations.map((calculation, index) => {
    if (!isRecord(calculation) || !Array.isArray(calculation.points)) {
      throw new ServiceError({
        code: "INVALID_TECHNICAL_ANALYSIS_RESULT",
        message: "저장된 기술적 분석 계산 결과 형식이 올바르지 않습니다.",
        retryable: false,
        details: { calculation_index: index },
      });
    }
    const { points, latest: _storedLatest, ...metadata } = calculation;
    const latest = points.at(-1);
    const profile = isRecord(metadata.profile)
      ? { ...metadata.profile, ...(Array.isArray(metadata.profile.buckets) ? { buckets: [] } : {}) }
      : metadata.profile;
    const calculationMetadata = isRecord(metadata.metadata) && isRecord(metadata.profile) && Array.isArray(metadata.profile.buckets)
      ? { ...metadata.metadata, profile_buckets: "omitted_in_latest_summary" }
      : metadata.metadata;
    return {
      ...metadata,
      ...(profile === undefined ? {} : { profile }),
      ...(calculationMetadata === undefined ? {} : { metadata: calculationMetadata }),
      ...(latest === undefined ? {} : { latest }),
    };
  });
  return {
    ...result,
    response_mode: "latest_summary",
    calculations,
  };
}

function validateTechnicalAnalysisResultVersion(result: unknown): void {
  if (!isRecord(result) || result.indicator_engine_version !== TECHNICAL_INDICATOR_ENGINE_VERSION) {
    throw new ServiceError({
      code: "TECHNICAL_INDICATOR_ENGINE_VERSION_MISMATCH",
      message: "Rust 기술 지표 엔진 버전이 Node.js 계약과 일치하지 않습니다.",
      retryable: false,
      details: {
        expected: TECHNICAL_INDICATOR_ENGINE_VERSION,
        actual: isRecord(result) ? result.indicator_engine_version : undefined,
      },
    });
  }
  const parsed = TechnicalAnalysisWorkerResultSchema.safeParse(result);
  if (!parsed.success || parsed.data.response_mode !== "full_series") {
    const profileLimitViolation = !parsed.success && parsed.error.issues.some((issue) => (
      issue.path.includes("buckets")
      || issue.path.includes("included_observations")
      || issue.path.includes("missing_volume_observations")
    ));
    throw new ServiceError({
      code: profileLimitViolation ? "TECHNICAL_VOLUME_PROFILE_OUTPUT_LIMIT" : "INVALID_TECHNICAL_ANALYSIS_RESULT",
      message: profileLimitViolation
        ? "Rust Volume Profile 결과가 bucket 또는 관측치 상한을 초과했습니다."
        : "Rust 기술 지표 full-series 결과 계약이 올바르지 않습니다.",
      retryable: false,
      details: parsed.success
        ? { response_mode: parsed.data.response_mode }
        : { issues: parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    });
  }
}

function taskArtifacts(output: Awaited<ReturnType<RustComputeClient["compute"]>>) {
  const indicators = output.artifacts.filter((artifact) => artifact.type === "technical-indicators");
  const diagnostics = output.artifacts.filter((artifact) => artifact.type === "technical-diagnostics");
  if (indicators.length !== 1 || diagnostics.length !== 1
    || !isRecord(output.result) || !Array.isArray(output.result.calculations)
    || !isDeepStrictEqual(indicators[0]!.content, output.result.calculations)
    || !isDeepStrictEqual(diagnostics[0]!.content, output.result.diagnostics)) {
    throw new ServiceError({
      code: "INVALID_TECHNICAL_ARTIFACT",
      message: "Rust 기술 지표 artifact가 필수 type 또는 canonical result와 일치하지 않습니다.",
      retryable: false,
    });
  }
  return output.artifacts.map((artifact) => {
    if (!isArtifactType(artifact.type)) {
      throw new ServiceError({
        code: "INVALID_TECHNICAL_ARTIFACT",
        message: `Rust worker가 등록되지 않은 artifact를 반환했습니다: ${artifact.type}`,
        retryable: false,
      });
    }
    return {
      type: artifact.type,
      content: artifact.content,
      rowCount: artifact.row_count,
    };
  });
}

export class TechnicalAnalysisService {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly runs: RunService,
    private readonly artifacts: ArtifactService,
    private readonly rustCompute?: RustComputeClient,
  ) {}

  async prepare(request: TechnicalAnalysisRequest, options: TechnicalAnalysisPrepareOptions = {}): Promise<PreparedTechnicalAnalysis> {
    const normalized = normalizeTechnicalAnalysisRequest(request);
    const volumeTargets = new Set(normalized.workerIndicators.flatMap((indicator) => (
      VOLUME_INDICATOR_KINDS.has(indicator.kind)
        ? indicator.instrument_keys ?? normalized.publicRequest.symbols
        : []
    )));
    for (const symbol of options.requireVolumeSymbols ?? []) volumeTargets.add(symbol.trim().toUpperCase());
    const loaded = await mapWithConcurrency(
      normalized.publicRequest.symbols,
      PRICE_FETCH_CONCURRENCY,
      (symbol) => this.marketData.getPriceSeries({
        symbol,
        fromDate: normalized.publicRequest.fromDate,
        toDate: normalized.publicRequest.toDate,
        interval: normalized.publicRequest.interval,
        adjusted: normalized.publicRequest.adjusted,
        currencyMode: normalized.publicRequest.currencyMode,
        requireVolume: volumeTargets.has(symbol),
      }),
    );
    const orderedSeries = [...loaded].sort((left, right) => left.instrument.symbol.localeCompare(right.instrument.symbol));
    const instruments = orderedSeries.map(workerInstrument);
    if (normalized.workerIndicators[0]?.kind === "volume_profile"
      && instruments[0]!.bars.length > MAX_VOLUME_PROFILE_OBSERVATIONS) {
      throw new ServiceError({
        code: "TECHNICAL_VOLUME_PROFILE_OUTPUT_LIMIT",
        message: `Volume Profile은 최대 ${MAX_VOLUME_PROFILE_OBSERVATIONS.toLocaleString("en-US")}개 봉까지 계산할 수 있습니다. 기간을 줄여 주세요.`,
        retryable: false,
        field: "fromDate",
        details: {
          observations: instruments[0]!.bars.length,
          maximum_observations: MAX_VOLUME_PROFILE_OBSERVATIONS,
        },
      });
    }
    const workUnits = technicalWorkUnits(instruments, normalized.workerIndicators);
    if (workUnits > MAX_TECHNICAL_WORK_UNITS) {
      throw new ServiceError({
        code: "TECHNICAL_ANALYSIS_WORKLOAD_LIMIT",
        message: `기술적 분석 계산량은 최대 ${MAX_TECHNICAL_WORK_UNITS.toLocaleString("en-US")} point-indicator 단위입니다. 종목, 기간 또는 지표 수를 줄여 주세요.`,
        retryable: false,
        field: "indicators",
        details: { work_units: workUnits, maximum_work_units: MAX_TECHNICAL_WORK_UNITS },
      });
    }
    const dataRevision = technicalAnalysisDataRevision(instruments);
    const payload: TechnicalAnalysisWorkerPayload = {
      technical_analysis: {
        schema_version: TECHNICAL_ANALYSIS_REQUEST_SCHEMA_VERSION,
        response_mode: "full_series",
        adjustment_policy: normalized.publicRequest.adjusted ? "adjusted" : "unadjusted",
        instruments,
        indicators: normalized.workerIndicators,
      },
    };
    const starts = orderedSeries.flatMap((series) => series.effectivePeriod ? [series.effectivePeriod.from] : []);
    const ends = orderedSeries.flatMap((series) => series.effectivePeriod ? [series.effectivePeriod.to] : []);
    const effectiveFrom = starts.sort().at(-1);
    const effectiveTo = ends.sort()[0];
    const effectivePeriod = effectiveFrom && effectiveTo && effectiveFrom <= effectiveTo
      ? { from: effectiveFrom, to: effectiveTo }
      : undefined;
    return {
      normalized,
      orderedSeries,
      instruments,
      payload,
      dataRevision,
      marketWarnings: Array.from(new Set(orderedSeries.flatMap((series) => series.warnings))),
      workUnits,
      ...(effectivePeriod ? { effectivePeriod } : {}),
    };
  }

  async safeTradeDates(prepared: PreparedTechnicalAnalysis): Promise<string[]> {
    if (prepared.normalized.publicRequest.interval === "1d") {
      return commonObservationDates(prepared.instruments);
    }
    const daily = await mapWithConcurrency(
      prepared.normalized.publicRequest.symbols,
      PRICE_FETCH_CONCURRENCY,
      (symbol) => this.marketData.getPriceSeries({
        symbol,
        fromDate: prepared.normalized.publicRequest.fromDate,
        toDate: prepared.normalized.publicRequest.toDate,
        interval: "1d",
        adjusted: prepared.normalized.publicRequest.adjusted,
        currencyMode: prepared.normalized.publicRequest.currencyMode,
        requireVolume: false,
      }),
    );
    return commonObservationDates(daily.map(workerInstrument));
  }

  async analyze(input: {
    ownerSubject: string;
    request: TechnicalAnalysisRequest;
    cacheNonce?: string;
  }): Promise<ReturnType<typeof envelope>> {
    const normalized = normalizeTechnicalAnalysisRequest(input.request);
    if (this.runs.executionMode === "inline") {
      throw new ServiceError({
        code: "RUST_COMPUTE_REQUIRED",
        message: "기술적 분석은 Rust compute 실행 모드에서만 사용할 수 있습니다.",
        retryable: false,
      });
    }
    if (this.runs.executionMode === "rust_socket" && !this.rustCompute) {
      throw new ServiceError({
        code: "RUST_COMPUTE_UNAVAILABLE",
        message: "기술적 분석 Rust compute client가 초기화되지 않았습니다.",
        retryable: true,
      });
    }

    const prepared = await this.prepare(normalized.publicRequest);
    const { orderedSeries: ordered, instruments, payload, dataRevision, marketWarnings, workUnits } = prepared;

    const runConfig = input.cacheNonce
      ? { ...normalized.cacheConfig, _replayNonce: input.cacheNonce }
      : normalized.cacheConfig;
    const executed = this.runs.executionMode === "external"
      ? await this.runs.executeExternal({
          ownerSubject: input.ownerSubject,
          kind: "technical_analysis",
          config: runConfig,
          dataRevision,
          payload,
        })
      : await this.runs.execute({
          ownerSubject: input.ownerSubject,
          kind: "technical_analysis",
          config: runConfig,
          dataRevision,
          task: async (context) => {
            await context.throwIfCancelled();
            const output = await this.rustCompute!.compute("technical_analysis", payload, {
              includeArtifacts: true,
              signal: context.signal,
            });
            validateTechnicalAnalysisResultVersion(output.result);
            return {
              summary: output.summary,
              result: output.result,
              warnings: Array.from(new Set([...marketWarnings, ...output.warnings])),
              artifacts: taskArtifacts(output),
            };
          },
        });
    const storedResult = executed.run.result;
    if (storedResult === undefined) {
      throw new ServiceError({
        code: "TECHNICAL_ANALYSIS_RESULT_NOT_FOUND",
        message: "완료된 기술적 분석 결과를 찾을 수 없습니다.",
        retryable: true,
        details: { run_id: executed.run.id },
      });
    }
    validateTechnicalAnalysisResultVersion(storedResult);
    const projected = normalized.publicRequest.responseMode === "full_series"
      ? storedResult
      : projectTechnicalAnalysisLatest(storedResult);
    const priceSeries = normalized.publicRequest.responseMode === "full_series"
      ? instruments
      : instruments.map((instrument) => ({
          ...instrument,
          bars: instrument.bars.length ? [instrument.bars[instrument.bars.length - 1]!] : [],
        }));

    const effectivePeriod = prepared.effectivePeriod;
    const artifactIndex = await this.artifacts.list(executed.run.id);
    return envelope({
      request: normalized.publicRequest,
      dataRevision,
      requestedPeriod: { from: normalized.publicRequest.fromDate, to: normalized.publicRequest.toDate },
      ...(effectivePeriod ? { effectivePeriod } : {}),
      assumptions: [
        normalized.publicRequest.adjusted
          ? "지표 입력 가격은 공급자 수정주가를 사용합니다."
          : "지표 입력 가격은 비수정 가격을 사용합니다.",
        "거래량은 공급자 원단위를 그대로 사용하며 FX 환산이나 worker-side corporate-action 보정을 하지 않습니다.",
        "거래량 availability는 worker에 전달되는 선택 interval 봉 기준이며 source daily coverage는 data_quality.volume.*.source_daily에 별도로 제공합니다.",
        "VWAP·Anchored VWAP은 선택 봉의 HLC3×거래량 누적 근사치이며 체결 단위 intraday VWAP이 아닙니다.",
        "Volume Profile은 단일 종목 집중 요청에서 각 봉의 전체 거래량을 close 또는 HLC3 bucket 하나에 배정한 근사치입니다.",
        "브라우저와 Node.js는 지표를 재계산하지 않고 Rust worker 결과를 표시합니다.",
      ],
      warnings: Array.from(new Set([...marketWarnings, ...executed.run.warnings])),
      dataQuality: {
        instrument_count: instruments.length,
        indicator_count: normalized.workerIndicators.length,
        work_units: workUnits,
        maximum_work_units: MAX_TECHNICAL_WORK_UNITS,
        maximum_volume_profile_buckets: MAX_VOLUME_PROFILE_BUCKETS,
        maximum_volume_profile_observations: MAX_VOLUME_PROFILE_OBSERVATIONS,
        price_fetch_concurrency: PRICE_FETCH_CONCURRENCY,
        observations: Object.fromEntries(instruments.map((instrument) => [instrument.key, instrument.bars.length])),
        volume: Object.fromEntries(ordered.map((series) => [
          series.instrument.symbol,
          {
            status: series.dataQuality.volumeStatus,
            observations: series.dataQuality.outputObservations,
            volume_observations: series.dataQuality.volumeObservations,
            missing_volume_observations: series.dataQuality.missingVolumeObservations,
            coverage: series.dataQuality.volumeCoverage,
            source_daily: {
              observations: series.dataQuality.observations,
              volume_observations: series.dataQuality.sourceDailyVolumeObservations,
              missing_volume_observations: series.dataQuality.sourceDailyMissingVolumeObservations,
              coverage: series.dataQuality.sourceDailyVolumeCoverage,
              status: series.dataQuality.sourceDailyVolumeStatus,
            },
            provider_field: "volume",
            currency_conversion: "not_applied",
            aggregate_policy: "sum_only_when_all_constituent_daily_volumes_are_available",
          },
        ])),
        data_revision_basis: "canonical_sorted_ohlcv_content",
      },
      result: {
        run_id: executed.run.id,
        reused: executed.reused,
        response_mode: normalized.publicRequest.responseMode,
        price_series: priceSeries,
        technical_analysis: projected,
        artifact_index: artifactIndex,
      },
    });
  }
}
