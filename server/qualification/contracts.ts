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

export const QualificationStateSchema = z.object({
  schemaVersion: z.literal(AI_QUALIFICATION_STATE_SCHEMA_VERSION),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  status: QualificationRunStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  deadlineAt: z.string().datetime(),
  activeStepId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable(),
  config: z.object({
    budgetHours: z.number().positive().max(24),
    durationHours: z.number().int().min(1).max(840),
    endExclusive: z.string().datetime(),
    symbols: z.array(z.string().regex(/^[A-Z0-9]{2,32}USDT$/)).min(1).max(10),
    gpu: z.literal("Tesla P40"),
    cudaCapability: z.literal("6.1"),
    workerMode: z.enum(["docker-source", "external"]),
    dockerBuild: z.literal(false),
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
  telemetry: z.object({
    polledAt: z.string().datetime(),
    gpuUtilizationPercent: z.number().min(0).max(100),
    memoryUsedMiB: z.number().nonnegative(),
    memoryTotalMiB: z.number().positive(),
    temperatureC: z.number(),
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
