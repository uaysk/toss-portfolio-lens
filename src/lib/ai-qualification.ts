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
  model: "system" | "kronos-base" | "fincast" | "comparison";
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

export type QualificationState = {
  schemaVersion: "ai-p40-qualification-state/v1";
  runId: string;
  status: QualificationRunStatus;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
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
    dockerBuild: false;
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
  telemetry?: {
    polledAt: string;
    gpuUtilizationPercent: number;
    memoryUsedMiB: number;
    memoryTotalMiB: number;
    temperatureC: number;
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
