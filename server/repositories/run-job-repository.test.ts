import { afterEach, describe, expect, it } from "vitest";
import { PGliteDatabase } from "../../test-support/pglite-database.js";
import { RunJobRepository } from "./run-job-repository.js";
import { RunRepository } from "./run-repository.js";

const databases: PGliteDatabase[] = [];

async function database(): Promise<PGliteDatabase> {
  const value = await PGliteDatabase.create();
  databases.push(value);
  await value.run(`
    CREATE TABLE portfolio_backtest_runs (
      run_id TEXT PRIMARY KEY
    )
  `);
  return value;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((value) => value.close()));
});

describe("RunJobRepository PostgreSQL queue boundary", () => {
  it("initializes the worker 2.0 queue on the test-only PGlite adapter", async () => {
    const value = await database();
    await expect(new RunJobRepository(value).initialize()).resolves.toBeUndefined();
    await expect(value.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name IN ('portfolio_run_jobs', 'portfolio_worker_artifacts')
      ORDER BY table_name
    `)).resolves.toEqual([
      { table_name: "portfolio_run_jobs" },
      { table_name: "portfolio_worker_artifacts" },
    ]);
  });

  it("refuses the worker 2.0 cutover while an older queued job exists", async () => {
    const value = await database();
    const repository = new RunJobRepository(value);
    await repository.initialize();
    await value.run("INSERT INTO portfolio_backtest_runs(run_id) VALUES (?)", ["run-old"]);
    await value.run(`
      INSERT INTO portfolio_worker_artifacts (
        artifact_id, run_id, artifact_role, format, content_encoding, content,
        byte_count, uncompressed_byte_count, checksum, schema_version,
        data_revision, created_at
      ) VALUES (?, ?, 'input', 'application/json', 'gzip', ?, 1, 1, ?, '1.0', ?, 1)
    `, ["artifact-old", "run-old", Buffer.from([0]), "a".repeat(64), "revision-old"]);
    await value.run(`
      INSERT INTO portfolio_run_jobs (
        run_id, job_kind, payload_schema_version, priority, state, available_at,
        deadline_at, attempt_count, max_attempts, input_artifact_id, created_at,
        updated_at
      ) VALUES (?, 'backtest', '1.0', 0, 'queued', 1, 1000, 0, 3, ?, 1, 1)
    `, ["run-old", "artifact-old"]);

    await expect(repository.initialize()).rejects.toThrow(
      "구 schema queued/running job을 모두 종료",
    );
  });

  it("soft archive된 terminal run의 external job 재시도를 거부한다", async () => {
    const value = await PGliteDatabase.create();
    databases.push(value);
    const runs = new RunRepository(value);
    const jobs = new RunJobRepository(value);
    await runs.initialize();
    await jobs.initialize();
    const run = await runs.create({
      kind: "backtest",
      ownerSubject: "owner-a",
      requestHash: "a".repeat(64),
      dataRevision: "revision-a",
      engineVersion: "engine-a",
      config: {},
      now: 100,
    });
    await runs.fail(run.id, { code: "FAILED" }, [], 110);
    await runs.archive(run.id, "owner-a", 120);
    await value.run(`
      INSERT INTO portfolio_worker_artifacts (
        artifact_id, run_id, artifact_role, format, content_encoding, content,
        byte_count, uncompressed_byte_count, checksum, schema_version,
        data_revision, created_at
      ) VALUES (?, ?, 'input', 'application/json', 'gzip', ?, 1, 1, ?, '2.0', ?, ?)
    `, ["artifact-archived", run.id, Buffer.from([0]), "a".repeat(64), "revision-a", 101]);
    await value.run(`
      INSERT INTO portfolio_run_jobs (
        run_id, job_kind, payload_schema_version, priority, state, available_at,
        deadline_at, attempt_count, max_attempts, input_artifact_id, last_error_json,
        created_at, updated_at, finished_at
      ) VALUES (?, 'backtest', '2.0', 0, 'failed', 100, 1000, 1, 3, ?, '{}', 100, 110, 110)
    `, [run.id, "artifact-archived"]);

    await expect(jobs.retryTerminal({
      runId: run.id,
      ownerSubject: "owner-a",
      deadlineAt: 2_000,
      now: 130,
    })).resolves.toBe(false);
    await expect(jobs.get(run.id)).resolves.toMatchObject({ state: "failed" });
    await expect(runs.get(run.id, "owner-a")).resolves.toMatchObject({
      status: "failed",
      archivedAt: 120,
    });
    await expect(value.query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM portfolio_run_events
      WHERE run_id = ? AND event_type = 'external_retry_requested'
    `, [run.id])).resolves.toEqual([{ count: 0 }]);
  });
});
