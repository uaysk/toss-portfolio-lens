import { z } from "zod";
import { ScannerCriterionSchema } from "../scalping/contracts.js";
import {
  CryptoFuturesSimulationMarketSchema,
  DEFAULT_CRYPTO_FUTURES_MARKET,
} from "../simulation/contracts.js";

export const BINANCE_USDM_STORAGE_KEY = "BINANCE_USDM" as const;
export const BINANCE_SCANNER_MAX_AGE_MS = 60_000;
export const BINANCE_SCANNER_SPREAD_LIMIT_BPS = 10;
export const BINANCE_SCANNER_LIQUIDITY_POOL_SIZE = 50;
export const BINANCE_MINIMUM_LISTING_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

const BinanceInstrumentRulesBaseSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,32}$/),
  baseAsset: z.string().regex(/^[A-Z0-9]{1,16}$/),
  quoteAsset: z.literal("USDT"),
  marginAsset: z.literal("USDT"),
  contractType: z.literal("PERPETUAL"),
  onboardDate: z.number().int().nonnegative(),
  tickSize: z.number().positive(),
  stepSize: z.number().positive(),
  minQuantity: z.number().nonnegative(),
  minNotional: z.number().nonnegative(),
});

export const BinanceInstrumentRulesSchema = z.discriminatedUnion(
  "maintenanceMarginSource",
  [
    BinanceInstrumentRulesBaseSchema.extend({
      // Public exchangeInfo does not provide an account-applicable maintenance
      // margin rate or account leverage cap. Execution must reject this source;
      // the sentinel values are deliberately unusable as trading evidence.
      maintenanceMarginRate: z.literal(1),
      maximumInitialLeverage: z.never().optional(),
      maintenanceMarginSource: z.literal("unavailable"),
    }).strict(),
    BinanceInstrumentRulesBaseSchema.extend({
      maintenanceMarginRate: z.number().positive().lt(1),
      maximumInitialLeverage: z.number().int().positive().max(125),
      maintenanceMarginMaximumNotional: z.number().positive(),
      maintenanceMarginSource: z.literal("binance_user_data_brackets"),
    }).strict(),
  ],
);
export type BinanceInstrumentRules = z.infer<typeof BinanceInstrumentRulesSchema>;

export const BinanceScannerCandidateSchema = z.object({
  rank: z.number().int().positive(),
  symbol: z.string().regex(/^[A-Z0-9]{2,32}$/),
  price: z.number().positive(),
  volume: z.number().nonnegative(),
  quoteVolume: z.number().nonnegative(),
  relativeVolume: z.number().nonnegative(),
  spreadBps: z.number().nonnegative(),
  realizedVolatility60m: z.number().nonnegative(),
  priceChangePercent24h: z.number().finite(),
  atrPercent14: z.number().nonnegative(),
  volatilityScore: z.number().min(0).max(1),
  score: z.number().min(0).max(1),
  scoreComponents: z.object({
    tradingAmount: z.number().min(0).max(1),
    volume: z.number().min(0).max(1),
    relativeVolume: z.number().min(0).max(1),
    realizedVolatility60m: z.number().min(0).max(1),
    priceChange24h: z.number().min(0).max(1),
    atrPercent14: z.number().min(0).max(1),
  }).strict(),
  dataQuality: z.object({
    status: z.enum(["available", "partial"]),
    finalBars: z.number().int().nonnegative(),
    missingFields: z.array(z.string()),
    reasons: z.array(z.string()),
    observedAt: z.string().datetime(),
  }).strict(),
}).strict();
export type BinanceScannerCandidate = z.infer<typeof BinanceScannerCandidateSchema>;

export const BinanceScannerSnapshotSchema = z.object({
  schemaVersion: z.literal("binance-usdm-scanner/v1"),
  market: CryptoFuturesSimulationMarketSchema,
  scannerSnapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  criterion: ScannerCriterionSchema,
  candidates: z.array(BinanceScannerCandidateSchema),
  evidence: z.object({
    exchangeInfoObservedAt: z.string().datetime(),
    universeSize: z.number().int().nonnegative(),
    liquidityPoolSize: z.number().int().nonnegative(),
    spreadQualifiedSize: z.number().int().nonnegative(),
    requirements: z.object({
      status: z.literal("TRADING"),
      contractType: z.literal("PERPETUAL"),
      quoteAsset: z.literal("USDT"),
      marginAsset: z.literal("USDT"),
      minimumListingAgeDays: z.literal(7),
      liquidityPoolSize: z.literal(50),
      maximumSpreadBps: z.literal(10),
    }).strict(),
    volatilityWeights: z.object({
      realized60m: z.literal(0.5),
      change24h: z.literal(0.3),
      atr14: z.literal(0.2),
    }).strict(),
  }).strict(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.scannerSnapshotId !== snapshot.snapshotId) {
    context.addIssue({
      code: "custom",
      path: ["snapshotId"],
      message: "snapshotId aliases must match",
    });
  }
  if (Date.parse(snapshot.expiresAt) - Date.parse(snapshot.generatedAt)
    !== BINANCE_SCANNER_MAX_AGE_MS) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "scanner snapshots must expire in exactly 60 seconds",
    });
  }
});
export type BinanceScannerSnapshot = z.infer<typeof BinanceScannerSnapshotSchema>;

export function cryptoFuturesMarket() {
  return { ...DEFAULT_CRYPTO_FUTURES_MARKET };
}
