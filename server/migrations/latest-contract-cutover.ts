import { createHash } from "node:crypto";
import type { RelationalDatabase } from "../database.js";

export const LATEST_CONTRACT_CUTOVER_MIGRATION_ID =
  "20260731_012_latest_contract_cutover";
export const LATEST_CONTRACT_CUTOVER_SIGNATURE =
  "ai-paper-simulation:v9;worker-payload:2.0;pair-catalog:v4;"
  + "archive-pre-v9;canonical-v7-v8-without-kronos;"
  + "optimization-metrics:cagr,totalReturn;postgres-jsonb-bounded-v1";

const AI_CONTRACT_VERSION = "ai-paper-simulation/v9";
const ARTIFACT_SCHEMA_VERSION = "1.1";
const WORKER_PAYLOAD_SCHEMA_VERSION = "2.0";
const METRIC_FUNCTION = "portfolio_contract_cutover_metric_v2";
const TERMINAL_STATUSES = new Set(["cancelled", "completed", "failed"]);
const LEGACY_AI_CONTRACTS = new Set(
  Array.from({ length: 8 }, (_, index) => `ai-paper-simulation/v${index + 1}`),
);
const PAIR_IDS = new Set([
  "qqq-tqqq-sqqq",
  "semiconductor-soxl-soxs",
  "sndk-snxx-sndq",
  "spy-spxl-spxs",
  "tsla-tsll-tslq",
  "tsla-tsll-tsls",
]);

type JsonObject = Record<string, unknown>;

type AiSourceRow = {
  run_id: string;
  status: string;
  input_json: string;
  source_contract_version: string | null;
  mentions_kronos: boolean | number | string;
  input_checksum: string;
  summary_checksum: string;
  result_checksum: string;
  manifest_checksum: string;
};

type OptimizationSourceRow = {
  run_id: string;
};

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}

function parseObject(value: string): JsonObject | undefined {
  try {
    return object(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function boolean(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === "1" || value === "t"
    || value === "true";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(scope: string, sourceId: string): string {
  const raw = sha256(`${LATEST_CONTRACT_CUTOVER_MIGRATION_ID}\n${scope}\n${sourceId}`);
  const variant = ((Number.parseInt(raw[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    `5${raw.slice(13, 16)}`,
    `${variant}${raw.slice(17, 20)}`,
    raw.slice(20, 32),
  ].join("-");
}

function canonicalPairId(value: unknown): string | undefined {
  const normalized = string(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "smh-soxl-soxs" || normalized === "soxx-soxl-soxs") {
    return "semiconductor-soxl-soxs";
  }
  return PAIR_IDS.has(normalized) ? normalized : undefined;
}

function modelPlan(
  simulationCase: "btc_eth" | "high_vol_crypto" | "us_etf_pair",
  selection: JsonObject,
): JsonObject[] {
  if (simulationCase === "btc_eth") {
    const symbols = Array.isArray(selection.symbols)
      ? selection.symbols.filter((value): value is string => typeof value === "string")
      : ["BTCUSDT", "ETHUSDT"];
    return symbols.flatMap((symbol): JsonObject[] => (
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

function normalizedSimulationInput(
  source: JsonObject,
): JsonObject | undefined {
  const market = object(source.market);
  const selection = object(source.selection);
  if (!market || !selection) return undefined;
  const marketKind = string(market.kind);
  const selectionMode = string(selection.mode);
  const sourceStrategy = object(source.strategy);
  let simulationCase: "btc_eth" | "high_vol_crypto" | "us_etf_pair";
  let strategy: JsonObject;

  if (marketKind === "crypto_futures"
    && market.venue === "BINANCE_USDM"
    && market.quoteAsset === "USDT"
    && market.contractType === "PERPETUAL") {
    if (selectionMode === "manual") {
      const symbols = Array.isArray(selection.symbols)
        ? selection.symbols.filter((value): value is string => (
          typeof value === "string" && Boolean(value.trim())
        )).map((value) => value.toUpperCase())
        : [];
      if (symbols.length < 1 || symbols.length > 2
        || symbols.some((symbol) => symbol !== "BTCUSDT" && symbol !== "ETHUSDT")
        || new Set(symbols).size !== symbols.length) return undefined;
      selection.symbols = symbols;
      simulationCase = "btc_eth";
    } else if (selectionMode === "auto"
      && ["trading_amount", "volume", "volatility"].includes(string(selection.criterion) ?? "")
      && [1, 2].includes(integer(selection.symbolCount) ?? 0)) {
      simulationCase = "high_vol_crypto";
    } else {
      return undefined;
    }
    strategy = { mode: "single" };
  } else if (marketKind === "stock" && market.country === "US"
    && sourceStrategy?.mode === "pair") {
    const pairId = canonicalPairId(sourceStrategy.pairId);
    if (!pairId) return undefined;
    simulationCase = "us_etf_pair";
    strategy = { mode: "pair", pairId, allowDegradedMode: false };
  } else {
    return undefined;
  }

  const initialCash = finite(source.initialCash);
  const durationMinutes = integer(source.durationMinutes);
  const riskTolerance = integer(source.riskTolerance);
  if (initialCash === undefined || durationMinutes === undefined
    || riskTolerance === undefined) return undefined;
  const plan = modelPlan(simulationCase, selection);
  const lanes = Array.from(new Set(plan.map((entry) => String(entry.modelLane))));
  const scanner = simulationCase === "high_vol_crypto"
    ? {
      symbolCount: integer(object(source.scanner)?.symbolCount)
        ?? integer(selection.symbolCount) ?? 1,
      minimumListingDays: integer(object(source.scanner)?.minimumListingDays) ?? 90,
      minimumTradingAmountUsd:
        finite(object(source.scanner)?.minimumTradingAmountUsd) ?? 25_000_000,
      maximumSpreadBps: finite(object(source.scanner)?.maximumSpreadBps) ?? 12,
      depthRangeBps: finite(object(source.scanner)?.depthRangeBps) ?? 10,
      minimumDepthUsd: finite(object(source.scanner)?.minimumDepthUsd) ?? 250_000,
      maximumMissingRate: finite(object(source.scanner)?.maximumMissingRate) ?? 0.02,
      rescanIntervalMinutes:
        integer(object(source.scanner)?.rescanIntervalMinutes) ?? 30,
      riskAppetite: ["conservative", "balanced", "aggressive"].includes(
        string(object(source.scanner)?.riskAppetite) ?? "",
      ) ? object(source.scanner)!.riskAppetite : "balanced",
    }
    : undefined;
  const normalized: JsonObject = {
    contractVersion: AI_CONTRACT_VERSION,
    schemaVersion: AI_CONTRACT_VERSION,
    simulationCase,
    market,
    initialCash,
    durationMinutes,
    selection,
    strategy,
    preset: string(source.preset) ?? "risk_management",
    riskTolerance,
    costs: object(source.costs) ?? (
      marketKind === "crypto_futures"
        ? {
          commissionBpsPerSide: 4,
          taxBpsOnExit: 0,
          spreadBpsRoundTrip: 2,
          slippageBpsPerSide: 1,
        }
        : {}
    ),
    modelLanes: lanes,
    resolvedModelPlan: plan,
    fincastCandleSeconds: 60,
    execution: { mode: "paper" },
    realOrder: false,
    ...(marketKind === "crypto_futures"
      ? {
        riskLimits: object(source.riskLimits) ?? {
          riskPerTradeRate: 0.005,
          dailyLossLimitRate: 0.03,
          maximumLeverage: 15,
          grossExposureLimitRate: 1.5,
          marginUsageLimitRate: 0.2,
          liquidationBufferMultiple: 2,
        },
      }
      : {}),
    ...(scanner ? { scanner } : {}),
  };
  for (const key of [
    "scannerSnapshotId",
    "scannerGeneratedAt",
    "selectedSymbols",
    "selectedSymbol",
    "sessionNonce",
  ]) {
    if (source[key] !== undefined) normalized[key] = source[key];
  }
  return normalized;
}

async function hasTable(
  database: RelationalDatabase,
  table: string,
): Promise<boolean> {
  const rows = await database.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ?
  `, [table]);
  return rows.length > 0;
}

async function assertDrained(database: RelationalDatabase): Promise<void> {
  if (await hasTable(database, "portfolio_backtest_runs")) {
    const [active] = await database.query<{ active_count: number | string }>(`
      SELECT COUNT(*) AS active_count
      FROM portfolio_backtest_runs
      WHERE status IN ('queued', 'running', 'cancel_requested')
    `);
    if (Number(active?.active_count ?? 0) > 0) {
      throw new Error(
        "최신 contract 전환 전에 실행 중인 run을 모두 종료해야 합니다.",
      );
    }
  }
  if (await hasTable(database, "portfolio_run_jobs")) {
    const rows = await database.query<{
      payload_schema_version: string;
      state: string;
    }>(`
      SELECT payload_schema_version, state
      FROM portfolio_run_jobs
      WHERE state IN ('queued', 'running')
      ORDER BY run_id
    `);
    if (rows.length > 0) {
      const versions = Array.from(new Set(rows.map((row) => row.payload_schema_version)));
      throw new Error(
        `worker payload ${WORKER_PAYLOAD_SCHEMA_VERSION} 전환 전에 durable queue를 비워야 합니다`
        + ` (active=${rows.length}, versions=${versions.join(",")}).`,
      );
    }
  }
}

function sourceManifest(
  source: AiSourceRow,
  disposition: "canonical_copy" | "historical_only",
  canonicalRunId?: string,
  reason?: string,
): JsonObject {
  return {
    schema_version: "portfolio-lens-contract-cutover-manifest/v1",
    migration: {
      id: LATEST_CONTRACT_CUTOVER_MIGRATION_ID,
      source_contract_version: source.source_contract_version ?? "missing",
      target_contract_version: AI_CONTRACT_VERSION,
      disposition,
      ...(canonicalRunId ? { canonical_run_id: canonicalRunId } : {}),
      ...(reason ? { reason } : {}),
    },
    source_checksums: {
      input: source.input_checksum,
      summary: source.summary_checksum,
      result: source.result_checksum,
      manifest: source.manifest_checksum,
    },
  };
}

async function createCanonicalRun(
  database: RelationalDatabase,
  sourceRunId: string,
  canonicalRunId: string,
  inputJson: string,
  manifest: JsonObject,
  now: number,
): Promise<void> {
  const requestHash = sha256(
    `${LATEST_CONTRACT_CUTOVER_MIGRATION_ID}\n${sourceRunId}\n${inputJson}`,
  );
  await database.run(`
    INSERT INTO portfolio_backtest_runs (
      run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
      status, progress, completed_candidates, total_candidates,
      current_validation_window, input_json, summary_json, result_json, error_json,
      warnings_json, name, tags_json, archived_at, deleted_at, replay_of,
      manifest_json, created_at, started_at, finished_at, updated_at
    )
    SELECT
      ?, run_kind, owner_subject, ?, data_revision, engine_version,
      status, progress, completed_candidates, total_candidates,
      current_validation_window, ?, summary_json, result_json, error_json,
      (COALESCE(warnings_json, '[]')::jsonb
        || ?::jsonb)::text,
      name,
      (COALESCE(tags_json, '[]')::jsonb
        || ?::jsonb)::text,
      NULL, NULL, run_id, ?, created_at, started_at, finished_at, ?
    FROM portfolio_backtest_runs
    WHERE run_id = ? AND archived_at IS NULL AND deleted_at IS NULL
    ON CONFLICT(run_id) DO NOTHING
  `, [
    canonicalRunId,
    requestHash,
    inputJson,
    JSON.stringify([
      `Historical result projected through ${AI_CONTRACT_VERSION}; raw output retains its source contract.`,
    ]),
    JSON.stringify([
      `contract:${AI_CONTRACT_VERSION}`,
      `migration:${LATEST_CONTRACT_CUTOVER_MIGRATION_ID}`,
    ]),
    JSON.stringify(manifest),
    now,
    sourceRunId,
  ]);
}

async function copyRunEvents(
  database: RelationalDatabase,
  sourceRunId: string,
  canonicalRunId: string,
  now: number,
): Promise<void> {
  if (!await hasTable(database, "portfolio_run_events")) return;
  await database.run(`
    INSERT INTO portfolio_run_events (
      event_id, run_id, event_type, event_json, created_at
    )
    SELECT ?, ?, 'contract_migrated', ?, ?
    ON CONFLICT(event_id) DO NOTHING
  `, [
    deterministicUuid("event", canonicalRunId),
    canonicalRunId,
    JSON.stringify({
      migration_id: LATEST_CONTRACT_CUTOVER_MIGRATION_ID,
      replay_of: sourceRunId,
    }),
    now,
  ]);
  await database.run(`
    INSERT INTO portfolio_run_events (
      event_id, run_id, event_type, event_json, created_at
    )
    SELECT ? || ':' || event_id, ?, event_type, event_json, created_at
    FROM portfolio_run_events
    WHERE run_id = ? AND event_type <> 'contract_migrated'
    ON CONFLICT(event_id) DO NOTHING
  `, [
    LATEST_CONTRACT_CUTOVER_MIGRATION_ID,
    canonicalRunId,
    sourceRunId,
  ]);
}

async function copyAiArtifacts(
  database: RelationalDatabase,
  sourceRunId: string,
  canonicalRunId: string,
): Promise<void> {
  if (!await hasTable(database, "portfolio_backtest_artifacts")) return;
  await database.run(`
    INSERT INTO portfolio_backtest_artifacts (
      artifact_id, run_id, artifact_type, content_json, row_count, byte_count,
      checksum, generated_at, schema_version, data_revision
    )
    SELECT ? || ':' || artifact_id, ?, artifact_type, content_json, row_count,
           byte_count, checksum, generated_at, schema_version, data_revision
    FROM portfolio_backtest_artifacts
    WHERE run_id = ?
    ON CONFLICT(run_id, artifact_type) DO NOTHING
  `, [
    LATEST_CONTRACT_CUTOVER_MIGRATION_ID,
    canonicalRunId,
    sourceRunId,
  ]);
}

async function archiveSourceRun(
  database: RelationalDatabase,
  sourceRunId: string,
  migrationManifest: JsonObject,
  now: number,
): Promise<void> {
  await database.run(`
    UPDATE portfolio_backtest_runs
    SET archived_at = ?,
        tags_json = (
          COALESCE(tags_json, '[]')::jsonb
          || ?::jsonb
        )::text,
        manifest_json = jsonb_build_object(
          'schema_version', 'portfolio-lens-contract-cutover-manifest/v1',
          'migration', ?::jsonb -> 'migration',
          'source_checksums', ?::jsonb -> 'source_checksums',
          'previous_manifest',
            CASE WHEN manifest_json IS NULL THEN 'null'::jsonb
                 ELSE manifest_json::jsonb END
        )::text,
        updated_at = ?
    WHERE run_id = ? AND archived_at IS NULL
  `, [
    now,
    JSON.stringify([
      "historical:contract-cutover",
      `migration:${LATEST_CONTRACT_CUTOVER_MIGRATION_ID}`,
    ]),
    JSON.stringify(migrationManifest),
    JSON.stringify(migrationManifest),
    now,
    sourceRunId,
  ]);
}

async function migrateAiRuns(
  database: RelationalDatabase,
  now: number,
): Promise<void> {
  if (!await hasTable(database, "portfolio_backtest_runs")) return;
  const sources = await database.query<AiSourceRow>(`
    SELECT run_id, status, input_json,
           COALESCE(
             input_json::jsonb ->> 'contractVersion',
             input_json::jsonb ->> 'schemaVersion',
             input_json::jsonb ->> 'schema_version'
           ) AS source_contract_version,
           (
             LOWER(input_json || COALESCE(summary_json, '')
               || COALESCE(result_json, '') || COALESCE(manifest_json, ''))
             LIKE '%kronos%'
           ) AS mentions_kronos,
           encode(sha256(convert_to(input_json, 'UTF8')), 'hex') AS input_checksum,
           encode(sha256(convert_to(COALESCE(summary_json, ''), 'UTF8')), 'hex')
             AS summary_checksum,
           encode(sha256(convert_to(COALESCE(result_json, ''), 'UTF8')), 'hex')
             AS result_checksum,
           encode(sha256(convert_to(COALESCE(manifest_json, ''), 'UTF8')), 'hex')
             AS manifest_checksum
    FROM portfolio_backtest_runs
    WHERE run_kind = 'ai_trading_simulation'
      AND archived_at IS NULL
      AND deleted_at IS NULL
    ORDER BY run_id
  `);
  for (const source of sources) {
    const version = source.source_contract_version ?? undefined;
    if (version === AI_CONTRACT_VERSION) continue;
    if (!TERMINAL_STATUSES.has(source.status)) {
      throw new Error(
        `변환 불가능한 활성 AI simulation run이 있습니다: ${source.run_id}`,
      );
    }
    const parsed = parseObject(source.input_json);
    const normalized = parsed
      && (version === "ai-paper-simulation/v7"
        || version === "ai-paper-simulation/v8")
      && !boolean(source.mentions_kronos)
      ? normalizedSimulationInput(parsed)
      : undefined;
    if (normalized && version && LEGACY_AI_CONTRACTS.has(version)) {
      const canonicalRunId = deterministicUuid("ai-run", source.run_id);
      const inputJson = JSON.stringify(normalized);
      const manifest = sourceManifest(
        source,
        "canonical_copy",
        canonicalRunId,
      );
      await createCanonicalRun(
        database,
        source.run_id,
        canonicalRunId,
        inputJson,
        {
          ...manifest,
          replay_of: source.run_id,
          historical_output_contract: version,
          checkpoints: {
            disposition: "source_only",
            source_run_id: source.run_id,
          },
        },
        now,
      );
      await copyRunEvents(database, source.run_id, canonicalRunId, now);
      await copyAiArtifacts(database, source.run_id, canonicalRunId);
      await archiveSourceRun(database, source.run_id, manifest, now);
      continue;
    }
    const reason = boolean(source.mentions_kronos)
      ? "kronos_history_only"
      : version && LEGACY_AI_CONTRACTS.has(version)
        ? "source_contract_not_losslessly_convertible"
        : "missing_or_unknown_source_contract";
    await archiveSourceRun(
      database,
      source.run_id,
      sourceManifest(source, "historical_only", undefined, reason),
      now,
    );
  }
}

async function createMetricFunction(database: RelationalDatabase): Promise<void> {
  await database.run(`
    CREATE OR REPLACE FUNCTION ${METRIC_FUNCTION}(input_value JSONB)
    RETURNS JSONB
    LANGUAGE plpgsql
    IMMUTABLE
    AS $function$
    DECLARE
      output_value JSONB;
    BEGIN
      IF input_value IS NULL THEN
        RETURN NULL;
      END IF;
      IF jsonb_typeof(input_value) = 'array' THEN
        SELECT COALESCE(
          jsonb_agg(${METRIC_FUNCTION}(entry.value)),
          '[]'::jsonb
        )
        INTO output_value
        FROM jsonb_array_elements(input_value) AS entry(value);
        RETURN output_value;
      END IF;
      IF jsonb_typeof(input_value) = 'object' THEN
        SELECT COALESCE(
          jsonb_object_agg(entry.key, ${METRIC_FUNCTION}(entry.value)),
          '{}'::jsonb
        )
        INTO output_value
        FROM jsonb_each(input_value) AS entry(key, value);
        IF jsonb_exists(input_value, 'return')
          AND (
            jsonb_exists(input_value, 'volatility')
            OR jsonb_exists(input_value, 'maxDrawdown')
            OR jsonb_exists(input_value, 'sharpe')
            OR jsonb_exists(input_value, 'cvar')
          )
        THEN
          output_value = output_value - 'return';
          IF NOT jsonb_exists(output_value, 'cagr') THEN
            output_value = output_value
              || jsonb_build_object('cagr', input_value -> 'return');
          END IF;
          IF NOT jsonb_exists(output_value, 'totalReturn') THEN
            output_value = output_value
              || jsonb_build_object('totalReturn', 'null'::jsonb);
          END IF;
        END IF;
        RETURN output_value;
      END IF;
      RETURN input_value;
    END;
    $function$
  `);
}

async function copyOptimizationRun(
  database: RelationalDatabase,
  sourceRunId: string,
  canonicalRunId: string,
  now: number,
): Promise<void> {
  const requestHash = sha256(
    `${LATEST_CONTRACT_CUTOVER_MIGRATION_ID}\noptimization\n${sourceRunId}`,
  );
  const manifest = JSON.stringify({
    schema_version: "portfolio-lens-contract-cutover-manifest/v1",
    migration: {
      id: LATEST_CONTRACT_CUTOVER_MIGRATION_ID,
      source_metric: "return",
      target_metrics: ["cagr", "totalReturn"],
      unavailable_total_return_projection: null,
    },
    replay_of: sourceRunId,
  });
  await database.run(`
    INSERT INTO portfolio_backtest_runs (
      run_id, run_kind, owner_subject, request_hash, data_revision, engine_version,
      status, progress, completed_candidates, total_candidates,
      current_validation_window, input_json, summary_json, result_json, error_json,
      warnings_json, name, tags_json, archived_at, deleted_at, replay_of,
      manifest_json, created_at, started_at, finished_at, updated_at
    )
    SELECT
      ?, run_kind, owner_subject, ?, data_revision, engine_version,
      status, progress, completed_candidates, total_candidates,
      current_validation_window,
      ${METRIC_FUNCTION}(input_json::jsonb)::text,
      CASE WHEN summary_json IS NULL THEN NULL
           ELSE ${METRIC_FUNCTION}(summary_json::jsonb)::text END,
      CASE WHEN result_json IS NULL THEN NULL
           ELSE ${METRIC_FUNCTION}(result_json::jsonb)::text END,
      error_json,
      (COALESCE(warnings_json, '[]')::jsonb
        || ?::jsonb)::text,
      name,
      (COALESCE(tags_json, '[]')::jsonb
        || ?::jsonb)::text,
      NULL, NULL, run_id, ?, created_at, started_at, finished_at, ?
    FROM portfolio_backtest_runs
    WHERE run_id = ? AND archived_at IS NULL AND deleted_at IS NULL
    ON CONFLICT(run_id) DO NOTHING
  `, [
    canonicalRunId,
    requestHash,
    JSON.stringify([
      "Legacy return was a CAGR alias; unavailable totalReturn values are explicit null.",
    ]),
    JSON.stringify([
      "optimization-metrics:v2",
      `migration:${LATEST_CONTRACT_CUTOVER_MIGRATION_ID}`,
    ]),
    manifest,
    now,
    sourceRunId,
  ]);
  await database.run(`
    INSERT INTO portfolio_optimization_runs (
      run_id, objective, seed, candidate_budget, objective_version,
      settings_json, created_at
    )
    SELECT ?, objective, seed, candidate_budget,
           objective_version || ':metrics-v2',
           ${METRIC_FUNCTION}(settings_json::jsonb)::text,
           created_at
    FROM portfolio_optimization_runs
    WHERE run_id = ?
    ON CONFLICT(run_id) DO NOTHING
  `, [canonicalRunId, sourceRunId]);
  if (await hasTable(database, "portfolio_optimization_candidates")) {
    await database.run(`
      INSERT INTO portfolio_optimization_candidates (
        candidate_id, run_id, candidate_hash, candidate_rank, weights_json,
        metrics_json, score, pareto, created_at
      )
      SELECT ? || ':' || candidate_id, ?, candidate_hash, candidate_rank,
             weights_json, ${METRIC_FUNCTION}(metrics_json::jsonb)::text,
             score, pareto, created_at
      FROM portfolio_optimization_candidates
      WHERE run_id = ?
      ON CONFLICT(run_id, candidate_hash) DO NOTHING
    `, [
      LATEST_CONTRACT_CUTOVER_MIGRATION_ID,
      canonicalRunId,
      sourceRunId,
    ]);
  }
  if (await hasTable(database, "portfolio_backtest_artifacts")) {
    await database.run(`
      WITH transformed AS (
        SELECT
          ? || ':' || artifact_id AS artifact_id,
          artifact_type,
          ${METRIC_FUNCTION}(content_json::jsonb)::text AS content_json,
          row_count,
          generated_at,
          data_revision
        FROM portfolio_backtest_artifacts
        WHERE run_id = ?
      )
      INSERT INTO portfolio_backtest_artifacts (
        artifact_id, run_id, artifact_type, content_json, row_count, byte_count,
        checksum, generated_at, schema_version, data_revision
      )
      SELECT artifact_id, ?, artifact_type, content_json, row_count,
             octet_length(content_json),
             encode(sha256(convert_to(content_json, 'UTF8')), 'hex'),
             generated_at, ?, data_revision
      FROM transformed
      ON CONFLICT(run_id, artifact_type) DO NOTHING
    `, [
      LATEST_CONTRACT_CUTOVER_MIGRATION_ID,
      sourceRunId,
      canonicalRunId,
      ARTIFACT_SCHEMA_VERSION,
    ]);
  }
  await copyRunEvents(database, sourceRunId, canonicalRunId, now);
  await archiveSourceRun(database, sourceRunId, JSON.parse(manifest) as JsonObject, now);
}

async function migrateOptimizationResults(
  database: RelationalDatabase,
  now: number,
): Promise<void> {
  if (!await hasTable(database, "portfolio_optimization_runs")) return;
  const sources = await database.query<OptimizationSourceRow>(`
    SELECT optimization.run_id
    FROM portfolio_optimization_runs optimization
    JOIN portfolio_backtest_runs run ON run.run_id = optimization.run_id
    WHERE run.archived_at IS NULL AND run.deleted_at IS NULL
      AND optimization.objective_version NOT LIKE '%:metrics-v2'
    ORDER BY optimization.run_id
  `);
  if (sources.length === 0) return;
  await createMetricFunction(database);
  try {
    for (const source of sources) {
      const canonicalRunId = deterministicUuid("optimization-run", source.run_id);
      await copyOptimizationRun(
        database,
        source.run_id,
        canonicalRunId,
        now,
      );
    }
  } finally {
    await database.run(`DROP FUNCTION IF EXISTS ${METRIC_FUNCTION}(JSONB)`);
  }
}

export async function migrateLatestContracts(
  database: RelationalDatabase,
  now = Date.now(),
): Promise<void> {
  await assertDrained(database);
  await migrateAiRuns(database, now);
  await migrateOptimizationResults(database, now);
}
