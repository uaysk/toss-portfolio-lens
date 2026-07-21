import { createHash } from "node:crypto";
import type { ArtifactType } from "../repositories/artifact-repository.js";
import type {
  ScalpingPredictionQuality,
  ScalpingPredictionRecord,
  ScalpingRepository,
} from "../repositories/scalping-repository.js";
import type { RunService } from "./run-service.js";
import { canonicalJson } from "../worker/contracts.js";
import {
  AiEvaluateRequestSchema,
  AiForecastRequestSchema,
  type AiEvaluateRequest,
  type AiForecastRequest,
  type AiResponse,
} from "../worker/ai-contract.js";
import type { AiComputeClient } from "../worker/ai-client.js";

export const SCALPING_AI_SERVICE_VERSION = "scalping-ai-service/v1";

type AiClient = Pick<AiComputeClient, "request">;
type PredictionStore = Pick<ScalpingRepository, "putPrediction">;
type RunScheduler = Pick<RunService, "enqueue">;

function dataRevision(request: AiEvaluateRequest): string {
  const source = request.series.map((series) => ({
    instrument_key: series.instrument_key,
    first_bar: series.bars[0]?.timestamp,
    last_bar: series.bars.at(-1)?.timestamp,
    bar_count: series.bars.length,
    origins_checksum: createHash("sha256").update(canonicalJson(series.origins)).digest("hex"),
    bar_checksum: createHash("sha256").update(canonicalJson(series.bars)).digest("hex"),
  }));
  return `scalping-bars:${createHash("sha256").update(canonicalJson(source)).digest("hex")}`;
}

function unavailableQuality(code: string | undefined): ScalpingPredictionQuality {
  const normalized = code?.toLowerCase() ?? "";
  if (normalized.includes("history") || normalized.includes("bar")) return "insufficient_history";
  if (normalized.includes("model") || normalized.includes("cache") || normalized.includes("cuda")) return "model_unavailable";
  return "partial";
}

function warnings(response: AiResponse): string[] {
  const values: string[] = [];
  if (response.status !== "available") values.push(`AI prediction status: ${response.status}`);
  if (!response.model.loaded) values.push("AI model was not loaded; unavailable results were preserved.");
  for (const series of response.series) {
    if (series.unavailable) values.push(`${series.instrument_key}: ${series.unavailable.code}`);
    values.push(...series.input_quality.warnings.map((warning) => `${series.instrument_key}: ${warning}`));
  }
  return Array.from(new Set(values));
}

export class ScalpingAiService {
  constructor(
    private readonly client: AiClient,
    private readonly predictions: PredictionStore,
    private readonly runs: RunScheduler,
    private readonly maximumBatchSize: number,
  ) {
    if (!Number.isInteger(maximumBatchSize) || maximumBatchSize < 1 || maximumBatchSize > 50) {
      throw new Error("AI batch 상한은 1~50 범위여야 합니다.");
    }
  }

  async forecast(input: AiForecastRequest, signal?: AbortSignal): Promise<{
    response: AiResponse;
    predictions: ScalpingPredictionRecord[];
  }> {
    const request = AiForecastRequestSchema.parse(input);
    if (request.series.length > this.maximumBatchSize) {
      throw new Error(`AI batch 예측은 한 번에 ${this.maximumBatchSize}종목 이하여야 합니다.`);
    }
    const response = await this.client.request(request, signal);
    const stored: ScalpingPredictionRecord[] = [];
    for (const series of response.series) {
      const unavailableCode = series.unavailable?.code;
      stored.push(await this.predictions.putPrediction({
        symbol: series.instrument_key,
        modelName: response.model.model_id,
        modelVersion: response.model.model_revision,
        inputEndedAt: series.input_end_at,
        generatedAt: response.generated_at,
        status: series.status === "available" ? "available" : "unavailable",
        dataQuality: series.status === "available"
          ? series.input_quality.status === "good" ? "complete" : "partial"
          : unavailableQuality(unavailableCode),
        retrospective: false,
        payload: {
          schema_version: response.schema_version,
          service_version: SCALPING_AI_SERVICE_VERSION,
          request_id: response.request_id,
          model: response.model,
          forecast: series,
        },
      }));
    }
    return { response, predictions: stored };
  }

  async evaluate(input: AiEvaluateRequest, ownerSubject = "owner"): Promise<{
    run: Awaited<ReturnType<RunScheduler["enqueue"]>>["run"];
    reused: boolean;
  }> {
    const request = AiEvaluateRequestSchema.parse(input);
    if (request.series.length > this.maximumBatchSize) {
      throw new Error(`AI 예측 검증은 한 번에 ${this.maximumBatchSize}종목 이하여야 합니다.`);
    }
    const totalOrigins = request.series.reduce((sum, series) => sum + series.origins.length, 0);
    const revision = dataRevision(request);
    const queued = await this.runs.enqueue({
      ownerSubject,
      kind: "scalping_prediction_evaluation",
      config: {
        schema_version: request.schema_version,
        mode: request.mode,
        horizons_minutes: request.horizons_minutes,
        quantiles: request.quantiles,
        seed: request.seed,
        instruments: request.series.map((series) => ({
          instrument_key: series.instrument_key,
          bar_count: series.bars.length,
          origin_count: series.origins.length,
          origins_checksum: createHash("sha256").update(canonicalJson(series.origins)).digest("hex"),
        })),
        cost_assumptions: request.cost_assumptions,
        retrospective: true,
        random_split: false,
      },
      dataRevision: revision,
      totalCandidates: totalOrigins,
      allowInlineInExternal: true,
      task: async (context) => {
        await context.throwIfCancelled();
        const response = await this.client.request(request, context.signal);
        await context.throwIfCancelled();
        if (!response.evaluation) throw new Error("AI worker가 예측 검증 결과를 반환하지 않았습니다.");
        await context.updateProgress(1, {
          completedCandidates: totalOrigins,
          totalCandidates: totalOrigins,
          currentValidationWindow: request.series.at(-1)?.origins.at(-1)?.origin,
        });
        const comparison = response.evaluation.metrics.map((metric) => ({
          horizon_minutes: metric.horizon_minutes,
          ...metric.strategy_comparison,
        }));
        const artifacts: Array<{ type: ArtifactType; content: unknown; rowCount: number }> = [
          {
            type: "scalping-evaluation-summary",
            content: response.evaluation.metrics,
            rowCount: response.evaluation.metrics.length,
          },
          {
            type: "scalping-prediction-replay",
            content: response.evaluation.records,
            rowCount: response.evaluation.records.length,
          },
          {
            type: "scalping-signal-comparison",
            content: comparison,
            rowCount: comparison.length,
          },
          {
            type: "scalping-cost-ledger",
            content: {
              assumptions: response.evaluation.cost_assumptions,
              record_count: response.evaluation.records.length,
              costs_applied_in_strategy_comparison: true,
            },
            rowCount: 1,
          },
          {
            type: "scalping-evaluation-diagnostics",
            content: {
              retrospective: true,
              chronological_origins: true,
              random_split: false,
              model: response.model,
              response_status: response.status,
              generated_at: response.generated_at,
              unavailable_series: response.series.filter((series) => series.status === "unavailable")
                .map((series) => ({ instrument_key: series.instrument_key, unavailable: series.unavailable })),
              distribution_shift: "unavailable_without_published_reference_statistics",
            },
            rowCount: 1,
          },
        ];
        return {
          summary: {
            retrospective: true,
            model_id: response.model.model_id,
            model_revision: response.model.model_revision,
            origin_count: totalOrigins,
            record_count: response.evaluation.records.length,
            metrics: response.evaluation.metrics,
          },
          result: response,
          warnings: warnings(response),
          artifacts,
        };
      },
    });
    return queued;
  }
}
