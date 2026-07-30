import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { PortfolioRunKind } from "../server/repositories/run-repository.js";
import { RustComputeClient } from "../server/worker/rust-client.js";

type DebugRequest = {
  kind: PortfolioRunKind;
  payload: Record<string, unknown>;
};

type Arguments = {
  binary: string;
  concurrency: number;
  iterations: number;
  output?: string;
  request: string;
};

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer in [${minimum}, ${maximum}], received ${value ?? fallback}.`);
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): Arguments {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const request = value("--request");
  if (!request) throw new Error("--request <debug-rust-request.json> is required.");
  return {
    binary: resolve(value("--binary") ?? fileURLToPath(
      new URL("../worker/rust/target/release/portfolio-lens-worker", import.meta.url),
    )),
    concurrency: integer(value("--concurrency"), 6, 2, 32),
    iterations: integer(value("--iterations"), 12, 2, 128),
    ...(value("--output") ? { output: resolve(value("--output")!) } : {}),
    request: resolve(request),
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function waitForSocket(socketPath: string, worker: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    if (worker.exitCode !== null) {
      throw new Error(`Rust worker exited before socket readiness with code ${worker.exitCode}.`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Rust worker did not create its socket within 10 seconds.");
}

async function stopWorker(worker: ReturnType<typeof spawn>): Promise<void> {
  if (worker.exitCode !== null) return;
  worker.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => worker.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (worker.exitCode === null) worker.kill("SIGKILL");
}

async function runSequential(
  client: RustComputeClient,
  request: DebugRequest,
  iterations: number,
  expectedHash: string,
): Promise<{ elapsedMs: number; hashes: string[] }> {
  const hashes: string[] = [];
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const output = await client.compute(request.kind, request.payload, { includeArtifacts: false });
    const resultHash = hash(output.result);
    if (resultHash !== expectedHash) {
      throw new Error(`Sequential result ${index} failed parity: ${resultHash} != ${expectedHash}.`);
    }
    hashes.push(resultHash);
  }
  return { elapsedMs: performance.now() - started, hashes };
}

async function runConcurrent(
  client: RustComputeClient,
  request: DebugRequest,
  iterations: number,
  concurrency: number,
  expectedHash: string,
): Promise<{ elapsedMs: number; hashes: string[] }> {
  const hashes = new Array<string>(iterations);
  let nextIndex = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= iterations) return;
      const output = await client.compute(request.kind, request.payload, { includeArtifacts: false });
      const resultHash = hash(output.result);
      if (resultHash !== expectedHash) {
        throw new Error(`Concurrent result ${index} failed parity: ${resultHash} != ${expectedHash}.`);
      }
      hashes[index] = resultHash;
    }
  }));
  return { elapsedMs: performance.now() - started, hashes };
}

const arguments_ = parseArguments(process.argv.slice(2));
const request = JSON.parse(await readFile(arguments_.request, "utf8")) as DebugRequest;
if (!request || typeof request !== "object" || typeof request.kind !== "string"
  || !request.payload || typeof request.payload !== "object") {
  throw new Error("Debug request must contain kind and payload.");
}

const runtimeDirectory = await mkdtemp(join(tmpdir(), "tpl-high-vol-rust-concurrency-"));
const socketPath = join(runtimeDirectory, "compute.sock");
const worker = spawn(arguments_.binary, ["serve", "--socket", socketPath], {
  stdio: ["ignore", "ignore", "pipe"],
});
let workerStderr = "";
worker.stderr?.setEncoding("utf8");
worker.stderr?.on("data", (chunk: string) => {
  workerStderr = `${workerStderr}${chunk}`.slice(-16_000);
});

const sequentialClient = new RustComputeClient({
  socketPath,
  poolSize: 1,
  timeoutMs: 300_000,
});
const concurrentClient = new RustComputeClient({
  socketPath,
  poolSize: arguments_.concurrency,
  timeoutMs: 300_000,
});

try {
  await waitForSocket(socketPath, worker);
  const reference = await sequentialClient.compute(request.kind, request.payload, {
    includeArtifacts: false,
  });
  const referenceHash = hash(reference.result);
  const splitIterations = Math.max(1, Math.floor(arguments_.iterations / 2));
  const sequentialBefore = await runSequential(
    sequentialClient,
    request,
    splitIterations,
    referenceHash,
  );
  const concurrent = await runConcurrent(
    concurrentClient,
    request,
    arguments_.iterations,
    arguments_.concurrency,
    referenceHash,
  );
  const sequentialAfter = await runSequential(
    sequentialClient,
    request,
    arguments_.iterations - splitIterations,
    referenceHash,
  );
  const sequentialElapsedMs = sequentialBefore.elapsedMs + sequentialAfter.elapsedMs;
  const sequentialRate = arguments_.iterations / (sequentialElapsedMs / 1_000);
  const concurrentRate = arguments_.iterations / (concurrent.elapsedMs / 1_000);
  const result = {
    schemaVersion: "high-vol-rust-concurrency-benchmark/v1",
    generatedAt: new Date().toISOString(),
    request: {
      file: arguments_.request,
      fileName: basename(arguments_.request),
      kind: request.kind,
      bytes: Buffer.byteLength(JSON.stringify(request)),
      resultHash: referenceHash,
    },
    environment: {
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCores: cpus().length,
      binary: arguments_.binary,
    },
    configuration: {
      concurrency: arguments_.concurrency,
      iterations: arguments_.iterations,
      sequentialPoolSize: 1,
      concurrentPoolSize: arguments_.concurrency,
    },
    sequential: {
      elapsedMs: round(sequentialElapsedMs),
      requestsPerSecond: round(sequentialRate),
      requestsPerMinute: round(sequentialRate * 60),
    },
    concurrent: {
      elapsedMs: round(concurrent.elapsedMs),
      requestsPerSecond: round(concurrentRate),
      requestsPerMinute: round(concurrentRate * 60),
    },
    speedup: round(concurrentRate / sequentialRate),
    parity: {
      passed: true,
      comparedResults: arguments_.iterations * 2 + 1,
      uniqueResultHashes: new Set([
        referenceHash,
        ...sequentialBefore.hashes,
        ...concurrent.hashes,
        ...sequentialAfter.hashes,
      ]).size,
    },
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (arguments_.output) await writeFile(arguments_.output, serialized, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(serialized);
} catch (error) {
  const detail = workerStderr.trim() ? `\nRust worker stderr:\n${workerStderr}` : "";
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
} finally {
  sequentialClient.close();
  concurrentClient.close();
  await stopWorker(worker);
  await rm(runtimeDirectory, { recursive: true, force: true });
}
