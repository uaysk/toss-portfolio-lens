import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PGliteDatabase } from "../../test-support/pglite-database.js";
import { migrateLatestContracts } from "./latest-contract-cutover.js";

const AI_RUN_ID = "10000000-0000-4000-8000-000000000001";
const KRONOS_RUN_ID = "10000000-0000-4000-8000-000000000002";
const OPTIMIZATION_RUN_ID = "10000000-0000-4000-8000-000000000003";

async function createSchema(database: PGliteDatabase): Promise<void> {
  await database.run(`
    CREATE TABLE portfolio_backtest_runs (
      run_id TEXT PRIMARY KEY,
      run_kind TEXT NOT NULL,
      owner_subject TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      data_revision TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      completed_candidates INTEGER NOT NULL DEFAULT 0,
      total_candidates INTEGER NOT NULL DEFAULT 0,
      current_validation_window TEXT,
      input_json TEXT NOT NULL,
      summary_json TEXT,
      result_json TEXT,
      error_json TEXT,
      warnings_json TEXT NOT NULL,
      name TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      archived_at BIGINT,
      deleted_at BIGINT,
      replay_of TEXT,
      manifest_json TEXT,
      created_at BIGINT NOT NULL,
      started_at BIGINT,
      finished_at BIGINT,
      updated_at BIGINT NOT NULL,
      UNIQUE(owner_subject, run_kind, request_hash, data_revision)
    )
  `);
  await database.run(`
    CREATE TABLE portfolio_run_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await database.run(`
    CREATE TABLE portfolio_backtest_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
      artifact_type TEXT NOT NULL,
      content_json TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      byte_count INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      data_revision TEXT NOT NULL,
      UNIQUE(run_id, artifact_type)
    )
  `);
  await database.run(`
    CREATE TABLE portfolio_optimization_runs (
      run_id TEXT PRIMARY KEY REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
      objective TEXT NOT NULL,
      seed TEXT NOT NULL,
      candidate_budget INTEGER NOT NULL,
      objective_version TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await database.run(`
    CREATE TABLE portfolio_optimization_candidates (
      candidate_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES portfolio_optimization_runs(run_id) ON DELETE CASCADE,
      candidate_hash TEXT NOT NULL,
      candidate_rank INTEGER,
      weights_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      score DOUBLE PRECISION NOT NULL,
      pareto INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      UNIQUE(run_id, candidate_hash)
    )
  `);
}

function simulationInput(version: "v7" | "v8", lanes: string[]) {
  return {
    contractVersion: `ai-paper-simulation/${version}`,
    schemaVersion: `ai-paper-simulation/${version}`,
    sourceContractVersion: `ai-paper-simulation/${version}`,
    simulationCase: "high_vol_crypto",
    market: {
      kind: "crypto_futures",
      venue: "BINANCE_USDM",
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
    },
    initialCash: 10_000,
    durationMinutes: 30,
    selection: { mode: "auto", criterion: "volatility", symbolCount: 1 },
    strategy: { mode: "single" },
    preset: "risk_management",
    riskTolerance: 50,
    costs: {
      commissionBpsPerSide: 4,
      taxBpsOnExit: 0,
      spreadBpsRoundTrip: 2,
      slippageBpsPerSide: 1,
    },
    riskLimits: {
      riskPerTradeRate: 0.005,
      dailyLossLimitRate: 0.03,
      maximumLeverage: 15,
      grossExposureLimitRate: 1.5,
      marginUsageLimitRate: 0.2,
      liquidationBufferMultiple: 2,
    },
    scanner: {
      symbolCount: 1,
      minimumListingDays: 90,
      minimumTradingAmountUsd: 25_000_000,
      maximumSpreadBps: 12,
      depthRangeBps: 10,
      minimumDepthUsd: 250_000,
      maximumMissingRate: 0.02,
      rescanIntervalMinutes: 30,
      riskAppetite: "balanced",
    },
    modelLanes: lanes,
    modelPlan: [{ symbol: "*", modelLane: lanes[0], role: "primary" }],
    fincastCandleSeconds: 60,
    execution: { mode: "paper" },
  };
}

async function insertRun(
  database: PGliteDatabase,
  input: {
    id: string;
    kind: "ai_trading_simulation" | "optimization";
    config: unknown;
    result?: unknown;
    status?: string;
  },
): Promise<void> {
  await database.run(`
    INSERT INTO portfolio_backtest_runs (
      run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
      status, progress, completed_candidates, total_candidates, input_json,
      summary_json, result_json, warnings_json, tags_json, manifest_json,
      created_at, started_at, finished_at, updated_at
    ) VALUES (?, ?, 'owner', ?, ?, 'engine-v1', ?, 1, 1, 1, ?, '{}', ?, '[]',
              '[]', '{"original":true}', 100, 110, 120, 120)
  `, [
    input.id,
    input.kind,
    `hash:${input.id}`,
    `revision:${input.id}`,
    input.status ?? "completed",
    JSON.stringify(input.config),
    input.result === undefined ? undefined : JSON.stringify(input.result),
  ]);
}

describe("latest PostgreSQL contract cutover", () => {
  let database: PGliteDatabase | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("archives legacy runs and creates bounded canonical v9/optimization copies", async () => {
    database = new PGliteDatabase();
    await createSchema(database);
    await insertRun(database, {
      id: AI_RUN_ID,
      kind: "ai_trading_simulation",
      config: simulationInput("v8", ["chronos2", "fincast"]),
      result: { snapshot: { schemaVersion: "ai-paper-simulation/v8" } },
    });
    await insertRun(database, {
      id: KRONOS_RUN_ID,
      kind: "ai_trading_simulation",
      config: simulationInput("v7", ["kronos_base"]),
      result: { model: "kronos_base" },
    });
    const legacyMetrics = {
      return: 0.12,
      volatility: 0.2,
      maxDrawdown: -0.1,
      sharpe: 0.8,
    };
    await insertRun(database, {
      id: OPTIMIZATION_RUN_ID,
      kind: "optimization",
      config: { objective: "max_cagr" },
      result: { candidates: [{ metrics: legacyMetrics }] },
    });
    await database.run(`
      INSERT INTO portfolio_optimization_runs (
        run_id, objective, seed, candidate_budget, objective_version,
        settings_json, created_at
      ) VALUES (?, 'max_cagr', '7', 10, 'optimizer-v1', '{}', 100)
    `, [OPTIMIZATION_RUN_ID]);
    await database.run(`
      INSERT INTO portfolio_optimization_candidates (
        candidate_id, run_id, candidate_hash, candidate_rank, weights_json,
        metrics_json, score, pareto, created_at
      ) VALUES ('candidate-1', ?, 'candidate-hash', 1, '{"AAA":1}', ?, 0.8, 1, 100)
    `, [OPTIMIZATION_RUN_ID, JSON.stringify(legacyMetrics)]);
    const artifactJson = JSON.stringify([{ weights: { AAA: 1 }, metrics: legacyMetrics }]);
    await database.run(`
      INSERT INTO portfolio_backtest_artifacts (
        artifact_id, run_id, artifact_type, content_json, row_count, byte_count,
        checksum, generated_at, schema_version, data_revision
      ) VALUES ('artifact-1', ?, 'candidates', ?, 1, ?, ?, '2026-07-31T00:00:00Z',
                '1.0', 'revision')
    `, [
      OPTIMIZATION_RUN_ID,
      artifactJson,
      Buffer.byteLength(artifactJson),
      createHash("sha256").update(artifactJson).digest("hex"),
    ]);

    await migrateLatestContracts(database, 900);
    await migrateLatestContracts(database, 999);

    const sources = await database.query<{
      run_id: string;
      archived_at: number | string | null;
      manifest_json: string | null;
    }>(`
      SELECT run_id, archived_at, manifest_json
      FROM portfolio_backtest_runs
      WHERE run_id IN (?, ?, ?)
      ORDER BY run_id
    `, [AI_RUN_ID, KRONOS_RUN_ID, OPTIMIZATION_RUN_ID]);
    expect(sources.every(({ archived_at }) => Number(archived_at) === 900)).toBe(true);
    expect(sources.map(({ manifest_json }) => JSON.parse(manifest_json!)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          migration: expect.objectContaining({ disposition: "canonical_copy" }),
          previous_manifest: { original: true },
        }),
        expect.objectContaining({
          migration: expect.objectContaining({ reason: "kronos_history_only" }),
          previous_manifest: { original: true },
        }),
      ]));

    const copies = await database.query<{
      run_id: string;
      run_kind: string;
      replay_of: string;
      input_json: string;
      result_json: string;
    }>(`
      SELECT run_id, run_kind, replay_of, input_json, result_json
      FROM portfolio_backtest_runs
      WHERE replay_of IS NOT NULL
      ORDER BY run_kind, run_id
    `);
    expect(copies).toHaveLength(2);
    expect(copies.some(({ replay_of }) => replay_of === KRONOS_RUN_ID)).toBe(false);

    const ai = copies.find(({ replay_of }) => replay_of === AI_RUN_ID)!;
    const aiInput = JSON.parse(ai.input_json);
    expect(aiInput).toMatchObject({
      contractVersion: "ai-paper-simulation/v9",
      schemaVersion: "ai-paper-simulation/v9",
      simulationCase: "high_vol_crypto",
      modelLanes: ["chronos2", "fincast"],
      resolvedModelPlan: expect.arrayContaining([
        expect.objectContaining({ modelLane: "chronos2", role: "primary" }),
        expect.objectContaining({ modelLane: "fincast", role: "veto" }),
      ]),
    });
    expect(aiInput).not.toHaveProperty("sourceContractVersion");
    expect(aiInput).not.toHaveProperty("modelPlan");

    const optimization = copies.find(
      ({ replay_of }) => replay_of === OPTIMIZATION_RUN_ID,
    )!;
    const resultMetrics = JSON.parse(optimization.result_json).candidates[0].metrics;
    expect(resultMetrics).toMatchObject({ cagr: 0.12, totalReturn: null });
    expect(resultMetrics).not.toHaveProperty("return");

    const [candidate] = await database.query<{ metrics_json: string }>(`
      SELECT metrics_json
      FROM portfolio_optimization_candidates
      WHERE run_id = ?
    `, [optimization.run_id]);
    expect(JSON.parse(candidate!.metrics_json)).toMatchObject({
      cagr: 0.12,
      totalReturn: null,
    });
    expect(JSON.parse(candidate!.metrics_json)).not.toHaveProperty("return");

    const [artifact] = await database.query<{
      content_json: string;
      byte_count: number | string;
      checksum: string;
      schema_version: string;
    }>(`
      SELECT content_json, byte_count, checksum, schema_version
      FROM portfolio_backtest_artifacts
      WHERE run_id = ?
    `, [optimization.run_id]);
    const artifactMetrics = JSON.parse(artifact!.content_json)[0].metrics;
    expect(artifactMetrics).toMatchObject({ cagr: 0.12, totalReturn: null });
    expect(artifactMetrics).not.toHaveProperty("return");
    expect(Number(artifact!.byte_count)).toBe(Buffer.byteLength(artifact!.content_json));
    expect(artifact!.checksum).toBe(
      createHash("sha256").update(artifact!.content_json).digest("hex"),
    );
    expect(artifact!.schema_version).toBe("1.1");
  });

  it("refuses the cutover while any run is active", async () => {
    database = new PGliteDatabase();
    await createSchema(database);
    await insertRun(database, {
      id: AI_RUN_ID,
      kind: "ai_trading_simulation",
      config: simulationInput("v8", ["chronos2", "fincast"]),
      status: "running",
    });
    await expect(migrateLatestContracts(database, 900))
      .rejects.toThrow("실행 중인 run을 모두 종료");
  });
});
