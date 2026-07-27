import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
  AI_QUALIFICATION_STATE_SCHEMA_VERSION,
  QualificationStateSchema,
  isTerminalQualificationStatus,
  type QualificationEvent,
  type QualificationRunStatus,
  type QualificationState,
  type QualificationStep,
} from "../server/qualification/contracts.js";
import type { CryptoModelReplayResult } from "../server/crypto/crypto-model-replay.js";
import { FINCAST_MODEL_ID } from "../server/worker/ai-contract.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_BUDGET_HOURS = 6;
const DEFAULT_DURATION_HOURS = 48;
const DEFAULT_KRONOS_PORT = 19_765;
const DEFAULT_FINCAST_PORT = 19_766;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBinary = path.join(repoRoot, "node_modules/.bin/tsx");

type WorkerMode = "docker-source" | "external";
type ReplayProfile = "base" | "kv_cache_v1";

export type QualificationArguments = {
  runRoot: string;
  runId: string;
  resume: boolean;
  dryRun: boolean;
  budgetHours: number;
  durationHours: number;
  endExclusive: string;
  symbols: string[];
  workerMode: WorkerMode;
  kronosPort: number;
  fincastPort: number;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  durationMs: number;
};

type ReplayConnection = {
  kronosUrl: string;
  kronosTokenFile: string;
  fincastUrl: string;
  fincastTokenFile: string;
};

type BenchmarkConnection = {
  url: string;
  tokenFile: string;
};

type WorkerController = {
  preflight(logFile: string, signal: AbortSignal): Promise<unknown>;
  activateReplayProfile(
    profile: ReplayProfile,
    logFile: string,
    signal: AbortSignal,
  ): Promise<ReplayConnection>;
  activateFincastBatch(
    batchSize: 4 | 8 | 16,
    logFile: string,
    signal: AbortSignal,
  ): Promise<BenchmarkConnection>;
  telemetry(signal: AbortSignal): Promise<QualificationState["telemetry"] | undefined>;
  close(): Promise<void>;
};

const stepDefinitions = [
  {
    id: "preflight",
    label: "P40 사전 점검",
    description: "Tesla P40, CUDA 6.1, 기존 워커 이미지와 모델 캐시를 확인합니다.",
    model: "system",
    variant: "docker-build=false",
    estimatedDurationMs: 2 * MINUTE_MS,
    outputFile: "preflight.json",
  },
  {
    id: "replay-base-btcusdt",
    label: "BTCUSDT 기준선 리플레이",
    description: "Kronos-Base와 FinCast가 동일한 48시간 입력을 처리하는 기준선을 측정합니다.",
    model: "comparison",
    variant: "kronos-base / fincast-batch-4",
    estimatedDurationMs: 110 * MINUTE_MS,
    outputFile: "replays/base-BTCUSDT.json",
  },
  {
    id: "replay-base-ethusdt",
    label: "ETHUSDT 기준선 리플레이",
    description: "두 번째 암호화폐에서 동일한 기준선과 모델 품질 지표를 수집합니다.",
    model: "comparison",
    variant: "kronos-base / fincast-batch-4",
    estimatedDurationMs: 110 * MINUTE_MS,
    outputFile: "replays/base-ETHUSDT.json",
  },
  {
    id: "replay-cache-btcusdt",
    label: "BTCUSDT KV 캐시 검증",
    description: "Kronos KV 캐시 후보의 속도와 기준선 대비 출력 동등성을 검증합니다.",
    model: "kronos-base",
    variant: "kv-cache-v1",
    estimatedDurationMs: 15 * MINUTE_MS,
    outputFile: "replays/kv-cache-v1-BTCUSDT.json",
  },
  {
    id: "replay-cache-ethusdt",
    label: "ETHUSDT KV 캐시 검증",
    description: "두 번째 암호화폐에서 KV 캐시 후보의 출력 동등성을 재검증합니다.",
    model: "kronos-base",
    variant: "kv-cache-v1",
    estimatedDurationMs: 15 * MINUTE_MS,
    outputFile: "replays/kv-cache-v1-ETHUSDT.json",
  },
  {
    id: "fincast-batch-4",
    label: "FinCast batch 4",
    description: "4개 시계열 묶음의 full forecast 지연시간과 출력 안정성을 측정합니다.",
    model: "fincast",
    variant: "microbatch-4",
    estimatedDurationMs: 5 * MINUTE_MS,
    outputFile: "benchmarks/fincast-batch-4.json",
  },
  {
    id: "fincast-batch-8",
    label: "FinCast batch 8",
    description: "8개 시계열 묶음의 full forecast 지연시간과 출력 안정성을 측정합니다.",
    model: "fincast",
    variant: "microbatch-8",
    estimatedDurationMs: 5 * MINUTE_MS,
    outputFile: "benchmarks/fincast-batch-8.json",
  },
  {
    id: "fincast-batch-16",
    label: "FinCast batch 16",
    description: "16개 시계열 묶음의 full forecast 지연시간과 출력 안정성을 측정합니다.",
    model: "fincast",
    variant: "microbatch-16",
    estimatedDurationMs: 5 * MINUTE_MS,
    outputFile: "benchmarks/fincast-batch-16.json",
  },
  {
    id: "finalize",
    label: "결과 판정 및 인계 자료 생성",
    description: "성능·동등성 게이트를 계산하고 보고서와 Codex 인계 프롬프트를 만듭니다.",
    model: "system",
    variant: "report-v1",
    estimatedDurationMs: MINUTE_MS,
    outputFile: "qualification-summary.json",
  },
] as const satisfies readonly Omit<QualificationStep, "order" | "status" | "logFile">[];

function exactUtcMinute(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(value)) {
    throw new Error(`${name} must be an exact UTC minute.`);
  }
  const parsed = Date.parse(value);
  const canonical = new Date(parsed).toISOString();
  if (!Number.isSafeInteger(parsed) || canonical !== (
    value.endsWith(":00Z") ? value.replace(/:00Z$/, ":00.000Z") : value
  )) {
    throw new Error(`${name} must be an exact UTC minute.`);
  }
  return canonical;
}

function boundedNumber(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)
    || parsed < minimum
    || parsed > maximum
    || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} in ${minimum}..=${maximum}.`);
  }
  return parsed;
}

function requiredArgument(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function generatedEndExclusive(now = Date.now()): string {
  return new Date(Math.floor(now / MINUTE_MS) * MINUTE_MS - 61 * MINUTE_MS).toISOString();
}

function generatedRunId(now = Date.now()): string {
  return `p40-${new Date(now).toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export function parseQualificationArguments(
  args: readonly string[],
  now = Date.now(),
): QualificationArguments {
  let runRoot = path.join(repoRoot, "data/ai-qualification");
  let runId = generatedRunId(now);
  let resume = false;
  let dryRun = false;
  let budgetHours = DEFAULT_BUDGET_HOURS;
  let durationHours = DEFAULT_DURATION_HOURS;
  let endExclusive = generatedEndExclusive(now);
  let symbols = ["BTCUSDT", "ETHUSDT"];
  let workerMode: WorkerMode = "docker-source";
  let kronosPort = DEFAULT_KRONOS_PORT;
  let fincastPort = DEFAULT_FINCAST_PORT;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--run-root") {
      runRoot = path.resolve(requiredArgument(args, index, argument));
      index += 1;
    } else if (argument === "--run-id") {
      runId = requiredArgument(args, index, argument);
      index += 1;
    } else if (argument === "--resume") {
      runId = requiredArgument(args, index, argument);
      resume = true;
      index += 1;
    } else if (argument === "--budget-hours") {
      budgetHours = boundedNumber(
        requiredArgument(args, index, argument),
        argument,
        0.25,
        24,
      );
      index += 1;
    } else if (argument === "--duration-hours") {
      durationHours = boundedNumber(
        requiredArgument(args, index, argument),
        argument,
        1,
        840,
        true,
      );
      index += 1;
    } else if (argument === "--end-exclusive") {
      endExclusive = exactUtcMinute(requiredArgument(args, index, argument), argument);
      index += 1;
    } else if (argument === "--symbols") {
      symbols = Array.from(new Set(
        requiredArgument(args, index, argument)
          .split(",")
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean),
      ));
      index += 1;
    } else if (argument === "--worker-mode") {
      const value = requiredArgument(args, index, argument);
      if (value !== "docker-source" && value !== "external") {
        throw new Error("--worker-mode must be docker-source or external.");
      }
      workerMode = value;
      index += 1;
    } else if (argument === "--kronos-port") {
      kronosPort = boundedNumber(
        requiredArgument(args, index, argument),
        argument,
        1_024,
        65_535,
        true,
      );
      index += 1;
    } else if (argument === "--fincast-port") {
      fincastPort = boundedNumber(
        requiredArgument(args, index, argument),
        argument,
        1_024,
        65_535,
        true,
      );
      index += 1;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
  }
  if (!path.isAbsolute(runRoot)) throw new Error("--run-root must be absolute.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("--run-id contains unsupported characters.");
  }
  if (!symbols.length
    || symbols.length > 10
    || symbols.some((symbol) => !/^[A-Z0-9]{2,32}USDT$/.test(symbol))) {
    throw new Error("--symbols must contain 1..10 Binance USDT contracts.");
  }
  if (kronosPort === fincastPort) throw new Error("Kronos and FinCast ports must differ.");
  return {
    runRoot,
    runId,
    resume,
    dryRun,
    budgetHours,
    durationHours,
    endExclusive,
    symbols,
    workerMode,
    kronosPort,
    fincastPort,
  };
}

export function qualificationSteps(symbols: readonly string[]): QualificationStep[] {
  const preflight = stepDefinitions[0];
  const baseTemplate = stepDefinitions[1];
  const cacheTemplate = stepDefinitions[3];
  const selected: Array<Omit<QualificationStep, "order" | "status" | "logFile">> = [
    preflight,
    ...symbols.map((symbol) => ({
      ...baseTemplate,
      id: `replay-base-${symbol.toLowerCase()}`,
      label: `${symbol} 기준선 리플레이`,
      description: `Kronos-Base와 FinCast가 동일한 ${symbol} 입력을 처리하는 기준선을 측정합니다.`,
      outputFile: `replays/base-${symbol}.json`,
    })),
    ...symbols.map((symbol) => ({
      ...cacheTemplate,
      id: `replay-cache-${symbol.toLowerCase()}`,
      label: `${symbol} KV 캐시 검증`,
      description: `${symbol}에서 Kronos KV 캐시 후보의 속도와 기준선 대비 출력 동등성을 검증합니다.`,
      outputFile: `replays/kv-cache-v1-${symbol}.json`,
    })),
    ...stepDefinitions.slice(5),
  ];
  return selected
    .map((step, index) => ({
      ...step,
      order: index + 1,
      status: "pending",
      logFile: `logs/${step.id}.log`,
    }));
}

function nowIso(): string {
  return new Date().toISOString();
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, filePath);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function elapsedState(state: QualificationState, now = Date.now()): QualificationState["progress"] {
  const startedAt = state.startedAt ? Date.parse(state.startedAt) : now;
  const elapsedMs = Math.max(0, now - startedAt);
  const finished = new Set(["completed", "failed", "skipped", "cancelled"]);
  const totalWeight = state.steps.reduce((sum, step) => sum + step.estimatedDurationMs, 0);
  let completedWeight = 0;
  let activeStepPercent: number | null = null;
  for (const step of state.steps) {
    if (finished.has(step.status)) {
      completedWeight += step.estimatedDurationMs;
    } else if (step.status === "running" && step.startedAt) {
      const fraction = Math.min(
        0.98,
        Math.max(0, (now - Date.parse(step.startedAt)) / step.estimatedDurationMs),
      );
      activeStepPercent = fraction * 100;
      completedWeight += step.estimatedDurationMs * fraction;
    }
  }
  return {
    completedSteps: state.steps.filter((step) => step.status === "completed").length,
    failedSteps: state.steps.filter((step) => step.status === "failed").length,
    skippedSteps: state.steps.filter((step) => step.status === "skipped").length,
    totalSteps: state.steps.length,
    percent: Math.min(100, Math.max(0, totalWeight ? completedWeight / totalWeight * 100 : 0)),
    activeStepPercent,
    elapsedMs,
    remainingBudgetMs: Math.max(0, Date.parse(state.deadlineAt) - now),
  };
}

class QualificationRecorder {
  readonly runDirectory: string;
  state: QualificationState;
  private sequence = 0;
  private writeQueue = Promise.resolve();

  private constructor(
    readonly arguments_: QualificationArguments,
    state: QualificationState,
    sequence: number,
  ) {
    this.runDirectory = path.join(arguments_.runRoot, state.runId);
    this.state = state;
    this.sequence = sequence;
  }

  static async create(arguments_: QualificationArguments): Promise<QualificationRecorder> {
    const createdAt = nowIso();
    const state: QualificationState = {
      schemaVersion: AI_QUALIFICATION_STATE_SCHEMA_VERSION,
      runId: arguments_.runId,
      status: "planned",
      createdAt,
      updatedAt: createdAt,
      deadlineAt: new Date(Date.now() + arguments_.budgetHours * HOUR_MS).toISOString(),
      activeStepId: null,
      config: {
        budgetHours: arguments_.budgetHours,
        durationHours: arguments_.durationHours,
        endExclusive: arguments_.endExclusive,
        symbols: arguments_.symbols,
        gpu: "Tesla P40",
        cudaCapability: "6.1",
        workerMode: arguments_.workerMode,
        dockerBuild: false,
      },
      progress: {
        completedSteps: 0,
        failedSteps: 0,
        skippedSteps: 0,
        totalSteps: qualificationSteps(arguments_.symbols).length,
        percent: 0,
        activeStepPercent: null,
        elapsedMs: 0,
        remainingBudgetMs: arguments_.budgetHours * HOUR_MS,
      },
      steps: qualificationSteps(arguments_.symbols),
      artifacts: {
        summaryJson: "qualification-summary.json",
        reportMarkdown: "qualification-report.md",
        handoffPrompt: "codex-handoff-prompt.md",
      },
    };
    QualificationStateSchema.parse(state);
    await mkdir(arguments_.runRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.join(arguments_.runRoot, arguments_.runId), { mode: 0o700 });
    await Promise.all([
      mkdir(path.join(arguments_.runRoot, arguments_.runId, "logs"), { recursive: true }),
      mkdir(path.join(arguments_.runRoot, arguments_.runId, "replays"), { recursive: true }),
      mkdir(path.join(arguments_.runRoot, arguments_.runId, "benchmarks"), { recursive: true }),
    ]);
    const recorder = new QualificationRecorder(arguments_, state, 0);
    await recorder.persist();
    await atomicWrite(
      path.join(arguments_.runRoot, "latest.json"),
      `${JSON.stringify({ runId: arguments_.runId })}\n`,
    );
    await recorder.event("run_created", "Tesla P40 6시간 자동 검증 실행을 생성했습니다.");
    return recorder;
  }

  static async resume(arguments_: QualificationArguments): Promise<QualificationRecorder> {
    const runDirectory = path.join(arguments_.runRoot, arguments_.runId);
    const state = QualificationStateSchema.parse(
      JSON.parse(await readFile(path.join(runDirectory, "state.json"), "utf8")),
    );
    if (isTerminalQualificationStatus(state.status)) {
      throw new Error(`Run ${state.runId} is already terminal (${state.status}).`);
    }
    const rawEvents = await readFile(path.join(runDirectory, "events.jsonl"), "utf8").catch(() => "");
    const sequence = rawEvents.split("\n").filter(Boolean).length;
    state.status = "planned";
    state.activeStepId = null;
    state.finishedAt = undefined;
    for (const step of state.steps) {
      if (step.status === "running" || step.status === "cancelled") {
        step.status = "pending";
        step.startedAt = undefined;
        step.finishedAt = undefined;
        step.durationMs = undefined;
        step.error = undefined;
      }
    }
    const resumedArguments: QualificationArguments = {
      ...arguments_,
      budgetHours: state.config.budgetHours,
      durationHours: state.config.durationHours,
      endExclusive: state.config.endExclusive,
      symbols: state.config.symbols,
      workerMode: state.config.workerMode,
    };
    const recorder = new QualificationRecorder(resumedArguments, state, sequence);
    await recorder.persist();
    await atomicWrite(
      path.join(arguments_.runRoot, "latest.json"),
      `${JSON.stringify({ runId: arguments_.runId })}\n`,
    );
    await recorder.event("warning", "중단된 실행을 재개했습니다. 완료된 단계는 다시 실행하지 않습니다.");
    return recorder;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }

  persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    snapshot.updatedAt = nowIso();
    snapshot.progress = elapsedState(snapshot);
    this.state.updatedAt = snapshot.updatedAt;
    this.state.progress = snapshot.progress;
    QualificationStateSchema.parse(snapshot);
    return this.enqueue(() => atomicWrite(
      path.join(this.runDirectory, "state.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    ));
  }

  async event(
    type: QualificationEvent["type"],
    message: string,
    stepId?: string,
  ): Promise<void> {
    const event: QualificationEvent = {
      schemaVersion: AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
      sequence: ++this.sequence,
      runId: this.state.runId,
      at: nowIso(),
      type,
      message: message.slice(0, 2_000),
      ...(stepId ? { stepId } : {}),
      status: this.state.status,
      progressPercent: this.state.progress.percent,
    };
    await this.enqueue(() => appendFile(
      path.join(this.runDirectory, "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ));
  }

  async start(): Promise<void> {
    this.state.status = "running";
    this.state.startedAt ??= nowIso();
    await this.persist();
    await this.event("run_started", "자동 검증 실행을 시작했습니다.");
  }

  step(id: string): QualificationStep {
    const step = this.state.steps.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`Unknown qualification step: ${id}`);
    return step;
  }

  async startStep(id: string): Promise<void> {
    const step = this.step(id);
    step.status = "running";
    step.startedAt = nowIso();
    step.finishedAt = undefined;
    step.durationMs = undefined;
    step.error = undefined;
    this.state.activeStepId = id;
    await this.persist();
    await this.event("step_started", `${step.label} 단계를 시작했습니다.`, id);
  }

  async completeStep(id: string, summary?: string): Promise<void> {
    const step = this.step(id);
    step.status = "completed";
    step.finishedAt = nowIso();
    step.durationMs = Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt ?? step.finishedAt));
    step.summary = summary?.slice(0, 1_000);
    this.state.activeStepId = null;
    await this.persist();
    await this.event("step_completed", summary || `${step.label} 단계를 완료했습니다.`, id);
  }

  async failStep(id: string, error: unknown): Promise<void> {
    const step = this.step(id);
    const message = error instanceof Error ? error.message : String(error);
    step.status = "failed";
    step.finishedAt = nowIso();
    step.durationMs = Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt ?? step.finishedAt));
    step.error = message.slice(0, 2_000);
    this.state.activeStepId = null;
    await this.persist();
    await this.event("step_failed", `${step.label}: ${message}`, id);
  }

  async skipPending(message: string): Promise<void> {
    for (const step of this.state.steps) {
      if (step.status !== "pending") continue;
      step.status = "skipped";
      step.finishedAt = nowIso();
      step.summary = message.slice(0, 1_000);
      await this.event("step_skipped", `${step.label}: ${message}`, step.id);
    }
    await this.persist();
  }

  async heartbeat(telemetry?: QualificationState["telemetry"]): Promise<void> {
    if (telemetry) this.state.telemetry = telemetry;
    await this.persist();
  }

  async finish(status: QualificationRunStatus, message: string): Promise<void> {
    this.state.status = status;
    this.state.activeStepId = null;
    this.state.finishedAt = nowIso();
    await this.persist();
    await this.event("run_completed", message);
    await this.persist();
  }

  async log(stepId: string, text: string): Promise<void> {
    const step = this.step(stepId);
    await appendFile(
      path.join(this.runDirectory, step.logFile),
      text.endsWith("\n") ? text : `${text}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

function safeCommandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].map((value) => (
    /\s/.test(value) ? JSON.stringify(value) : value
  )).join(" ");
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs: number;
    signal: AbortSignal;
    onOutput?: (text: string) => void | Promise<void>;
  },
): Promise<CommandResult> {
  if (options.signal.aborted) throw options.signal.reason ?? new Error("Command cancelled.");
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  let outputQueue = Promise.resolve();
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (signal: NodeJS.Signals) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  const onAbort = () => {
    terminate("SIGTERM");
    killTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
    killTimer.unref();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    if (!settled) onAbort();
  }, options.timeoutMs);
  timeout.unref();
  const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (target === "stdout") stdout = (stdout + text).slice(-16 * 1024 * 1024);
    else stderr = (stderr + text).slice(-16 * 1024 * 1024);
    if (options.onOutput) {
      outputQueue = outputQueue.then(() => options.onOutput!(text)).then(() => undefined);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    await outputQueue;
    settled = true;
    if (options.signal.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Command cancelled.");
    }
    if (code !== 0) {
      const detail = stderr.trim().split("\n").at(-1) || stdout.trim().split("\n").at(-1);
      throw new Error(
        `${path.basename(command)} exited with ${code ?? signal ?? "unknown"}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      );
    }
    return { stdout, stderr, durationMs: Date.now() - startedAt };
  } finally {
    settled = true;
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    options.signal.removeEventListener("abort", onAbort);
  }
}

function environment(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sourceMount(source: string, target: string): string[] {
  if (path.isAbsolute(source)) {
    return ["--mount", `type=bind,source=${source},target=${target},readonly`];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(source)) {
    throw new Error(`Invalid Docker volume source: ${source}`);
  }
  return ["--mount", `type=volume,source=${source},target=${target},readonly`];
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Cancelled."));
      return;
    }
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

class DockerSourceWorkerController implements WorkerController {
  private readonly prefix: string;
  private readonly kronosImage = environment(
    "AI_WORKER_IMAGE",
    "toss-portfolio-lens-ai-worker:local",
  );
  private readonly fincastImage = environment(
    "AI_FINCAST_WORKER_IMAGE",
    "toss-portfolio-lens-fincast-worker:local",
  );
  private readonly kronosCache = environment(
    "AI_MODEL_CACHE_SOURCE",
    `${path.basename(repoRoot)}_ai_model_cache`,
  );
  private readonly fincastCache = environment(
    "AI_FINCAST_MODEL_CACHE_SOURCE",
    this.kronosCache,
  );
  private authDirectory?: string;
  private kronosTokenFile?: string;
  private fincastTokenFile?: string;
  private kronosProfile?: ReplayProfile;
  private fincastBatch?: 4 | 8 | 16;

  constructor(
    private readonly arguments_: QualificationArguments,
    private readonly command: (
      command: string,
      args: readonly string[],
      logFile: string,
      signal: AbortSignal,
      timeoutMs?: number,
    ) => Promise<CommandResult>,
  ) {
    this.prefix = `tpl-aiq-${arguments_.runId}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 48);
  }

  private get kronosName(): string {
    return `${this.prefix}-kronos`;
  }

  private get fincastName(): string {
    return `${this.prefix}-fincast`;
  }

  private async tokens(): Promise<{ kronos: string; fincast: string }> {
    if (this.kronosTokenFile && this.fincastTokenFile) {
      return { kronos: this.kronosTokenFile, fincast: this.fincastTokenFile };
    }
    this.authDirectory = await mkdtemp(path.join(tmpdir(), "tpl-aiq-auth-"));
    this.kronosTokenFile = path.join(this.authDirectory, "kronos-token");
    this.fincastTokenFile = path.join(this.authDirectory, "fincast-token");
    await Promise.all([
      writeFile(this.kronosTokenFile, randomBytes(32).toString("base64url"), { mode: 0o444 }),
      writeFile(this.fincastTokenFile, randomBytes(32).toString("base64url"), { mode: 0o444 }),
    ]);
    return { kronos: this.kronosTokenFile, fincast: this.fincastTokenFile };
  }

  private remainingTimeout(maximum = 15 * MINUTE_MS): number {
    return Math.max(
      1_000,
      Math.min(maximum, Date.parse(this.arguments_.endExclusive) + 365 * 24 * HOUR_MS),
    );
  }

  private async stop(name: string, logFile: string): Promise<void> {
    const controller = new AbortController();
    await this.command(
      "docker",
      ["stop", "--time", "10", name],
      logFile,
      controller.signal,
      30_000,
    ).catch(() => undefined);
  }

  private async start(
    lane: "kronos" | "fincast",
    variant: ReplayProfile | 4 | 8 | 16,
    logFile: string,
    signal: AbortSignal,
  ): Promise<void> {
    const tokens = await this.tokens();
    const isKronos = lane === "kronos";
    const name = isKronos ? this.kronosName : this.fincastName;
    await this.stop(name, logFile);
    const hostPort = isKronos ? this.arguments_.kronosPort : this.arguments_.fincastPort;
    const containerPort = isKronos ? 8765 : 8766;
    const tokenFile = isKronos ? tokens.kronos : tokens.fincast;
    const tokenTarget = isKronos ? "/app/ai-auth/token" : "/app/fincast-auth/token";
    const image = isKronos ? this.kronosImage : this.fincastImage;
    const cache = isKronos ? this.kronosCache : this.fincastCache;
    const environmentArguments = [
      "-e", "PYTHONPATH=/app/src",
      "-e", "AI_WEBSOCKET_HOST=0.0.0.0",
      "-e", `AI_WEBSOCKET_PORT=${containerPort}`,
      "-e", "AI_WEBSOCKET_PATH=/ws/scalping-ai/v1",
      "-e", `AI_WEBSOCKET_AUTH_TOKEN_FILE=${tokenTarget}`,
      "-e", "AI_WEBSOCKET_GENERATE_AUTH_TOKEN=false",
      "-e", "AI_WEBSOCKET_MAX_IN_FLIGHT=1",
      "-e", "AI_DEVICE=cuda",
      "-e", "AI_ALLOW_CPU_FALLBACK=false",
      "-e", "AI_EXPECTED_CUDA_CAPABILITY=6.1",
      "-e", "AI_EXPECTED_CUDA_DEVICE_NAME=Tesla P40",
      "-e", "AI_MODEL_CACHE_DIR=/models",
      "-e", `AI_MODEL_LANE=${isKronos ? "kronos_base" : "fincast"}`,
      "-e", "AI_MAX_EVALUATION_ORIGINS=10000",
      "-e", "AI_MAX_REQUEST_BYTES=67108864",
      "-e", "AI_MAX_RESPONSE_BYTES=134217728",
      "-e", `AI_MICROBATCH_SIZE=${isKronos ? 4 : variant}`,
      ...(isKronos
        ? ["-e", `AI_KRONOS_KV_CACHE_ENABLED=${variant === "kv_cache_v1" ? "true" : "false"}`]
        : [
          "-e", "AI_FINCAST_CONTEXT_BARS=512",
          "-e", "AI_MIN_CONTEXT_BARS=512",
          "-e", "AI_MAX_CONTEXT_BARS=512",
          "-e", "AI_FINCAST_MIN_VRAM_HEADROOM_MIB=2048",
        ]),
      "-e", "HF_HUB_OFFLINE=1",
      "-e", "TRANSFORMERS_OFFLINE=1",
      "-e", "HF_HUB_DISABLE_TELEMETRY=1",
      "-e", "CUDA_MODULE_LOADING=LAZY",
      "-e", "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
    ];
    await this.command("docker", [
      "run",
      "--detach",
      "--rm",
      "--name", name,
      "--gpus", "device=0",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--tmpfs", "/tmp:size=256m,mode=1777",
      "--shm-size", "2g",
      "--publish", `127.0.0.1:${hostPort}:${containerPort}`,
      ...environmentArguments,
      ...sourceMount(path.join(repoRoot, "worker/ai/src"), "/app/src"),
      ...sourceMount(cache, "/models"),
      "--mount", `type=bind,source=${tokenFile},target=${tokenTarget},readonly`,
      image,
      "serve",
    ], logFile, signal, this.remainingTimeout());

    const readinessDeadline = Date.now() + Math.min(
      10 * MINUTE_MS,
      Math.max(MINUTE_MS, this.remainingTimeout()),
    );
    let lastError: unknown;
    while (Date.now() < readinessDeadline) {
      try {
        await this.command(
          "docker",
          ["exec", name, "/app/.venv/bin/portfolio-ai-worker", "healthcheck"],
          logFile,
          signal,
          10_000,
        );
        await this.command(
          "docker",
          ["exec", name, "/app/.venv/bin/portfolio-ai-worker", "preflight-json"],
          logFile,
          signal,
          10 * MINUTE_MS,
        );
        return;
      } catch (error) {
        lastError = error;
        await sleep(2_000, signal);
      }
    }
    throw new Error(
      `${lane} worker did not become model-ready: ${
        lastError instanceof Error ? lastError.message : "unknown error"
      }`,
    );
  }

  async preflight(logFile: string, signal: AbortSignal): Promise<unknown> {
    await stat(path.join(repoRoot, "worker/ai/src/portfolio_ai_worker"));
    const version = await this.command(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      logFile,
      signal,
      30_000,
    );
    await Promise.all([
      this.command(
        "docker",
        ["image", "inspect", this.kronosImage, "--format", "{{.Id}}"],
        logFile,
        signal,
        30_000,
      ),
      this.command(
        "docker",
        ["image", "inspect", this.fincastImage, "--format", "{{.Id}}"],
        logFile,
        signal,
        30_000,
      ),
    ]);
    for (const source of new Set([this.kronosCache, this.fincastCache])) {
      if (path.isAbsolute(source)) await stat(source);
      else {
        await this.command(
          "docker",
          ["volume", "inspect", source, "--format", "{{.Name}}"],
          logFile,
          signal,
          30_000,
        );
      }
    }
    const gpu = await this.command(
      "nvidia-smi",
      ["--query-gpu=name,compute_cap,memory.total", "--format=csv,noheader,nounits", "--id=0"],
      logFile,
      signal,
      30_000,
    );
    const [name, capability, memoryTotalMiB] = gpu.stdout.trim().split(",").map((item) => item.trim());
    if (name !== "Tesla P40" || capability !== "6.1") {
      throw new Error(`Expected Tesla P40 compute capability 6.1, observed ${name} / ${capability}.`);
    }
    return {
      dockerServerVersion: version.stdout.trim(),
      gpu: {
        name,
        cudaCapability: capability,
        memoryTotalMiB: Number(memoryTotalMiB),
      },
      images: {
        kronos: this.kronosImage,
        fincast: this.fincastImage,
      },
      sourceMode: "bind-mounted /app/src; no Docker build",
      modelCaches: [this.kronosCache, this.fincastCache],
    };
  }

  async activateReplayProfile(
    profile: ReplayProfile,
    logFile: string,
    signal: AbortSignal,
  ): Promise<ReplayConnection> {
    if (this.fincastBatch !== 4) {
      await this.start("fincast", 4, logFile, signal);
      this.fincastBatch = 4;
    }
    if (this.kronosProfile !== profile) {
      await this.start("kronos", profile, logFile, signal);
      this.kronosProfile = profile;
    }
    const tokens = await this.tokens();
    return {
      kronosUrl: `ws://127.0.0.1:${this.arguments_.kronosPort}/ws/scalping-ai/v1`,
      kronosTokenFile: tokens.kronos,
      fincastUrl: `ws://127.0.0.1:${this.arguments_.fincastPort}/ws/scalping-ai/v1`,
      fincastTokenFile: tokens.fincast,
    };
  }

  async activateFincastBatch(
    batchSize: 4 | 8 | 16,
    logFile: string,
    signal: AbortSignal,
  ): Promise<BenchmarkConnection> {
    if (this.kronosProfile) {
      await this.stop(this.kronosName, logFile);
      this.kronosProfile = undefined;
    }
    if (this.fincastBatch !== batchSize) {
      await this.start("fincast", batchSize, logFile, signal);
      this.fincastBatch = batchSize;
    }
    const tokens = await this.tokens();
    return {
      url: `ws://127.0.0.1:${this.arguments_.fincastPort}/ws/scalping-ai/v1`,
      tokenFile: tokens.fincast,
    };
  }

  async telemetry(signal: AbortSignal): Promise<QualificationState["telemetry"] | undefined> {
    const result = await runCommand("nvidia-smi", [
      "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits",
      "--id=0",
    ], { timeoutMs: 10_000, signal });
    const [gpu, used, total, temperature] = result.stdout
      .trim()
      .split(",")
      .map((item) => Number(item.trim()));
    if ([gpu, used, total, temperature].some((value) => !Number.isFinite(value))) return undefined;
    return {
      polledAt: nowIso(),
      gpuUtilizationPercent: gpu!,
      memoryUsedMiB: used!,
      memoryTotalMiB: total!,
      temperatureC: temperature!,
    };
  }

  async close(): Promise<void> {
    const logFile = "logs/worker-cleanup.log";
    await Promise.all([
      this.stop(this.kronosName, logFile),
      this.stop(this.fincastName, logFile),
    ]);
    if (this.authDirectory) {
      await rm(this.authDirectory, { recursive: true });
      this.authDirectory = undefined;
      this.kronosTokenFile = undefined;
      this.fincastTokenFile = undefined;
    }
  }
}

class ExternalWorkerController implements WorkerController {
  async preflight(_logFile: string, _signal: AbortSignal): Promise<unknown> {
    return {
      mode: "external",
      warning: "외부 endpoint의 프로필과 microbatch 설정은 운영자가 사전에 맞춰야 합니다.",
    };
  }

  async activateReplayProfile(profile: ReplayProfile): Promise<ReplayConnection> {
    const prefix = profile === "base"
      ? "AI_QUALIFICATION_KRONOS_BASE"
      : "AI_QUALIFICATION_KRONOS_CACHE";
    return {
      kronosUrl: environment(`${prefix}_URL`),
      kronosTokenFile: environment(`${prefix}_AUTH_TOKEN_FILE`),
      fincastUrl: environment("AI_QUALIFICATION_FINCAST_URL"),
      fincastTokenFile: environment("AI_QUALIFICATION_FINCAST_AUTH_TOKEN_FILE"),
    };
  }

  async activateFincastBatch(batchSize: 4 | 8 | 16): Promise<BenchmarkConnection> {
    return {
      url: environment(`AI_QUALIFICATION_FINCAST_BATCH_${batchSize}_URL`),
      tokenFile: environment(`AI_QUALIFICATION_FINCAST_BATCH_${batchSize}_AUTH_TOKEN_FILE`),
    };
  }

  async telemetry(signal: AbortSignal): Promise<QualificationState["telemetry"] | undefined> {
    const result = await runCommand("nvidia-smi", [
      "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits",
      "--id=0",
    ], { timeoutMs: 10_000, signal });
    const [gpu, used, total, temperature] = result.stdout
      .trim()
      .split(",")
      .map((item) => Number(item.trim()));
    if ([gpu, used, total, temperature].some((value) => !Number.isFinite(value))) return undefined;
    return {
      polledAt: nowIso(),
      gpuUtilizationPercent: gpu!,
      memoryUsedMiB: used!,
      memoryTotalMiB: total!,
      temperatureC: temperature!,
    };
  }

  async close(): Promise<void> {}
}

function replayEnvironment(connection: ReplayConnection, deadlineMs: number): NodeJS.ProcessEnv {
  return {
    AI_KRONOS_COMPUTE_URL: connection.kronosUrl,
    AI_KRONOS_COMPUTE_AUTH_TOKEN_FILE: connection.kronosTokenFile,
    AI_KRONOS_COMPUTE_MAX_IN_FLIGHT: "1",
    AI_FINCAST_COMPUTE_URL: connection.fincastUrl,
    AI_FINCAST_COMPUTE_AUTH_TOKEN_FILE: connection.fincastTokenFile,
    AI_FINCAST_COMPUTE_MAX_IN_FLIGHT: "1",
    AI_COMPUTE_ALLOW_INSECURE_PRIVATE_WS: "false",
    AI_COMPUTE_TIMEOUT_MS: String(Math.min(3_600_000, Math.max(1_000, deadlineMs))),
    AI_COMPUTE_CONNECT_TIMEOUT_MS: "10000",
    AI_MAX_REQUEST_BYTES: "67108864",
    AI_MAX_RESPONSE_BYTES: "134217728",
  };
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Command did not emit JSON output.");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function maxMetricDelta(left: CryptoModelReplayResult, right: CryptoModelReplayResult): number {
  const leftMetrics = left.lanes.kronos_base.metrics;
  const rightMetrics = right.lanes.kronos_base.metrics;
  const values: number[] = [];
  for (let index = 0; index < leftMetrics.length; index += 1) {
    const a = leftMetrics[index];
    const b = rightMetrics[index];
    if (!a || !b || a.horizonMinutes !== b.horizonMinutes) return Number.POSITIVE_INFINITY;
    for (const key of ["meanPinballLoss", "medianReturnMae", "directionAccuracy"] as const) {
      const av = a[key];
      const bv = b[key];
      if (av === null || bv === null) {
        if (av !== bv) return Number.POSITIVE_INFINITY;
      } else {
        values.push(Math.abs(av - bv));
      }
    }
    if (a.quantiles.length !== b.quantiles.length) return Number.POSITIVE_INFINITY;
    for (let quantileIndex = 0; quantileIndex < a.quantiles.length; quantileIndex += 1) {
      const aq = a.quantiles[quantileIndex];
      const bq = b.quantiles[quantileIndex];
      if (!aq || !bq || aq.quantile !== bq.quantile) return Number.POSITIVE_INFINITY;
      values.push(
        Math.abs(aq.pinballLoss - bq.pinballLoss),
        Math.abs(aq.observedCoverage - bq.observedCoverage),
        Math.abs(aq.calibrationError - bq.calibrationError),
      );
    }
  }
  return values.length ? Math.max(...values) : 0;
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function recoverCompletedOutput(
  recorder: QualificationRecorder,
  step: QualificationStep,
): Promise<string | undefined> {
  if (!step.outputFile) return undefined;
  const value = await readJsonIfPresent(path.join(recorder.runDirectory, step.outputFile));
  if (!value || typeof value !== "object") return undefined;
  if (step.id === "preflight") return "기존 사전 점검 결과를 복구했습니다.";
  if (step.id.startsWith("replay-")) {
    const replay = value as CryptoModelReplayResult;
    if (replay.schemaVersion !== "crypto-model-comparison-replay/v1"
      || replay.comparison?.outcome !== "review_required") return undefined;
    return `기존 ${replay.symbol} 리플레이 결과를 복구했습니다.`;
  }
  if (step.id.startsWith("fincast-")) {
    const benchmark = value as {
      schema_version?: string;
      stable_output_digest?: boolean;
      model?: { model_id?: string };
    };
    if (benchmark.schema_version !== "scalping-ai-speed-benchmark/v1"
      || benchmark.stable_output_digest !== true
      || benchmark.model?.model_id !== FINCAST_MODEL_ID) return undefined;
    return "기존 FinCast benchmark 결과를 복구했습니다.";
  }
  if (step.id === "finalize"
    && (value as { schemaVersion?: string }).schemaVersion === "ai-p40-qualification-summary/v1") {
    return "기존 결과 보고서를 복구했습니다.";
  }
  return undefined;
}

async function buildReports(recorder: QualificationRecorder): Promise<string> {
  const replays: Record<string, CryptoModelReplayResult> = {};
  const benchmarks: Record<string, unknown> = {};
  for (const step of recorder.state.steps) {
    if (step.status !== "completed" || !step.outputFile) continue;
    const value = await readJsonIfPresent(path.join(recorder.runDirectory, step.outputFile));
    if (!value) continue;
    if (step.id.startsWith("replay-")) replays[step.id] = value as CryptoModelReplayResult;
    if (step.id.startsWith("fincast-")) benchmarks[step.id] = value;
  }

  const parity = recorder.state.config.symbols.map((symbol) => {
    const suffix = symbol.toLowerCase();
    const base = replays[`replay-base-${suffix}`];
    const cache = replays[`replay-cache-${suffix}`];
    if (!base || !cache) {
      return { symbol, available: false, passed: false, reason: "missing replay evidence" };
    }
    const digestMatch = base.inputDigest === cache.inputDigest
      && base.lanes.kronos_base.recordDigest === cache.lanes.kronos_base.recordDigest
      && base.lanes.kronos_base.predictionDigest
        === cache.lanes.kronos_base.predictionDigest
      && base.lanes.kronos_base.effectiveContextDigest
        === cache.lanes.kronos_base.effectiveContextDigest;
    const metricDelta = maxMetricDelta(base, cache);
    const baseLatencyMs = base.lanes.kronos_base.latencyMs;
    const cacheLatencyMs = cache.lanes.kronos_base.latencyMs;
    return {
      symbol,
      available: true,
      passed: digestMatch && metricDelta <= 1e-12,
      digestMatch,
      maximumMetricDelta: metricDelta,
      baseLatencyMs,
      cacheLatencyMs,
      speedup: cacheLatencyMs > 0 ? baseLatencyMs / cacheLatencyMs : null,
      comparable: base.comparison.outcome === "review_required"
        && cache.comparison.outcome === "review_required",
    };
  });
  const replayComparable = Object.values(replays).every(
    (replay) => replay.comparison.outcome === "review_required",
  ) && Object.keys(replays).length === recorder.state.config.symbols.length * 2;
  const parityPassed = parity.every((item) => item.passed);
  const fincastEntries = Object.entries(benchmarks).map(([id, value]) => {
    const benchmark = value as {
      elapsed_ms?: { median?: number; p95?: number };
      stable_output_digest?: boolean;
      model?: { model_id?: string; dtype?: string; device?: string };
    };
    return {
      id,
      medianMs: benchmark.elapsed_ms?.median ?? null,
      p95Ms: benchmark.elapsed_ms?.p95 ?? null,
      stableOutput: benchmark.stable_output_digest === true,
      model: benchmark.model,
    };
  });
  const fastestFincast = [...fincastEntries]
    .filter((entry) => typeof entry.medianMs === "number")
    .sort((left, right) => left.medianMs! - right.medianMs!)[0] ?? null;
  const summary = {
    schemaVersion: "ai-p40-qualification-summary/v1",
    runId: recorder.state.runId,
    generatedAt: nowIso(),
    statusAtReport: recorder.state.status,
    config: recorder.state.config,
    progress: recorder.state.progress,
    gates: {
      replayComparable,
      kronosKvCacheParity: parityPassed,
      fincastStable: fincastEntries.length === 3
        && fincastEntries.every((entry) => entry.stableOutput),
      withinBudget: recorder.state.progress.remainingBudgetMs > 0,
    },
    kronosKvCache: parity,
    fincast: {
      candidates: fincastEntries,
      fastest: fastestFincast,
    },
    recommendation: {
      kronosKvCache: replayComparable && parityPassed
        ? "48시간 BTC/ETH screening을 통과했습니다. 5주 최종 검증 후보로 유지합니다."
        : "승격하지 말고 실패 증거와 출력 차이를 먼저 조사합니다.",
      fincastMicrobatch: fastestFincast
        ? `${fastestFincast.id}가 이 screening의 최저 median 후보입니다. VRAM headroom과 5주 검증을 거쳐 확정합니다.`
        : "완료된 FinCast benchmark가 없어 결론을 보류합니다.",
      scope: "이 결과는 48시간 screening이며 모델/지표 성과의 최종 채택 근거가 아닙니다.",
    },
    steps: recorder.state.steps,
  };
  await writeJson(
    path.join(recorder.runDirectory, recorder.state.artifacts.summaryJson),
    summary,
  );
  const report = [
    `# Tesla P40 AI 모델 자동 검증 — ${recorder.state.runId}`,
    "",
    `- 생성 시각: ${summary.generatedAt}`,
    `- 입력 범위: ${recorder.state.config.durationHours}시간, 종료(exclusive) ${recorder.state.config.endExclusive}`,
    `- 심볼: ${recorder.state.config.symbols.join(", ")}`,
    `- 예산: ${recorder.state.config.budgetHours}시간`,
    "- Docker build: 실행하지 않음 (기존 이미지 + `/app/src` 읽기 전용 bind mount)",
    "",
    "## 판정",
    "",
    `- 리플레이 비교 가능: ${summary.gates.replayComparable ? "통과" : "실패"}`,
    `- Kronos KV 캐시 출력 동등성: ${summary.gates.kronosKvCacheParity ? "통과" : "실패"}`,
    `- FinCast 반복 출력 안정성: ${summary.gates.fincastStable ? "통과" : "실패"}`,
    `- 6시간 예산 준수: ${summary.gates.withinBudget ? "통과" : "실패"}`,
    "",
    "## Kronos KV 캐시",
    "",
    ...parity.map((item) => (
      `- ${item.symbol}: ${item.passed ? "동등" : "검토 필요"}`
      + ("speedup" in item && typeof item.speedup === "number"
        ? `, ${item.speedup.toFixed(2)}x`
        : "")
    )),
    "",
    "## FinCast microbatch",
    "",
    ...fincastEntries.map((entry) => (
      `- ${entry.id}: median ${entry.medianMs === null ? "N/A" : `${entry.medianMs.toFixed(1)}ms`}`
      + `, p95 ${entry.p95Ms === null ? "N/A" : `${entry.p95Ms.toFixed(1)}ms`}`
      + `, stable ${entry.stableOutput ? "yes" : "no"}`
    )),
    "",
    "## 해석 제한",
    "",
    "- 이 실행은 48시간 BTC/ETH screening입니다. 모델이나 지표의 성과 개선을 확정하려면 별도의 5주 out-of-sample 검증이 필요합니다.",
    "- 자동 winner를 선택하지 않습니다. 원본 JSON, provenance, latency, 지표를 함께 검토해야 합니다.",
    "",
  ].join("\n");
  await atomicWrite(
    path.join(recorder.runDirectory, recorder.state.artifacts.reportMarkdown),
    `${report}\n`,
  );
  const handoff = [
    "다음 Tesla P40 AI 검증 실행 결과를 분석해줘.",
    "",
    `- 실행 ID: ${recorder.state.runId}`,
    `- 실행 디렉터리: ${recorder.runDirectory}`,
    `- 요약 JSON: ${path.join(recorder.runDirectory, recorder.state.artifacts.summaryJson)}`,
    `- 보고서: ${path.join(recorder.runDirectory, recorder.state.artifacts.reportMarkdown)}`,
    `- 상태: ${path.join(recorder.runDirectory, "state.json")}`,
    `- 이벤트: ${path.join(recorder.runDirectory, "events.jsonl")}`,
    `- 로그: ${path.join(recorder.runDirectory, "logs")}`,
    "",
    "요청:",
    "1. state.json과 qualification-summary.json의 schema/status/gate를 확인하고, 실패·누락 단계가 있으면 해당 로그와 원본 JSON에서 원인을 찾아라.",
    "2. Kronos base 대비 kv-cache-v1의 심볼별 speedup, record/context digest, 최대 지표 차이를 표로 비교하라.",
    "3. FinCast batch 4/8/16의 median/p95, 출력 안정성, provenance, VRAM 위험을 비교하고 가장 안전한 후보를 제안하라.",
    "4. 이 결과는 48시간 screening임을 명시하고, 채택 후보에 필요한 5주 out-of-sample 검증 계획과 예상 P40 시간을 갱신하라.",
    "5. 최적화가 완전히 확정되기 전에는 Docker build나 배포를 하지 마라.",
    "6. 추가 수정이 필요하면 코드 수정, 집중 테스트, dry-run까지만 진행하고 변경 파일과 검증 결과를 알려라.",
    "",
  ].join("\n");
  await atomicWrite(
    path.join(recorder.runDirectory, recorder.state.artifacts.handoffPrompt),
    handoff,
  );
  return `보고서 생성 완료 · KV 캐시 ${parityPassed ? "동등성 통과" : "검토 필요"}`;
}

async function main(): Promise<void> {
  const parsed = parseQualificationArguments(process.argv.slice(2));
  if (parsed.dryRun) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "ai-p40-qualification-plan/v1",
      config: {
        ...parsed,
        dockerBuild: false,
      },
      steps: qualificationSteps(parsed.symbols),
      dashboard: {
        runRootEnvironment: `AI_QUALIFICATION_RUN_ROOT=${parsed.runRoot}`,
        route: "/#ai-qualification",
        refreshIntervalMs: 1_000,
      },
      requiredEnvironment: parsed.workerMode === "docker-source"
        ? [
          "AI_WORKER_IMAGE (optional; existing image only)",
          "AI_FINCAST_WORKER_IMAGE (optional; existing image only)",
          "AI_MODEL_CACHE_SOURCE (optional Docker volume or absolute path)",
          "AI_FINCAST_MODEL_CACHE_SOURCE (optional Docker volume or absolute path)",
        ]
        : [
          "AI_QUALIFICATION_KRONOS_BASE_URL/AUTH_TOKEN_FILE",
          "AI_QUALIFICATION_KRONOS_CACHE_URL/AUTH_TOKEN_FILE",
          "AI_QUALIFICATION_FINCAST_URL/AUTH_TOKEN_FILE",
          "AI_QUALIFICATION_FINCAST_BATCH_{4,8,16}_URL/AUTH_TOKEN_FILE",
        ],
    }, null, 2)}\n`);
    return;
  }

  const recorder = parsed.resume
    ? await QualificationRecorder.resume(parsed)
    : await QualificationRecorder.create(parsed);
  const arguments_ = recorder.arguments_;
  const controller = new AbortController();
  let stoppedBySignal = false;
  const stop = (signal: NodeJS.Signals) => {
    stoppedBySignal = true;
    if (!controller.signal.aborted) controller.abort(new Error(`Stopped by ${signal}.`));
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const loggedCommand = async (
    command: string,
    args: readonly string[],
    logFile: string,
    signal: AbortSignal,
    timeoutMs = Math.max(1_000, recorder.state.progress.remainingBudgetMs),
    env?: NodeJS.ProcessEnv,
  ): Promise<CommandResult> => {
    const header = `$ ${safeCommandLabel(command, args)}\n`;
    await appendFile(path.join(recorder.runDirectory, logFile), header, { encoding: "utf8", mode: 0o600 });
    return runCommand(command, args, {
      env,
      cwd: repoRoot,
      timeoutMs: Math.max(1_000, Math.min(timeoutMs, recorder.state.progress.remainingBudgetMs)),
      signal,
      onOutput: (text) => appendFile(
        path.join(recorder.runDirectory, logFile),
        text,
        { encoding: "utf8", mode: 0o600 },
      ),
    });
  };
  const worker: WorkerController = arguments_.workerMode === "docker-source"
    ? new DockerSourceWorkerController(arguments_, loggedCommand)
    : new ExternalWorkerController();
  let telemetryPolling = false;
  let lastTelemetryAt = 0;
  const heartbeat = setInterval(() => {
    if (isTerminalQualificationStatus(recorder.state.status)) return;
    void (async () => {
      let telemetry: QualificationState["telemetry"] | undefined;
      if (!telemetryPolling && Date.now() - lastTelemetryAt >= 5_000) {
        telemetryPolling = true;
        lastTelemetryAt = Date.now();
        try {
          telemetry = await worker.telemetry(controller.signal);
        } catch {
          telemetry = undefined;
        } finally {
          telemetryPolling = false;
        }
      }
      await recorder.heartbeat(telemetry);
    })().catch(() => undefined);
  }, 1_000);
  heartbeat.unref();

  const runStep = async (
    id: string,
    operation: (step: QualificationStep) => Promise<string | undefined>,
    fatal = false,
  ): Promise<void> => {
    const step = recorder.step(id);
    if (step.status === "completed") return;
    if (arguments_.resume && step.status === "pending") {
      const recovered = await recoverCompletedOutput(recorder, step);
      if (recovered) {
        await recorder.startStep(id);
        await recorder.completeStep(id, recovered);
        return;
      }
    }
    if (recorder.state.progress.remainingBudgetMs < 10_000) {
      throw new Error("Qualification time budget is exhausted.");
    }
    await recorder.startStep(id);
    try {
      const summary = await operation(step);
      await recorder.completeStep(id, summary);
    } catch (error) {
      await recorder.failStep(id, error);
      if (fatal) throw error;
    }
  };

  try {
    await recorder.start();
    await runStep("preflight", async (step) => {
      const evidence = await worker.preflight(step.logFile, controller.signal);
      await writeJson(path.join(recorder.runDirectory, step.outputFile!), evidence);
      return "Tesla P40 / CUDA 6.1 / 기존 이미지 / 모델 캐시 점검 통과";
    }, true);

    for (const profile of ["base", "kv_cache_v1"] as const) {
      for (const symbol of arguments_.symbols) {
        const id = `replay-${profile === "base" ? "base" : "cache"}-${symbol.toLowerCase()}`;
        if (!recorder.state.steps.some((step) => step.id === id)) continue;
        await runStep(id, async (step) => {
          const connection = await worker.activateReplayProfile(
            profile,
            step.logFile,
            controller.signal,
          );
          const output = path.join(recorder.runDirectory, step.outputFile!);
          const deadlineMs = Math.min(
            24 * HOUR_MS,
            Math.max(1_000, recorder.state.progress.remainingBudgetMs),
          );
          await loggedCommand(
            tsxBinary,
            [
              "server/crypto/crypto-model-replay-cli.ts",
              "--symbol", symbol,
              "--output", output,
              "--deadline-ms", String(Math.floor(deadlineMs)),
              "--duration-hours", String(arguments_.durationHours),
              "--end-exclusive", arguments_.endExclusive,
              "--kronos-loader-profile", profile,
            ],
            step.logFile,
            controller.signal,
            deadlineMs,
            replayEnvironment(connection, deadlineMs),
          );
          const result = JSON.parse(await readFile(output, "utf8")) as CryptoModelReplayResult;
          if (result.comparison.outcome !== "review_required") {
            throw new Error(`Replay is not comparable (${result.comparison.outcome}).`);
          }
          return `${symbol} ${profile} · ${result.window.originCount} origins · Kronos ${Math.round(result.lanes.kronos_base.latencyMs)}ms`;
        });
      }
    }

    for (const batchSize of [4, 8, 16] as const) {
      await runStep(`fincast-batch-${batchSize}`, async (step) => {
        const connection = await worker.activateFincastBatch(
          batchSize,
          step.logFile,
          controller.signal,
        );
        const result = await loggedCommand(
          tsxBinary,
          ["scripts/benchmark-ai-forecast-latency.ts"],
          step.logFile,
          controller.signal,
          Math.min(30 * MINUTE_MS, recorder.state.progress.remainingBudgetMs),
          {
            AI_BENCHMARK_URL: connection.url,
            AI_BENCHMARK_AUTH_TOKEN_FILE: connection.tokenFile,
            AI_BENCHMARK_PROFILE: "full",
            AI_BENCHMARK_SERIES_COUNT: String(batchSize),
            AI_BENCHMARK_ITERATIONS: "5",
            AI_BENCHMARK_WARMUPS: "1",
            AI_BENCHMARK_CANDLE_SECONDS: "60",
            AI_BENCHMARK_TIMEOUT_MS: "600000",
          },
        );
        const benchmark = parseJsonOutput(result.stdout) as {
          elapsed_ms?: { median?: number };
          stable_output_digest?: boolean;
          model?: { model_id?: string };
        };
        if (benchmark.model?.model_id !== FINCAST_MODEL_ID) {
          throw new Error(`Expected ${FINCAST_MODEL_ID}, observed ${benchmark.model?.model_id ?? "unknown"}.`);
        }
        if (!benchmark.stable_output_digest) {
          throw new Error("FinCast benchmark output digest was not stable.");
        }
        await writeJson(path.join(recorder.runDirectory, step.outputFile!), benchmark);
        return `batch ${batchSize} · median ${benchmark.elapsed_ms?.median?.toFixed(1) ?? "N/A"}ms · stable`;
      });
    }

    await runStep("finalize", async () => buildReports(recorder), true);
    const failures = recorder.state.steps.filter((step) => step.status === "failed").length;
    await recorder.finish(
      failures ? "completed_with_failures" : "completed",
      failures
        ? `${failures}개 단계가 실패한 상태로 검증과 보고서 생성을 마쳤습니다.`
        : "모든 검증 단계와 보고서 생성을 완료했습니다.",
    );
  } catch (error) {
    const budgetExhausted = recorder.state.progress.remainingBudgetMs <= 0;
    await recorder.skipPending(
      budgetExhausted ? "6시간 실행 예산을 소진했습니다." : "선행 필수 단계가 실패했습니다.",
    );
    await buildReports(recorder).catch(() => undefined);
    await recorder.finish(
      stoppedBySignal ? "cancelled" : budgetExhausted ? "budget_exhausted" : "failed",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    await worker.close().catch(async (error) => {
      await recorder.event(
        "warning",
        `테스트 워커 정리 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    await recorder.flush();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `ai-p40-qualification-error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
