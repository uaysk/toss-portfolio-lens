import { z } from "zod";
import {
  MarketCountrySchema,
  ScannerCriterionSchema,
} from "../scalping/contracts.js";

export const AI_SIMULATION_CONTRACT_VERSION = "ai-paper-simulation/v5" as const;

export const SimulationPresetSchema = z.enum([
  "trend",
  "breakout",
  "mean_reversion",
  "risk_management",
]);
export type SimulationPreset = z.infer<typeof SimulationPresetSchema>;

export const DEFAULT_SIMULATION_COSTS = {
  commissionBpsPerSide: 1.5,
  taxBpsOnExit: 18,
  spreadBpsRoundTrip: 5,
  slippageBpsPerSide: 2,
} as const;

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
    // Keep the legacy field shape for v4 false-valued requests, while v5
    // cannot opt a degraded model into forward execution.
    allowDegradedMode: z.literal(false).default(false),
  }).strict(),
]);
export type SimulationStrategy = z.infer<typeof SimulationStrategySchema>;

export function createSimulationStartRequestSchema(limits: SimulationRequestLimits) {
  if (!Number.isSafeInteger(limits.maxDurationMinutes) || limits.maxDurationMinutes < 1) {
    throw new Error("Simulation maximum duration must be a positive safe integer.");
  }
  return z.object({
    marketCountry: MarketCountrySchema.default("KR"),
    initialCash: z.number().finite().min(100_000).max(10_000_000_000_000),
    durationMinutes: z.number().int().min(1).max(limits.maxDurationMinutes),
    selection: SimulationSelectionSchema,
    // Optional on the wire so existing auto/manual requests remain valid.
    // An omitted value has the exact semantics of `{ mode: "single" }`.
    strategy: SimulationStrategySchema.optional(),
    preset: SimulationPresetSchema.default("risk_management"),
    riskTolerance: z.number().int().min(0).max(100).default(50),
    costs: SimulationCostOverridesSchema.optional(),
  }).strict().superRefine((input, context) => {
    if (input.strategy?.mode === "pair" && input.marketCountry !== "US") {
      context.addIssue({
        code: "custom",
        path: ["marketCountry"],
        message: "페어 전략은 미국 시장에서만 사용할 수 있습니다.",
      });
    }
  }).transform((input) => ({
    ...input,
    costs: {
      ...DEFAULT_SIMULATION_COSTS,
      taxBpsOnExit: input.marketCountry === "US" ? 0 : DEFAULT_SIMULATION_COSTS.taxBpsOnExit,
      ...input.costs,
    },
  }));
}

export type SimulationStartRequest = z.infer<ReturnType<typeof createSimulationStartRequestSchema>>;
