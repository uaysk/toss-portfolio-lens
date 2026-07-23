import { createHash, randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";
import { canonicalJson } from "../worker/contracts.js";

export const ARTIFACT_TYPES = [
  "equity", "drawdown", "holdings", "trades", "rolling", "correlation",
  "risk-contribution", "monthly-returns", "cash-ledger", "cash-flows", "dividends",
  "target-weight-schedule", "data-quality", "regime-policy",
  "candidates", "walk-forward", "worker-pareto-frontier", "scenario-comparison",
  "monte-carlo-distribution", "monte-carlo-percentile-paths", "monte-carlo-sample-paths",
  "screening-candidates", "ledger-validated-candidates", "outlook-summary",
  "outlook-oos-equity", "outlook-quantile-paths", "outlook-calibration",
  "outlook-worst-scenarios", "outlook-sensitivity", "outlook-market-regimes",
  "technical-indicators", "technical-signals", "technical-diagnostics",
  "scalping-evaluation-summary", "scalping-prediction-replay", "scalping-signal-comparison",
  "scalping-cost-ledger", "scalping-evaluation-diagnostics",
  "simulation-selection", "simulation-decisions", "simulation-equity",
  "simulation-trades", "simulation-diagnostics",
  "portfolio-exposures", "pareto-frontier", "research-report", "worker-metrics", "result",
] as const;

export type ArtifactType = typeof ARTIFACT_TYPES[number];

export function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value);
}

export type ArtifactDescriptor = {
  id: string;
  runId: string;
  type: ArtifactType;
  uri: string;
  format: "application/json";
  rowCount: number;
  byteCount: number;
  checksum: string;
  generatedAt: string;
  schemaVersion: string;
  dataRevision: string;
};

type ArtifactRow = {
  artifact_id: string;
  run_id: string;
  artifact_type: ArtifactType;
  content_json: string;
  row_count: number;
  byte_count: number;
  checksum: string;
  generated_at: string;
  schema_version: string;
  data_revision: string;
};

function uriFor(runId: string, type: ArtifactType): string {
  if (["candidates", "walk-forward", "worker-pareto-frontier", "pareto-frontier", "scenario-comparison", "monte-carlo-distribution", "monte-carlo-percentile-paths", "monte-carlo-sample-paths"].includes(type)) {
    return `optimization://runs/${runId}/${type}`;
  }
  if (["equity", "drawdown", "holdings", "trades", "rolling", "correlation", "risk-contribution", "monthly-returns", "cash-ledger", "cash-flows"].includes(type)) {
    return `backtest://runs/${runId}/${type}`;
  }
  return `portfolio://runs/${runId}/artifacts/${type}`;
}

function descriptor(row: ArtifactRow): ArtifactDescriptor {
  return {
    id: row.artifact_id,
    runId: row.run_id,
    type: row.artifact_type,
    uri: uriFor(row.run_id, row.artifact_type),
    format: "application/json",
    rowCount: Number(row.row_count),
    byteCount: Number(row.byte_count),
    checksum: row.checksum,
    generatedAt: row.generated_at,
    schemaVersion: row.schema_version,
    dataRevision: row.data_revision,
  };
}

export class ArtifactRepository {
  constructor(private readonly database: RelationalDatabase) {}

  async initialize(): Promise<void> {
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS portfolio_backtest_artifacts (
          artifact_id VARCHAR(64) PRIMARY KEY,
          run_id VARCHAR(64) NOT NULL,
          artifact_type VARCHAR(64) NOT NULL,
          content_json LONGTEXT NOT NULL,
          row_count INT NOT NULL,
          byte_count BIGINT NOT NULL,
          checksum VARCHAR(128) NOT NULL,
          generated_at VARCHAR(40) NOT NULL,
          schema_version VARCHAR(64) NOT NULL,
          data_revision VARCHAR(128) NOT NULL,
          UNIQUE KEY uq_portfolio_artifact_type (run_id, artifact_type),
          CONSTRAINT fk_portfolio_artifact_run FOREIGN KEY (run_id)
            REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      return;
    }
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_backtest_artifacts (
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
  }

  async put(input: {
    runId: string;
    type: ArtifactType;
    content: unknown;
    rowCount?: number;
    schemaVersion: string;
    dataRevision: string;
    generatedAt?: string;
  }): Promise<ArtifactDescriptor> {
    const contentJson = canonicalJson(input.content);
    const checksum = createHash("sha256").update(contentJson).digest("hex");
    const byteCount = Buffer.byteLength(contentJson);
    const rowCount = input.rowCount ?? (Array.isArray(input.content) ? input.content.length : 1);
    const id = randomUUID();
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const values = [
      id,
      input.runId,
      input.type,
      contentJson,
      rowCount,
      byteCount,
      checksum,
      generatedAt,
      input.schemaVersion,
      input.dataRevision,
    ];
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        INSERT INTO portfolio_backtest_artifacts (
          artifact_id, run_id, artifact_type, content_json, row_count, byte_count,
          checksum, generated_at, schema_version, data_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          content_json = VALUES(content_json), row_count = VALUES(row_count),
          byte_count = VALUES(byte_count), checksum = VALUES(checksum),
          generated_at = VALUES(generated_at), schema_version = VALUES(schema_version),
          data_revision = VALUES(data_revision)
      `, values);
    } else {
      await this.database.run(`
        INSERT INTO portfolio_backtest_artifacts (
          artifact_id, run_id, artifact_type, content_json, row_count, byte_count,
          checksum, generated_at, schema_version, data_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, artifact_type) DO UPDATE SET
          content_json = excluded.content_json, row_count = excluded.row_count,
          byte_count = excluded.byte_count, checksum = excluded.checksum,
          generated_at = excluded.generated_at, schema_version = excluded.schema_version,
          data_revision = excluded.data_revision
      `, values);
    }
    const stored = await this.get(input.runId, input.type);
    if (!stored) throw new Error("artifact를 저장하지 못했습니다.");
    return stored.descriptor;
  }

  async get(runId: string, type: ArtifactType): Promise<{
    descriptor: ArtifactDescriptor;
    content: unknown;
  } | undefined> {
    const [row] = await this.database.query<ArtifactRow>(`
      SELECT * FROM portfolio_backtest_artifacts WHERE run_id = ? AND artifact_type = ?
    `, [runId, type]);
    if (!row) return undefined;
    let content: unknown;
    try {
      content = JSON.parse(row.content_json) as unknown;
    } catch {
      throw new Error("저장된 artifact JSON이 손상되었습니다.");
    }
    return { descriptor: descriptor(row), content };
  }

  async list(runId: string): Promise<ArtifactDescriptor[]> {
    const rows = await this.database.query<ArtifactRow>(`
      SELECT artifact_id, run_id, artifact_type, '' AS content_json, row_count, byte_count,
             checksum, generated_at, schema_version, data_revision
      FROM portfolio_backtest_artifacts WHERE run_id = ? ORDER BY artifact_type ASC
    `, [runId]);
    return rows.map(descriptor);
  }
}
