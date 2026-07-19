import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { SqliteDatabase } from "../server/database.js";
import { ArtifactRepository } from "../server/repositories/artifact-repository.js";
import { RunRepository } from "../server/repositories/run-repository.js";
import type { OptimizationInput } from "../server/services/optimization-service.js";
import { RustComputeClient } from "../server/worker/rust-client.js";
import { buildSyntheticFixture } from "./benchmark-compute.js";

type Algorithm = "random_search" | "nsga_ii";

function numberList(name: string, fallback: number[], minimum: number, maximum: number): number[] {
  const source = process.env[name];
  if (!source) return fallback;
  const values = source.split(",").map(Number).filter((value) => Number.isInteger(value));
  if (!values.length || values.some((value) => value < minimum || value > maximum)) {
    throw new Error(`${name} 값은 ${minimum}~${maximum} 범위의 comma-separated 정수여야 합니다.`);
  }
  return Array.from(new Set(values));
}

function algorithmList(): Algorithm[] {
  const source = process.env.BENCH_ALGORITHMS;
  if (!source) return ["random_search", "nsga_ii"];
  const values = source.split(",");
  if (!values.length || values.some((value) => value !== "random_search" && value !== "nsga_ii")) {
    throw new Error("BENCH_ALGORITHMS는 random_search,nsga_ii 중 하나 이상이어야 합니다.");
  }
  return Array.from(new Set(values)) as Algorithm[];
}

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Rust UDS worker가 socket을 만들지 못했습니다.");
}

function metric(artifacts: Array<{ type: string; content: unknown }>) {
  return artifacts.find((artifact) => artifact.type === "worker-metrics")?.content as {
    compute_ms?: number;
    serialization_ms?: number;
    serialized_result_bytes?: number;
    peak_process_rss_bytes?: number;
  } | undefined;
}

const binary = fileURLToPath(new URL("../worker/rust/target/release/portfolio-lens-worker", import.meta.url));
if (!existsSync(binary)) {
  throw new Error("release worker가 없습니다. cargo build --release --locked --manifest-path worker/rust/Cargo.toml을 먼저 실행하세요.");
}

const symbolCounts = numberList("BENCH_SYMBOLS", [12, 20], 2, 20);
const budgets = numberList("BENCH_CANDIDATES", [500, 1_000, 1_500, 3_000], 1, 10_000);
const ledgerBudgets = numberList("BENCH_LEDGER_BUDGETS", [8, 32, 64], 1, 128);
const robustModes = process.env.BENCH_ROBUST === "off"
  ? [false]
  : process.env.BENCH_ROBUST === "on" ? [true] : [false, true];
const algorithms = algorithmList();
const dayCount = numberList("BENCH_DAYS", [1_319], 90, 5_000)[0];
const socketPath = path.join("/tmp", `tpl-optimization-load-${process.pid}.sock`);
const worker = spawn(binary, ["serve", "--socket", socketPath], { stdio: ["ignore", "ignore", "pipe"] });
let workerStderr = "";
worker.stderr.setEncoding("utf8");
worker.stderr.on("data", (chunk: string) => { workerStderr += chunk; });
const client = new RustComputeClient({ socketPath, poolSize: 1, timeoutMs: 3_600_000 });
const database = new SqliteDatabase(":memory:");
const runs = new RunRepository(database);
const artifacts = new ArtifactRepository(database);
await runs.initialize();
await artifacts.initialize();

const rows: Array<Record<string, unknown>> = [];
try {
  await waitForSocket(socketPath);
  for (const symbolCount of symbolCounts) {
    const fixture = buildSyntheticFixture(dayCount, symbolCount);
    for (const candidateBudget of budgets) {
      for (const algorithm of algorithms) {
        for (const robustValidation of robustModes) {
          for (const ledgerValidationBudget of ledgerBudgets) {
            const optimization: OptimizationInput = {
              ...fixture.optimization,
              algorithm,
              candidateBudget,
              baselines: [],
              walkForwardConfig: robustValidation ? {
                enabled: true,
                mode: "walk_forward",
                windowMode: "rolling",
                trainWindow: 126,
                testWindow: 21,
                step: 21,
                foldCount: 5,
                minimumTrainObservations: 63,
                minimumTestObservations: 10,
              } : { enabled: false },
              ledgerTemplate: fixture.backtest,
              ledgerValidationBudget,
            };
            const label = `${symbolCount}-${candidateBudget}-${algorithm}-${robustValidation}-${ledgerValidationBudget}`;
            const started = performance.now();
            try {
              const output = await client.compute<Record<string, unknown>>("optimization", {
                optimization,
                objective: "robust_score",
              });
              const elapsedMs = performance.now() - started;
              const candidatesArtifact = output.artifacts.find((artifact) => artifact.type === "candidates");
              const candidateCount = Number(output.result.candidateCount ?? candidatesArtifact?.row_count ?? 0);
              const workerMetric = metric(output.artifacts);
              const storageRun = await runs.create({
                kind: "optimization",
                ownerSubject: "optimization-load-benchmark",
                requestHash: createHash("sha256").update(label).digest("hex"),
                dataRevision: "synthetic-load-v1",
                engineVersion: "rust-load-benchmark",
                config: { symbolCount, candidateBudget, algorithm, robustValidation, ledgerValidationBudget },
                totalCandidates: candidateBudget,
              });
              await runs.markRunning(storageRun.id);
              const dbStarted = performance.now();
              const descriptor = await artifacts.put({
                runId: storageRun.id,
                type: "candidates",
                content: candidatesArtifact?.content ?? [],
                rowCount: candidateCount,
                schemaVersion: "optimization-load-benchmark/v1",
                dataRevision: "synthetic-load-v1",
              });
              await runs.complete(storageRun.id, { candidateCount }, output.result, output.warnings);
              const dbWriteMs = performance.now() - dbStarted;
              rows.push({
                symbol_count: symbolCount,
                candidate_budget: candidateBudget,
                algorithm,
                robust_validation: robustValidation,
                ledger_validation_budget: ledgerValidationBudget,
                status: "completed",
                elapsed_ms: elapsedMs,
                compute_ms: workerMetric?.compute_ms ?? null,
                serialization_ms: workerMetric?.serialization_ms ?? null,
                db_write_ms: dbWriteMs,
                peak_rss_bytes: workerMetric?.peak_process_rss_bytes ?? null,
                completed_candidate_count: candidateCount,
                candidate_throughput_per_second: elapsedMs > 0 ? candidateCount / elapsedMs * 1_000 : null,
                artifact_byte_size: descriptor.byteCount,
                serialized_result_bytes: workerMetric?.serialized_result_bytes ?? null,
                worker_exit_status: worker.exitCode === null ? "running" : worker.exitCode,
              });
            } catch (error) {
              rows.push({
                symbol_count: symbolCount,
                candidate_budget: candidateBudget,
                algorithm,
                robust_validation: robustValidation,
                ledger_validation_budget: ledgerValidationBudget,
                status: "failed",
                elapsed_ms: performance.now() - started,
                error: error instanceof Error ? error.message : String(error),
                worker_exit_status: worker.exitCode === null ? "running" : worker.exitCode,
              });
              if (worker.exitCode !== null) break;
            }
          }
        }
      }
    }
  }
} finally {
  client.close();
  await database.close();
  if (worker.exitCode === null) {
    const exited = once(worker, "exit");
    worker.kill("SIGTERM");
    await exited;
  }
}

process.stdout.write(`${JSON.stringify({
  schema_version: "optimization-load-benchmark/v1",
  generated_at: new Date().toISOString(),
  matrix: { symbolCounts, budgets, algorithms, robustModes, ledgerBudgets, dayCount },
  worker: {
    exit_code: worker.exitCode,
    signal: worker.signalCode,
    stderr: workerStderr || null,
  },
  results: rows,
}, null, 2)}\n`);
