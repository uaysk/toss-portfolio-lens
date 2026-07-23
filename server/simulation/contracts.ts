import { z } from "zod";
import {
  MarketCountrySchema,
  ScannerCriterionSchema,
} from "../scalping/contracts.js";

export const AI_SIMULATION_CONTRACT_VERSION = "ai-paper-simulation/v1" as const;

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

export function createSimulationStartRequestSchema(limits: SimulationRequestLimits) {
  if (!Number.isSafeInteger(limits.maxDurationMinutes) || limits.maxDurationMinutes < 1) {
    throw new Error("Simulation maximum duration must be a positive safe integer.");
  }
  return z.object({
    marketCountry: MarketCountrySchema.default("KR"),
    criterion: ScannerCriterionSchema.default("trading_amount"),
    initialCash: z.number().finite().min(100_000).max(10_000_000_000_000),
    durationMinutes: z.number().int().min(1).max(limits.maxDurationMinutes),
    symbolCount: z.union([z.literal(1), z.literal(2)]),
    preset: SimulationPresetSchema.default("risk_management"),
    costs: SimulationCostOverridesSchema.optional(),
  }).strict().transform((input) => ({
    ...input,
    costs: {
      ...DEFAULT_SIMULATION_COSTS,
      taxBpsOnExit: input.marketCountry === "US" ? 0 : DEFAULT_SIMULATION_COSTS.taxBpsOnExit,
      ...input.costs,
    },
  }));
}

export type SimulationStartRequest = z.infer<ReturnType<typeof createSimulationStartRequestSchema>>;
