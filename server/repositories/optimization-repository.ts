import { createHash, randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";

export type OptimizationCandidateRecord = {
  id: string;
  runId: string;
  rank?: number;
  weights: Record<string, number>;
  metrics: Record<string, number | null>;
  score: number;
  pareto: boolean;
  createdAt: number;
};

type CandidateRow = {
  candidate_id: string;
  run_id: string;
  candidate_rank: number | null;
  weights_json: string;
  metrics_json: string;
  score: number;
  pareto: number | boolean;
  created_at: number;
};

function parseCandidate(row: CandidateRow): OptimizationCandidateRecord {
  return {
    id: row.candidate_id,
    runId: row.run_id,
    ...(row.candidate_rank !== null ? { rank: Number(row.candidate_rank) } : {}),
    weights: JSON.parse(row.weights_json) as Record<string, number>,
    metrics: JSON.parse(row.metrics_json) as Record<string, number | null>,
    score: Number(row.score),
    pareto: Boolean(row.pareto),
    createdAt: Number(row.created_at),
  };
}

export class OptimizationRepository {
  constructor(private readonly database: RelationalDatabase) {}

  async initialize(): Promise<void> {
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS portfolio_optimization_runs (
          run_id VARCHAR(64) PRIMARY KEY,
          objective VARCHAR(64) NOT NULL,
          seed VARCHAR(128) NOT NULL,
          candidate_budget INT NOT NULL,
          objective_version VARCHAR(64) NOT NULL,
          settings_json LONGTEXT NOT NULL,
          created_at BIGINT NOT NULL,
          CONSTRAINT fk_portfolio_optimization_run FOREIGN KEY (run_id)
            REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await this.database.run(`
        CREATE TABLE IF NOT EXISTS portfolio_optimization_candidates (
          candidate_id VARCHAR(64) PRIMARY KEY,
          run_id VARCHAR(64) NOT NULL,
          candidate_hash VARCHAR(128) NOT NULL,
          candidate_rank INT NULL,
          weights_json LONGTEXT NOT NULL,
          metrics_json LONGTEXT NOT NULL,
          score DOUBLE NOT NULL,
          pareto TINYINT(1) NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL,
          UNIQUE KEY uq_optimization_candidate (run_id, candidate_hash),
          KEY idx_optimization_candidate_rank (run_id, candidate_rank),
          CONSTRAINT fk_optimization_candidate_run FOREIGN KEY (run_id)
            REFERENCES portfolio_optimization_runs(run_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      return;
    }
    const timestampType = this.database.dialect === "postgres" ? "BIGINT" : "INTEGER";
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_optimization_runs (
        run_id TEXT PRIMARY KEY REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
        objective TEXT NOT NULL,
        seed TEXT NOT NULL,
        candidate_budget INTEGER NOT NULL,
        objective_version TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        created_at ${timestampType} NOT NULL
      )
    `);
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_optimization_candidates (
        candidate_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES portfolio_optimization_runs(run_id) ON DELETE CASCADE,
        candidate_hash TEXT NOT NULL,
        candidate_rank INTEGER,
        weights_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        score REAL NOT NULL,
        pareto INTEGER NOT NULL DEFAULT 0,
        created_at ${timestampType} NOT NULL,
        UNIQUE(run_id, candidate_hash)
      )
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_optimization_candidate_rank
      ON portfolio_optimization_candidates(run_id, candidate_rank)
    `);
  }

  async createRun(input: {
    runId: string;
    objective: string;
    seed: string | number;
    candidateBudget: number;
    objectiveVersion: string;
    settings: unknown;
    createdAt?: number;
  }): Promise<void> {
    const values = [
      input.runId,
      input.objective,
      String(input.seed),
      input.candidateBudget,
      input.objectiveVersion,
      JSON.stringify(input.settings),
      input.createdAt ?? Date.now(),
    ];
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        INSERT IGNORE INTO portfolio_optimization_runs (
          run_id, objective, seed, candidate_budget, objective_version, settings_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, values);
    } else {
      await this.database.run(`
        INSERT INTO portfolio_optimization_runs (
          run_id, objective, seed, candidate_budget, objective_version, settings_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO NOTHING
      `, values);
    }
  }

  async putCandidate(input: Omit<OptimizationCandidateRecord, "id" | "createdAt"> & {
    createdAt?: number;
  }): Promise<void> {
    const weightsJson = JSON.stringify(input.weights);
    const candidateHash = createHash("sha256").update(weightsJson).digest("hex");
    const values = [
      randomUUID(),
      input.runId,
      candidateHash,
      input.rank,
      weightsJson,
      JSON.stringify(input.metrics),
      input.score,
      input.pareto ? 1 : 0,
      input.createdAt ?? Date.now(),
    ];
    if (this.database.dialect === "mysql") {
      await this.database.run(`
        INSERT INTO portfolio_optimization_candidates (
          candidate_id, run_id, candidate_hash, candidate_rank, weights_json,
          metrics_json, score, pareto, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          candidate_rank = VALUES(candidate_rank), metrics_json = VALUES(metrics_json),
          score = VALUES(score), pareto = VALUES(pareto)
      `, values);
    } else {
      await this.database.run(`
        INSERT INTO portfolio_optimization_candidates (
          candidate_id, run_id, candidate_hash, candidate_rank, weights_json,
          metrics_json, score, pareto, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, candidate_hash) DO UPDATE SET
          candidate_rank = excluded.candidate_rank, metrics_json = excluded.metrics_json,
          score = excluded.score, pareto = excluded.pareto
      `, values);
    }
  }

  async listCandidates(runId: string, limit = 100): Promise<OptimizationCandidateRecord[]> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = await this.database.query<CandidateRow>(`
      SELECT candidate_id, run_id, candidate_rank, weights_json, metrics_json,
             score, pareto, created_at
      FROM portfolio_optimization_candidates
      WHERE run_id = ?
      ORDER BY CASE WHEN candidate_rank IS NULL THEN 1 ELSE 0 END,
               candidate_rank ASC, score DESC
      LIMIT ${safeLimit}
    `, [runId]);
    return rows.map(parseCandidate);
  }

  async listParetoCandidates(runId: string, limit = 100): Promise<OptimizationCandidateRecord[]> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = await this.database.query<CandidateRow>(`
      SELECT candidate_id, run_id, candidate_rank, weights_json, metrics_json,
             score, pareto, created_at
      FROM portfolio_optimization_candidates
      WHERE run_id = ? AND pareto = 1
      ORDER BY CASE WHEN candidate_rank IS NULL THEN 1 ELSE 0 END,
               candidate_rank ASC, score DESC
      LIMIT ${safeLimit}
    `, [runId]);
    return rows.map(parseCandidate);
  }
}
