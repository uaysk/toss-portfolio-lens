export type QualificationRunStatus =
  | "planned"
  | "running"
  | "completed"
  | "completed_with_failures"
  | "failed"
  | "cancelled"
  | "budget_exhausted";

export type QualificationStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type QualificationStep = {
  id: string;
  order: number;
  label: string;
  description: string;
  model: "system" | "chronos-2" | "fincast" | "comparison";
  variant: string;
  status: QualificationStepStatus;
  estimatedDurationMs: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  outputFile?: string;
  logFile: string;
  summary?: string;
  error?: string;
};

export type CadenceContextCombinationStatus =
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "retrying"
  | "failed"
  | "excluded"
  | "followup_only"
  | "dependency_failed";

export type CadenceContextCombination = {
  id: string;
  model: "fincast" | "chronos-2";
  contextBars: 512 | 1024 | 2048 | 4096 | 8192;
  cadenceSeconds: 5 | 15 | 30 | 60;
  lookbackSeconds: number;
  predictionLengthSteps: 60 | 120 | 240 | 720;
  planRole?: "default" | "conditional" | "excluded" | "followup_only";
  dependencyIds?: string[];
  screeningComparatorIds?: string[];
  status: CadenceContextCombinationStatus;
  screeningDecision:
    | "pending"
    | "included"
    | "passed"
    | "excluded"
    | "borderline"
    | "followup_only";
  screeningStatus?:
    | "not_started"
    | "running"
    | "completed"
    | "failed"
    | "not_required"
    | "not_triggered"
    | "dependency_failed"
    | "followup_only";
  smokeStatus?: "not_started" | "completed" | "failed" | "not_run";
  screeningReason: string | null;
  screeningTriggerReason?: string | null;
  selectedForFinal: boolean;
  completedOrigins: number;
  totalOrigins: number;
  progressPercent: number;
  attempt: number;
  currentSymbol: "BTCUSDT" | "ETHUSDT" | null;
  currentOrigin: string | null;
  elapsedMs: number;
  etaMs: number | null;
  latencyP50Ms?: number | null;
  latencyP95Ms?: number | null;
  throughputOriginsPerSecond?: number | null;
  peakVramMiB?: number | null;
  peakRamMiB?: number | null;
  executionOptimizationVersion?: string;
  inferenceBatchSize?: number;
  retryCount: number;
  failureReason: string | null;
  partialPrediction?: {
    count: number;
    mae?: number | null;
    rmse?: number | null;
    meanPinballLoss?: number | null;
    wis?: number | null;
    coverage?: number | null;
    calibrationError?: number | null;
    directionAccuracy?: number | null;
  } | null;
  partialTrading?: {
    grossReturn?: number;
    netReturn?: number;
    sharpe?: number | null;
    maxDrawdown?: number | null;
    winRate?: number | null;
    tradeCount?: number;
    turnover?: number;
    averageHoldingMinutes?: number | null;
    costDrag?: number;
  } | null;
};

export type HighVolatilityModelLane = {
  role: "primary" | "veto";
  modelId: string;
  modelRevision: string | null;
  contextBars: number;
  cadenceSeconds: 5 | 15 | 30 | 60;
  status: "queued" | "running" | "completed" | "failed" | "unavailable";
  completed: number;
  total: number;
  retries: number;
};

export type HighVolatilityResultMetrics = {
  grossReturn?: number;
  netReturn?: number;
  sharpe?: number | null;
  maxDrawdown?: number | null;
  turnover?: number;
  tradeCount?: number;
  vetoCount?: number;
};

export type HighVolatilityProfitabilityExperiment = {
  kind: "high-volatility-profitability-backtest";
  phase:
    | "prepare"
    | "load-data"
    | "scan"
    | "infer-chronos2"
    | "infer-fincast"
    | "materialize"
    | "source-complete"
    | "rust-evidence"
    | "selector"
    | "policy-backtest"
    | "aggregate"
    | "complete"
    | "failed"
    | "cancelled";
  evaluationStart: string;
  evaluationEndExclusive: string;
  calibrationStart: string;
  originIntervalMinutes: 15;
  horizonsMinutes: [5, 15, 30, 60];
  candidateUniverse: string[];
  usableCandidates: string[];
  scannerTopCount: 5;
  modelSelectorCandidateCount: 3;
  models: {
    chronos2: HighVolatilityModelLane;
    fincast: HighVolatilityModelLane;
  };
  completedOrigins: number;
  totalOrigins: number;
  currentSymbol: string | null;
  currentOrigin: string | null;
  policyVersions: {
    selector: string;
    vetoCalibration: string;
  };
  dataErrorCount: number;
  failureReason: string | null;
  recentLogLines: string[];
  results: {
    chronos2Rust: HighVolatilityResultMetrics | null;
    chronos2FincastVetoRust: HighVolatilityResultMetrics | null;
  } | null;
};

export type QualificationState = {
  schemaVersion: "ai-p40-qualification-state/v1";
  runId: string;
  status: QualificationRunStatus;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  resumeCount?: number;
  deadlineAt: string;
  activeStepId: string | null;
  config: {
    budgetHours: number;
    durationHours: number;
    endExclusive: string;
    symbols: string[];
    gpu: "Tesla P40";
    cudaCapability: "6.1";
    workerMode: "docker-source" | "external";
    dockerBuild: boolean;
  };
  progress: {
    completedSteps: number;
    failedSteps: number;
    skippedSteps: number;
    totalSteps: number;
    percent: number;
    activeStepPercent: number | null;
    elapsedMs: number;
    remainingBudgetMs: number;
  };
  steps: QualificationStep[];
  artifacts: {
    summaryJson: string;
    reportMarkdown: string;
    handoffPrompt: string;
  };
  experiment?: {
    kind: "fincast-fp32-backend-comparison";
    durationWeeks: number;
    cadenceSeconds: 60;
    batchSize: 48;
    referenceBackend: "cuda_graph";
    candidateBackend: "tensorrt_fp32";
    routingPolicy: "row-id-stateless-uniform/v1";
    thresholdMarginArtifact: string;
    detailArtifact?: string;
    rowCount?: number;
    originCount?: number;
    metrics?: {
      cudaGraphSeriesPerSecond?: number;
      tensorRtSeriesPerSecond?: number;
      speedupRatio?: number;
      speedupPercent?: number;
      cudaGraphEndToEndSeriesPerSecond?: number;
      tensorRtEndToEndSeriesPerSecond?: number;
      endToEndSpeedupRatio?: number;
      directionMatchRate?: number;
      q50ErrorIqrMedian?: number;
      q50ErrorIqrP95?: number;
      policyActionMismatches?: number;
      policyReasonMismatches?: number;
      thresholdMarginRecordCount?: number;
      thresholdCrossingCount?: number;
      probabilityOnlyDecisionCount?: number;
      probabilityOnlyActionMismatchRate?: number;
      probabilityOutlier1ppCount?: number;
      probabilityOutlier5ppCount?: number;
      probabilityOutlier10ppCount?: number;
      maximumProbabilityDelta?: number;
      realizedDirectionDisagreements?: number;
      closestReferenceMargin?: number;
      closestCandidateMargin?: number;
      referenceRealizedDirectionAccuracy?: number;
      candidateRealizedDirectionAccuracy?: number;
      maximumReturnDelta?: number;
      maximumDrawdownDelta?: number;
      modelSignalDecisionMismatches?: number;
      symbolAlignedActionMismatches?: number;
      symbolAlignedReasonMismatches?: number;
      offlineEconomicallyAcceptable?: boolean;
    };
  } | {
    kind: "chronos2-fincast-model-comparison";
    mode: "pilot" | "full";
    durationWeeks: number;
    cadenceSeconds: 60;
    profiles: [
      "close_only",
      "ohlcv_calendar",
      "microstructure_calendar",
      "derivatives_calendar",
    ];
    referenceModel: "fincast";
    candidateModel: "chronos-2";
    referenceBackend: "cuda_graph";
    candidateBackend: string | null;
    automaticLivePromotion: false;
    metrics?: {
      selectedProfile?: "close_only" | "ohlcv_calendar" | "microstructure_calendar" | "derivatives_calendar" | null;
      selectedBackend?: string | null;
      selectedBatchSize?: number | null;
      additionalCovariatesImprovedHoldout?: boolean | null;
      fincastDirectionAccuracy?: number;
      chronos2DirectionAccuracy?: number;
      fincastMedianPolicyReturn?: number;
      chronos2MedianPolicyReturn?: number;
      estimatedFullDurationMs?: number;
      estimatedFullDurationUpperMs?: number;
    };
  } | {
    kind: "chronos2-context-window-comparison";
    phase: "pilot" | "full";
    durationWeeks: 5;
    cadenceSeconds: 60;
    profile: "close_only";
    crossLearning: false;
    contexts: [512, 1024, 2048, 4096, 8192];
    batchCandidates: [1, 2, 4, 8, 12, 16, 24, 32, 48, 50];
    backendCandidates: [
      "pipeline_eager",
      "worker_local",
      "no_padding",
      "gpu_gather",
    ];
    automaticLivePromotion: false;
    resultStatus: "development_context_selected_holdout_pending" | null;
    metrics: {
      pilotGatePassed?: boolean;
      estimatedFullDurationMs?: number;
      estimatedFullDurationUpperMs?: number;
      projectedDiskFreeGiB?: number;
      selectedContextBars?: 512 | 1024 | 2048 | 4096 | 8192 | null;
      scoredOriginDigest?: string;
      contextResults?: Array<{
        contextBars: 512 | 1024 | 2048 | 4096 | 8192;
        status: "pending" | "running" | "passed" | "rejected" | "failed" | "completed";
        progressPercent?: number;
        batchSize?: number | null;
        backend?: "pipeline_eager" | "worker_local" | "no_padding" | "gpu_gather" | null;
        latencyP95Ms?: number;
        tasksPerSecond?: number;
        peakVramBytes?: number;
        minimumFreeVramBytes?: number;
        maximumPowerW?: number;
        maximumTemperatureC?: number;
        meanPinballLoss?: number;
        wis?: number;
        q50Mae?: number;
        brier?: number;
        bootstrapCiLow?: number;
        bootstrapCiHigh?: number;
        artifactDigest?: string;
        failureCount?: number;
        resumed?: boolean;
      }>;
    };
  } | {
    kind: "cadence-context-3week-benchmark";
    phase:
      | "prepare"
      | "validate-data"
      | "smoke-test"
      | "screen"
      | "decide"
      | "build-final-plan"
      | "full-test"
      | "aggregate"
      | "finalize";
    evaluationDays: 21;
    evaluationStart: string;
    evaluationEndExclusive: string;
    originIntervalMinutes: 15;
    screeningOriginIntervalMinutes: 30;
    horizonsMinutes: [5, 15, 30, 60];
    featureProfile: "compact_causal_v1";
    crossLearning: false;
    selectedPlanReady: boolean;
    selectedCombinationCount: number;
    totalCombinationCount: 20;
    screeningPolicyVersion?: string;
    defaultFinalCombinationIds?: string[];
    conditionalCombinationIds?: string[];
    followupCandidateIds?: string[];
    failedFinalCombinationIds?: string[];
    currentCombinationId: string | null;
    currentSymbol: "BTCUSDT" | "ETHUSDT" | null;
    currentOrigin: string | null;
    screeningWindows: Array<{
      regime: "low" | "medium" | "high";
      start: string;
      endExclusive: string;
      realizedVolatility: number;
    }>;
    combinations: CadenceContextCombination[];
    matchedLookbackCombinationIds: [
      "chronos2-c1024-s60",
      "chronos2-c2048-s30",
      "chronos2-c4096-s15",
    ];
    fiveSecondLookbackNote: string;
    dataRowsProcessed: number;
    inferenceOriginsProcessed: number;
    dataThroughputRowsPerSecond: number | null;
    inferenceThroughputOriginsPerSecond: number | null;
    recentLogLines: string[];
  } | HighVolatilityProfitabilityExperiment;
  telemetry?: {
    polledAt: string;
    gpuUtilizationPercent: number;
    memoryUsedMiB: number;
    memoryTotalMiB: number;
    temperatureC: number;
    powerDrawW?: number;
    powerLimitW?: number;
    memoryHeadroomMiB?: number;
    cpuUtilizationPercent?: number;
    ramUsedMiB?: number;
    ramTotalMiB?: number;
    dataRowsPerSecond?: number;
    inferenceOriginsPerSecond?: number;
  };
};

export type QualificationEvent = {
  schemaVersion: "ai-p40-qualification-event/v1";
  sequence: number;
  runId: string;
  at: string;
  type: string;
  message: string;
  stepId?: string;
  status?: QualificationRunStatus;
  progressPercent?: number;
};

export type QualificationPayload = {
  state: QualificationState;
  events: QualificationEvent[];
};

export function isQualificationPayload(value: unknown): value is QualificationPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<QualificationPayload>;
  return payload.state?.schemaVersion === "ai-p40-qualification-state/v1"
    && typeof payload.state.runId === "string"
    && typeof payload.state.progress?.percent === "number"
    && Array.isArray(payload.state.steps)
    && Array.isArray(payload.events);
}

export function isTerminalQualificationStatus(status: QualificationRunStatus): boolean {
  return status !== "planned" && status !== "running";
}
