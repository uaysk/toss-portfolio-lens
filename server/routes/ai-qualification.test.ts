import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import type { RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
  AI_QUALIFICATION_STATE_SCHEMA_VERSION,
  type QualificationEvent,
  type QualificationState,
} from "../qualification/contracts.js";
import { createAiQualificationRouter } from "./ai-qualification.js";

const servers: Server[] = [];
const directories: string[] = [];

function fixtureState(runId: string): QualificationState {
  return {
    schemaVersion: AI_QUALIFICATION_STATE_SCHEMA_VERSION,
    runId,
    status: "running",
    createdAt: "2026-07-27T00:00:00.000Z",
    startedAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:00:02.000Z",
    deadlineAt: "2026-07-27T06:00:01.000Z",
    activeStepId: "replay-base-btc",
    config: {
      budgetHours: 6,
      durationHours: 48,
      endExclusive: "2026-07-27T00:00:00.000Z",
      symbols: ["BTCUSDT", "ETHUSDT"],
      gpu: "Tesla P40",
      cudaCapability: "6.1",
      workerMode: "docker-source",
      dockerBuild: false,
    },
    progress: {
      completedSteps: 1,
      failedSteps: 0,
      skippedSteps: 0,
      totalSteps: 2,
      percent: 50,
      activeStepPercent: 25,
      elapsedMs: 1_000,
      remainingBudgetMs: 21_599_000,
    },
    steps: [
      {
        id: "preflight",
        order: 1,
        label: "사전 점검",
        description: "GPU와 기존 이미지를 확인합니다.",
        model: "system",
        variant: "P40",
        status: "completed",
        estimatedDurationMs: 120_000,
        logFile: "logs/preflight.log",
      },
      {
        id: "replay-base-btc",
        order: 2,
        label: "BTC 기본 리플레이",
        description: "48시간 기준선을 측정합니다.",
        model: "comparison",
        variant: "base",
        status: "running",
        estimatedDurationMs: 6_600_000,
        logFile: "logs/replay-base-btc.log",
      },
    ],
    artifacts: {
      summaryJson: "qualification-summary.json",
      reportMarkdown: "qualification-report.md",
      handoffPrompt: "codex-handoff-prompt.md",
    },
  };
}

function benchmarkState(runId: string): QualificationState {
  const state = fixtureState(runId);
  const cadences = [60, 30, 15, 5] as const;
  const combination = (
    model: "fincast" | "chronos-2",
    contextBars: 512 | 1024 | 2048 | 4096 | 8192,
    cadenceSeconds: 5 | 15 | 30 | 60,
  ) => {
    const id = `${model === "fincast" ? "fincast" : "chronos2"}-c${contextBars}-s${cadenceSeconds}`;
    const followup = id === "chronos2-c8192-s5";
    return {
    id,
    model,
    contextBars,
    cadenceSeconds,
    lookbackSeconds: contextBars * cadenceSeconds,
    predictionLengthSteps: ({ 60: 60, 30: 120, 15: 240, 5: 720 } as const)[cadenceSeconds],
    planRole: followup ? "followup_only" as const : "conditional" as const,
    dependencyIds: [],
    screeningComparatorIds: [],
    status: followup ? "followup_only" as const : "queued" as const,
    screeningDecision: followup ? "followup_only" as const : "pending" as const,
    screeningStatus: followup ? "followup_only" as const : "not_started" as const,
    smokeStatus: followup ? "not_run" as const : "not_started" as const,
    screeningReason: followup
      ? "이번 자동 pipeline에서는 실행하지 않고 후속 후보로만 기록"
      : null,
    screeningTriggerReason: null,
    selectedForFinal: false,
    completedOrigins: 0,
    totalOrigins: 0,
    progressPercent: 0,
    attempt: 0,
    currentSymbol: null,
    currentOrigin: null,
    elapsedMs: 0,
    etaMs: null,
    retryCount: 0,
    failureReason: null,
    };
  };
  state.config.budgetHours = 504;
  state.config.durationHours = 504;
  state.experiment = {
    kind: "cadence-context-3week-benchmark",
    phase: "prepare",
    evaluationDays: 21,
    evaluationStart: "2026-07-06T00:00:00.000Z",
    evaluationEndExclusive: "2026-07-27T00:00:00.000Z",
    originIntervalMinutes: 15,
    screeningOriginIntervalMinutes: 30,
    horizonsMinutes: [5, 15, 30, 60],
    featureProfile: "compact_causal_v1",
    crossLearning: false,
    selectedPlanReady: false,
    selectedCombinationCount: 0,
    totalCombinationCount: 20,
    screeningPolicyVersion: "cadence-context-screening-policy/v2",
    defaultFinalCombinationIds: [],
    conditionalCombinationIds: [],
    followupCandidateIds: [],
    failedFinalCombinationIds: [],
    currentCombinationId: null,
    currentSymbol: null,
    currentOrigin: null,
    screeningWindows: [],
    combinations: [
      ...cadences.map((cadence) => combination("fincast", 512, cadence)),
      ...([1024, 2048, 4096, 8192] as const).flatMap((context) => (
        cadences.map((cadence) => combination("chronos-2", context, cadence))
      )),
    ],
    matchedLookbackCombinationIds: [
      "chronos2-c1024-s60",
      "chronos2-c2048-s30",
      "chronos2-c4096-s15",
    ],
    fiveSecondLookbackNote: "8192×5초는 약 17시간 matched lookback이 아닙니다.",
    dataRowsProcessed: 0,
    inferenceOriginsProcessed: 0,
    dataThroughputRowsPerSecond: null,
    inferenceThroughputOriginsPerSecond: null,
    recentLogLines: [],
  };
  return state;
}

async function fixtureRoot(runId = "p40-20260727-test"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ai-qualification-route-"));
  directories.push(root);
  const state = fixtureState(runId);
  const event: QualificationEvent = {
    schemaVersion: AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
    sequence: 1,
    runId,
    at: "2026-07-27T00:00:02.000Z",
    type: "step_started",
    message: "BTC 기본 리플레이를 시작했습니다.",
    stepId: "replay-base-btc",
    progressPercent: 50,
  };
  await mkdir(path.join(root, runId), { recursive: true });
  await writeFile(path.join(root, "latest.json"), `${JSON.stringify({ runId })}\n`);
  await writeFile(path.join(root, runId, "state.json"), `${JSON.stringify(state)}\n`);
  await writeFile(path.join(root, runId, "events.jsonl"), `${JSON.stringify(event)}\n`);
  return root;
}

async function start(
  root: string,
  authenticate: RequestHandler = (_request, _response, next) => next(),
) {
  const router = createAiQualificationRouter({
    authenticate,
    runRoot: root,
    pollIntervalMs: 250,
    heartbeatMs: 1_000,
  });
  const app = createApp({
    trustProxy: [],
    routeRegistrars: [(application) => application.use(router)],
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address is unavailable.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("AI qualification progress routes", () => {
  it("returns the latest validated state and events without caching", async () => {
    const root = await fixtureRoot();
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/latest`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const payload = await response.json() as { state: QualificationState; events: QualificationEvent[] };
    expect(payload.state.runId).toBe("p40-20260727-test");
    expect(payload.state.progress.percent).toBe(50);
    expect(payload.events.map((event) => event.sequence)).toEqual([1]);
  });

  it("returns the complete cadence/context matrix through the live status API", async () => {
    const root = await fixtureRoot("cadence-context-api-test");
    const state = benchmarkState("cadence-context-api-test");
    if (state.experiment?.kind !== "cadence-context-3week-benchmark") {
      throw new Error("unexpected experiment");
    }
    const screened = state.experiment.combinations.find(
      (combination) => combination.id === "chronos2-c2048-s15",
    );
    if (!screened) throw new Error("screened combination fixture is missing");
    screened.screeningDecision = "passed";
    screened.screeningStatus = "completed";
    screened.screeningReason = "공통 screening의 거래 성능 경로를 통과";
    screened.executionOptimizationVersion = "chronos2-fixed-batch-prefetch-v1";
    screened.inferenceBatchSize = 4;
    Object.assign(screened, {
      futureRunnerDiagnostic: {
        source: "additive-producer-metadata",
      },
    });
    await writeFile(
      path.join(root, "cadence-context-api-test", "state.json"),
      `${JSON.stringify(state)}\n`,
    );
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/latest`);
    const payload = await response.json() as { state: QualificationState };

    expect(response.status).toBe(200);
    expect(payload.state.experiment?.kind).toBe("cadence-context-3week-benchmark");
    if (payload.state.experiment?.kind !== "cadence-context-3week-benchmark") {
      throw new Error("unexpected experiment");
    }
    expect(payload.state.experiment.combinations).toHaveLength(20);
    expect(payload.state.experiment.combinations).toContainEqual(
      expect.objectContaining({
        id: "chronos2-c2048-s15",
        screeningDecision: "passed",
        executionOptimizationVersion: "chronos2-fixed-batch-prefetch-v1",
        inferenceBatchSize: 4,
        futureRunnerDiagnostic: {
          source: "additive-producer-metadata",
        },
      }),
    );
    expect(payload.state.experiment.combinations.at(-1)).toMatchObject({
      id: "chronos2-c8192-s5",
      predictionLengthSteps: 720,
      status: "followup_only",
      screeningDecision: "followup_only",
    });
  });

  it("returns a projected high-volatility profitability run through the shared API", async () => {
    const runId = "high-vol-profitability-api-test";
    const root = await fixtureRoot(runId);
    const state = fixtureState(runId);
    state.config.durationHours = 1_056;
    state.config.symbols = ["SOLUSDT", "DOGEUSDT", "XRPUSDT"];
    state.experiment = {
      kind: "high-volatility-profitability-backtest",
      phase: "infer-chronos2",
      evaluationStart: "2026-06-15T00:00:00.000Z",
      evaluationEndExclusive: "2026-07-29T00:00:00.000Z",
      calibrationStart: "2026-06-01T00:00:00.000Z",
      originIntervalMinutes: 15,
      horizonsMinutes: [5, 15, 30, 60],
      candidateUniverse: ["SOLUSDT", "DOGEUSDT", "XRPUSDT"],
      usableCandidates: ["SOLUSDT", "DOGEUSDT"],
      scannerTopCount: 5,
      modelSelectorCandidateCount: 3,
      models: {
        chronos2: {
          role: "primary",
          modelId: "amazon/chronos-2",
          modelRevision: "chronos-revision",
          contextBars: 2_048,
          cadenceSeconds: 60,
          status: "running",
          completed: 12,
          total: 40,
          retries: 0,
        },
        fincast: {
          role: "veto",
          modelId: "Vincent05R/FinCast",
          modelRevision: "fincast-revision",
          contextBars: 512,
          cadenceSeconds: 60,
          status: "queued",
          completed: 0,
          total: 40,
          retries: 0,
        },
      },
      completedOrigins: 12,
      totalOrigins: 40,
      currentSymbol: "SOLUSDT",
      currentOrigin: "2026-06-15T03:00:00.000Z",
      policyVersions: {
        selector: "high-volatility-stack-policy/v2",
        vetoCalibration: "fincast-veto-probability-calibration/v1",
      },
      dataErrorCount: 0,
      failureReason: null,
      recentLogLines: ["Chronos-2 origin 12/40"],
      results: null,
    };
    await writeFile(
      path.join(root, runId, "state.json"),
      `${JSON.stringify(state)}\n`,
    );
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/latest`);
    const payload = await response.json() as { state: QualificationState };

    expect(response.status).toBe(200);
    expect(payload.state.experiment).toMatchObject({
      kind: "high-volatility-profitability-backtest",
      phase: "infer-chronos2",
      currentSymbol: "SOLUSDT",
      dataErrorCount: 0,
    });
  });

  it("keeps known cadence execution fields validated while accepting additive metadata", async () => {
    const runId = "cadence-context-invalid-batch-test";
    const root = await fixtureRoot(runId);
    const state = benchmarkState(runId);
    if (state.experiment?.kind !== "cadence-context-3week-benchmark") {
      throw new Error("unexpected experiment");
    }
    Object.assign(state.experiment.combinations[0]!, {
      inferenceBatchSize: 0,
      futureRunnerDiagnostic: "allowed",
    });
    await writeFile(
      path.join(root, runId, "state.json"),
      `${JSON.stringify(state)}\n`,
    );
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/latest`);
    const payload = await response.json() as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(500);
    expect(payload.error.code).toBe("qualification-state-invalid");
    expect(payload.error.message).toContain("대시보드 계약");
  });

  it("accepts resumed-run state and events without breaking the latest endpoint", async () => {
    const runId = "cadence-context-resumed-api-test";
    const root = await fixtureRoot(runId);
    const state = benchmarkState(runId);
    state.resumeCount = 1;
    const resumed: QualificationEvent = {
      schemaVersion: AI_QUALIFICATION_EVENT_SCHEMA_VERSION,
      sequence: 2,
      runId,
      at: "2026-07-29T05:06:53.412Z",
      type: "run_resumed",
      message: "실패 이력을 보존하고 benchmark pipeline을 재개했습니다.",
    };
    await writeFile(
      path.join(root, runId, "state.json"),
      `${JSON.stringify(state)}\n`,
    );
    await writeFile(
      path.join(root, runId, "events.jsonl"),
      `${JSON.stringify(resumed)}\n`,
    );
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/latest`);
    const payload = await response.json() as {
      state: QualificationState;
      events: QualificationEvent[];
    };

    expect(response.status).toBe(200);
    expect(payload.state.resumeCount).toBe(1);
    expect(payload.events).toEqual([resumed]);
  });

  it("streams the current snapshot and ordered progress events over SSE", async () => {
    const root = await fixtureRoot();
    const baseUrl = await start(root);
    const controller = new AbortController();

    const response = await fetch(
      `${baseUrl}/api/ai-qualification/runs/p40-20260727-test/events`,
      { signal: controller.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response body is unavailable.");
    const decoder = new TextDecoder();
    let received = "";
    for (let index = 0; index < 4 && !received.includes("event: progress"); index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();

    expect(received).toContain("event: snapshot");
    expect(received).toContain("id: 1");
    expect(received).toContain("event: progress");
    expect(received).toContain("replay-base-btc");
  });

  it("does not expose state without the dashboard session guard", async () => {
    const root = await fixtureRoot();
    const authenticate = vi.fn<RequestHandler>((_request, response) => {
      response.status(401).json({ error: { code: "authentication-required" } });
    });
    const baseUrl = await start(root, authenticate);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/latest`);

    expect(response.status).toBe(401);
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("rejects path-shaped run identifiers as not found", async () => {
    const root = await fixtureRoot();
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/%2e%2e`);

    expect(response.status).toBe(404);
  });

  it("rejects a run directory symlink even when its target contains valid state", async () => {
    const root = await fixtureRoot();
    const target = path.join(root, "real-run");
    await mkdir(target);
    await writeFile(
      path.join(target, "state.json"),
      `${JSON.stringify(fixtureState("linked-run"))}\n`,
    );
    await symlink(target, path.join(root, "linked-run"));
    const baseUrl = await start(root);

    const response = await fetch(`${baseUrl}/api/ai-qualification/runs/linked-run`);

    expect(response.status).toBe(404);
  });

  it("serves bounded run artifacts and rejects traversal or symlinks", async () => {
    const root = await fixtureRoot();
    const run = path.join(root, "p40-20260727-test");
    await writeFile(path.join(run, "qualification-summary.json"), "{\"ok\":true}\n");
    const outside = path.join(root, "outside.json");
    await writeFile(outside, "{\"secret\":true}\n");
    await symlink(outside, path.join(run, "linked.json"));
    const baseUrl = await start(root);

    const valid = await fetch(
      `${baseUrl}/api/ai-qualification/runs/p40-20260727-test/artifact?path=qualification-summary.json`,
    );
    expect(valid.status).toBe(200);
    expect(valid.headers.get("cache-control")).toContain("no-store");
    expect(await valid.json()).toEqual({ ok: true });

    const traversal = await fetch(
      `${baseUrl}/api/ai-qualification/runs/p40-20260727-test/artifact?path=../outside.json`,
    );
    expect(traversal.status).toBe(404);
    const linked = await fetch(
      `${baseUrl}/api/ai-qualification/runs/p40-20260727-test/artifact?path=linked.json`,
    );
    expect(linked.status).toBe(404);
  });
});
