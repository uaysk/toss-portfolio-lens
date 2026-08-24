import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  CadenceContextCombination,
  QualificationState,
} from "@/lib/ai-qualification";
import {
  AiQualificationRunView,
  QUALIFICATION_POLL_INTERVAL_MS,
  QUALIFICATION_POLL_MAX_INTERVAL_MS,
  nextQualificationPollInterval,
  shouldPollAiQualification,
} from "./ai-qualification-dashboard";

function state(): QualificationState {
  return {
    schemaVersion: "ai-p40-qualification-state/v1",
    runId: "p40-ui-test",
    status: "running",
    createdAt: "2026-07-27T00:00:00.000Z",
    startedAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:10:00.000Z",
    deadlineAt: "2026-07-27T06:00:01.000Z",
    activeStepId: "replay-base-btcusdt",
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
      percent: 32.5,
      activeStepPercent: 24,
      elapsedMs: 600_000,
      remainingBudgetMs: 21_000_000,
    },
    steps: [
      {
        id: "preflight",
        order: 1,
        label: "P40 사전 점검",
        description: "GPU를 점검합니다.",
        model: "system",
        variant: "docker-build=false",
        status: "completed",
        estimatedDurationMs: 120_000,
        durationMs: 20_000,
        logFile: "logs/preflight.log",
      },
      {
        id: "replay-base-btcusdt",
        order: 2,
        label: "BTCUSDT 기준선 리플레이",
        description: "두 모델을 비교합니다.",
        model: "comparison",
        variant: "base",
        status: "running",
        estimatedDurationMs: 6_600_000,
        logFile: "logs/replay.log",
      },
    ],
    artifacts: {
      summaryJson: "qualification-summary.json",
      reportMarkdown: "qualification-report.md",
      handoffPrompt: "codex-handoff-prompt.md",
    },
    telemetry: {
      polledAt: "2026-07-27T00:10:00.000Z",
      gpuUtilizationPercent: 94,
      memoryUsedMiB: 18_432,
      memoryTotalMiB: 24_576,
      temperatureC: 71,
    },
  };
}

describe("AI qualification dashboard", () => {
  it("polls only for visible discovery or explicit SSE fallback", () => {
    expect(shouldPollAiQualification("connecting", "visible")).toBe(true);
    expect(shouldPollAiQualification("polling", "visible")).toBe(true);
    expect(shouldPollAiQualification("polling", "hidden")).toBe(false);
    expect(shouldPollAiQualification("live", "visible")).toBe(false);
    expect(shouldPollAiQualification("terminal", "visible")).toBe(false);
  });

  it("backs failed polling off within a bounded interval and resets after recovery", () => {
    expect(nextQualificationPollInterval(QUALIFICATION_POLL_INTERVAL_MS, "error")).toBe(10_000);
    expect(nextQualificationPollInterval(20_000, "error")).toBe(QUALIFICATION_POLL_MAX_INTERVAL_MS);
    expect(nextQualificationPollInterval(QUALIFICATION_POLL_MAX_INTERVAL_MS, "error"))
      .toBe(QUALIFICATION_POLL_MAX_INTERVAL_MS);
    expect(nextQualificationPollInterval(20_000, "success")).toBe(QUALIFICATION_POLL_INTERVAL_MS);
    expect(nextQualificationPollInterval(20_000, "missing")).toBe(QUALIFICATION_POLL_INTERVAL_MS);
    expect(nextQualificationPollInterval(20_000, "busy")).toBe(QUALIFICATION_POLL_INTERVAL_MS);
  });

  it("renders the live P40 progress, active step, GPU telemetry, and event", () => {
    const markup = renderToStaticMarkup(
      <AiQualificationRunView
        state={state()}
        events={[{
          schemaVersion: "ai-p40-qualification-event/v1",
          sequence: 2,
          runId: "p40-ui-test",
          at: "2026-07-27T00:09:59.000Z",
          type: "step_started",
          message: "BTCUSDT 기준선 리플레이를 시작했습니다.",
        }]}
        connection="live"
      />,
    );

    expect(markup).toContain("SSE LIVE · 1초");
    expect(markup).toContain("32.5");
    expect(markup).toContain("BTCUSDT 기준선 리플레이");
    expect(markup).toContain("94%");
    expect(markup).toContain("18.0 GB");
    expect(markup).toContain("BF16 미사용");
  });

  it("restructures the monitor for the c60/B48 five-week FP32 backend comparison", () => {
    const comparison = state();
    comparison.experiment = {
      kind: "fincast-fp32-backend-comparison",
      durationWeeks: 5,
      cadenceSeconds: 60,
      batchSize: 48,
      referenceBackend: "cuda_graph",
      candidateBackend: "tensorrt_fp32",
      routingPolicy: "row-id-stateless-uniform/v1",
      thresholdMarginArtifact: "policy-threshold-margins.jsonl",
      rowCount: 6_720,
      originCount: 3_360,
      metrics: {
        cudaGraphSeriesPerSecond: 206.45,
        tensorRtSeriesPerSecond: 246.45,
        speedupRatio: 1.1938,
        speedupPercent: 19.38,
        directionMatchRate: 0.9987,
        policyActionMismatches: 0,
        policyReasonMismatches: 5,
        thresholdMarginRecordCount: 268_800,
        thresholdCrossingCount: 5,
        probabilityOnlyDecisionCount: 268_800,
        probabilityOnlyActionMismatchRate: 5 / 268_800,
        probabilityOutlier1ppCount: 223,
        probabilityOutlier5ppCount: 19,
        probabilityOutlier10ppCount: 1,
        maximumProbabilityDelta: 0.119_742,
        realizedDirectionDisagreements: 26,
        closestReferenceMargin: 0.000_001,
        closestCandidateMargin: 0.000_002,
        referenceRealizedDirectionAccuracy: 0.5112,
        candidateRealizedDirectionAccuracy: 0.5111,
        maximumReturnDelta: 0.000_04,
        maximumDrawdownDelta: 0.000_02,
        symbolAlignedActionMismatches: 0,
        symbolAlignedReasonMismatches: 7,
        offlineEconomicallyAcceptable: true,
      },
    };
    comparison.steps = [
      {
        ...comparison.steps[0]!,
        id: "cuda-graph-a",
        label: "CUDA Graph FP32 · pass A",
        variant: "cuda_graph · c60/B48 · A",
      },
      {
        ...comparison.steps[1]!,
        id: "tensorrt-a",
        label: "TensorRT FP32 · pass A",
        variant: "tensorrt_fp32 · c60/B48 · A",
      },
    ];

    const markup = renderToStaticMarkup(
      <AiQualificationRunView state={comparison} events={[]} connection="live" />,
    );

    expect(markup).toContain("FinCast FP32 5주 백엔드 검증");
    expect(markup).toContain("CUDA Graph FP32");
    expect(markup).toContain("TensorRT FP32");
    expect(markup).toContain("1.194×");
    expect(markup).toContain("268800 rows");
    expect(markup).toContain("11.9742pp / 26");
    expect(markup).toContain("223 /");
    expect(markup).toContain("조건부 통과");
    expect(markup).toContain("FP32 only · stateless routing");
  });

  it("renders the Chronos-2 context pilot gate and per-context measurements", () => {
    const comparison = state();
    comparison.config.durationHours = 840;
    comparison.experiment = {
      kind: "chronos2-context-window-comparison",
      phase: "pilot",
      durationWeeks: 5,
      cadenceSeconds: 60,
      profile: "close_only",
      crossLearning: false,
      contexts: [512, 1024, 2048, 4096, 8192],
      batchCandidates: [1, 2, 4, 8, 12, 16, 24, 32, 48, 50],
      backendCandidates: ["pipeline_eager", "worker_local", "no_padding", "gpu_gather"],
      automaticLivePromotion: false,
      resultStatus: null,
      metrics: {
        pilotGatePassed: true,
        estimatedFullDurationUpperMs: 7_200_000,
        projectedDiskFreeGiB: 51.25,
        selectedContextBars: null,
        contextResults: [{
          contextBars: 512,
          status: "passed",
          progressPercent: 100,
          batchSize: 32,
          backend: "gpu_gather",
          latencyP95Ms: 52.1,
          tasksPerSecond: 19.2,
          minimumFreeVramBytes: 8 * 2 ** 30,
          maximumPowerW: 158.2,
          maximumTemperatureC: 71,
          artifactDigest: "a".repeat(64),
        }],
      },
    };

    const markup = renderToStaticMarkup(
      <AiQualificationRunView state={comparison} events={[]} connection="polling" />,
    );

    expect(markup).toContain("Chronos-2 Context Window pilot 검증");
    expect(markup).toContain("5개 / close");
    expect(markup).toContain("gpu_gather · B32");
    expect(markup).toContain("pilot gate");
    expect(markup).toContain("51.3 GiB");
    expect(markup).toContain("live 512 유지");
  });

  it("renders the live 3-week cadence/context screening matrix and resource telemetry", () => {
    const benchmark = state();
    benchmark.config.durationHours = 504;
    benchmark.config.budgetHours = 504;
    benchmark.telemetry = {
      ...benchmark.telemetry!,
      cpuUtilizationPercent: 37,
      ramUsedMiB: 32_768,
      ramTotalMiB: 65_536,
      inferenceOriginsPerSecond: 0.42,
    };
    const buildCombination = (
      model: "fincast" | "chronos-2",
      contextBars: CadenceContextCombination["contextBars"],
      cadenceSeconds: CadenceContextCombination["cadenceSeconds"],
    ): CadenceContextCombination => {
      const id = `${model === "fincast" ? "fincast" : "chronos2"}-c${contextBars}-s${cadenceSeconds}`;
      const current = id === "chronos2-c2048-s5";
      const followup = id === "chronos2-c8192-s5";
      return {
      id,
      model,
      contextBars,
      cadenceSeconds,
      lookbackSeconds: contextBars * cadenceSeconds,
      predictionLengthSteps: ({ 60: 60, 30: 120, 15: 240, 5: 720 } as const)[cadenceSeconds],
      planRole: followup ? "followup_only" : current ? "conditional" : "default",
      dependencyIds: current ? [] : undefined,
      screeningComparatorIds: current
        ? ["chronos2-c1024-s15", "chronos2-c4096-s15"]
        : undefined,
      status: followup ? "followup_only" : current ? "running" : "queued",
      screeningDecision: followup
        ? "followup_only"
        : id === "chronos2-c2048-s15"
          ? "passed"
          : cadenceSeconds === 60
            ? "included"
            : "pending",
      screeningStatus: followup ? "followup_only" : current ? "running" : "completed",
      smokeStatus: followup ? "not_run" : "completed",
      screeningReason: cadenceSeconds === 60 ? "기본 포함 matrix이며 기술적 실패가 없음" : null,
      selectedForFinal: cadenceSeconds === 60,
      completedOrigins: current ? 24 : 0,
      totalOrigins: current ? 288 : 0,
      progressPercent: current ? 8.3 : 0,
      attempt: current ? 1 : 0,
      currentSymbol: current ? "BTCUSDT" : null,
      currentOrigin: current ? "2026-06-23T00:29:59.999Z" : null,
      elapsedMs: 120_000,
      etaMs: current ? 1_320_000 : null,
      latencyP95Ms: current ? 4_500 : null,
      peakVramMiB: current ? 21_504 : null,
      peakRamMiB: 32_768,
      executionOptimizationVersion: current
        ? "chronos2-fixed-batch-prefetch-v1"
        : undefined,
      inferenceBatchSize: current ? 4 : undefined,
      retryCount: 0,
      failureReason: null,
      partialPrediction: current
        ? { count: 96, wis: 0.0042, directionAccuracy: 0.54 }
        : null,
      partialTrading: current
        ? { netReturn: 0.012, tradeCount: 8 }
        : null,
      };
    };
    const cadences = [60, 30, 15, 5] as const;
    const combinations: CadenceContextCombination[] = [
      ...cadences.map((cadence) => buildCombination("fincast", 512, cadence)),
      ...([1024, 2048, 4096, 8192] as const).flatMap((context) => (
        cadences.map((cadence) => buildCombination("chronos-2", context, cadence))
      )),
    ];
    benchmark.experiment = {
      kind: "cadence-context-3week-benchmark",
      phase: "screen",
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
      defaultFinalCombinationIds: combinations.filter((item) => item.planRole === "default").slice(0, 10).map((item) => item.id),
      conditionalCombinationIds: ["chronos2-c2048-s5"],
      followupCandidateIds: [],
      failedFinalCombinationIds: [],
      currentCombinationId: "chronos2-c2048-s5",
      currentSymbol: "BTCUSDT",
      currentOrigin: "2026-06-23T00:29:59.999Z",
      screeningWindows: [{
        regime: "low",
        start: "2026-06-23T00:00:00.000Z",
        endExclusive: "2026-06-24T00:00:00.000Z",
        realizedVolatility: 0.031,
      }],
      combinations,
      matchedLookbackCombinationIds: [
        "chronos2-c1024-s60",
        "chronos2-c2048-s30",
        "chronos2-c4096-s15",
      ],
      fiveSecondLookbackNote: "8192×5초는 약 17시간 matched-lookback과 동일하지 않습니다.",
      dataRowsProcessed: 82,
      inferenceOriginsProcessed: 24,
      dataThroughputRowsPerSecond: 1.25,
      inferenceThroughputOriginsPerSecond: 0.42,
      recentLogLines: ["2026-07-29T00:00:00.000Z Chronos-2 screening running"],
    };

    const markup = renderToStaticMarkup(
      <AiQualificationRunView state={benchmark} events={[]} connection="live" />,
    );

    expect(markup).toContain("cadence/context 3주 benchmark");
    expect(markup).toContain('data-benchmark-combination="chronos2-c8192-s5"');
    expect(markup).toContain("followup_only");
    expect(markup).toContain('data-screening-decision="followup_only"');
    expect(markup).toContain('data-screening-decision="passed"');
    expect(markup).toContain("8192×5초는 약 17시간");
    expect(markup).toContain("720 step");
    expect(markup).toContain("32.0 GB");
    expect(markup).toContain("BTCUSDT");
    expect(markup).toContain("Chronos-2 screening running");
    expect(markup).toContain("chronos2-fixed-batch-prefetch-v1");
    expect(markup).toContain("B4");
  });

  it("renders the high-volatility profitability pipeline in the shared dashboard", () => {
    const profitability = state();
    profitability.config.durationHours = 1_056;
    profitability.config.symbols = ["SOLUSDT", "DOGEUSDT", "XRPUSDT"];
    profitability.activeStepId = "infer-chronos2";
    profitability.steps = [{
      ...profitability.steps[1]!,
      id: "infer-chronos2",
      label: "Chronos-2 primary 추론",
      model: "chronos-2",
      variant: "c2048-s60-primary",
    }];
    profitability.experiment = {
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
      results: {
        chronos2Rust: {
          grossReturn: 0.02,
          netReturn: 0.01,
          sharpe: 0.8,
          maxDrawdown: 0.03,
          tradeCount: 5,
        },
        chronos2FincastVetoRust: {
          grossReturn: 0.03,
          netReturn: 0.018,
          sharpe: 1.1,
          maxDrawdown: 0.025,
          tradeCount: 4,
          vetoCount: 2,
        },
      },
    };

    const markup = renderToStaticMarkup(
      <AiQualificationRunView
        state={profitability}
        events={[]}
        connection="polling"
      />,
    );

    expect(markup).toContain("data-high-vol-profitability-dashboard");
    expect(markup).toContain("고변동성 암호화폐 모델 스택 수익성 검증");
    expect(markup).toContain("point-in-time top-5");
    expect(markup).toContain("amazon/chronos-2");
    expect(markup).toContain("primary");
    expect(markup).toContain("veto");
    expect(markup).toContain("SOLUSDT");
    expect(markup).toContain("1.80%");
    expect(markup).toContain("Chronos-2 primary · FinCast veto · Rust quality");
  });
});
