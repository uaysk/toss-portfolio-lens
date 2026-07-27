import { z } from "zod";
import {
  MarketCountrySchema,
  ScannerCriterionSchema,
} from "../scalping/contracts.js";
import { defaultSimulationCostsForMarket } from "./cost-profile.js";

export const AI_SIMULATION_CONTRACT_VERSION = "ai-paper-simulation/v7" as const;

export const StockSimulationMarketSchema = z.object({
  kind: z.literal("stock"),
  country: MarketCountrySchema,
}).strict();
export type StockSimulationMarket = z.infer<typeof StockSimulationMarketSchema>;

export const CryptoFuturesSimulationMarketSchema = z.object({
  kind: z.literal("crypto_futures"),
  venue: z.literal("BINANCE_USDM"),
  quoteAsset: z.literal("USDT"),
  contractType: z.literal("PERPETUAL"),
}).strict();
export type CryptoFuturesSimulationMarket = z.infer<
  typeof CryptoFuturesSimulationMarketSchema
>;

export const SimulationMarketSchema = z.discriminatedUnion("kind", [
  StockSimulationMarketSchema,
  CryptoFuturesSimulationMarketSchema,
]);
export type SimulationMarket = z.infer<typeof SimulationMarketSchema>;

export const DEFAULT_CRYPTO_FUTURES_MARKET: CryptoFuturesSimulationMarket = Object.freeze({
  kind: "crypto_futures",
  venue: "BINANCE_USDM",
  quoteAsset: "USDT",
  contractType: "PERPETUAL",
});

export const SimulationModelLaneSchema = z.enum(["kronos_base", "fincast"]);
export type SimulationModelLane = z.infer<typeof SimulationModelLaneSchema>;
export const MAIN_SIMULATION_MODEL_LANE = "fincast" as const satisfies SimulationModelLane;
export const LEGACY_SIMULATION_MODEL_LANE = "kronos_base" as const satisfies SimulationModelLane;
export const FinCastCandleSecondsSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
]);
export type FinCastCandleSeconds = z.infer<typeof FinCastCandleSecondsSchema>;
export const SimulationModelLanesSchema = z.union([
  z.tuple([z.literal("kronos_base")]),
  z.tuple([z.literal("fincast")]),
  z.tuple([z.literal("kronos_base"), z.literal("fincast")]),
]).default([MAIN_SIMULATION_MODEL_LANE]);

export const SimulationExecutionSchema = z.object({
  mode: z.literal("paper").default("paper"),
}).strict().default({ mode: "paper" });
export type SimulationExecution = z.infer<typeof SimulationExecutionSchema>;
export type SimulationModelLanes = z.infer<typeof SimulationModelLanesSchema>;

export const SimulationPresetSchema = z.enum([
  "trend",
  "breakout",
  "mean_reversion",
  "risk_management",
]);
export type SimulationPreset = z.infer<typeof SimulationPresetSchema>;

export const DEFAULT_SIMULATION_COSTS = Object.freeze(defaultSimulationCostsForMarket("KR"));
export const DEFAULT_CRYPTO_FUTURES_COSTS = Object.freeze({
  commissionBpsPerSide: 4,
  taxBpsOnExit: 0,
  spreadBpsRoundTrip: 2,
  slippageBpsPerSide: 1,
});

export const DEFAULT_CRYPTO_FUTURES_RISK_LIMITS = Object.freeze({
  riskPerTradeRate: 0.005,
  dailyLossLimitRate: 0.03,
  maximumLeverage: 15,
  grossExposureLimitRate: 1.5,
  marginUsageLimitRate: 0.2,
  liquidationBufferMultiple: 2,
});

export const CryptoFuturesRiskLimitsSchema = z.object({
  riskPerTradeRate: z.number().finite().min(0.001)
    .max(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.riskPerTradeRate)
    .default(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.riskPerTradeRate),
  dailyLossLimitRate: z.number().finite().min(0.005)
    .max(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.dailyLossLimitRate)
    .default(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.dailyLossLimitRate),
  maximumLeverage: z.number().int().min(1).max(15)
    .default(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.maximumLeverage),
  grossExposureLimitRate: z.number().finite().min(0.1)
    .max(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.grossExposureLimitRate)
    .default(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.grossExposureLimitRate),
  marginUsageLimitRate: z.number().finite().min(0.05)
    .max(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.marginUsageLimitRate)
    .default(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.marginUsageLimitRate),
  liquidationBufferMultiple: z.number().finite()
    .min(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.liquidationBufferMultiple)
    .max(5)
    .default(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS.liquidationBufferMultiple),
}).strict();
export type CryptoFuturesRiskLimits = z.infer<typeof CryptoFuturesRiskLimitsSchema>;

export const SimulationCostsSchema = z.object({
  commissionBpsPerSide: z.number().finite().min(0).max(1_000)
    .default(DEFAULT_SIMULATION_COSTS.commissionBpsPerSide),
  taxBpsOnExit: z.number().finite().min(0).max(1_000)
    .default(DEFAULT_SIMULATION_COSTS.taxBpsOnExit),
  spreadBpsRoundTrip: z.number().finite().min(0).max(5_000)
    .default(DEFAULT_SIMULATION_COSTS.spreadBpsRoundTrip),
  slippageBpsPerSide: z.number().finite().min(0).max(5_000)
    .default(DEFAULT_SIMULATION_COSTS.slippageBpsPerSide),
}).strict();
export type SimulationCosts = z.infer<typeof SimulationCostsSchema>;

const SimulationCostOverridesSchema = z.object({
  commissionBpsPerSide: z.number().finite().min(0).max(1_000).optional(),
  taxBpsOnExit: z.number().finite().min(0).max(1_000).optional(),
  spreadBpsRoundTrip: z.number().finite().min(0).max(5_000).optional(),
  slippageBpsPerSide: z.number().finite().min(0).max(5_000).optional(),
}).strict();

export type SimulationRequestLimits = {
  maxDurationMinutes: number;
};

const SimulationSymbolSchema = z.string()
  .trim()
  .min(1)
  .max(32)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/));

export const SimulationAutoSelectionSchema = z.object({
  mode: z.literal("auto"),
  criterion: ScannerCriterionSchema.default("trading_amount"),
  symbolCount: z.union([z.literal(1), z.literal(2)]),
}).strict();
export type SimulationAutoSelection = z.infer<typeof SimulationAutoSelectionSchema>;

export const SimulationManualSelectionSchema = z.object({
  mode: z.literal("manual"),
  symbols: z.union([
    z.tuple([SimulationSymbolSchema]),
    z.tuple([SimulationSymbolSchema, SimulationSymbolSchema]),
  ]).superRefine((symbols, context) => {
    if (new Set(symbols).size !== symbols.length) {
      context.addIssue({
        code: "custom",
        message: "수동 선택 종목은 중복될 수 없습니다.",
      });
    }
  }),
}).strict();
export type SimulationManualSelection = z.infer<typeof SimulationManualSelectionSchema>;

export const SimulationSelectionSchema = z.discriminatedUnion("mode", [
  SimulationAutoSelectionSchema,
  SimulationManualSelectionSchema,
]);
export type SimulationSelection = z.infer<typeof SimulationSelectionSchema>;

export const SimulationPairIdSchema = z.enum([
  "soxx-soxl-soxs",
  "smh-soxl-soxs",
  "sndk-snxx-sndq",
  "tsla-tsll-tsls",
  "tsla-tsll-tslq",
  "qqq-tqqq-sqqq",
]);
export type SimulationPairId = z.infer<typeof SimulationPairIdSchema>;

export const SimulationStrategySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("single"),
  }).strict(),
  z.object({
    mode: z.literal("pair"),
    pairId: SimulationPairIdSchema,
    // Keep the legacy field shape for v4 false-valued requests, while v6
    // cannot opt a degraded model into forward execution.
    allowDegradedMode: z.literal(false).default(false),
  }).strict(),
]);
export type SimulationStrategy = z.infer<typeof SimulationStrategySchema>;

export type SimulationStartRequest = {
  market: SimulationMarket;
  /**
   * Internal stock-v6 coordinator compatibility. This property is
   * non-enumerable for crypto requests, so wire responses and artifacts only
   * serialize the normalized `market` discriminated union.
   */
  marketCountry: z.infer<typeof MarketCountrySchema>;
  initialCash: number;
  durationMinutes: number;
  selection: SimulationSelection;
  strategy?: SimulationStrategy;
  preset: SimulationPreset;
  riskTolerance: number;
  costs: SimulationCosts;
  riskLimits?: CryptoFuturesRiskLimits;
  modelLanes: SimulationModelLanes;
  fincastCandleSeconds: FinCastCandleSeconds;
  execution: SimulationExecution;
};

export function createSimulationStartRequestSchema(limits: SimulationRequestLimits) {
  if (!Number.isSafeInteger(limits.maxDurationMinutes) || limits.maxDurationMinutes < 1) {
    throw new Error("Simulation maximum duration must be a positive safe integer.");
  }
  return z.object({
    market: SimulationMarketSchema.optional(),
    // v6 compatibility input. Every v7 request is normalized to `market`.
    marketCountry: MarketCountrySchema.optional(),
    initialCash: z.number().finite().min(100).max(10_000_000_000_000),
    durationMinutes: z.number().int().min(1).max(limits.maxDurationMinutes),
    selection: SimulationSelectionSchema,
    // Optional on the wire so existing auto/manual requests remain valid.
    // An omitted value has the exact semantics of `{ mode: "single" }`.
    strategy: SimulationStrategySchema.optional(),
    preset: SimulationPresetSchema.default("risk_management"),
    riskTolerance: z.number().int().min(0).max(100).default(50),
    costs: SimulationCostOverridesSchema.optional(),
    riskLimits: CryptoFuturesRiskLimitsSchema.optional(),
    modelLanes: SimulationModelLanesSchema,
    fincastCandleSeconds: FinCastCandleSecondsSchema.default(60),
    execution: SimulationExecutionSchema,
  }).strict().superRefine((input, context) => {
    const market = input.market
      ?? { kind: "stock" as const, country: input.marketCountry ?? "KR" };
    if (input.market && input.marketCountry !== undefined) {
      if (input.market.kind !== "stock" || input.market.country !== input.marketCountry) {
        context.addIssue({
          code: "custom",
          path: ["marketCountry"],
          message: "marketCountry와 market이 서로 일치해야 합니다.",
        });
      }
    }
    if (input.strategy?.mode === "pair"
      && (market.kind !== "stock" || market.country !== "US")) {
      context.addIssue({
        code: "custom",
        path: ["market"],
        message: "페어 전략은 미국 시장에서만 사용할 수 있습니다.",
      });
    }
    if (market.kind === "crypto_futures") {
      if (input.initialCash > 100_000_000) {
        context.addIssue({
          code: "custom",
          path: ["initialCash"],
          message: "암호화폐 선물 초기 자산은 100,000,000 USDT 이하여야 합니다.",
        });
      }
      if (input.strategy?.mode === "pair") {
        context.addIssue({
          code: "custom",
          path: ["strategy"],
          message: "암호화폐 선물은 단일 종목 전략만 지원합니다.",
        });
      }
      if (
        input.fincastCandleSeconds < 60
        && (
          input.modelLanes.length !== 1
          || input.modelLanes[0] !== "fincast"
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["fincastCandleSeconds"],
          message: "15초·30초 모델 봉은 FinCast 단독 lane에서만 사용할 수 있습니다.",
        });
      }
    } else {
      if (
        input.modelLanes.length !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["modelLanes"],
          message: "주식 시뮬레이션은 독립 원장을 보장하기 위해 한 번에 하나의 모델 lane만 지원합니다.",
        });
      }
      if (input.strategy?.mode === "pair" && input.modelLanes[0] !== "kronos_base") {
        context.addIssue({
          code: "custom",
          path: ["modelLanes"],
          message: "주식 페어 전략은 현재 Kronos-base와 Rust 결합만 지원합니다.",
        });
      }
      if (input.initialCash < 100_000) {
        context.addIssue({
          code: "custom",
          path: ["initialCash"],
          message: "주식 초기 자산은 100,000 이상이어야 합니다.",
        });
      }
      if (input.riskLimits !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["riskLimits"],
          message: "선물 위험 한도는 암호화폐 선물 요청에서만 사용할 수 있습니다.",
        });
      }
      if (input.fincastCandleSeconds !== 60) {
        context.addIssue({
          code: "custom",
          path: ["fincastCandleSeconds"],
          message: "FinCast sub-minute 모델 봉은 암호화폐 선물 요청에서만 사용할 수 있습니다.",
        });
      }
    }
  }).transform((input): SimulationStartRequest => {
    const market = input.market
      ?? { kind: "stock" as const, country: input.marketCountry ?? "KR" };
    const normalized = {
      ...input,
      market,
      costs: {
        ...(market.kind === "stock"
          ? defaultSimulationCostsForMarket(market.country)
          : DEFAULT_CRYPTO_FUTURES_COSTS),
        ...input.costs,
      },
      ...(market.kind === "crypto_futures"
        ? {
          riskLimits: CryptoFuturesRiskLimitsSchema.parse(input.riskLimits ?? {}),
        }
        : {}),
    } as Omit<SimulationStartRequest, "marketCountry">;
    if (market.kind === "stock") {
      return { ...normalized, marketCountry: market.country };
    }
    Object.defineProperty(normalized, "marketCountry", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: "US",
    });
    return normalized as SimulationStartRequest;
  });
}
