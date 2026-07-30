import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
  AI_QUALIFICATION_STATE_SCHEMA_VERSION,
  QualificationStateSchema,
  isTerminalQualificationStatus,
  type QualificationEvent,
  type QualificationState,
  type QualificationStep,
} from "../server/qualification/contracts.js";

const HOUR_MS = 60 * 60_000;
const DEFAULT_DURATION_WEEKS = 3;
let DURATION_WEEKS = DEFAULT_DURATION_WEEKS;
let DURATION_HOURS = DURATION_WEEKS * 7 * 24;
let EXPECTED_ROWS = DURATION_HOURS * 4 * 2;
let EXPECTED_ORIGINS = EXPECTED_ROWS / 2;
const BATCH_SIZE = 48;
const CADENCE_SECONDS = 60;
const PRODUCTION_CONTAINER = "toss-portfolio-lens-ai-worker-fincast-worker-1";
const GPU_PEER_SERVICE = "llama-swap.service";
const IMAGE = "toss-portfolio-lens-fincast-worker:fincast-p40-opt-20260727-190032";
const ENGINE_SHA256 = "e3afdda18254a9893ded00576e8cd38b45d947e33ba6a26aa5db06f68f2afbb6";
const PLUGIN_SHA256 = "68b756332e41faa8c7cec35870ddf655cf3ce496b3ba6549ea934a8713819dfd";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Arguments = {
  runRoot: string;
  runId: string;
  optimizationRoot: string;
  endExclusive: string;
  durationWeeks: number;
  budgetHours: number;
  resume: boolean;
  refreshAnalysis: boolean;
  dryRun: boolean;
};

type ProcessResult = {
  wallMs: number;
  stdout: string;
};

type OutputStats = {
  backend: "cuda_graph" | "tensorrt_fp32";
  batchSize: number;
  rowCount: number;
  outputDigest: string;
  totalInferenceWallMs: number;
  integratedSeriesPerSecond: number;
  medianChunkSeriesPerSecond: number;
  graphCaptureMs: number;
  processWallMs: number;
  endToEndSeriesPerSecond: number;
};

type JsonObject = Record<string, unknown>;
type FinCastBackendExperiment = Extract<
  NonNullable<QualificationState["experiment"]>,
  { kind: "fincast-fp32-backend-comparison" }
>;

function fincastExperiment(state: QualificationState): FinCastBackendExperiment {
  const experiment = state.experiment;
  if (experiment?.kind !== "fincast-fp32-backend-comparison") {
    throw new Error("qualification state is not a FinCast backend comparison");
  }
  return experiment;
}

const steps: QualificationStep[] = [
  {
    id: "preflight",
    order: 1,
    label: "P40 · artifact 사전 점검",
    description: "160W, GPU 독점 상태, CUDA 12.2/cuDNN 8.9.7, engine/plugin digest를 확인합니다.",
    model: "system",
    variant: "P40 · CUDA 12.2 · cuDNN 8.9.7",
    status: "pending",
    estimatedDurationMs: 45_000,
    outputFile: "preflight.json",
    logFile: "logs/preflight.log",
  },
  {
    id: "prepare-input",
    order: 2,
    label: "3주 BTC/ETH raw 입력 생성",
    description: "Binance USD-M 1분봉에서 504시간, 4,032개 causal context를 생성합니다.",
    model: "comparison",
    variant: "c60 · 504h · 4,032 rows",
    status: "pending",
    estimatedDurationMs: 180_000,
    outputFile: "input/manifest.json",
    logFile: "logs/prepare-input.log",
  },
  {
    id: "cuda-graph-a",
    order: 3,
    label: "CUDA Graph FP32 · pass A",
    description: "qualified reference를 c60/B48로 독립 프로세스에서 실행합니다.",
    model: "fincast",
    variant: "cuda_graph · c60/B48 · A",
    status: "pending",
    estimatedDurationMs: 180_000,
    outputFile: "outputs/cuda-graph-a/manifest.json",
    logFile: "logs/cuda-graph-a.log",
  },
  {
    id: "cuda-graph-b",
    order: 4,
    label: "CUDA Graph FP32 · pass B",
    description: "동일 reference를 다시 실행해 raw output digest 안정성을 확인합니다.",
    model: "fincast",
    variant: "cuda_graph · c60/B48 · B",
    status: "pending",
    estimatedDurationMs: 180_000,
    outputFile: "outputs/cuda-graph-b/manifest.json",
    logFile: "logs/cuda-graph-b.log",
  },
  {
    id: "tensorrt-a",
    order: 5,
    label: "TensorRT FP32 · pass A",
    description: "고정 c60/B48 TensorRT 8.6.1.6 engine을 독립 프로세스에서 실행합니다.",
    model: "fincast",
    variant: "tensorrt_fp32 · c60/B48 · A",
    status: "pending",
    estimatedDurationMs: 180_000,
    outputFile: "outputs/tensorrt-a/manifest.json",
    logFile: "logs/tensorrt-a.log",
  },
  {
    id: "tensorrt-b",
    order: 6,
    label: "TensorRT FP32 · pass B",
    description: "동일 challenger를 다시 실행해 raw output digest 안정성을 확인합니다.",
    model: "fincast",
    variant: "tensorrt_fp32 · c60/B48 · B",
    status: "pending",
    estimatedDurationMs: 180_000,
    outputFile: "outputs/tensorrt-b/manifest.json",
    logFile: "logs/tensorrt-b.log",
  },
  {
    id: "deterministic-gate",
    order: 7,
    label: "반복 실행 digest gate",
    description: "각 backend의 A/B output bytes가 완전히 동일한지 확인합니다.",
    model: "comparison",
    variant: "exact output digest",
    status: "pending",
    estimatedDurationMs: 30_000,
    outputFile: "deterministic-gate.json",
    logFile: "logs/deterministic-gate.log",
  },
  {
    id: "policy-regression",
    order: 8,
    label: "수치 · 정책 · threshold margin 회귀",
    description: "확률, 정책 임계값, 부호 있는 간격을 모든 action에 대해 기록합니다.",
    model: "comparison",
    variant: "80,640 scenarios · 161,280 margins",
    status: "pending",
    estimatedDurationMs: 300_000,
    outputFile: "policy-regression.json",
    logFile: "logs/policy-regression.log",
  },
  {
    id: "final-summary",
    order: 9,
    label: "교체 가능성 판정",
    description: "통합/프로세스 wall throughput과 모든 gate를 한 번에 판정합니다.",
    model: "comparison",
    variant: "no auto promotion",
    status: "pending",
    estimatedDurationMs: 30_000,
    outputFile: "qualification-summary.json",
    logFile: "logs/final-summary.log",
  },
];

function configureDuration(durationWeeks: number): void {
  if (!Number.isSafeInteger(durationWeeks) || durationWeeks < 1 || durationWeeks > 5) {
    throw new Error("--duration-weeks must be an integer in 1..5.");
  }
  DURATION_WEEKS = durationWeeks;
  DURATION_HOURS = durationWeeks * 7 * 24;
  EXPECTED_ROWS = DURATION_HOURS * 4 * 2;
  EXPECTED_ORIGINS = EXPECTED_ROWS / 2;
  const prepare = steps.find((step) => step.id === "prepare-input")!;
  prepare.label = `${durationWeeks}주 BTC/ETH raw·market 입력 생성`;
  prepare.description = `Binance USD-M 1분봉에서 ${DURATION_HOURS}시간, ${EXPECTED_ROWS.toLocaleString("en-US")}개 causal context와 실현 OHLCV를 생성합니다.`;
  prepare.variant = `c60 · ${DURATION_HOURS}h · ${EXPECTED_ROWS.toLocaleString("en-US")} rows`;
  const policy = steps.find((step) => step.id === "policy-regression")!;
  policy.label = "수치 · 실현 정확도 · 수익률 · reason 원인 회귀";
  policy.description = "확률/정책 임계값, 실현 예측 오차, active probability-threshold 수익률과 reason 원인을 기록합니다.";
  policy.variant = `${(EXPECTED_ORIGINS * 4 * 5 * 2).toLocaleString("en-US")} scenarios · ${(EXPECTED_ORIGINS * 4 * 5 * 2 * 2).toLocaleString("en-US")} margins`;
}

function requiredValue(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function exactMinute(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed % 60_000 !== 0) {
    throw new Error("--end-exclusive must be an exact UTC minute.");
  }
  return new Date(parsed).toISOString();
}

function parseArguments(argv: readonly string[]): Arguments {
  let runRoot = path.join(repoRoot, "data/ai-qualification");
  let runId: string | undefined;
  let optimizationRoot = "/home/uaysk/toss-portfolio-lens-optimization/fincast-p40-opt-20260727-190032";
  let endExclusive = "2026-07-27T00:53:00.000Z";
  let durationWeeks = DEFAULT_DURATION_WEEKS;
  let budgetHours = 2;
  let resume = false;
  let refreshAnalysis = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--run-root") {
      runRoot = path.resolve(requiredValue(argv, index, name));
      index += 1;
    } else if (name === "--run-id") {
      runId = requiredValue(argv, index, name);
      index += 1;
    } else if (name === "--optimization-root") {
      optimizationRoot = path.resolve(requiredValue(argv, index, name));
      index += 1;
    } else if (name === "--end-exclusive") {
      endExclusive = exactMinute(requiredValue(argv, index, name));
      index += 1;
    } else if (name === "--duration-weeks") {
      durationWeeks = Number(requiredValue(argv, index, name));
      index += 1;
    } else if (name === "--budget-hours") {
      budgetHours = Number(requiredValue(argv, index, name));
      index += 1;
    } else if (name === "--resume") {
      runId = requiredValue(argv, index, name);
      resume = true;
      index += 1;
    } else if (name === "--refresh-analysis") {
      refreshAnalysis = true;
    } else if (name === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${name ?? ""}`);
    }
  }
  if (!path.isAbsolute(runRoot) || !path.isAbsolute(optimizationRoot)) {
    throw new Error("run and optimization roots must be absolute.");
  }
  configureDuration(durationWeeks);
  runId ??= `fincast-fp32-${durationWeeks}w-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("--run-id contains unsupported characters.");
  }
  if (!Number.isFinite(budgetHours) || budgetHours < 0.25 || budgetHours > 24) {
    throw new Error("--budget-hours must be in 0.25..24.");
  }
  if (refreshAnalysis && !resume) {
    throw new Error("--refresh-analysis requires --resume <run-id>.");
  }
  return {
    runRoot,
    runId,
    optimizationRoot,
    endExclusive,
    durationWeeks,
    budgetHours,
    resume,
    refreshAnalysis,
    dryRun,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, filePath);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function progress(state: QualificationState): QualificationState["progress"] {
  const now = Date.now();
  const start = state.startedAt ? Date.parse(state.startedAt) : now;
  const finished = new Set(["completed", "failed", "skipped", "cancelled"]);
  const totalWeight = state.steps.reduce((sum, step) => sum + step.estimatedDurationMs, 0);
  let finishedWeight = 0;
  let activeStepPercent: number | null = null;
  for (const step of state.steps) {
    if (finished.has(step.status)) {
      finishedWeight += step.estimatedDurationMs;
    } else if (step.status === "running" && step.startedAt) {
      const fraction = Math.min(
        0.98,
        Math.max(0, (now - Date.parse(step.startedAt)) / step.estimatedDurationMs),
      );
      activeStepPercent = fraction * 100;
      finishedWeight += step.estimatedDurationMs * fraction;
    }
  }
  return {
    completedSteps: state.steps.filter((step) => step.status === "completed").length,
    failedSteps: state.steps.filter((step) => step.status === "failed").length,
    skippedSteps: state.steps.filter((step) => step.status === "skipped").length,
    totalSteps: state.steps.length,
    percent: totalWeight ? Math.min(100, finishedWeight / totalWeight * 100) : 0,
    activeStepPercent,
    elapsedMs: Math.max(0, now - start),
    remainingBudgetMs: Math.max(0, Date.parse(state.deadlineAt) - now),
  };
}

class Recorder {
  readonly runDirectory: string;
  state: QualificationState;
  private sequence: number;
  private writeQueue = Promise.resolve();

  private constructor(
    readonly arguments_: Arguments,
    state: QualificationState,
    sequence: number,
  ) {
    this.runDirectory = path.join(arguments_.runRoot, state.runId);
    this.state = state;
    this.sequence = sequence;
  }

  static async create(arguments_: Arguments): Promise<Recorder> {
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
        durationHours: DURATION_HOURS,
        endExclusive: arguments_.endExclusive,
        symbols: ["BTCUSDT", "ETHUSDT"],
        gpu: "Tesla P40",
        cudaCapability: "6.1",
        workerMode: "docker-source",
        dockerBuild: false,
      },
      progress: {
        completedSteps: 0,
        failedSteps: 0,
        skippedSteps: 0,
        totalSteps: steps.length,
        percent: 0,
        activeStepPercent: null,
        elapsedMs: 0,
        remainingBudgetMs: arguments_.budgetHours * HOUR_MS,
      },
      steps: structuredClone(steps),
      artifacts: {
        summaryJson: "qualification-summary.json",
        reportMarkdown: "qualification-report.md",
        handoffPrompt: "codex-handoff-prompt.md",
      },
      experiment: {
        kind: "fincast-fp32-backend-comparison",
        durationWeeks: DURATION_WEEKS,
        cadenceSeconds: CADENCE_SECONDS,
        batchSize: BATCH_SIZE,
        referenceBackend: "cuda_graph",
        candidateBackend: "tensorrt_fp32",
        routingPolicy: "row-id-stateless-uniform/v1",
        thresholdMarginArtifact: "policy-threshold-margins.jsonl",
        detailArtifact: "backend-comparison-details.jsonl",
      },
    };
    QualificationStateSchema.parse(state);
    await mkdir(arguments_.runRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.join(arguments_.runRoot, arguments_.runId), {
      recursive: true,
      mode: 0o700,
    });
    await Promise.all([
      mkdir(path.join(arguments_.runRoot, arguments_.runId, "logs"), { recursive: true }),
      mkdir(path.join(arguments_.runRoot, arguments_.runId, "outputs"), { recursive: true }),
    ]);
    const recorder = new Recorder(arguments_, state, 0);
    await recorder.persist();
    await atomicWrite(
      path.join(arguments_.runRoot, "latest.json"),
      `${JSON.stringify({ runId: arguments_.runId })}\n`,
    );
    await recorder.event(
      "run_created",
      `FinCast c60/B48 FP32 ${DURATION_WEEKS}주 backend 비교 실행을 생성했습니다.`,
    );
    return recorder;
  }

  static async resume(arguments_: Arguments): Promise<Recorder> {
    const runDirectory = path.join(arguments_.runRoot, arguments_.runId);
    const state = QualificationStateSchema.parse(
      JSON.parse(await readFile(path.join(runDirectory, "state.json"), "utf8")),
    );
    if (
      state.config.durationHours !== DURATION_HOURS
      || state.experiment?.kind !== "fincast-fp32-backend-comparison"
      || state.experiment.durationWeeks !== DURATION_WEEKS
    ) {
      throw new Error("resume duration does not match --duration-weeks.");
    }
    if (
      isTerminalQualificationStatus(state.status)
      && state.status !== "failed"
      && !arguments_.refreshAnalysis
    ) {
      throw new Error(`Run ${state.runId} is already terminal (${state.status}).`);
    }
    for (const step of state.steps) {
      const refreshStep = arguments_.refreshAnalysis
        && (step.id === "policy-regression" || step.id === "final-summary");
      if (
        refreshStep
        || step.status === "running"
        || step.status === "failed"
        || step.status === "skipped"
        || step.status === "cancelled"
      ) {
        step.status = "pending";
        step.startedAt = undefined;
        step.finishedAt = undefined;
        step.durationMs = undefined;
        step.summary = undefined;
        step.error = undefined;
      }
    }
    state.status = "planned";
    state.activeStepId = null;
    state.finishedAt = undefined;
    const eventPayload = await readFile(path.join(runDirectory, "events.jsonl"), "utf8")
      .catch(() => "");
    const recorder = new Recorder(
      {
        ...arguments_,
        budgetHours: state.config.budgetHours,
        endExclusive: state.config.endExclusive,
      },
      state,
      eventPayload.split("\n").filter(Boolean).length,
    );
    await recorder.persist();
    await atomicWrite(
      path.join(arguments_.runRoot, "latest.json"),
      `${JSON.stringify({ runId: arguments_.runId })}\n`,
    );
    await recorder.event(
      "warning",
      arguments_.refreshAnalysis
        ? `${DURATION_WEEKS}주 inference artifact를 보존하고 상세 분석 단계만 다시 실행합니다.`
        : `중단된 ${DURATION_WEEKS}주 backend 비교를 재개합니다.`,
    );
    return recorder;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }

  async persist(): Promise<void> {
    this.state.updatedAt = nowIso();
    this.state.progress = progress(this.state);
    const snapshot = QualificationStateSchema.parse(structuredClone(this.state));
    await this.enqueue(() => atomicWrite(
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
    await this.event("run_started", `${DURATION_WEEKS}주 c60/B48 FP32 비교를 시작했습니다.`);
  }

  step(id: string): QualificationStep {
    const step = this.state.steps.find((item) => item.id === id);
    if (!step) throw new Error(`Unknown step: ${id}`);
    return step;
  }

  async startStep(id: string): Promise<boolean> {
    const step = this.step(id);
    if (step.status === "completed") {
      await this.event("step_skipped", `${step.label}: resume에서 완료 상태를 보존했습니다.`, id);
      return false;
    }
    step.status = "running";
    step.startedAt = nowIso();
    step.finishedAt = undefined;
    step.durationMs = undefined;
    step.error = undefined;
    this.state.activeStepId = id;
    await this.persist();
    await this.event("step_started", `${step.label} 단계를 시작했습니다.`, id);
    return true;
  }

  async completeStep(id: string, summary: string): Promise<void> {
    const step = this.step(id);
    step.status = "completed";
    step.finishedAt = nowIso();
    step.durationMs = Math.max(
      0,
      Date.parse(step.finishedAt) - Date.parse(step.startedAt ?? step.finishedAt),
    );
    step.summary = summary.slice(0, 1_000);
    this.state.activeStepId = null;
    await this.persist();
    await this.event("step_completed", summary, id);
  }

  async failStep(id: string, error: unknown): Promise<void> {
    const step = this.step(id);
    const message = error instanceof Error ? error.message : String(error);
    step.status = "failed";
    step.finishedAt = nowIso();
    step.durationMs = Math.max(
      0,
      Date.parse(step.finishedAt) - Date.parse(step.startedAt ?? step.finishedAt),
    );
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

  async telemetry(value: QualificationState["telemetry"]): Promise<void> {
    this.state.telemetry = value;
    await this.persist();
  }

  async finish(status: QualificationState["status"], message: string): Promise<void> {
    this.state.status = status;
    this.state.finishedAt = nowIso();
    this.state.activeStepId = null;
    await this.persist();
    await this.event("run_completed", message);
  }
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function numeric(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a string.`);
  return value;
}

function median(values: readonly number[]): number {
  if (!values.length) throw new Error("median requires values.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

let activeChild: ChildProcess | undefined;

async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  logPath: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
  const started = Date.now();
  const log = await open(input.logPath, "a", 0o600);
  let stdout = "";
  await log.write(`\n[${nowIso()}] $ ${input.command} ${input.args.join(" ")}\n`);
  return new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.environment },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    activeChild = child;
    child.stdout.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      stdout += value;
      if (stdout.length > 1 << 20) stdout = stdout.slice(-(1 << 20));
      void log.write(value);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      void log.write(chunk);
    });
    child.once("error", async (error) => {
      activeChild = undefined;
      await log.close().catch(() => undefined);
      rejectPromise(error);
    });
    child.once("close", async (code, signal) => {
      activeChild = undefined;
      await log.write(`\n[${nowIso()}] exit=${String(code)} signal=${String(signal)}\n`);
      await log.close();
      if (code !== 0) {
        rejectPromise(new Error(
          `${input.command} exited with ${String(code)}${signal ? ` (${signal})` : ""}; see ${input.logPath}`,
        ));
        return;
      }
      resolvePromise({ wallMs: Date.now() - started, stdout });
    });
  });
}

async function capture(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`${command} failed (${String(code)}): ${stderr.trim()}`));
    });
  });
}

async function exists(filePath: string): Promise<boolean> {
  return lstat(filePath).then(() => true, () => false);
}

async function telemetrySample(): Promise<QualificationState["telemetry"]> {
  const raw = await capture("nvidia-smi", [
    "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
    "--format=csv,noheader,nounits",
  ]);
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("nvidia-smi telemetry shape changed.");
  }
  const [gpu, used, total, temperature, power, limit] = values as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    polledAt: nowIso(),
    gpuUtilizationPercent: gpu,
    memoryUsedMiB: used,
    memoryTotalMiB: total,
    temperatureC: temperature,
    powerDrawW: power,
    powerLimitW: limit,
    memoryHeadroomMiB: Math.max(0, total - used),
  };
}

function startTelemetry(recorder: Recorder): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || isTerminalQualificationStatus(recorder.state.status)) return;
    inFlight = true;
    void telemetrySample()
      .then((sample) => recorder.telemetry(sample))
      .catch(() => undefined)
      .finally(() => { inFlight = false; });
  }, 1_000);
  return () => clearInterval(timer);
}

function optimizationPaths(root: string): {
  source: string;
  trtRoot: string;
  engine: string;
  plugin: string;
  trtPython: string;
  sitePackages: string;
  sdkLibrary: string;
  cudaRoot: string;
} {
  const trtRoot = path.join(root, "tensorrt");
  return {
    source: path.join(root, "source"),
    trtRoot,
    engine: path.join(trtRoot, "engine-c60-b48/fincast-c60-b48-fp32.plan"),
    plugin: path.join(trtRoot, "plugin-build/libfincast_trt_plugins.so"),
    trtPython: path.join(
      trtRoot,
      "python/cpython-3.11.15-linux-x86_64-gnu/bin/python3.11",
    ),
    sitePackages: path.join(trtRoot, "venv/lib/python3.11/site-packages"),
    sdkLibrary: path.join(trtRoot, "sdk/TensorRT-8.6.1.6/lib"),
    cudaRoot: "/usr/local/cuda-12.2",
  };
}

async function preflight(recorder: Recorder): Promise<void> {
  if (process.env.FINCAST_GPU_EXCLUSIVE !== "1") {
    throw new Error("worker wrapper did not assert FINCAST_GPU_EXCLUSIVE=1.");
  }
  const paths = optimizationPaths(recorder.arguments_.optimizationRoot);
  const modelCache = process.env.FINCAST_MODEL_CACHE;
  if (!modelCache || !path.isAbsolute(modelCache)) {
    throw new Error("FINCAST_MODEL_CACHE is missing or not absolute.");
  }
  for (const required of [
    paths.source,
    paths.engine,
    paths.plugin,
    paths.trtPython,
    paths.sitePackages,
    path.join(paths.cudaRoot, "include/cudnn_version.h"),
    path.join(modelCache, "fincast"),
  ]) {
    if (!await exists(required)) throw new Error(`required path is unavailable: ${required}`);
  }
  const [
    gpu,
    production,
    peer,
    engineDigest,
    pluginDigest,
    image,
    nvcc,
    cudnn,
    computeProcesses,
  ] = await Promise.all([
    capture("nvidia-smi", [
      "--query-gpu=name,power.limit",
      "--format=csv,noheader,nounits",
    ]),
    capture("docker", ["inspect", "--format", "{{.State.Status}}", PRODUCTION_CONTAINER]),
    capture("bash", ["-lc", `systemctl is-active ${GPU_PEER_SERVICE} || true`]),
    capture("sha256sum", [paths.engine]),
    capture("sha256sum", [paths.plugin]),
    capture("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE]),
    capture(path.join(paths.cudaRoot, "bin/nvcc"), ["-V"]),
    capture("bash", [
      "-lc",
      `grep -E '^#define CUDNN_(MAJOR|MINOR|PATCHLEVEL)' '${path.join(paths.cudaRoot, "include/cudnn_version.h")}'`,
    ]),
    capture("nvidia-smi", [
      "--query-compute-apps=pid,process_name",
      "--format=csv,noheader,nounits",
    ]),
  ]);
  if (!gpu.startsWith("Tesla P40, 160.00")) {
    throw new Error(`unexpected GPU or power cap: ${gpu}`);
  }
  if (production !== "exited" || peer !== "inactive") {
    throw new Error(`GPU owners were not stopped: production=${production}, peer=${peer}`);
  }
  if (computeProcesses) throw new Error(`GPU is not exclusive: ${computeProcesses}`);
  if (engineDigest.split(/\s+/)[0] !== ENGINE_SHA256) throw new Error("engine SHA-256 mismatch.");
  if (pluginDigest.split(/\s+/)[0] !== PLUGIN_SHA256) throw new Error("plugin SHA-256 mismatch.");
  if (!nvcc.includes("release 12.2")) throw new Error("CUDA 12.2 nvcc is unavailable.");
  if (
    !cudnn.includes("CUDNN_MAJOR 8")
    || !cudnn.includes("CUDNN_MINOR 9")
    || !cudnn.includes("CUDNN_PATCHLEVEL 7")
  ) {
    throw new Error("cuDNN 8.9.7 headers are unavailable.");
  }
  const result = {
    schema_version: `fincast-p40-fp32-${DURATION_WEEKS}week-preflight/v1`,
    observed_at: nowIso(),
    gpu,
    production_container_state: production,
    gpu_peer_service_state: peer,
    compute_processes: [],
    cuda: "12.2",
    cudnn: "8.9.7",
    image_id: image,
    engine_sha256: ENGINE_SHA256,
    plugin_sha256: PLUGIN_SHA256,
    power_cap_w: 160,
  };
  await writeJson(path.join(recorder.runDirectory, "preflight.json"), result);
}

async function prepareInput(recorder: Recorder): Promise<void> {
  const output = path.join(recorder.runDirectory, "input");
  const manifestPath = path.join(output, "manifest.json");
  const marketManifestPath = path.join(output, "market-data.json");
  if (!await exists(manifestPath) || !await exists(marketManifestPath)) {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await runProcess({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "scripts/prepare-fincast-p40-policy-regression.ts",
        "--output",
        output,
        "--end-exclusive",
        recorder.state.config.endExclusive,
        "--duration-hours",
        String(DURATION_HOURS),
        "--model-seed",
        "0",
      ],
      cwd: repoRoot,
      logPath: path.join(recorder.runDirectory, "logs/prepare-input.log"),
    });
  }
  const manifest = object(JSON.parse(await readFile(manifestPath, "utf8")), "input manifest");
  const marketManifest = object(
    JSON.parse(await readFile(marketManifestPath, "utf8")),
    "market data manifest",
  );
  const manifestDigest = createHash("sha256")
    .update(await readFile(manifestPath))
    .digest("hex");
  if (
    manifest.schema_version !== "fincast-raw-input/v1"
    || manifest.row_count !== EXPECTED_ROWS
    || manifest.cadence_seconds !== CADENCE_SECONDS
    || manifest.model_seed !== 0
  ) {
    throw new Error(
      `${DURATION_WEEKS}-week input manifest does not match c60/${EXPECTED_ROWS} rows/seed 0.`,
    );
  }
  if (
    marketManifest.schema_version !== "fincast-replay-market-data/v1"
    || marketManifest.raw_input_manifest_sha256 !== manifestDigest
    || marketManifest.duration_hours !== DURATION_HOURS
  ) {
    throw new Error("market data artifact does not match the raw input manifest.");
  }
  recorder.state.experiment = {
    ...fincastExperiment(recorder.state),
    rowCount: EXPECTED_ROWS,
    originCount: EXPECTED_ORIGINS,
  };
  await recorder.persist();
}

function dockerArguments(input: {
  recorder: Recorder;
  backend: "cuda_graph" | "tensorrt_fp32";
  output: string;
  containerName: string;
  resume: boolean;
}): string[] {
  const paths = optimizationPaths(input.recorder.arguments_.optimizationRoot);
  const modelCache = process.env.FINCAST_MODEL_CACHE!;
  const inputRoot = path.join(input.recorder.runDirectory, "input");
  const common = [
    "run",
    "--rm",
    "--name",
    input.containerName,
    "--user",
    "1000:1000",
    "--gpus",
    "all",
    "--network",
    "none",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=512m",
    "-e",
    "AI_MODEL_LANE=fincast",
    "-e",
    "AI_MODEL_CACHE_DIR=/models",
    "-e",
    "AI_MODEL_MANIFEST=/app/model-manifest.json",
    "-e",
    "AI_DEVICE=cuda",
    "-e",
    "AI_ALLOW_CPU_FALLBACK=false",
    "-e",
    "AI_EXPECTED_CUDA_CAPABILITY=6.1",
    "-e",
    "AI_EXPECTED_CUDA_DEVICE_NAME=Tesla P40",
    "-e",
    "AI_FINCAST_MIN_VRAM_HEADROOM_MIB=2048",
    "-v",
    `${paths.source}:/app/src:ro`,
    "-v",
    `${modelCache}:/models:ro`,
    "-v",
    `${inputRoot}:/work/input:ro`,
    "-v",
    `${input.output}:/work/output:rw`,
  ];
  if (input.backend === "tensorrt_fp32") {
    common.push(
      "-e",
      `AI_FINCAST_TENSORRT_PYTHON=${paths.trtPython}`,
      "-e",
      `AI_FINCAST_TENSORRT_SITE_PACKAGES=${paths.sitePackages}`,
      "-e",
      `AI_FINCAST_TENSORRT_FP32_ENGINE=${paths.engine}`,
      "-e",
      `AI_FINCAST_TENSORRT_PLUGIN=${paths.plugin}`,
      "-e",
      `AI_FINCAST_TENSORRT_FP32_ENGINE_SHA256=${ENGINE_SHA256}`,
      "-e",
      `AI_FINCAST_TENSORRT_PLUGIN_SHA256=${PLUGIN_SHA256}`,
      "-e",
      `CUDA_HOME=${paths.cudaRoot}`,
      "-e",
      `LD_LIBRARY_PATH=${paths.sdkLibrary}:${paths.cudaRoot}/targets/x86_64-linux/lib`,
      "-v",
      `${paths.trtRoot}:${paths.trtRoot}:ro`,
      "-v",
      `${paths.cudaRoot}:${paths.cudaRoot}:ro`,
    );
  }
  common.push(
    "--entrypoint",
    "/app/.venv/bin/python",
    IMAGE,
    "-m",
    "portfolio_ai_worker",
    "raw-generate",
    "--job",
    "/work/input/manifest.json",
    "--output",
    "/work/output",
    "--backend",
    input.backend,
    "--batch-size",
    String(BATCH_SIZE),
  );
  if (input.resume) common.push("--resume");
  return common;
}

async function generate(
  recorder: Recorder,
  stepId: "cuda-graph-a" | "cuda-graph-b" | "tensorrt-a" | "tensorrt-b",
  backend: "cuda_graph" | "tensorrt_fp32",
): Promise<number> {
  const output = path.join(recorder.runDirectory, "outputs", stepId);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const resume = await exists(path.join(output, "manifest.json"));
  const result = await runProcess({
    command: "docker",
    args: dockerArguments({
      recorder,
      backend,
      output,
      containerName: `fincast-${stepId}-${recorder.state.runId}`.slice(0, 120),
      resume,
    }),
    cwd: repoRoot,
    logPath: path.join(recorder.runDirectory, `logs/${stepId}.log`),
  });
  await writeJson(path.join(output, "process-wall.json"), {
    schema_version: "fincast-process-wall/v1",
    backend,
    batch_size: BATCH_SIZE,
    wall_ms: result.wallMs,
    measured_at: nowIso(),
  });
  return result.wallMs;
}

async function outputStats(directory: string): Promise<OutputStats> {
  const manifest = object(
    JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
    "output manifest",
  );
  const backend = manifest.backend;
  if (backend !== "cuda_graph" && backend !== "tensorrt_fp32") {
    throw new Error(`unexpected output backend: ${String(backend)}`);
  }
  const rowCount = numeric(manifest.row_count, "row_count");
  const batchSize = numeric(manifest.batch_size, "batch_size");
  if (
    manifest.complete !== true
    || manifest.completed_rows !== EXPECTED_ROWS
    || rowCount !== EXPECTED_ROWS
    || batchSize !== BATCH_SIZE
    || !Array.isArray(manifest.chunks)
    || manifest.chunks.length !== EXPECTED_ROWS / BATCH_SIZE
  ) {
    throw new Error(`${backend} output is incomplete or has the wrong shape.`);
  }
  const digest = createHash("sha256");
  const wallTimes: number[] = [];
  const chunkThroughput: number[] = [];
  let graphCaptureMs = 0;
  for (const rawChunk of manifest.chunks) {
    const chunkName = stringValue(rawChunk, "chunk name");
    if (!/^chunks\/chunk-\d{10}-\d{10}\.json$/.test(chunkName)) {
      throw new Error(`unsafe chunk name: ${chunkName}`);
    }
    const metadata = object(
      JSON.parse(await readFile(path.join(directory, chunkName), "utf8")),
      "chunk metadata",
    );
    const latency = object(metadata.latency, "chunk latency");
    const output = object(metadata.output, "chunk output");
    const binaryName = stringValue(output.name, "chunk binary");
    digest.update(await readFile(path.join(directory, binaryName)));
    wallTimes.push(numeric(latency.inference_wall_ms, "chunk inference wall"));
    chunkThroughput.push(numeric(latency.series_per_second, "chunk throughput"));
    if (latency.graph_capture_ms !== null && latency.graph_capture_ms !== undefined) {
      graphCaptureMs += numeric(latency.graph_capture_ms, "graph capture");
    }
  }
  const processWall = object(
    JSON.parse(await readFile(path.join(directory, "process-wall.json"), "utf8")),
    "process wall",
  );
  const processWallMs = numeric(processWall.wall_ms, "process wall_ms");
  const totalInferenceWallMs = wallTimes.reduce((sum, value) => sum + value, 0);
  return {
    backend,
    batchSize,
    rowCount,
    outputDigest: digest.digest("hex"),
    totalInferenceWallMs,
    integratedSeriesPerSecond: rowCount / (totalInferenceWallMs / 1_000),
    medianChunkSeriesPerSecond: median(chunkThroughput),
    graphCaptureMs,
    processWallMs,
    endToEndSeriesPerSecond: rowCount / (processWallMs / 1_000),
  };
}

async function executeStep(
  recorder: Recorder,
  id: string,
  operation: () => Promise<string>,
): Promise<void> {
  if (!await recorder.startStep(id)) return;
  try {
    const summary = await operation();
    await recorder.completeStep(id, summary);
  } catch (error) {
    await recorder.failStep(id, error);
    throw error;
  }
}

async function readStats(recorder: Recorder): Promise<{
  graphA: OutputStats;
  graphB: OutputStats;
  trtA: OutputStats;
  trtB: OutputStats;
}> {
  const root = path.join(recorder.runDirectory, "outputs");
  const [graphA, graphB, trtA, trtB] = await Promise.all([
    outputStats(path.join(root, "cuda-graph-a")),
    outputStats(path.join(root, "cuda-graph-b")),
    outputStats(path.join(root, "tensorrt-a")),
    outputStats(path.join(root, "tensorrt-b")),
  ]);
  return { graphA, graphB, trtA, trtB };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.dryRun) {
    process.stdout.write(`${JSON.stringify({
      schema_version: `fincast-p40-fp32-${DURATION_WEEKS}week-plan/v1`,
      arguments: arguments_,
      expected_rows: EXPECTED_ROWS,
      expected_origins: EXPECTED_ORIGINS,
      expected_scenarios: EXPECTED_ORIGINS * 4 * 5 * 2,
      expected_margin_records: EXPECTED_ORIGINS * 4 * 5 * 2 * 2,
      steps,
    }, null, 2)}\n`);
    return;
  }
  const recorder = arguments_.resume
    ? await Recorder.resume(arguments_)
    : await Recorder.create(arguments_);
  const stopTelemetry = startTelemetry(recorder);
  let currentStep = "preflight";
  const signal = async (name: NodeJS.Signals): Promise<void> => {
    if (activeChild?.pid) {
      try {
        process.kill(-activeChild.pid, "SIGTERM");
      } catch {
        // The child already exited.
      }
    }
    recorder.state.status = "cancelled";
    recorder.state.finishedAt = nowIso();
    recorder.state.activeStepId = null;
    await recorder.persist().catch(() => undefined);
    await recorder.event("run_completed", `signal ${name}로 실행을 중단했습니다.`)
      .catch(() => undefined);
    stopTelemetry();
    process.exit(name === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", () => { void signal("SIGINT"); });
  process.once("SIGTERM", () => { void signal("SIGTERM"); });
  process.once("SIGHUP", () => { void signal("SIGHUP"); });

  try {
    await recorder.start();
    currentStep = "preflight";
    await executeStep(recorder, currentStep, async () => {
      await preflight(recorder);
      return "P40 160W · CUDA 12.2 · cuDNN 8.9.7 · engine/plugin digest · GPU 독점 확인";
    });

    currentStep = "prepare-input";
    await executeStep(recorder, currentStep, async () => {
      await prepareInput(recorder);
      return `BTCUSDT/ETHUSDT ${DURATION_WEEKS}주 ${EXPECTED_ROWS.toLocaleString("en-US")} rows · ${EXPECTED_ORIGINS.toLocaleString("en-US")} origins · c60 raw/market 입력 확정`;
    });

    for (const [id, backend] of [
      ["cuda-graph-a", "cuda_graph"],
      ["cuda-graph-b", "cuda_graph"],
      ["tensorrt-a", "tensorrt_fp32"],
      ["tensorrt-b", "tensorrt_fp32"],
    ] as const) {
      currentStep = id;
      await executeStep(recorder, id, async () => {
        const wallMs = await generate(recorder, id, backend);
        const stats = await outputStats(path.join(recorder.runDirectory, "outputs", id));
        const experiment = fincastExperiment(recorder.state);
        const metrics = experiment.metrics ?? {};
        recorder.state.experiment = {
          ...experiment,
          metrics: backend === "cuda_graph"
            ? {
                ...metrics,
                cudaGraphSeriesPerSecond: stats.integratedSeriesPerSecond,
                cudaGraphEndToEndSeriesPerSecond: stats.endToEndSeriesPerSecond,
              }
            : {
                ...metrics,
                tensorRtSeriesPerSecond: stats.integratedSeriesPerSecond,
                tensorRtEndToEndSeriesPerSecond: stats.endToEndSeriesPerSecond,
              },
        };
        await recorder.persist();
        return `${stats.integratedSeriesPerSecond.toFixed(2)} series/s · process ${(wallMs / 1_000).toFixed(2)}s · digest ${stats.outputDigest.slice(0, 12)}`;
      });
    }

    currentStep = "deterministic-gate";
    await executeStep(recorder, currentStep, async () => {
      const stats = await readStats(recorder);
      const graphStable = stats.graphA.outputDigest === stats.graphB.outputDigest;
      const trtStable = stats.trtA.outputDigest === stats.trtB.outputDigest;
      const result = {
        schema_version: "fincast-p40-fp32-deterministic-gate/v1",
        passed: graphStable && trtStable,
        cuda_graph: {
          passed: graphStable,
          pass_a_digest: stats.graphA.outputDigest,
          pass_b_digest: stats.graphB.outputDigest,
        },
        tensorrt_fp32: {
          passed: trtStable,
          pass_a_digest: stats.trtA.outputDigest,
          pass_b_digest: stats.trtB.outputDigest,
        },
      };
      await writeJson(path.join(recorder.runDirectory, "deterministic-gate.json"), result);
      if (!result.passed) throw new Error("one or more backend output digests are unstable.");
      return "CUDA Graph A/B 및 TensorRT A/B raw output digest exact 일치";
    });

    currentStep = "policy-regression";
    await executeStep(recorder, currentStep, async () => {
      const output = path.join(recorder.runDirectory, "policy-regression.json");
      const marginOutput = path.join(recorder.runDirectory, "policy-threshold-margins.jsonl");
      const detailOutput = path.join(recorder.runDirectory, "backend-comparison-details.jsonl");
      await runProcess({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "scripts/compare-fincast-p40-policy-regression.ts",
          "--job",
          path.join(recorder.runDirectory, "input/manifest.json"),
          "--reference",
          path.join(recorder.runDirectory, "outputs/cuda-graph-a"),
          "--candidate",
          path.join(recorder.runDirectory, "outputs/tensorrt-a"),
          "--market-data",
          path.join(recorder.runDirectory, "input/market-data.json"),
          "--output",
          output,
          "--margins-output",
          marginOutput,
          "--details-output",
          detailOutput,
        ],
        cwd: repoRoot,
        logPath: path.join(recorder.runDirectory, "logs/policy-regression.log"),
      });
      const result = object(JSON.parse(await readFile(output, "utf8")), "policy regression");
      const prediction = object(result.prediction_gate, "prediction gate");
      const q50 = object(prediction.q50_error_over_iqr, "q50 gate");
      const gate = object(result.gate, "policy gate");
      const audit = object(result.threshold_margin_audit, "threshold audit");
      const accuracy = object(result.realized_accuracy, "realized accuracy");
      const accuracyReference = object(accuracy.reference, "reference realized accuracy");
      const accuracyCandidate = object(accuracy.candidate, "candidate realized accuracy");
      const accuracyPaired = object(accuracy.paired, "paired realized accuracy");
      const outlierDiagnostics = object(
        accuracy.outlier_diagnostics,
        "realized probability outlier diagnostics",
      );
      const probabilityOutlierCounts = object(
        outlierDiagnostics.probability_delta_counts,
        "probability outlier counts",
      );
      const absoluteProbabilityDelta = object(
        accuracyPaired.absolute_up_probability_delta,
        "absolute probability delta",
      );
      const returns = object(result.model_signal_returns, "model signal returns");
      const returnGate = object(returns.gate, "model signal return gate");
      const reason = object(result.reason_difference_analysis, "reason analysis");
      const assessment = object(reason.assessment, "reason assessment");
      const probabilityOnly = object(
        result.probability_only_near_threshold,
        "probability-only near-threshold test",
      );
      const aligned = object(gate.symbol_aligned, "symbol aligned policy gate");
      const referenceMargin = object(audit.reference_absolute_margin, "reference margin");
      const candidateMargin = object(audit.candidate_absolute_margin, "candidate margin");
      const experiment = fincastExperiment(recorder.state);
      recorder.state.experiment = {
        ...experiment,
        metrics: {
          ...experiment.metrics,
          directionMatchRate: numeric(prediction.direction_match_rate, "direction match"),
          q50ErrorIqrMedian: numeric(q50.median, "q50 median"),
          q50ErrorIqrP95: numeric(q50.p95, "q50 p95"),
          policyActionMismatches: numeric(gate.action_kind_mismatches, "action mismatches"),
          policyReasonMismatches: numeric(gate.reason_mismatches, "reason mismatches"),
          thresholdMarginRecordCount: numeric(audit.record_count, "margin record count"),
          thresholdCrossingCount: numeric(audit.threshold_crossing_count, "threshold crossings"),
          probabilityOnlyDecisionCount: numeric(
            probabilityOnly.decision_count,
            "probability-only decision count",
          ),
          probabilityOnlyActionMismatchRate: numeric(
            probabilityOnly.action_mismatch_rate,
            "probability-only action mismatch rate",
          ),
          probabilityOutlier1ppCount: numeric(
            probabilityOutlierCounts.at_least_1pp,
            "1pp probability outlier count",
          ),
          probabilityOutlier5ppCount: numeric(
            probabilityOutlierCounts.at_least_5pp,
            "5pp probability outlier count",
          ),
          probabilityOutlier10ppCount: numeric(
            probabilityOutlierCounts.at_least_10pp,
            "10pp probability outlier count",
          ),
          maximumProbabilityDelta: numeric(
            absoluteProbabilityDelta.maximum,
            "maximum probability delta",
          ),
          realizedDirectionDisagreements: numeric(
            accuracyPaired.direction_disagreements,
            "realized direction disagreements",
          ),
          closestReferenceMargin: numeric(referenceMargin.minimum, "reference minimum margin"),
          closestCandidateMargin: numeric(candidateMargin.minimum, "candidate minimum margin"),
          referenceRealizedDirectionAccuracy: numeric(
            accuracyReference.direction_accuracy,
            "reference realized direction accuracy",
          ),
          candidateRealizedDirectionAccuracy: numeric(
            accuracyCandidate.direction_accuracy,
            "candidate realized direction accuracy",
          ),
          maximumReturnDelta: numeric(
            returnGate.maximum_absolute_total_return_delta,
            "maximum return delta",
          ),
          maximumDrawdownDelta: numeric(
            returnGate.maximum_absolute_drawdown_delta,
            "maximum drawdown delta",
          ),
          modelSignalDecisionMismatches: numeric(
            returnGate.decision_mismatch_count,
            "model signal decision mismatches",
          ),
          symbolAlignedActionMismatches: numeric(
            aligned.action_kind_mismatches,
            "symbol aligned action mismatches",
          ),
          symbolAlignedReasonMismatches: numeric(
            aligned.reason_mismatches,
            "symbol aligned reason mismatches",
          ),
          offlineEconomicallyAcceptable:
            assessment.acceptable_for_offline_raw_generation === true,
        },
      };
      await recorder.persist();
      return `prediction=${String(prediction.passed)} · realized direction Graph/TRT=${(numeric(accuracyReference.direction_accuracy, "reference direction") * 100).toFixed(2)}%/${(numeric(accuracyCandidate.direction_accuracy, "candidate direction") * 100).toFixed(2)}% · return gate=${String(returnGate.passed)} · aligned action/reason=${String(aligned.action_kind_mismatches)}/${String(aligned.reason_mismatches)}`;
    });

    currentStep = "final-summary";
    await executeStep(recorder, currentStep, async () => {
      const stats = await readStats(recorder);
      const policy = object(
        JSON.parse(await readFile(
          path.join(recorder.runDirectory, "policy-regression.json"),
          "utf8",
        )),
        "policy regression",
      );
      const prediction = object(policy.prediction_gate, "prediction gate");
      const gate = object(policy.gate, "policy gate");
      const audit = object(policy.threshold_margin_audit, "threshold audit");
      const accuracy = object(policy.realized_accuracy, "realized accuracy");
      const returns = object(policy.model_signal_returns, "model signal returns");
      const returnGate = object(returns.gate, "model signal return gate");
      const reasonAnalysis = object(
        policy.reason_difference_analysis,
        "reason difference analysis",
      );
      const reasonAssessment = object(reasonAnalysis.assessment, "reason assessment");
      const probabilityOnly = object(
        policy.probability_only_near_threshold,
        "probability-only near-threshold test",
      );
      const graphSeries = median([
        stats.graphA.integratedSeriesPerSecond,
        stats.graphB.integratedSeriesPerSecond,
      ]);
      const trtSeries = median([
        stats.trtA.integratedSeriesPerSecond,
        stats.trtB.integratedSeriesPerSecond,
      ]);
      const graphE2e = median([
        stats.graphA.endToEndSeriesPerSecond,
        stats.graphB.endToEndSeriesPerSecond,
      ]);
      const trtE2e = median([
        stats.trtA.endToEndSeriesPerSecond,
        stats.trtB.endToEndSeriesPerSecond,
      ]);
      const speedupRatio = trtSeries / graphSeries;
      const e2eSpeedup = trtE2e / graphE2e;
      const deterministic = object(
        JSON.parse(await readFile(
          path.join(recorder.runDirectory, "deterministic-gate.json"),
          "utf8",
        )),
        "deterministic gate",
      );
      const replacementEligible = deterministic.passed === true
        && prediction.passed === true
        && gate.passed === true
        && audit.threshold_crossing_count === 0
        && returnGate.passed === true;
      const offlineEconomicallyAcceptable =
        reasonAssessment.acceptable_for_offline_raw_generation === true;
      const experiment = fincastExperiment(recorder.state);
      recorder.state.experiment = {
        ...experiment,
        metrics: {
          ...experiment.metrics,
          cudaGraphSeriesPerSecond: graphSeries,
          tensorRtSeriesPerSecond: trtSeries,
          speedupRatio,
          speedupPercent: (speedupRatio - 1) * 100,
          cudaGraphEndToEndSeriesPerSecond: graphE2e,
          tensorRtEndToEndSeriesPerSecond: trtE2e,
          endToEndSpeedupRatio: e2eSpeedup,
        },
      };
      const summary = {
        schema_version: `fincast-p40-fp32-${DURATION_WEEKS}week-qualification/v1`,
        run_id: recorder.state.runId,
        generated_at: nowIso(),
        status: replacementEligible ? "passed" : "rejected",
        replacement_eligible: replacementEligible,
        automatic_promotion: false,
        configuration: {
          gpu: "Tesla P40",
          power_cap_w: 160,
          cuda: "12.2",
          cudnn: "8.9.7",
          cadence_seconds: CADENCE_SECONDS,
          batch_size: BATCH_SIZE,
          duration_hours: DURATION_HOURS,
          row_count: EXPECTED_ROWS,
          origin_count: EXPECTED_ORIGINS,
          end_exclusive: recorder.state.config.endExclusive,
          routing_policy: "row-id-stateless-uniform/v1",
        },
        throughput: {
          cuda_graph_series_per_second: graphSeries,
          tensorrt_fp32_series_per_second: trtSeries,
          speedup_ratio: speedupRatio,
          speedup_percent: (speedupRatio - 1) * 100,
          cuda_graph_process_series_per_second: graphE2e,
          tensorrt_fp32_process_series_per_second: trtE2e,
          process_speedup_ratio: e2eSpeedup,
          cuda_graph_capture_ms: median([stats.graphA.graphCaptureMs, stats.graphB.graphCaptureMs]),
        },
        deterministic_gate: deterministic,
        prediction_gate: prediction,
        realized_accuracy: accuracy,
        model_signal_returns: returns,
        policy_gate: gate,
        threshold_margin_audit: audit,
        reason_difference_analysis: reasonAnalysis,
        probability_only_near_threshold: probabilityOnly,
        acceptability: {
          offline_raw_generation: offlineEconomicallyAcceptable
            ? "conditionally_acceptable"
            : "not_acceptable",
          live_service_replacement: replacementEligible
            ? "eligible_after_separate_approval"
            : "not_eligible",
          automatic_promotion: false,
        },
        provenance: {
          image: IMAGE,
          engine_sha256: ENGINE_SHA256,
          plugin_sha256: PLUGIN_SHA256,
        },
      };
      await writeJson(path.join(recorder.runDirectory, "qualification-summary.json"), summary);
      const report = [
        `# FinCast P40 FP32 ${DURATION_WEEKS}주 backend qualification`,
        "",
        `- Run: ${recorder.state.runId}`,
        `- Window: ${DURATION_HOURS}h ending ${recorder.state.config.endExclusive}`,
        `- Input: ${EXPECTED_ROWS.toLocaleString("en-US")} rows / ${EXPECTED_ORIGINS.toLocaleString("en-US")} origins / c60/B48`,
        `- CUDA Graph FP32: ${graphSeries.toFixed(3)} series/s`,
        `- TensorRT FP32: ${trtSeries.toFixed(3)} series/s`,
        `- Integrated speedup: ${speedupRatio.toFixed(4)}x (${((speedupRatio - 1) * 100).toFixed(2)}%)`,
        `- Process-wall speedup: ${e2eSpeedup.toFixed(4)}x`,
        `- Prediction gate: ${String(prediction.passed)}`,
        `- Realized direction accuracy (Graph / TRT): ${(numeric(object(accuracy.reference, "accuracy reference").direction_accuracy, "reference accuracy") * 100).toFixed(3)}% / ${(numeric(object(accuracy.candidate, "accuracy candidate").direction_accuracy, "candidate accuracy") * 100).toFixed(3)}%`,
        `- Probability-threshold return equivalence: ${String(returnGate.passed)} · max return Δ ${(numeric(returnGate.maximum_absolute_total_return_delta, "return delta") * 10_000).toFixed(4)} bp`,
        `- Policy gate: ${String(gate.passed)}`,
        `- Threshold crossings: ${String(audit.threshold_crossing_count)}`,
        `- Probability-only action differences: ${String(probabilityOnly.action_mismatch_count)} / ${String(probabilityOnly.decision_count)} (${(numeric(probabilityOnly.action_mismatch_rate, "probability-only mismatch rate") * 100).toFixed(4)}%)`,
        `- Reason acceptability (offline raw / live): ${String(reasonAssessment.acceptable_for_offline_raw_generation)} / ${String(reasonAssessment.acceptable_for_live_service_replacement)}`,
        `- Replacement eligible: ${String(replacementEligible)}`,
        "- Automatic promotion/deployment: disabled",
        "",
        "Every policy action's actual up_probability, threshold and signed margin is stored in policy-threshold-margins.jsonl.",
        "Every prediction/outlier/reason/economic decision detail is stored in backend-comparison-details.jsonl.",
        "",
      ].join("\n");
      await atomicWrite(path.join(recorder.runDirectory, "qualification-report.md"), report);
      await atomicWrite(
        path.join(recorder.runDirectory, "codex-handoff-prompt.md"),
        [
          `worker-1의 FinCast P40 FP32 ${DURATION_WEEKS}주 qualification 결과를 분석해줘.`,
          `run: ${recorder.runDirectory}`,
          `summary: ${path.join(recorder.runDirectory, "qualification-summary.json")}`,
          `policy: ${path.join(recorder.runDirectory, "policy-regression.json")}`,
          `margins: ${path.join(recorder.runDirectory, "policy-threshold-margins.jsonl")}`,
          `details: ${path.join(recorder.runDirectory, "backend-comparison-details.jsonl")}`,
          "TensorRT FP32의 실제 서비스 교체 가능성을 수치, 정책, reason, threshold crossing 기준으로 판정해줘.",
          "",
        ].join("\n"),
      );
      await recorder.persist();
      return replacementEligible
        ? `모든 gate 통과 · TensorRT FP32 ${speedupRatio.toFixed(3)}×`
        : `challenger rejected · TensorRT FP32 ${speedupRatio.toFixed(3)}× · offline 경제적 동등성=${String(offlineEconomicallyAcceptable)} · 상세 artifact 보존`;
    });

    const summary = object(
      JSON.parse(await readFile(
        path.join(recorder.runDirectory, "qualification-summary.json"),
        "utf8",
      )),
      "qualification summary",
    );
    await recorder.finish(
      summary.replacement_eligible === true ? "completed" : "completed_with_failures",
      summary.replacement_eligible === true
        ? `${DURATION_WEEKS}주 FP32 backend qualification을 통과했습니다.`
        : `${DURATION_WEEKS}주 측정을 완료했지만 TensorRT challenger는 하나 이상의 gate에서 거부되었습니다.`,
    );
  } catch (error) {
    await recorder.skipPending(`선행 단계 ${currentStep} 실패로 실행하지 않았습니다.`);
    await recorder.finish(
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    stopTelemetry();
  }
}

await main().catch((error) => {
  process.stderr.write(
    `fincast-p40-fp32-${DURATION_WEEKS}week-qualification-error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
