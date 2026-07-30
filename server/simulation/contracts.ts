import { z } from "zod";
import {
  MarketCountrySchema,
  ScannerCriterionSchema,
} from "../scalping/contracts.js";
import { defaultSimulationCostsForMarket } from "./cost-profile.js";

export const AI_SIMULATION_CONTRACT_VERSION = "ai-paper-simulation/v8" as const;

export const SimulationCaseSchema = z.enum([
  "btc_eth",
  "high_vol_crypto",
  "us_etf_pair",
]);
export type SimulationCase = z.infer<typeof SimulationCaseSchema>;

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

export const SimulationModelLaneSchema = z.enum(["kronos_base", "fincast", "chronos2"]);
export type SimulationModelLane = z.infer<typeof SimulationModelLaneSchema>;
export const MAIN_SIMULATION_MODEL_LANE = "fincast" as const satisfies SimulationModelLane;
export const LEGACY_SIMULATION_MODEL_LANE = "kronos_base" as const satisfies SimulationModelLane;
export const CHRONOS2_SIMULATION_MODEL_LANE = "chronos2" as const satisfies SimulationModelLane;
export const FinCastCandleSecondsSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
]);
export type FinCastCandleSeconds = z.infer<typeof FinCastCandleSecondsSchema>;
export const SimulationModelLanesSchema = z.array(SimulationModelLaneSchema)
  .min(1)
  .max(3)
  .superRefine((lanes, context) => {
    if (new Set(lanes).size !== lanes.length) {
      context.addIssue({
        code: "custom",
        message: "모델 lane은 중복될 수 없습니다.",
      });
    }
  });

export const SimulationExecutionSchema = z.object({
  mode: z.literal("paper").default("paper"),
}).strict().default({ mode: "paper" });
export type SimulationExecution = z.infer<typeof SimulationExecutionSchema>;
export type SimulationModelLanes = z.infer<typeof SimulationModelLanesSchema>;

export const SimulationModelRoleSchema = z.enum(["primary", "veto", "shadow"]);
export type SimulationModelRole = z.infer<typeof SimulationModelRoleSchema>;

export const SimulationModelPlanEntrySchema = z.object({
  symbol: z.string().trim().min(1).max(32),
  modelLane: SimulationModelLaneSchema,
  role: SimulationModelRoleSchema,
  required: z.boolean(),
  preferredHorizonsMinutes: z.array(z.union([
    z.literal(5),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ])).min(1).max(4),
}).strict();
export type SimulationModelPlanEntry = z.infer<typeof SimulationModelPlanEntrySchema>;

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
    .max(1)
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

export const HighVolatilityScannerSettingsSchema = z.object({
  symbolCount: z.union([z.literal(1), z.literal(2)]).default(1),
  minimumListingDays: z.number().int().min(7).max(3_650).default(90),
  minimumTradingAmountUsd: z.number().finite().min(100_000).max(100_000_000_000)
    .default(25_000_000),
  maximumSpreadBps: z.number().finite().min(0.1).max(100).default(12),
  depthRangeBps: z.number().finite().min(1).max(100).default(10),
  minimumDepthUsd: z.number().finite().min(10_000).max(10_000_000_000)
    .default(250_000),
  maximumMissingRate: z.number().finite().min(0).max(0.2).default(0.02),
  rescanIntervalMinutes: z.number().int().min(5).max(1_440).default(30),
  riskAppetite: z.enum(["conservative", "balanced", "aggressive"]).default("balanced"),
}).strict();
export type HighVolatilityScannerSettings = z.infer<
  typeof HighVolatilityScannerSettingsSchema
>;

export const SimulationPairIdSchema = z.enum([
  "semiconductor-soxl-soxs",
  "soxx-soxl-soxs",
  "smh-soxl-soxs",
  "spy-spxl-spxs",
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
  contractVersion: typeof AI_SIMULATION_CONTRACT_VERSION;
  sourceContractVersion: "ai-paper-simulation/v7" | typeof AI_SIMULATION_CONTRACT_VERSION;
  simulationCase?: SimulationCase;
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
  scanner?: HighVolatilityScannerSettings;
  modelLanes: SimulationModelLanes;
  modelPlan: SimulationModelPlanEntry[];
  fincastCandleSeconds: FinCastCandleSeconds;
  execution: SimulationExecution;
};

type SimulationCaseInferenceInput = {
  market: SimulationMarket;
  selection: SimulationSelection;
  strategy?: SimulationStrategy;
};

export function inferSimulationCase(input: SimulationCaseInferenceInput): SimulationCase | undefined {
  if (
    input.market.kind === "stock"
    && input.market.country === "US"
    && input.strategy?.mode === "pair"
  ) {
    return "us_etf_pair";
  }
  if (input.market.kind !== "crypto_futures") return undefined;
  if (
    input.selection.mode === "manual"
    && input.selection.symbols.every((symbol) => symbol === "BTCUSDT" || symbol === "ETHUSDT")
  ) {
    return "btc_eth";
  }
  return "high_vol_crypto";
}

export function defaultModelPlanForCase(
  simulationCase: SimulationCase | undefined,
  selection: SimulationSelection,
): SimulationModelPlanEntry[] {
  if (simulationCase === "btc_eth") {
    const symbols = selection.mode === "manual"
      ? selection.symbols
      : (["BTCUSDT", "ETHUSDT"] as const);
    return symbols.flatMap((symbol): SimulationModelPlanEntry[] => (
      symbol === "ETHUSDT"
        ? [
          {
            symbol,
            modelLane: "fincast",
            role: "primary",
            required: true,
            preferredHorizonsMinutes: [15, 30, 60],
          },
          {
            symbol,
            modelLane: "chronos2",
            role: "shadow",
            required: false,
            preferredHorizonsMinutes: [15, 30, 60],
          },
        ]
        : [
          {
            symbol,
            modelLane: "chronos2",
            role: "primary",
            required: true,
            preferredHorizonsMinutes: [30, 60, 15],
          },
          {
            symbol,
            modelLane: "fincast",
            role: "veto",
            required: true,
            preferredHorizonsMinutes: [30, 60, 15],
          },
        ]
    ));
  }
  if (simulationCase === "high_vol_crypto") {
    return [
      {
        symbol: "*",
        modelLane: "chronos2",
        role: "primary",
        required: true,
        preferredHorizonsMinutes: [15, 30, 60],
      },
      {
        symbol: "*",
        modelLane: "fincast",
        role: "veto",
        required: true,
        preferredHorizonsMinutes: [15, 30, 60],
      },
    ];
  }
  if (simulationCase === "us_etf_pair") {
    return [
      {
        symbol: "*",
        modelLane: "chronos2",
        role: "primary",
        required: true,
        preferredHorizonsMinutes: [15, 30, 60],
      },
      {
        symbol: "*",
        modelLane: "fincast",
        role: "shadow",
        required: false,
        preferredHorizonsMinutes: [15, 30, 60],
      },
    ];
  }
  return [];
}

export function createSimulationStartRequestSchema(limits: SimulationRequestLimits) {
  if (!Number.isSafeInteger(limits.maxDurationMinutes) || limits.maxDurationMinutes < 1) {
    throw new Error("Simulation maximum duration must be a positive safe integer.");
  }
  return z.object({
    contractVersion: z.union([
      z.literal("ai-paper-simulation/v7"),
      z.literal(AI_SIMULATION_CONTRACT_VERSION),
    ]).optional(),
    simulationCase: SimulationCaseSchema.optional(),
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
    scanner: HighVolatilityScannerSettingsSchema.optional(),
    modelLanes: SimulationModelLanesSchema.optional(),
    modelPlan: z.array(SimulationModelPlanEntrySchema).min(1).max(8).optional(),
    fincastCandleSeconds: FinCastCandleSecondsSchema.default(60),
    execution: SimulationExecutionSchema,
  }).strict().superRefine((input, context) => {
    const market = input.market
      ?? { kind: "stock" as const, country: input.marketCountry ?? "KR" };
    const strategy = input.strategy;
    const inferredCase = inferSimulationCase({
      market,
      selection: input.selection,
      ...(strategy ? { strategy } : {}),
    });
    const simulationCase = input.simulationCase ?? inferredCase;
    if (input.modelPlan !== undefined) {
      if (input.simulationCase === undefined) {
        context.addIssue({
          code: "custom",
          path: ["modelPlan"],
          message: "modelPlan은 simulationCase가 명시된 v8 요청에서만 사용할 수 있습니다.",
        });
      } else {
        const canonicalModelPlan = defaultModelPlanForCase(simulationCase, input.selection);
        if (JSON.stringify(input.modelPlan) !== JSON.stringify(canonicalModelPlan)) {
          context.addIssue({
            code: "custom",
            path: ["modelPlan"],
            message: "modelPlan이 선택한 simulationCase의 고정 모델 역할 정책과 일치하지 않습니다.",
          });
        }
      }
    }
    if (input.market && input.marketCountry !== undefined) {
      if (input.market.kind !== "stock" || input.market.country !== input.marketCountry) {
        context.addIssue({
          code: "custom",
          path: ["marketCountry"],
          message: "marketCountry와 market이 서로 일치해야 합니다.",
        });
      }
    }
    if (strategy?.mode === "pair"
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
      if (strategy?.mode === "pair") {
        context.addIssue({
          code: "custom",
          path: ["strategy"],
          message: "암호화폐 선물은 단일 종목 전략만 지원합니다.",
        });
      }
      if (
        input.fincastCandleSeconds < 60
        && (
          (input.modelLanes?.length ?? 1) !== 1
          || (input.modelLanes?.[0] ?? "fincast") !== "fincast"
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
        simulationCase !== "us_etf_pair"
        && (input.modelLanes?.length ?? 1) !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["modelLanes"],
          message: "주식 시뮬레이션은 독립 원장을 보장하기 위해 한 번에 하나의 모델 lane만 지원합니다.",
        });
      }
      if (
        strategy?.mode === "pair"
        && input.simulationCase === undefined
        && (input.modelLanes?.[0] ?? "fincast") !== "kronos_base"
      ) {
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
    if (input.simulationCase !== undefined && input.simulationCase !== inferredCase) {
      context.addIssue({
        code: "custom",
        path: ["simulationCase"],
        message: "simulationCase가 market, selection, strategy와 일치하지 않습니다.",
      });
    }
    if (simulationCase === "btc_eth") {
      if (
        market.kind !== "crypto_futures"
        || input.selection.mode !== "manual"
        || !input.selection.symbols.every(
          (symbol) => symbol === "BTCUSDT" || symbol === "ETHUSDT",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["selection"],
          message: "BTC·ETH 케이스는 BTCUSDT/ETHUSDT 수동 선택만 지원합니다.",
        });
      }
    }
    if (simulationCase === "high_vol_crypto") {
      if (market.kind !== "crypto_futures") {
        context.addIssue({
          code: "custom",
          path: ["market"],
          message: "고변동성 케이스는 Binance USD-M 선물만 지원합니다.",
        });
      }
      if (input.simulationCase !== undefined && input.selection.mode !== "auto") {
        context.addIssue({
          code: "custom",
          path: ["selection"],
          message: "새 고변동성 케이스는 point-in-time 자동 스캐너를 사용해야 합니다.",
        });
      }
    }
    if (simulationCase === "us_etf_pair" && (
      market.kind !== "stock"
      || market.country !== "US"
      || strategy?.mode !== "pair"
    )) {
      context.addIssue({
        code: "custom",
        path: ["strategy"],
        message: "미국 ETF 페어 케이스는 미국 pair 전략이어야 합니다.",
      });
    }
    if (input.scanner !== undefined && simulationCase !== "high_vol_crypto") {
      context.addIssue({
        code: "custom",
        path: ["scanner"],
        message: "scanner 설정은 고변동성 암호화폐 케이스에서만 사용할 수 있습니다.",
      });
    }
  }).transform((input): SimulationStartRequest => {
    const market = input.market
      ?? { kind: "stock" as const, country: input.marketCountry ?? "KR" };
    const strategy = input.strategy;
    const simulationCase = input.simulationCase ?? inferSimulationCase({
      market,
      selection: input.selection,
      ...(strategy ? { strategy } : {}),
    });
    const defaultModelPlan = defaultModelPlanForCase(simulationCase, input.selection);
    const modelLanes = input.simulationCase !== undefined
      ? [...new Set(defaultModelPlan.map((entry) => entry.modelLane))]
      : input.modelLanes ?? [MAIN_SIMULATION_MODEL_LANE];
    const modelPlan = input.simulationCase !== undefined
      ? defaultModelPlan
      : modelLanes.map((modelLane) => ({
          symbol: "*",
          modelLane,
          role: "primary" as const,
          required: true,
          preferredHorizonsMinutes: [15, 30, 60] as Array<15 | 30 | 60>,
        }));
    const normalized = {
      ...input,
      contractVersion: AI_SIMULATION_CONTRACT_VERSION,
      sourceContractVersion: input.contractVersion
        ?? (input.simulationCase ? AI_SIMULATION_CONTRACT_VERSION : "ai-paper-simulation/v7"),
      ...(simulationCase ? { simulationCase } : {}),
      market,
      modelLanes,
      modelPlan,
      costs: {
        ...(market.kind === "stock"
          ? defaultSimulationCostsForMarket(market.country)
          : DEFAULT_CRYPTO_FUTURES_COSTS),
        ...input.costs,
      },
      ...(market.kind === "crypto_futures"
        ? {
          riskLimits: CryptoFuturesRiskLimitsSchema.parse(input.riskLimits ?? {}),
          ...(simulationCase === "high_vol_crypto"
            ? {
              scanner: HighVolatilityScannerSettingsSchema.parse({
                ...(input.selection.mode === "auto"
                  ? { symbolCount: input.selection.symbolCount }
                  : {}),
                ...input.scanner,
              }),
            }
            : {}),
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
