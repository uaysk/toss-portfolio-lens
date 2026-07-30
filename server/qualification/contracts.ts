import { z } from "zod";

export const AI_QUALIFICATION_STATE_SCHEMA_VERSION = "ai-p40-qualification-state/v1" as const;
export const AI_QUALIFICATION_EVENT_SCHEMA_VERSION = "ai-p40-qualification-event/v1" as const;

export const QualificationRunStatusSchema = z.enum([
  "planned",
  "running",
  "completed",
  "completed_with_failures",
  "failed",
  "cancelled",
  "budget_exhausted",
]);

export const QualificationStepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

export const QualificationModelSchema = z.enum([
  "system",
  "kronos-base",
  "chronos-2",
  "fincast",
  "comparison",
]);

const RelativeArtifactPathSchema = z.string()
  .min(1)
  .max(240)
  .refine((value) => (
    !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  ), "artifact paths must be safe relative paths");

export const QualificationStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  order: z.number().int().min(1),
  label: z.string().min(1).max(160),
  description: z.string().min(1).max(500),
  model: QualificationModelSchema,
  variant: z.string().min(1).max(120),
  status: QualificationStepStatusSchema,
  estimatedDurationMs: z.number().int().positive(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  outputFile: RelativeArtifactPathSchema.optional(),
  logFile: RelativeArtifactPathSchema,
  summary: z.string().max(1_000).optional(),
  error: z.string().max(2_000).optional(),
}).strict();

const FinCastBackendComparisonMetricsSchema = z.object({
  cudaGraphSeriesPerSecond: z.number().positive().optional(),
  tensorRtSeriesPerSecond: z.number().positive().optional(),
  speedupRatio: z.number().positive().optional(),
  speedupPercent: z.number().optional(),
  cudaGraphEndToEndSeriesPerSecond: z.number().positive().optional(),
  tensorRtEndToEndSeriesPerSecond: z.number().positive().optional(),
  endToEndSpeedupRatio: z.number().positive().optional(),
  directionMatchRate: z.number().min(0).max(1).optional(),
  q50ErrorIqrMedian: z.number().nonnegative().optional(),
  q50ErrorIqrP95: z.number().nonnegative().optional(),
  policyActionMismatches: z.number().int().nonnegative().optional(),
  policyReasonMismatches: z.number().int().nonnegative().optional(),
  thresholdMarginRecordCount: z.number().int().nonnegative().optional(),
  thresholdCrossingCount: z.number().int().nonnegative().optional(),
  probabilityOnlyDecisionCount: z.number().int().nonnegative().optional(),
  probabilityOnlyActionMismatchRate: z.number().min(0).max(1).optional(),
  probabilityOutlier1ppCount: z.number().int().nonnegative().optional(),
  probabilityOutlier5ppCount: z.number().int().nonnegative().optional(),
  probabilityOutlier10ppCount: z.number().int().nonnegative().optional(),
  maximumProbabilityDelta: z.number().min(0).max(1).optional(),
  realizedDirectionDisagreements: z.number().int().nonnegative().optional(),
  closestReferenceMargin: z.number().nonnegative().optional(),
  closestCandidateMargin: z.number().nonnegative().optional(),
  referenceRealizedDirectionAccuracy: z.number().min(0).max(1).optional(),
  candidateRealizedDirectionAccuracy: z.number().min(0).max(1).optional(),
  maximumReturnDelta: z.number().nonnegative().optional(),
  maximumDrawdownDelta: z.number().nonnegative().optional(),
  modelSignalDecisionMismatches: z.number().int().nonnegative().optional(),
  symbolAlignedActionMismatches: z.number().int().nonnegative().optional(),
  symbolAlignedReasonMismatches: z.number().int().nonnegative().optional(),
  offlineEconomicallyAcceptable: z.boolean().optional(),
}).strict();

const FinCastBackendComparisonSchema = z.object({
  kind: z.literal("fincast-fp32-backend-comparison"),
  durationWeeks: z.number().int().min(1).max(5),
  cadenceSeconds: z.literal(60),
  batchSize: z.literal(48),
  referenceBackend: z.literal("cuda_graph"),
  candidateBackend: z.literal("tensorrt_fp32"),
  routingPolicy: z.literal("row-id-stateless-uniform/v1"),
  thresholdMarginArtifact: RelativeArtifactPathSchema,
  detailArtifact: RelativeArtifactPathSchema.optional(),
  rowCount: z.number().int().positive().optional(),
  originCount: z.number().int().positive().optional(),
  metrics: FinCastBackendComparisonMetricsSchema.optional(),
}).strict();

const Chronos2ModelComparisonMetricsSchema = z.object({
  selectedProfile: z.enum([
    "close_only",
    "ohlcv_calendar",
    "microstructure_calendar",
    "derivatives_calendar",
  ]).nullable().optional(),
  selectedBackend: z.string().min(1).max(64).nullable().optional(),
  selectedBatchSize: z.number().int().positive().nullable().optional(),
  additionalCovariatesImprovedHoldout: z.boolean().nullable().optional(),
  fincastDirectionAccuracy: z.number().min(0).max(1).optional(),
  chronos2DirectionAccuracy: z.number().min(0).max(1).optional(),
  fincastMedianPolicyReturn: z.number().optional(),
  chronos2MedianPolicyReturn: z.number().optional(),
  estimatedFullDurationMs: z.number().int().nonnegative().optional(),
  estimatedFullDurationUpperMs: z.number().int().nonnegative().optional(),
}).strict();

const Chronos2ModelComparisonSchema = z.object({
  kind: z.literal("chronos2-fincast-model-comparison"),
  mode: z.enum(["pilot", "full"]),
  durationWeeks: z.number().min(0).max(5),
  cadenceSeconds: z.literal(60),
  profiles: z.tuple([
    z.literal("close_only"),
    z.literal("ohlcv_calendar"),
    z.literal("microstructure_calendar"),
    z.literal("derivatives_calendar"),
  ]),
  referenceModel: z.literal("fincast"),
  candidateModel: z.literal("chronos-2"),
  referenceBackend: z.literal("cuda_graph"),
  candidateBackend: z.string().min(1).max(64).nullable(),
  automaticLivePromotion: z.literal(false),
  metrics: Chronos2ModelComparisonMetricsSchema.optional(),
}).strict();

const Chronos2ContextResultSchema = z.object({
  contextBars: z.union([
    z.literal(512),
    z.literal(1024),
    z.literal(2048),
    z.literal(4096),
    z.literal(8192),
  ]),
  status: z.enum(["pending", "running", "passed", "rejected", "failed", "completed"]),
  progressPercent: z.number().min(0).max(100).optional(),
  batchSize: z.number().int().positive().nullable().optional(),
  backend: z.enum([
    "pipeline_eager",
    "worker_local",
    "no_padding",
    "gpu_gather",
  ]).nullable().optional(),
  latencyP95Ms: z.number().nonnegative().optional(),
  tasksPerSecond: z.number().nonnegative().optional(),
  peakVramBytes: z.number().int().nonnegative().optional(),
  minimumFreeVramBytes: z.number().int().nonnegative().optional(),
  maximumPowerW: z.number().nonnegative().optional(),
  maximumTemperatureC: z.number().optional(),
  meanPinballLoss: z.number().nonnegative().optional(),
  wis: z.number().nonnegative().optional(),
  q50Mae: z.number().nonnegative().optional(),
  brier: z.number().nonnegative().optional(),
  bootstrapCiLow: z.number().optional(),
  bootstrapCiHigh: z.number().optional(),
  artifactDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  failureCount: z.number().int().nonnegative().optional(),
  resumed: z.boolean().optional(),
}).strict();

const Chronos2ContextWindowComparisonSchema = z.object({
  kind: z.literal("chronos2-context-window-comparison"),
  phase: z.enum(["pilot", "full"]),
  durationWeeks: z.literal(5),
  cadenceSeconds: z.literal(60),
  profile: z.literal("close_only"),
  crossLearning: z.literal(false),
  contexts: z.tuple([
    z.literal(512),
    z.literal(1024),
    z.literal(2048),
    z.literal(4096),
    z.literal(8192),
  ]),
  batchCandidates: z.tuple([
    z.literal(1),
    z.literal(2),
    z.literal(4),
    z.literal(8),
    z.literal(12),
    z.literal(16),
    z.literal(24),
    z.literal(32),
    z.literal(48),
    z.literal(50),
  ]),
  backendCandidates: z.tuple([
    z.literal("pipeline_eager"),
    z.literal("worker_local"),
    z.literal("no_padding"),
    z.literal("gpu_gather"),
  ]),
  automaticLivePromotion: z.literal(false),
  resultStatus: z.literal("development_context_selected_holdout_pending").nullable(),
  metrics: z.object({
    pilotGatePassed: z.boolean().optional(),
    estimatedFullDurationMs: z.number().int().nonnegative().optional(),
    estimatedFullDurationUpperMs: z.number().int().nonnegative().optional(),
    projectedDiskFreeGiB: z.number().nonnegative().optional(),
    selectedContextBars: z.union([
      z.literal(512),
      z.literal(1024),
      z.literal(2048),
      z.literal(4096),
      z.literal(8192),
    ]).nullable().optional(),
    scoredOriginDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    contextResults: z.array(Chronos2ContextResultSchema).max(5).optional(),
  }).strict(),
}).strict();

const CadenceContextCombinationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "skipped",
  "retrying",
  "failed",
  "excluded",
  "followup_only",
  "dependency_failed",
]);

const PartialPredictionMetricsSchema = z.object({
  count: z.number().int().nonnegative(),
  mae: z.number().nonnegative().nullable().optional(),
  rmse: z.number().nonnegative().nullable().optional(),
  meanPinballLoss: z.number().nonnegative().nullable().optional(),
  wis: z.number().nonnegative().nullable().optional(),
  coverage: z.number().min(0).max(1).nullable().optional(),
  calibrationError: z.number().nonnegative().nullable().optional(),
  directionAccuracy: z.number().min(0).max(1).nullable().optional(),
}).strict();

const PartialTradingMetricsSchema = z.object({
  grossReturn: z.number().optional(),
  netReturn: z.number().optional(),
  sharpe: z.number().nullable().optional(),
  maxDrawdown: z.number().min(0).nullable().optional(),
  winRate: z.number().min(0).max(1).nullable().optional(),
  tradeCount: z.number().int().nonnegative().optional(),
  turnover: z.number().nonnegative().optional(),
  averageHoldingMinutes: z.number().nonnegative().nullable().optional(),
  costDrag: z.number().nonnegative().optional(),
}).strict();

const CadenceContextCombinationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  model: z.enum(["fincast", "chronos-2"]),
  contextBars: z.union([
    z.literal(512),
    z.literal(1024),
    z.literal(2048),
    z.literal(4096),
    z.literal(8192),
  ]),
  cadenceSeconds: z.union([
    z.literal(5),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ]),
  lookbackSeconds: z.number().int().positive(),
  predictionLengthSteps: z.union([
    z.literal(60),
    z.literal(120),
    z.literal(240),
    z.literal(720),
  ]),
  planRole: z.enum([
    "default",
    "conditional",
    "excluded",
    "followup_only",
  ]).optional(),
  dependencyIds: z.array(z.string().max(64)).max(4).optional(),
  screeningComparatorIds: z.array(z.string().max(64)).max(4).optional(),
  status: CadenceContextCombinationStatusSchema,
  screeningDecision: z.enum([
    "pending",
    "included",
    "passed",
    "excluded",
    "borderline",
    "followup_only",
  ]),
  screeningStatus: z.enum([
    "not_started",
    "running",
    "completed",
    "failed",
    "not_required",
    "not_triggered",
    "dependency_failed",
    "followup_only",
  ]).optional(),
  smokeStatus: z.enum([
    "not_started",
    "completed",
    "failed",
    "not_run",
  ]).optional(),
  screeningReason: z.string().min(1).max(1_000).nullable(),
  screeningTriggerReason: z.string().min(1).max(1_000).nullable().optional(),
  selectedForFinal: z.boolean(),
  completedOrigins: z.number().int().nonnegative(),
  totalOrigins: z.number().int().nonnegative(),
  progressPercent: z.number().min(0).max(100),
  attempt: z.number().int().min(0).max(3),
  currentSymbol: z.enum(["BTCUSDT", "ETHUSDT"]).nullable(),
  currentOrigin: z.string().datetime().nullable(),
  elapsedMs: z.number().int().nonnegative(),
  etaMs: z.number().int().nonnegative().nullable(),
  latencyP50Ms: z.number().nonnegative().nullable().optional(),
  latencyP95Ms: z.number().nonnegative().nullable().optional(),
  throughputOriginsPerSecond: z.number().nonnegative().nullable().optional(),
  peakVramMiB: z.number().nonnegative().nullable().optional(),
  peakRamMiB: z.number().nonnegative().nullable().optional(),
  executionOptimizationVersion: z.string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
    .optional(),
  inferenceBatchSize: z.number().int().min(1).max(256).optional(),
  retryCount: z.number().int().nonnegative(),
  failureReason: z.string().min(1).max(2_000).nullable(),
  partialPrediction: PartialPredictionMetricsSchema.nullable().optional(),
  partialTrading: PartialTradingMetricsSchema.nullable().optional(),
// Runner-owned execution provenance is intentionally forward compatible. Known
// fields above remain validated, while a newly added diagnostic must not make the
// entire live dashboard unavailable before the UI is deployed.
}).passthrough();

const CadenceContextBenchmarkSchema = z.object({
  kind: z.literal("cadence-context-3week-benchmark"),
  phase: z.enum([
    "prepare",
    "validate-data",
    "smoke-test",
    "screen",
    "decide",
    "build-final-plan",
    "full-test",
    "aggregate",
    "finalize",
  ]),
  evaluationDays: z.literal(21),
  evaluationStart: z.string().datetime(),
  evaluationEndExclusive: z.string().datetime(),
  originIntervalMinutes: z.literal(15),
  screeningOriginIntervalMinutes: z.literal(30),
  horizonsMinutes: z.tuple([
    z.literal(5),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ]),
  featureProfile: z.literal("compact_causal_v1"),
  crossLearning: z.literal(false),
  selectedPlanReady: z.boolean(),
  selectedCombinationCount: z.number().int().nonnegative().max(20),
  totalCombinationCount: z.literal(20),
  screeningPolicyVersion: z.string().min(1).max(100).optional(),
  defaultFinalCombinationIds: z.array(z.string().max(64)).max(20).optional(),
  conditionalCombinationIds: z.array(z.string().max(64)).max(20).optional(),
  followupCandidateIds: z.array(z.string().max(64)).max(20).optional(),
  failedFinalCombinationIds: z.array(z.string().max(64)).max(20).optional(),
  currentCombinationId: z.string().max(64).nullable(),
  currentSymbol: z.enum(["BTCUSDT", "ETHUSDT"]).nullable(),
  currentOrigin: z.string().datetime().nullable(),
  screeningWindows: z.array(z.object({
    regime: z.enum(["low", "medium", "high"]),
    start: z.string().datetime(),
    endExclusive: z.string().datetime(),
    realizedVolatility: z.number().nonnegative(),
  }).strict()).max(3),
  combinations: z.array(CadenceContextCombinationSchema).length(20),
  matchedLookbackCombinationIds: z.tuple([
    z.literal("chronos2-c1024-s60"),
    z.literal("chronos2-c2048-s30"),
    z.literal("chronos2-c4096-s15"),
  ]),
  fiveSecondLookbackNote: z.string().min(1).max(500),
  dataRowsProcessed: z.number().int().nonnegative(),
  inferenceOriginsProcessed: z.number().int().nonnegative(),
  dataThroughputRowsPerSecond: z.number().nonnegative().nullable(),
  inferenceThroughputOriginsPerSecond: z.number().nonnegative().nullable(),
  recentLogLines: z.array(z.string().max(500)).max(40),
// The cadence runner may add bounded diagnostic/provenance fields between UI
// releases. Preserve them instead of blanking an otherwise valid run.
}).passthrough();

const HighVolatilityModelLaneSchema = z.object({
  role: z.enum(["primary", "veto"]),
  modelId: z.string().min(1).max(120),
  modelRevision: z.string().min(1).max(120).nullable(),
  contextBars: z.number().int().min(1).max(8_192),
  cadenceSeconds: z.union([
    z.literal(5),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ]),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "unavailable",
  ]),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
}).strict();

const HighVolatilityResultMetricsSchema = z.object({
  grossReturn: z.number().optional(),
  netReturn: z.number().optional(),
  sharpe: z.number().nullable().optional(),
  maxDrawdown: z.number().nonnegative().nullable().optional(),
  turnover: z.number().nonnegative().optional(),
  tradeCount: z.number().int().nonnegative().optional(),
  vetoCount: z.number().int().nonnegative().optional(),
}).strict();

const HighVolatilityProfitabilitySchema = z.object({
  kind: z.literal("high-volatility-profitability-backtest"),
  phase: z.enum([
    "prepare",
    "load-data",
    "scan",
    "infer-chronos2",
    "infer-fincast",
    "materialize",
    "source-complete",
    "rust-evidence",
    "selector",
    "policy-backtest",
    "aggregate",
    "complete",
    "failed",
    "cancelled",
  ]),
  evaluationStart: z.string().datetime(),
  evaluationEndExclusive: z.string().datetime(),
  calibrationStart: z.string().datetime(),
  originIntervalMinutes: z.literal(15),
  horizonsMinutes: z.tuple([
    z.literal(5),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ]),
  candidateUniverse: z.array(
    z.string().regex(/^[A-Z0-9]{2,32}USDT$/),
  ).max(20),
  usableCandidates: z.array(
    z.string().regex(/^[A-Z0-9]{2,32}USDT$/),
  ).max(20),
  scannerTopCount: z.literal(5),
  modelSelectorCandidateCount: z.literal(3),
  models: z.object({
    chronos2: HighVolatilityModelLaneSchema,
    fincast: HighVolatilityModelLaneSchema,
  }).strict(),
  completedOrigins: z.number().int().nonnegative(),
  totalOrigins: z.number().int().nonnegative(),
  currentSymbol: z.string().regex(/^[A-Z0-9]{2,32}USDT$/).nullable(),
  currentOrigin: z.string().datetime().nullable(),
  policyVersions: z.object({
    selector: z.string().min(1).max(100),
    vetoCalibration: z.string().min(1).max(100),
  }).strict(),
  dataErrorCount: z.number().int().nonnegative(),
  failureReason: z.string().min(1).max(2_000).nullable(),
  recentLogLines: z.array(z.string().max(500)).max(20),
  results: z.object({
    chronos2Rust: HighVolatilityResultMetricsSchema.nullable(),
    chronos2FincastVetoRust: HighVolatilityResultMetricsSchema.nullable(),
  }).strict().nullable(),
}).strict();

export const QualificationStateSchema = z.object({
  schemaVersion: z.literal(AI_QUALIFICATION_STATE_SCHEMA_VERSION),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  status: QualificationRunStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  resumeCount: z.number().int().nonnegative().max(10_000).optional(),
  deadlineAt: z.string().datetime(),
  activeStepId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable(),
  config: z.object({
    budgetHours: z.number().positive().max(720),
    durationHours: z.number().int().min(1).max(2_160),
    endExclusive: z.string().datetime(),
    symbols: z.array(z.string().regex(/^[A-Z0-9]{2,32}USDT$/)).min(1).max(10),
    gpu: z.literal("Tesla P40"),
    cudaCapability: z.literal("6.1"),
    workerMode: z.enum(["docker-source", "external"]),
    dockerBuild: z.boolean(),
  }).strict(),
  progress: z.object({
    completedSteps: z.number().int().nonnegative(),
    failedSteps: z.number().int().nonnegative(),
    skippedSteps: z.number().int().nonnegative(),
    totalSteps: z.number().int().positive(),
    percent: z.number().min(0).max(100),
    activeStepPercent: z.number().min(0).max(100).nullable(),
    elapsedMs: z.number().int().nonnegative(),
    remainingBudgetMs: z.number().int().nonnegative(),
  }).strict(),
  steps: z.array(QualificationStepSchema).min(1).max(100),
  artifacts: z.object({
    summaryJson: RelativeArtifactPathSchema,
    reportMarkdown: RelativeArtifactPathSchema,
    handoffPrompt: RelativeArtifactPathSchema,
  }).strict(),
  experiment: z.union([
    FinCastBackendComparisonSchema,
    Chronos2ModelComparisonSchema,
    Chronos2ContextWindowComparisonSchema,
    CadenceContextBenchmarkSchema,
    HighVolatilityProfitabilitySchema,
  ]).optional(),
  telemetry: z.object({
    polledAt: z.string().datetime(),
    gpuUtilizationPercent: z.number().min(0).max(100),
    memoryUsedMiB: z.number().nonnegative(),
    memoryTotalMiB: z.number().positive(),
    temperatureC: z.number(),
    powerDrawW: z.number().nonnegative().optional(),
    powerLimitW: z.number().positive().optional(),
    memoryHeadroomMiB: z.number().nonnegative().optional(),
    cpuUtilizationPercent: z.number().min(0).max(100).optional(),
    ramUsedMiB: z.number().nonnegative().optional(),
    ramTotalMiB: z.number().positive().optional(),
    dataRowsPerSecond: z.number().nonnegative().optional(),
    inferenceOriginsPerSecond: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();

export const QualificationEventSchema = z.object({
  schemaVersion: z.literal(AI_QUALIFICATION_EVENT_SCHEMA_VERSION),
  sequence: z.number().int().positive(),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  at: z.string().datetime(),
  type: z.enum([
    "run_created",
    "run_started",
    "run_resumed",
    "step_started",
    "step_output",
    "step_completed",
    "step_failed",
    "step_skipped",
    "warning",
    "run_completed",
  ]),
  message: z.string().min(1).max(2_000),
  stepId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  status: QualificationRunStatusSchema.optional(),
  progressPercent: z.number().min(0).max(100).optional(),
}).strict();

export type QualificationRunStatus = z.infer<typeof QualificationRunStatusSchema>;
export type QualificationStepStatus = z.infer<typeof QualificationStepStatusSchema>;
export type QualificationModel = z.infer<typeof QualificationModelSchema>;
export type QualificationStep = z.infer<typeof QualificationStepSchema>;
export type QualificationState = z.infer<typeof QualificationStateSchema>;
export type QualificationEvent = z.infer<typeof QualificationEventSchema>;

export function isTerminalQualificationStatus(status: QualificationRunStatus): boolean {
  return !["planned", "running"].includes(status);
}
