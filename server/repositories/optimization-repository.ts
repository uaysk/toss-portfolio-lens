import { createHash, randomUUID } from "node:crypto";
import type { RelationalDatabase } from "../database.js";

export type OptimizationCandidateRecord = {
  id: string;
  runId: string;
  rank?: number;
  weights: Record<string, number>;
  metrics: Record<string, unknown>;
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
    metrics: JSON.parse(row.metrics_json) as Record<string, unknown>,
    score: Number(row.score),
    pareto: Boolean(row.pareto),
    createdAt: Number(row.created_at),
  };
}

export class OptimizationRepository {
  constructor(private readonly database: RelationalDatabase) {}

  async initialize(): Promise<void> {
    await this.database.run(`
      CREATE TABLE IF NOT EXISTS portfolio_optimization_runs (
        run_id TEXT PRIMARY KEY REFERENCES portfolio_backtest_runs(run_id) ON DELETE CASCADE,
        objective TEXT NOT NULL,
        seed TEXT NOT NULL,
        candidate_budget INTEGER NOT NULL,
        objective_version TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        created_at BIGINT NOT NULL
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
        score DOUBLE PRECISION NOT NULL,
        pareto INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        UNIQUE(run_id, candidate_hash)
      )
    `);
    await this.database.run(`
      ALTER TABLE portfolio_optimization_candidates
      ALTER COLUMN score TYPE DOUBLE PRECISION
    `);
    await this.database.run(`
      CREATE INDEX IF NOT EXISTS idx_optimization_candidate_order
      ON portfolio_optimization_candidates(
        run_id, candidate_rank ASC NULLS LAST, score DESC
      )
    `);
    // The ordering index is a strict superset of the legacy rank index. Keep
    // one candidate-write index rather than paying for both on large searches.
    await this.database.run("DROP INDEX IF EXISTS idx_optimization_candidate_rank");
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
    await this.database.run(`
      INSERT INTO portfolio_optimization_runs (
        run_id, objective, seed, candidate_budget, objective_version, settings_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `, values);
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

  async putCandidates(inputs: Array<Omit<OptimizationCandidateRecord, "id" | "createdAt"> & {
    createdAt?: number;
  }>): Promise<void> {
    if (!inputs.length) return;
    const chunkSize = 250;
    for (let offset = 0; offset < inputs.length; offset += chunkSize) {
      const chunk = inputs.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const rows = chunk.map((input) => {
        const weightsJson = JSON.stringify(input.weights);
        values.push(
          randomUUID(),
          input.runId,
          createHash("sha256").update(weightsJson).digest("hex"),
          input.rank,
          weightsJson,
          JSON.stringify(input.metrics),
          input.score,
          input.pareto ? 1 : 0,
          input.createdAt ?? Date.now(),
        );
        return "(?, ?, ?, ?, ?, ?, ?, ?, ?)";
      });
      await this.database.run(`
        INSERT INTO portfolio_optimization_candidates (
          candidate_id, run_id, candidate_hash, candidate_rank, weights_json,
          metrics_json, score, pareto, created_at
        ) VALUES ${rows.join(", ")}
        ON CONFLICT(run_id, candidate_hash) DO UPDATE SET
          candidate_rank = excluded.candidate_rank, metrics_json = excluded.metrics_json,
          score = excluded.score, pareto = excluded.pareto
      `, values);
    }
  }

  async listCandidates(runId: string, limit = 100): Promise<OptimizationCandidateRecord[]> {
    const safeLimit = Math.max(1, Math.min(100_000, Math.floor(limit)));
    const rows = await this.database.query<CandidateRow>(`
      SELECT candidate_id, run_id, candidate_rank, weights_json, metrics_json,
             score, pareto, created_at
      FROM portfolio_optimization_candidates
      WHERE run_id = ?
      ORDER BY candidate_rank ASC NULLS LAST, score DESC
      LIMIT ${safeLimit}
    `, [runId]);
    return rows.map(parseCandidate);
  }

  async candidateCount(runId: string): Promise<number> {
    const [row] = await this.database.query<{ candidate_count: number | string }>(`
      SELECT COUNT(*) AS candidate_count FROM portfolio_optimization_candidates WHERE run_id = ?
    `, [runId]);
    return Number(row?.candidate_count ?? 0);
  }

  async listParetoCandidates(runId: string, limit = 100): Promise<OptimizationCandidateRecord[]> {
    const safeLimit = Math.max(1, Math.min(100_000, Math.floor(limit)));
    const rows = await this.database.query<CandidateRow>(`
      SELECT candidate_id, run_id, candidate_rank, weights_json, metrics_json,
             score, pareto, created_at
      FROM portfolio_optimization_candidates
      WHERE run_id = ? AND pareto = 1
      ORDER BY candidate_rank ASC NULLS LAST, score DESC
      LIMIT ${safeLimit}
    `, [runId]);
    return rows.map(parseCandidate);
  }

  async getCandidateAt(runId: string, index: number, paretoOnly = false): Promise<OptimizationCandidateRecord | undefined> {
    if (!Number.isSafeInteger(index) || index < 0 || index > 100_000) return undefined;
    const [row] = await this.database.query<CandidateRow>(`
      SELECT candidate_id, run_id, candidate_rank, weights_json, metrics_json,
             score, pareto, created_at
      FROM portfolio_optimization_candidates
      WHERE run_id = ?${paretoOnly ? " AND pareto = 1" : ""}
      ORDER BY candidate_rank ASC NULLS LAST, score DESC
      LIMIT 1 OFFSET ${index}
    `, [runId]);
    return row ? parseCandidate(row) : undefined;
  }
}
