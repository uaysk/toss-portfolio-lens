import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { freemem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const HEAP_LIMIT_MB = 768;
export const UNIT_BATCH_SIZE = 16;
export const PROCESS_RESERVATION_MB = 1_024;
export const MEMORY_HEADROOM_MB = 512;
export const MAX_LIGHT_PARALLELISM = 4;

const TEST_FILE = /\.test\.(?:ts|tsx)$/u;
const PGLITE_MARKERS =
  /@electric-sql\/pglite|\bPGlite\b|createTestDatabase|PGliteDatabase|openTestHistoryStore|test-support\/history-store/u;
const HEAVY_PATH =
  /(?:^|\/)server\/(?:crypto\/|simulation\/(?:historical-backtest|simulation-service)\.test\.)/u;
const HEAVY_MARKERS =
  /\b(?:CryptoPaperRuntime|runHistoricalSimulationBacktest|SimulationService)\b/u;
const HEAVY_FILE_BYTES = 64 * 1_024;
const REPORT_PATH = ".cache/performance/vitest-batches.json";
const RSS_SAMPLE_INTERVAL_MS = 250;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function argumentValue(arguments_, name) {
  const assignment = arguments_.find((value) => value.startsWith(`${name}=`));
  if (assignment) return assignment.slice(name.length + 1);
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

export function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

export function classifyTestFile(path, contents) {
  if (PGLITE_MARKERS.test(contents)) {
    return { lane: "pglite", reason: "pglite-marker" };
  }
  if (HEAVY_PATH.test(path)) {
    return { lane: "heavy", reason: "heavy-path" };
  }
  if (HEAVY_MARKERS.test(contents)) {
    return { lane: "heavy", reason: "heavy-marker" };
  }
  if (Buffer.byteLength(contents) >= HEAVY_FILE_BYTES) {
    return { lane: "heavy", reason: "large-test-file" };
  }
  return { lane: "light", reason: "default" };
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules"
      || entry.name === "dist"
      || entry.name === ".git"
      || entry.name === "graphify-out"
      || entry.name === ".cache") {
      return [];
    }
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : TEST_FILE.test(entry.name) ? [path] : [];
  });
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

export function planBatches(files, group, unitBatchSize = UNIT_BATCH_SIZE) {
  const lightFiles = files.filter(({ lane }) => lane === "light").map(({ path }) => path);
  const heavyFiles = files.filter(({ lane }) => lane === "heavy").map(({ path }) => path);
  const pgliteFiles = files.filter(({ lane }) => lane === "pglite").map(({ path }) => path);
  const batches = [
    ...(group === "all" || group === "unit"
      ? chunks(lightFiles, unitBatchSize).map((batch, index) => ({
          name: `light-${index + 1}`,
          lane: "light",
          files: batch,
        }))
      : []),
    ...(group === "all" || group === "unit"
      ? heavyFiles.map((path, index) => ({
          name: `heavy-${index + 1}`,
          lane: "heavy",
          files: [path],
        }))
      : []),
    ...(group === "all" || group === "pglite"
      ? pgliteFiles.map((path, index) => ({
          name: `pglite-${index + 1}`,
          lane: "pglite",
          files: [path],
        }))
      : []),
  ];
  return batches.map((batch, index) => ({ ...batch, ordinal: index + 1 }));
}

function bytesFromMeminfo(name) {
  try {
    const contents = readFileSync("/proc/meminfo", "utf8");
    const match = contents.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "mu"));
    return match ? Number(match[1]) * 1_024 : undefined;
  } catch {
    return undefined;
  }
}

function cgroupValue(path) {
  try {
    const value = readFileSync(path, "utf8").trim();
    if (!value || value === "max") return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function detectAvailableMemoryBytes() {
  const hostAvailableBytes = bytesFromMeminfo("MemAvailable") ?? freemem();
  const cgroupV2LimitBytes = cgroupValue("/sys/fs/cgroup/memory.max");
  const cgroupV2UsageBytes = cgroupValue("/sys/fs/cgroup/memory.current");
  const cgroupV1LimitBytes = cgroupValue("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const cgroupV1UsageBytes = cgroupValue("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  const cgroupLimitBytes = cgroupV2LimitBytes ?? cgroupV1LimitBytes;
  const cgroupUsageBytes = cgroupV2UsageBytes ?? cgroupV1UsageBytes;
  const cgroupAvailableBytes = cgroupLimitBytes === undefined
    ? undefined
    : Math.max(0, cgroupLimitBytes - (cgroupUsageBytes ?? 0));
  const candidates = [hostAvailableBytes, cgroupAvailableBytes]
    .filter((value) => value !== undefined && Number.isFinite(value) && value >= 0);
  const effectiveAvailableBytes = candidates.length > 0 ? Math.min(...candidates) : undefined;
  return {
    hostAvailableBytes,
    cgroupLimitBytes,
    cgroupUsageBytes,
    cgroupAvailableBytes,
    effectiveAvailableBytes,
  };
}

export function memoryPlan({
  detectedAvailableMb,
  explicitBudgetMb,
  requestedMaxParallel,
}) {
  const safeDetectedMb = Number.isFinite(detectedAvailableMb) && detectedAvailableMb > 0
    ? Math.floor(detectedAvailableMb)
    : undefined;
  const safeExplicitMb = explicitBudgetMb === undefined
    ? undefined
    : positiveInteger(explicitBudgetMb, "memory budget");
  const requestedParallel = requestedMaxParallel === undefined
    ? MAX_LIGHT_PARALLELISM
    : positiveInteger(requestedMaxParallel, "max parallelism");
  const fallbackBudgetMb = PROCESS_RESERVATION_MB + MEMORY_HEADROOM_MB;
  const requestedBudgetMb = safeExplicitMb ?? safeDetectedMb ?? fallbackBudgetMb;
  const effectiveBudgetMb = safeDetectedMb === undefined
    ? requestedBudgetMb
    : Math.min(requestedBudgetMb, safeDetectedMb);
  const memoryBound = Math.max(
    1,
    Math.floor(Math.max(0, effectiveBudgetMb - MEMORY_HEADROOM_MB) / PROCESS_RESERVATION_MB),
  );
  return {
    detectedAvailableMb: safeDetectedMb,
    requestedBudgetMb,
    explicitBudgetMb: safeExplicitMb,
    effectiveBudgetMb,
    processReservationMb: PROCESS_RESERVATION_MB,
    headroomMb: MEMORY_HEADROOM_MB,
    requestedMaxParallel: requestedParallel,
    lightParallelism: Math.max(
      1,
      Math.min(requestedParallel, MAX_LIGHT_PARALLELISM, memoryBound),
    ),
  };
}

export function nodeOptionsWithHeapLimit(value, heapLimitMb = HEAP_LIMIT_MB) {
  const inherited = (value ?? "")
    .replace(
      /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\d+(?=\s|$)/gu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return [
    inherited,
    `--max-old-space-size=${heapLimitMb}`,
  ].filter(Boolean).join(" ");
}

function readLinuxProcessRecords() {
  if (process.platform !== "linux") return undefined;
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return undefined;
  }
  const records = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) continue;
      const statFields = stat.slice(commandEnd + 2).split(" ");
      const parentPid = Number(statFields[1]);
      const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu);
      records.set(pid, {
        parentPid,
        rssBytes: rssMatch ? Number(rssMatch[1]) * 1_024 : 0,
      });
    } catch {
      // Processes may exit while /proc is sampled.
    }
  }
  return records;
}

function processTreeRssBytes(records, rootPid) {
  if (!records?.has(rootPid)) return 0;
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, record] of records) {
      if (!descendants.has(pid) && descendants.has(record.parentPid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return [...descendants].reduce(
    (total, pid) => total + (records.get(pid)?.rssBytes ?? 0),
    0,
  );
}

class RssSampler {
  constructor(report) {
    this.report = report;
    this.active = new Map();
    this.supported = process.platform === "linux";
    this.interval = undefined;
  }

  start() {
    this.sample();
    this.interval = setInterval(() => this.sample(), RSS_SAMPLE_INTERVAL_MS);
    this.interval.unref();
  }

  add(name, pid) {
    this.active.set(name, { pid, peakRssBytes: 0 });
    this.sample();
  }

  remove(name) {
    this.sample();
    const peakRssBytes = this.active.get(name)?.peakRssBytes ?? null;
    this.active.delete(name);
    return this.supported ? peakRssBytes : null;
  }

  sample() {
    const records = readLinuxProcessRecords();
    if (!records) this.supported = false;
    let aggregateChildRssBytes = 0;
    for (const active of this.active.values()) {
      const rssBytes = records ? processTreeRssBytes(records, active.pid) : 0;
      active.peakRssBytes = Math.max(active.peakRssBytes, rssBytes);
      aggregateChildRssBytes += rssBytes;
    }
    const totalRssBytes = aggregateChildRssBytes + process.memoryUsage().rss;
    this.report.execution.peakAggregateChildRssBytes = Math.max(
      this.report.execution.peakAggregateChildRssBytes,
      aggregateChildRssBytes,
    );
    this.report.execution.peakRssBytes = Math.max(
      this.report.execution.peakRssBytes,
      totalRssBytes,
    );
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.sample();
    this.report.execution.rssMeasurement = this.supported
      ? "linux-proc-process-tree-plus-runner"
      : "runner-only";
  }
}

function pendingBatchRecord(batch) {
  return {
    ordinal: batch.ordinal,
    name: batch.name,
    lane: batch.lane,
    serial: batch.lane !== "light",
    files: batch.files,
    state: "pending",
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    durationMs: null,
    peakRssBytes: null,
    exitCode: null,
    status: null,
    signal: null,
    error: null,
  };
}

async function executeBatch(batch, record, context) {
  const plural = batch.files.length === 1 ? "" : "s";
  process.stdout.write(
    `\n[vitest-batch] ${batch.ordinal}/${context.totalBatchCount} ${batch.name}`
      + ` ${batch.lane} (${batch.files.length} file${plural})\n`,
  );
  const started = performance.now();
  record.state = "running";
  record.startedAt = new Date().toISOString();
  let spawnError;
  const child = spawn(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      ...batch.files,
      "--maxWorkers=1",
      "--minWorkers=1",
      "--no-file-parallelism",
      "--reporter=dot",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: context.nodeOptions,
      },
      stdio: "inherit",
    },
  );
  if (child.pid) context.sampler.add(batch.name, child.pid);
  child.once("error", (error) => {
    spawnError = error;
  });
  const result = await new Promise((resolveResult) => {
    child.once("close", (exitCode, signal) => resolveResult({ exitCode, signal }));
  });
  const elapsedMs = Math.round(performance.now() - started);
  record.finishedAt = new Date().toISOString();
  record.elapsedMs = elapsedMs;
  record.durationMs = elapsedMs;
  record.peakRssBytes = context.sampler.remove(batch.name);
  record.exitCode = result.exitCode;
  record.status = result.exitCode;
  record.signal = result.signal;
  record.error = spawnError?.message ?? null;
  record.state = result.exitCode === 0 && !result.signal && !spawnError ? "passed" : "failed";
  process.stdout.write(
    `[vitest-batch] ${batch.name} ${record.state} ${elapsedMs}ms`
      + `${record.peakRssBytes === null
        ? ""
        : ` peak=${Math.round(record.peakRssBytes / 1_048_576)}MiB`}\n`,
  );
  return record.state === "passed";
}

async function executeLightBatches(batches, records, context, parallelism) {
  let nextIndex = 0;
  let failed = false;
  const workerCount = Math.min(parallelism, batches.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      const batch = batches[index];
      if (!batch) return;
      const passed = await executeBatch(batch, records.get(batch.name), context);
      if (!passed) failed = true;
    }
  }));
  return !failed;
}

function writeReport(report) {
  const reportPath = join(root, REPORT_PATH);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(reportPath, 0o600);
  process.stdout.write(`\n[vitest-batch] report: ${relative(root, reportPath)}\n`);
}

export async function main(arguments_ = process.argv.slice(2), environment = process.env) {
  const group = argumentValue(arguments_, "--group") ?? "all";
  const validGroups = new Set(["all", "unit", "pglite"]);
  if (!validGroups.has(group)) throw new Error(`Unknown Vitest group: ${group}`);
  const startBatch = positiveInteger(
    argumentValue(arguments_, "--start-batch") ?? "1",
    "start batch",
  );
  const explicitBudgetValue = argumentValue(arguments_, "--memory-budget-mb")
    ?? environment.VITEST_MEMORY_BUDGET_MB;
  const maxParallelValue = argumentValue(arguments_, "--max-parallel")
    ?? environment.VITEST_MAX_PARALLEL;
  const dryRun = arguments_.includes("--dry-run");
  const detectedMemory = detectAvailableMemoryBytes();
  const detectedAvailableMb = detectedMemory.effectiveAvailableBytes === undefined
    ? undefined
    : Math.floor(detectedMemory.effectiveAvailableBytes / 1_048_576);
  const resolvedMemoryPlan = memoryPlan({
    detectedAvailableMb,
    explicitBudgetMb: explicitBudgetValue,
    requestedMaxParallel: maxParallelValue,
  });
  const files = walk(root)
    .map((path) => {
      const relativePath = relative(root, path);
      return {
        path: relativePath,
        ...classifyTestFile(relativePath, readFileSync(path, "utf8")),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const allBatches = planBatches(files, group);
  if (allBatches.length === 0) throw new Error(`No Vitest files found for group: ${group}`);
  if (startBatch > allBatches.length) {
    throw new Error(
      `Start batch ${startBatch} exceeds ${group} batch count ${allBatches.length}`,
    );
  }
  const batches = allBatches.slice(startBatch - 1);
  const laneFileCounts = Object.fromEntries(["light", "heavy", "pglite"].map((lane) => [
    lane,
    files.filter((file) => file.lane === lane).length,
  ]));
  const dryRunSummary = {
    group,
    heapLimitMb: HEAP_LIMIT_MB,
    memory: resolvedMemoryPlan,
    laneFileCounts,
    totalBatchCount: allBatches.length,
    selectedBatchCount: batches.length,
    batches: batches.map(({ ordinal, name, lane, files: batchFiles }) => ({
      ordinal,
      name,
      lane,
      serial: lane !== "light",
      fileCount: batchFiles.length,
      files: batchFiles,
    })),
  };
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(dryRunSummary, null, 2)}\n`);
    return 0;
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const batchRecords = new Map(batches.map((batch) => [
    batch.name,
    pendingBatchRecord(batch),
  ]));
  const report = {
    schemaVersion: "vitest-batch-report/v2",
    generatedAt: startedAt,
    group,
    workerLimit: 1,
    fileParallelism: false,
    heapLimitMb: HEAP_LIMIT_MB,
    unitBatchSize: UNIT_BATCH_SIZE,
    laneFileCounts,
    startBatch,
    totalBatchCount: allBatches.length,
    selectedBatchCount: batches.length,
    memory: {
      ...resolvedMemoryPlan,
      hostAvailableBytes: detectedMemory.hostAvailableBytes ?? null,
      cgroupLimitBytes: detectedMemory.cgroupLimitBytes ?? null,
      cgroupUsageBytes: detectedMemory.cgroupUsageBytes ?? null,
      cgroupAvailableBytes: detectedMemory.cgroupAvailableBytes ?? null,
    },
    execution: {
      startedAt,
      finishedAt: null,
      elapsedMs: null,
      result: "running",
      peakRssBytes: 0,
      peakAggregateChildRssBytes: 0,
      rssMeasurement: "pending",
    },
    batches: batches.map((batch) => batchRecords.get(batch.name)),
  };
  const sampler = new RssSampler(report);
  sampler.start();
  const context = {
    nodeOptions: nodeOptionsWithHeapLimit(environment.NODE_OPTIONS),
    sampler,
    totalBatchCount: allBatches.length,
  };
  const lightBatches = batches.filter(({ lane }) => lane === "light");
  const serialBatches = batches.filter(({ lane }) => lane !== "light");
  let passed = await executeLightBatches(
    lightBatches,
    batchRecords,
    context,
    resolvedMemoryPlan.lightParallelism,
  );
  if (passed) {
    for (const batch of serialBatches) {
      passed = await executeBatch(batch, batchRecords.get(batch.name), context);
      if (!passed) break;
    }
  }
  for (const record of batchRecords.values()) {
    if (record.state === "pending") record.state = "skipped-after-failure";
  }
  sampler.stop();
  report.execution.finishedAt = new Date().toISOString();
  report.execution.elapsedMs = Math.round(performance.now() - started);
  report.execution.result = passed ? "passed" : "failed";
  writeReport(report);
  return passed ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`[vitest-batch] ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
