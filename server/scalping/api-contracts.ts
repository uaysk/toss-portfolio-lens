import { z } from "zod";
import type { IntradayBarRecord, ScalpingPredictionRecord } from "../repositories/scalping-repository.js";
import type { InstrumentInfo, Holding } from "../toss.js";
import type { AiResponse } from "../worker/ai-contract.js";
import {
  MarketCountrySchema,
  MinuteIntervalSchema,
  createScannerRequestSchema,
  type DataQuality,
  type MarketCountry,
  type NormalizedOrderbook,
  type ScannerCandidate,
} from "./contracts.js";

export const SCALPING_WORKSPACE_SCHEMA_VERSION = "scalping-workspace/v1" as const;
export const SCALPING_REALTIME_ANALYSIS_SCHEMA_VERSION = "scalping-realtime-analysis/v1" as const;

export const WorkspacePresetSchema = z.enum(["trend", "breakout", "mean_reversion", "risk_management"]);
export type WorkspacePreset = z.infer<typeof WorkspacePresetSchema>;

const normalizedSymbolSchema = z.string()
  .trim()
  .min(1)
  .max(32)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/));

function uniqueSymbolsSchema(maximumSymbols: number) {
  if (!Number.isInteger(maximumSymbols) || maximumSymbols < 1) {
    throw new Error("maximumSymbols must be a positive integer.");
  }
  return z.array(normalizedSymbolSchema)
    .min(1)
    .max(maximumSymbols)
    .superRefine((symbols, context) => {
      const seen = new Set<string>();
      symbols.forEach((symbol, index) => {
        if (seen.has(symbol)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "중복 종목을 제거해 주세요.",
          });
        }
        seen.add(symbol);
      });
    });
}

export type ScalpingRequestLimits = {
  minimumTopCount: number;
  maximumTopCount: number;
};

export function createScalpingWorkspaceRequestSchema(limits: ScalpingRequestLimits) {
  return createScannerRequestSchema(limits).extend({
    interval: MinuteIntervalSchema,
    layoutColumns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    preset: WorkspacePresetSchema,
    symbols: uniqueSymbolsSchema(limits.maximumTopCount).optional(),
    scanOnly: z.boolean().optional(),
    analysisSymbol: normalizedSymbolSchema.optional(),
    accountId: z.string().trim().min(1).max(128).optional(),
    includePortfolioContext: z.boolean().optional(),
  }).superRefine((request, context) => {
    if ((request.symbols?.length ?? 0) > request.topCount) {
      context.addIssue({
        code: "custom",
        path: ["symbols"],
        message: "사용자 지정 종목 수는 표시 종목 수를 넘을 수 없습니다.",
      });
    }
    if (request.scanOnly && request.analysisSymbol) {
      context.addIssue({
        code: "custom",
        path: ["analysisSymbol"],
        message: "목록 스캔과 상세 분석 종목은 한 요청에서 함께 지정할 수 없습니다.",
      });
    }
  });
}

export function createScalpingForecastRequestSchema(maximumSymbols: number) {
  return z.object({
    marketCountry: MarketCountrySchema.default("KR"),
    symbols: uniqueSymbolsSchema(maximumSymbols),
    interval: MinuteIntervalSchema,
  }).strict();
}

export function createScalpingRealtimeAnalysisRequestSchema(maximumSymbols: number) {
  return z.object({
    marketCountry: MarketCountrySchema.default("KR"),
    symbols: uniqueSymbolsSchema(maximumSymbols),
    interval: MinuteIntervalSchema,
    preset: WorkspacePresetSchema,
    accountId: z.string().trim().min(1).max(128).optional(),
    positionContext: z.object({
      mode: z.literal("isolated"),
      positions: z.array(z.object({
        symbol: normalizedSymbolSchema,
        quantity: z.number().finite().positive(),
        averagePrice: z.number().finite().positive(),
        asOf: z.string().datetime({ offset: true }),
      }).strict()).max(maximumSymbols),
    }).strict().optional(),
  }).strict().superRefine((request, context) => {
    if (!request.positionContext) return;
    const requested = new Set(request.symbols);
    const seen = new Set<string>();
    request.positionContext.positions.forEach((position, index) => {
      if (!requested.has(position.symbol)) {
        context.addIssue({
          code: "custom",
          path: ["positionContext", "positions", index, "symbol"],
          message: "격리 포지션은 분석 요청 종목에 포함되어야 합니다.",
        });
      }
      if (seen.has(position.symbol)) {
        context.addIssue({
          code: "custom",
          path: ["positionContext", "positions", index, "symbol"],
          message: "격리 포지션 종목은 중복될 수 없습니다.",
        });
      }
      seen.add(position.symbol);
    });
  });
}

export function createScalpingEvaluationRequestSchema(maximumSymbols: number) {
  return z.object({
    marketCountry: MarketCountrySchema.default("KR"),
    symbols: uniqueSymbolsSchema(maximumSymbols),
    interval: MinuteIntervalSchema,
    preset: WorkspacePresetSchema.default("risk_management"),
    evaluation: z.object({
      walkForward: z.literal(true),
      retrospective: z.literal(true),
      commissionBpsPerSide: z.number().finite().min(0).max(1_000),
      taxBpsOnExit: z.number().finite().min(0).max(1_000),
      spreadBpsRoundTrip: z.number().finite().min(0).max(5_000),
      slippageBpsPerSide: z.number().finite().min(0).max(5_000),
    }).strict(),
  }).strict();
}

export type ScalpingWorkspaceRequest = z.input<ReturnType<typeof createScalpingWorkspaceRequestSchema>>;
export type ParsedScalpingWorkspaceRequest = z.output<ReturnType<typeof createScalpingWorkspaceRequestSchema>>;
export type ScalpingForecastRequest = z.input<ReturnType<typeof createScalpingForecastRequestSchema>>;
export type ParsedScalpingForecastRequest = z.output<ReturnType<typeof createScalpingForecastRequestSchema>>;
export type ScalpingRealtimeAnalysisRequest = z.input<ReturnType<typeof createScalpingRealtimeAnalysisRequestSchema>>;
export type ParsedScalpingRealtimeAnalysisRequest = z.output<ReturnType<typeof createScalpingRealtimeAnalysisRequestSchema>>;
export type ScalpingEvaluationRequest = z.input<ReturnType<typeof createScalpingEvaluationRequestSchema>>;
export type ParsedScalpingEvaluationRequest = z.output<ReturnType<typeof createScalpingEvaluationRequestSchema>>;

const analysisPriceRangeSchema = z.object({
  low: z.number().finite(),
  high: z.number().finite(),
}).strict();

export const ScalpingAnalysisSignalPointSchema = z.object({
  status: z.string().min(1).max(64).optional(),
  calculation_timestamp: z.string().datetime({ offset: true }).optional(),
  signal_timestamp: z.string().datetime({ offset: true }).optional(),
  technical_signal: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  basis_price: z.number().finite().optional(),
  stop_candidate_price: z.number().finite().nullable().optional(),
  target_candidate_price: z.number().finite().nullable().optional(),
  target_price_range: analysisPriceRangeSchema.nullable().optional(),
  multi_timeframe_agreement: z.string().min(1).max(64).optional(),
}).passthrough();
export type ScalpingAnalysisSignalPoint = z.infer<typeof ScalpingAnalysisSignalPointSchema>;

const analysisSignalSeriesSchema = z.object({
  points: z.array(ScalpingAnalysisSignalPointSchema).optional(),
  latest: ScalpingAnalysisSignalPointSchema.optional(),
}).strict().nullable();

const analysisMetricSchema = z.object({
  value: z.number().finite().nullable().optional(),
  values: z.object({
    value: z.number().finite().nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

export const ScalpingAnalysisInstrumentSchema = z.object({
  instrument_key: z.string().trim().min(1).max(128),
  signals: analysisSignalSeriesSchema.optional(),
  signal_snapshots: z.array(ScalpingAnalysisSignalPointSchema).optional(),
  scanner_metrics: z.record(z.string(), analysisMetricSchema).optional(),
  status: z.string().min(1).max(64).optional(),
  reason: z.string().min(1).max(240).optional(),
}).passthrough();
export type ScalpingAnalysisInstrument = z.infer<typeof ScalpingAnalysisInstrumentSchema>;

export const ScalpingAnalysisResultSchema = z.object({
  schema_version: z.literal("scalping-analysis-result/v3"),
  scalping_engine_version: z.string().min(1).max(128).optional(),
  indicator_engine_version: z.string().min(1).max(128).optional(),
  response_mode: z.enum(["full_series", "latest_summary"]).optional(),
  interval_minutes: z.union([
    z.literal(1),
    z.literal(5),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ]).optional(),
  instruments: z.array(ScalpingAnalysisInstrumentSchema),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type ScalpingAnalysisResult = z.infer<typeof ScalpingAnalysisResultSchema>;

export const ScalpingUnavailableAnalysisResultSchema = z.object({
  instruments: z.array(ScalpingAnalysisInstrumentSchema),
}).strict();
export type ScalpingUnavailableAnalysisResult = z.infer<typeof ScalpingUnavailableAnalysisResultSchema>;
export type ScalpingTechnicalAnalysisResult =
  | ScalpingAnalysisResult
  | ScalpingUnavailableAnalysisResult;

export type ScalpingUnavailableTechnical = {
  status: "unavailable";
  reason: string;
};

export type ScalpingWorkspaceInstrument = {
  symbol: string;
  metadata?: InstrumentInfo;
  bars: IntradayBarRecord[];
  orderbook?: NormalizedOrderbook;
  orderbookStatus:
    | { status: "available"; source: string; depth?: "top_of_book" }
    | { status: "unavailable"; code: string; reason: string };
  technical: ScalpingAnalysisInstrument | ScalpingUnavailableTechnical;
  realtime: Record<string, unknown>;
  position: (Holding & { asOf: string }) | { status: "unavailable"; reason: string };
  tradeMarkers: unknown[];
  prediction: ScalpingPredictionRecord | { status: "unavailable"; reason: string };
};

export type ScalpingWorkspaceResult = {
  workspace: {
    schemaVersion: typeof SCALPING_WORKSPACE_SCHEMA_VERSION;
    generatedAt: string;
    marketCountry: MarketCountry;
    criterion: ParsedScalpingWorkspaceRequest["criterion"];
    requestedTopCount: number;
    interval: ParsedScalpingWorkspaceRequest["interval"];
    layoutColumns: ParsedScalpingWorkspaceRequest["layoutColumns"];
    preset: WorkspacePreset;
    analysisSymbol?: string;
    candidates: ScannerCandidate[];
    excluded: ScannerCandidate[];
    instruments: ScalpingWorkspaceInstrument[];
    quality: DataQuality;
    diagnostics: {
      providerErrors: string[];
      analysisBatchInstrumentCount: number;
      analysisBatchRequestCount: number;
      browserIndicatorCalculation: false;
      tradingAmountUnit: "KRW" | "USD";
      exchangeEligibleCandidateCount?: number;
      exchangeMetadataFallbackCount?: number;
      orderbookPolicy?: string;
    };
  };
};

export type ScalpingUnavailableSeries = { symbol: string; code: string };
export type ScalpingUnavailablePrediction = {
  symbol: string;
  status: "unavailable";
  unavailable: { code: string; message: string };
};

export type ScalpingForecastResult = {
  forecast: AiResponse | {
    status: "unavailable";
    code?: string;
    series?: ScalpingUnavailableSeries[];
  };
  predictions: Array<ScalpingPredictionRecord | ScalpingUnavailablePrediction>;
  unavailable?: ScalpingUnavailableSeries[];
};

export type ScalpingRealtimeAnalysisResult = {
  schemaVersion: typeof SCALPING_REALTIME_ANALYSIS_SCHEMA_VERSION;
  generatedAt: string;
  marketCountry: MarketCountry;
  interval: ParsedScalpingRealtimeAnalysisRequest["interval"];
  preset: WorkspacePreset;
  barRevision: string;
  technical: ScalpingTechnicalAnalysisResult | ScalpingUnavailableTechnical;
  diagnostics: {
    analysisBatchRequestCount: number;
    analysisBatchInstrumentCount: number;
    finalizedBarsOnly: true;
    providerRescan: false;
    positionContext: "isolated_request" | "latest_workspace_snapshot" | "unavailable";
  };
};
