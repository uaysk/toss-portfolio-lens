import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AI_SIMULATION_CASES,
  AI_SIMULATION_CONTRACT_VERSION as CLIENT_CONTRACT_VERSION,
  AI_SIMULATION_CRITERIA,
  AI_SIMULATION_CRYPTO_FUTURES_MARKET,
  AI_SIMULATION_EXECUTION_MODES,
  AI_SIMULATION_FINCAST_CANDLE_SECONDS,
  AI_SIMULATION_MARKETS,
  AI_SIMULATION_MODEL_LANES,
  AI_SIMULATION_MODEL_ROLES,
  AI_SIMULATION_PAIR_IDS,
  AI_SIMULATION_PRESETS,
  DEFAULT_AI_SIMULATION_CRYPTO_REQUEST,
  DEFAULT_AI_SIMULATION_CRYPTO_RISK_LIMITS,
  DEFAULT_AI_SIMULATION_REQUEST,
  defaultAiSimulationCosts,
  normalizeAiSimulationHistory,
  normalizeAiSimulationRun,
  validateAiSimulationCryptoRequest,
  validateAiSimulationRequest,
  type AiSimulationCase,
  type AiSimulationCosts,
  type AiSimulationCriterion,
  type AiSimulationCryptoRiskLimits,
  type AiSimulationHighVolatilityScannerSettings,
  type AiSimulationMarket,
  type AiSimulationModelLane,
  type AiSimulationModelPlanEntry,
  type AiSimulationModelRole,
  type AiSimulationPairId,
  type AiSimulationPreset,
  type AiSimulationStrategyRequest,
} from "../../src/lib/ai-simulation";
import {
  SIMULATION_RUN_EVENT_SCHEMA_VERSION as CLIENT_EVENT_SCHEMA_VERSION,
  SIMULATION_RUN_EVENT_TYPES,
  parseSimulationRunEvent,
  type SimulationRunEventType as ClientSimulationRunEventType,
  type SimulationRunEventV1 as ClientSimulationRunEventV1,
} from "../../src/lib/simulation-run-events";
import type { PortfolioRunRecord } from "../repositories/run-repository.js";
import {
  MarketCountrySchema,
  ScannerCriterionSchema,
  type ScannerCriterion,
} from "../scalping/contracts.js";
import {
  AI_SIMULATION_CONTRACT_VERSION as SERVER_CONTRACT_VERSION,
  DEFAULT_CRYPTO_FUTURES_COSTS,
  DEFAULT_CRYPTO_FUTURES_MARKET,
  DEFAULT_CRYPTO_FUTURES_RISK_LIMITS,
  FinCastCandleSecondsSchema,
  SIMULATION_RUN_EVENT_SCHEMA_VERSION as SERVER_EVENT_SCHEMA_VERSION,
  SimulationCaseSchema,
  SimulationExecutionSchema,
  SimulationModelLaneSchema,
  SimulationModelRoleSchema,
  SimulationPairIdSchema,
  SimulationPresetSchema,
  SimulationRunEventTypeSchema,
  createSimulationStartRequestSchema,
  type CryptoFuturesRiskLimits,
  type HighVolatilityScannerSettings,
  type SimulationCase,
  type SimulationCosts,
  type SimulationMarket,
  type SimulationModelLane,
  type SimulationModelPlanEntry,
  type SimulationModelRole,
  type SimulationPairId,
  type SimulationPreset,
  type SimulationRunEventType as ServerSimulationRunEventType,
  type SimulationRunEventV1 as ServerSimulationRunEventV1,
  type SimulationStrategy,
} from "./contracts.js";
import { defaultSimulationCostsForMarket } from "./cost-profile.js";
import { historyItem, runSnapshot, runView } from "./query-report-projection.js";

const startRequestSchema = createSimulationStartRequestSchema({ maxDurationMinutes: 390 });

const projectedRun: PortfolioRunRecord = {
  id: "simulation-run",
  kind: "ai_trading_simulation",
  ownerSubject: "owner",
  requestHash: "request-hash",
  dataRevision: "revision",
  engineVersion: "engine",
  status: "completed",
  progress: 1,
  completedCandidates: 1,
  totalCandidates: 1,
  input: DEFAULT_AI_SIMULATION_REQUEST,
  result: {
    snapshot: {
      phase: "completed",
      market: { kind: "stock", country: "US" },
      currency: "USD",
      initialCash: 100_000,
      cash: 1_000,
      equity: 101_000,
      progress: 1,
      selected: [{ symbol: "QQQ" }],
      positions: [],
      charts: [],
      trades: [],
      decisions: [],
      modelForecasts: [],
      warnings: [],
      capabilities: {},
    },
  },
  summary: { tradeCount: 0, decisionCount: 0 },
  warnings: [],
  tags: [],
  createdAt: Date.parse("2026-08-24T00:00:00.000Z"),
  updatedAt: Date.parse("2026-08-24T00:01:00.000Z"),
  startedAt: Date.parse("2026-08-24T00:00:00.000Z"),
  finishedAt: Date.parse("2026-08-24T00:01:00.000Z"),
};

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

describe("simulation browser/server contract parity", () => {
  it("keeps duplicated wire enum values identical to the canonical server schemas", () => {
    expect(CLIENT_CONTRACT_VERSION).toBe(SERVER_CONTRACT_VERSION);
    expect(CLIENT_EVENT_SCHEMA_VERSION).toBe(SERVER_EVENT_SCHEMA_VERSION);
    expect(sortedStrings(AI_SIMULATION_CASES)).toEqual(sortedStrings(SimulationCaseSchema.options));
    expect(sortedStrings(AI_SIMULATION_MARKETS)).toEqual(sortedStrings(MarketCountrySchema.options));
    expect(sortedStrings(AI_SIMULATION_CRITERIA)).toEqual(sortedStrings(ScannerCriterionSchema.options));
    expect(sortedStrings(AI_SIMULATION_MODEL_LANES)).toEqual(
      sortedStrings(SimulationModelLaneSchema.options),
    );
    expect(sortedStrings(AI_SIMULATION_MODEL_ROLES)).toEqual(
      sortedStrings(SimulationModelRoleSchema.options),
    );
    expect(sortedStrings(AI_SIMULATION_PRESETS)).toEqual(sortedStrings(SimulationPresetSchema.options));
    expect(sortedStrings(AI_SIMULATION_PAIR_IDS)).toEqual(sortedStrings(SimulationPairIdSchema.options));
    expect(sortedStrings(SIMULATION_RUN_EVENT_TYPES)).toEqual(
      sortedStrings(SimulationRunEventTypeSchema.options),
    );
    expect(sortedNumbers(AI_SIMULATION_FINCAST_CANDLE_SECONDS)).toEqual(sortedNumbers(
      FinCastCandleSecondsSchema.options.map((option) => option.value),
    ));
    expect(AI_SIMULATION_EXECUTION_MODES).toEqual([
      SimulationExecutionSchema.parse(undefined).mode,
    ]);
  });

  it("keeps shared browser types exactly aligned with server output types", () => {
    expectTypeOf<AiSimulationCase>().toEqualTypeOf<SimulationCase>();
    expectTypeOf<AiSimulationCriterion>().toEqualTypeOf<ScannerCriterion>();
    expectTypeOf<AiSimulationMarket>().toEqualTypeOf<SimulationMarket>();
    expectTypeOf<AiSimulationModelLane>().toEqualTypeOf<SimulationModelLane>();
    expectTypeOf<AiSimulationModelRole>().toEqualTypeOf<SimulationModelRole>();
    expectTypeOf<AiSimulationModelPlanEntry>().toEqualTypeOf<SimulationModelPlanEntry>();
    expectTypeOf<AiSimulationPreset>().toEqualTypeOf<SimulationPreset>();
    expectTypeOf<AiSimulationPairId>().toEqualTypeOf<SimulationPairId>();
    expectTypeOf<AiSimulationStrategyRequest>().toEqualTypeOf<SimulationStrategy>();
    expectTypeOf<AiSimulationCosts>().toEqualTypeOf<SimulationCosts>();
    expectTypeOf<AiSimulationCryptoRiskLimits>().toEqualTypeOf<CryptoFuturesRiskLimits>();
    expectTypeOf<AiSimulationHighVolatilityScannerSettings>()
      .toEqualTypeOf<HighVolatilityScannerSettings>();
    expectTypeOf<ClientSimulationRunEventType>().toEqualTypeOf<ServerSimulationRunEventType>();
    expectTypeOf<ClientSimulationRunEventV1>().toEqualTypeOf<ServerSimulationRunEventV1>();
  });

  it("accepts both browser defaults through browser validation and the server schema", () => {
    expect(validateAiSimulationRequest(DEFAULT_AI_SIMULATION_REQUEST, {
      minimumInitialCash: 100_000,
      maximumDurationMinutes: 390,
    })).toEqual([]);
    expect(validateAiSimulationCryptoRequest(DEFAULT_AI_SIMULATION_CRYPTO_REQUEST, {
      maximumDurationMinutes: 390,
    })).toEqual([]);
    expect(startRequestSchema.safeParse(DEFAULT_AI_SIMULATION_REQUEST).success).toBe(true);
    expect(startRequestSchema.safeParse(DEFAULT_AI_SIMULATION_CRYPTO_REQUEST).success).toBe(true);
  });

  it("keeps browser defaults synchronized with server-owned execution defaults", () => {
    for (const market of AI_SIMULATION_MARKETS) {
      expect(defaultAiSimulationCosts(market)).toEqual(defaultSimulationCostsForMarket(market));
    }
    expect(AI_SIMULATION_CRYPTO_FUTURES_MARKET).toEqual(DEFAULT_CRYPTO_FUTURES_MARKET);
    expect(DEFAULT_AI_SIMULATION_CRYPTO_REQUEST.costs).toEqual(DEFAULT_CRYPTO_FUTURES_COSTS);
    expect(DEFAULT_AI_SIMULATION_CRYPTO_RISK_LIMITS).toEqual(DEFAULT_CRYPTO_FUTURES_RISK_LIMITS);
  });

  it("normalizes canonical server run and history projections in the browser", () => {
    const snapshot = runSnapshot(projectedRun);
    const run = normalizeAiSimulationRun({ run: runView(projectedRun), snapshot });
    const history = normalizeAiSimulationHistory({ items: [historyItem(projectedRun)] });

    expect(run).toMatchObject({
      runId: projectedRun.id,
      status: "completed",
      snapshot: {
        market: { kind: "stock", country: "US" },
        currency: "USD",
        equity: 101_000,
      },
    });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      runId: projectedRun.id,
      status: "completed",
      market: { kind: "stock", country: "US" },
      currency: "USD",
      finalEquity: 101_000,
    });
  });

  it("parses every canonical server event envelope in the browser", () => {
    for (const type of SimulationRunEventTypeSchema.options) {
      const event: ServerSimulationRunEventV1 = {
        schemaVersion: SERVER_EVENT_SCHEMA_VERSION,
        runId: "d11ca2de-33d4-4ae0-af76-cfc020842b2e",
        revision: 1,
        type,
        emittedAt: "2026-08-24T00:00:00.000Z",
        payload: { status: "running" },
      };
      expect(parseSimulationRunEvent(event)).toEqual(event);
    }
  });
});
