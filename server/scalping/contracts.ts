import { z } from "zod";

export const SCALPING_CONTRACT_VERSION = "scalping-market/v1" as const;

export const MarketProviderSchema = z.enum(["toss", "kis", "derived"]);
export type MarketProvider = z.infer<typeof MarketProviderSchema>;

export const MarketCountrySchema = z.enum(["KR", "US"]);
export type MarketCountry = z.infer<typeof MarketCountrySchema>;

export const UsExchangeSchema = z.enum(["NAS", "NYS", "AMS"]);
export type UsExchange = z.infer<typeof UsExchangeSchema>;

export function normalizeUsExchange(value: unknown): UsExchange | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (["NAS", "NASDAQ", "XNAS"].includes(normalized)) return "NAS";
  if (["NYS", "NYSE", "XNYS"].includes(normalized)) return "NYS";
  if (["AMS", "AMEX", "NYSEAMERICAN", "XASE"].includes(normalized)) return "AMS";
  return undefined;
}

export const ScannerCriterionSchema = z.enum(["trading_amount", "volume", "volatility"]);
export type ScannerCriterion = z.infer<typeof ScannerCriterionSchema>;

export const MinuteIntervalSchema = z.enum(["1m", "5m", "15m", "30m", "60m"]);
export type MinuteInterval = z.infer<typeof MinuteIntervalSchema>;

export const DataQualityStatusSchema = z.enum([
  "available",
  "partial",
  "insufficient_history",
  "source_unavailable",
  "stale",
]);
export type DataQualityStatus = z.infer<typeof DataQualityStatusSchema>;

export const isoTimestampSchema = z.string().max(64).refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)),
  "RFC3339 timestamp with an explicit offset is required",
);

export const sessionDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "valid YYYY-MM-DD date is required");

export const marketSymbolSchema = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/);
const finiteNumberSchema = z.number().finite();
const nonNegativeNumberSchema = finiteNumberSchema.nonnegative();
const positiveNumberSchema = finiteNumberSchema.positive();

export const DataQualitySchema = z.object({
  status: DataQualityStatusSchema,
  missing: z.array(z.string().trim().min(1).max(80)).max(64),
  reasons: z.array(z.string().trim().min(1).max(240)).max(64),
  sources: z.array(MarketProviderSchema).min(1).max(3),
  observedAt: isoTimestampSchema.optional(),
}).strict();
export type DataQuality = z.infer<typeof DataQualitySchema>;

export const NormalizedRankingSchema = z.object({
  provider: z.enum(["toss", "kis"]),
  symbol: marketSymbolSchema,
  name: z.string().trim().max(160).optional(),
  marketCountry: MarketCountrySchema,
  exchange: UsExchangeSchema.optional(),
  currency: z.string().trim().min(3).max(3),
  rank: z.number().int().positive(),
  rankedAt: isoTimestampSchema,
  price: positiveNumberSchema,
  basePrice: positiveNumberSchema.optional(),
  changeRateRatio: finiteNumberSchema.optional(),
  volume: nonNegativeNumberSchema.optional(),
  tradingAmount: nonNegativeNumberSchema.optional(),
}).strict();
export type NormalizedRanking = z.infer<typeof NormalizedRankingSchema>;

export const NormalizedPriceSchema = z.object({
  provider: z.enum(["toss", "kis"]),
  symbol: marketSymbolSchema,
  currency: z.string().trim().min(3).max(3),
  observedAt: isoTimestampSchema,
  price: positiveNumberSchema,
  basePrice: positiveNumberSchema.optional(),
  changeRateRatio: finiteNumberSchema.optional(),
  volume: nonNegativeNumberSchema.optional(),
  tradingAmount: nonNegativeNumberSchema.optional(),
}).strict();
export type NormalizedPrice = z.infer<typeof NormalizedPriceSchema>;

export const NormalizedMinuteCandleSchema = z.object({
  provider: z.enum(["toss", "kis"]),
  symbol: marketSymbolSchema,
  timestamp: isoTimestampSchema,
  sessionDate: sessionDateSchema,
  interval: z.literal("1m"),
  status: z.enum(["forming", "final", "unknown"]),
  open: positiveNumberSchema,
  high: positiveNumberSchema,
  low: positiveNumberSchema,
  close: positiveNumberSchema,
  volume: nonNegativeNumberSchema.optional(),
  tradingAmount: nonNegativeNumberSchema.optional(),
}).strict().superRefine((bar, context) => {
  if (bar.high < Math.max(bar.open, bar.close, bar.low)) {
    context.addIssue({ code: "custom", message: "high must bound OHLC", path: ["high"] });
  }
  if (bar.low > Math.min(bar.open, bar.close, bar.high)) {
    context.addIssue({ code: "custom", message: "low must bound OHLC", path: ["low"] });
  }
});
export type NormalizedMinuteCandle = z.infer<typeof NormalizedMinuteCandleSchema>;

export const NormalizedTradeSchema = z.object({
  provider: z.enum(["toss", "kis"]),
  symbol: marketSymbolSchema,
  eventId: z.string().trim().min(1).max(240),
  eventIdSource: z.enum(["provider", "composite"]),
  executedAt: isoTimestampSchema,
  price: positiveNumberSchema,
  quantity: positiveNumberSchema,
  tradingAmount: positiveNumberSchema.optional(),
  side: z.enum(["buy", "sell", "unknown"]),
  cumulativeVolume: nonNegativeNumberSchema.optional(),
  executionStrength: nonNegativeNumberSchema.optional(),
}).strict();
export type NormalizedTrade = z.infer<typeof NormalizedTradeSchema>;

export const OrderbookLevelSchema = z.object({
  price: positiveNumberSchema,
  quantity: nonNegativeNumberSchema,
}).strict();
export type OrderbookLevel = z.infer<typeof OrderbookLevelSchema>;

export const NormalizedOrderbookSchema = z.object({
  provider: z.enum(["toss", "kis"]),
  symbol: marketSymbolSchema,
  observedAt: isoTimestampSchema,
  depth: z.enum(["top_of_book", "ten_level"]).optional(),
  asks: z.array(OrderbookLevelSchema).min(1),
  bids: z.array(OrderbookLevelSchema).min(1),
  totalAskQuantity: nonNegativeNumberSchema.optional(),
  totalBidQuantity: nonNegativeNumberSchema.optional(),
}).strict().superRefine((book, context) => {
  for (let index = 1; index < book.asks.length; index += 1) {
    if (book.asks[index]!.price < book.asks[index - 1]!.price) {
      context.addIssue({ code: "custom", message: "asks must be ordered from best to worst", path: ["asks", index] });
    }
  }
  for (let index = 1; index < book.bids.length; index += 1) {
    if (book.bids[index]!.price > book.bids[index - 1]!.price) {
      context.addIssue({ code: "custom", message: "bids must be ordered from best to worst", path: ["bids", index] });
    }
  }
});
export type NormalizedOrderbook = z.infer<typeof NormalizedOrderbookSchema>;

export const NormalizedWarningSchema = z.object({
  provider: z.enum(["toss", "kis"]),
  symbol: marketSymbolSchema,
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().max(500).optional(),
  severity: z.enum(["info", "warning", "blocking", "unknown"]),
  observedAt: isoTimestampSchema,
}).strict();
export type NormalizedWarning = z.infer<typeof NormalizedWarningSchema>;

export const InstrumentStateSchema = z.object({
  symbol: marketSymbolSchema,
  suspended: z.boolean(),
  managed: z.boolean(),
  liquidationTrading: z.boolean(),
  investmentCaution: z.boolean(),
  unsupported: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(240)).max(64),
}).strict();
export type InstrumentState = z.infer<typeof InstrumentStateSchema>;

export type ScannerRequestLimits = {
  minimumTopCount: number;
  maximumTopCount: number;
};

export function createScannerRequestSchema(limits: ScannerRequestLimits) {
  if (!Number.isInteger(limits.minimumTopCount) || !Number.isInteger(limits.maximumTopCount)
    || limits.minimumTopCount <= 0 || limits.maximumTopCount < limits.minimumTopCount) {
    throw new Error("Scanner request limits are invalid.");
  }
  return z.object({
    marketCountry: MarketCountrySchema.default("KR"),
    criterion: ScannerCriterionSchema,
    topCount: z.number().int().min(limits.minimumTopCount).max(limits.maximumTopCount),
  }).strict();
}

export const VolatilityInputsSchema = z.object({
  realizedVolatility: nonNegativeNumberSchema.optional(),
  normalizedAtr: nonNegativeNumberSchema.optional(),
  dayRangeRatio: nonNegativeNumberSchema.optional(),
  bollingerWidthExpansion: finiteNumberSchema.optional(),
  relativeVolume: nonNegativeNumberSchema.optional(),
  tradingAmount: nonNegativeNumberSchema.optional(),
  spreadBps: nonNegativeNumberSchema.optional(),
}).strict();
export type VolatilityInputs = z.infer<typeof VolatilityInputsSchema>;

export type ScannerCandidate = {
  symbol: string;
  name?: string;
  exchange?: UsExchange;
  currency: string;
  price?: number;
  changeRateRatio?: number;
  volume?: number;
  tradingAmount?: number;
  spreadBps?: number;
  volatilityScore?: number;
  providerRanks: Partial<Record<"toss" | "kis", number>>;
  warnings: NormalizedWarning[];
  filtered: boolean;
  filterReasons: string[];
  quality: DataQuality;
};
