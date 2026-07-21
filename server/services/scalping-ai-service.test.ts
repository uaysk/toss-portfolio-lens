import { describe, expect, it, vi } from "vitest";
import { aiRequestBase, type AiEvaluateRequest, type AiForecastRequest, type AiResponse } from "../worker/ai-contract.js";
import { ScalpingAiService } from "./scalping-ai-service.js";

const start = Date.parse("2026-07-21T00:00:00.000Z");
const time = (index: number) => new Date(start + index * 60_000).toISOString();
const bars = Array.from({ length: 65 }, (_, index) => ({
  timestamp: time(index), open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index,
  volume: 1_000, amount: 100_000, complete: true as const,
}));
const future = (origin: number) => Array.from({ length: 60 }, (_, index) => time(origin + index + 1));

function model() {
  return {
    model_id: "NeoQuasar/Kronos-small",
    model_revision: "revision-a",
    tokenizer_id: "NeoQuasar/Kronos-Tokenizer-base",
    tokenizer_revision: "revision-t",
    source_revision: "source-a",
    loader_version: "portfolio-ai-loader/v1",
    license: "MIT",
    device: "unavailable" as const,
    dtype: "float32" as const,
    attention_backend: "unavailable" as const,
    loaded: false,
  };
}

function unavailable(mode: "forecast" | "evaluate", requestId: string): AiResponse {
  return {
    schema_version: "scalping-ai/v1",
    request_id: requestId,
    mode,
    status: "unavailable",
    model: model(),
    generated_at: time(66),
    series: [{
      instrument_key: "005930",
      status: "unavailable",
      input_end_at: time(mode === "forecast" ? 64 : 4),
      horizons: [],
      input_quality: { status: "partial", bar_count: 65, missing_volume_ratio: 0, missing_amount_ratio: 0, irregular_interval_count: 0, warnings: [] },
      distribution_shift: { status: "unavailable", reason: "reference_statistics_not_published" },
      unavailable: { code: "model-cache-missing", message: "model is unavailable" },
    }],
    ...(mode === "evaluate" ? {
      evaluation: {
        retrospective: true,
        cost_assumptions: { commission_bps_per_side: 1, tax_bps_on_exit: 2, spread_bps_round_trip: 3, slippage_bps_per_side: 4 },
        records: [],
        metrics: [],
      },
    } : {}),
  };
}

describe("ScalpingAiService", () => {
  it("batch 예측 provenance와 unavailable 상태를 고빈도 전용 저장소에 보존한다", async () => {
    const request: AiForecastRequest = {
      ...aiRequestBase("forecast-1"), mode: "forecast",
      series: [{ instrument_key: "005930", timezone: "Asia/Seoul", input_end_at: time(64), bars, future_timestamps: future(64) }],
    };
    const response = unavailable("forecast", request.request_id);
    const putPrediction = vi.fn(async (input) => ({ id: "prediction-1", createdAt: 1, ...input }));
    const service = new ScalpingAiService(
      { request: vi.fn(async () => response) } as never,
      { putPrediction } as never,
      { enqueue: vi.fn() } as never,
      20,
    );
    const result = await service.forecast(request, undefined, "US");
    expect(result.response.status).toBe("unavailable");
    expect(putPrediction).toHaveBeenCalledWith(expect.objectContaining({
      status: "unavailable",
      dataQuality: "model_unavailable",
      modelName: "NeoQuasar/Kronos-small",
      modelVersion: "revision-a",
      marketCountry: "US",
      retrospective: false,
    }));
  });

  it("시간순 retrospective 평가를 run과 다섯 artifact로 예약한다", async () => {
    const request: AiEvaluateRequest = {
      ...aiRequestBase("evaluate-1"), mode: "evaluate",
      series: [{
        instrument_key: "005930", timezone: "Asia/Seoul", bars,
        origins: [{ origin: time(4), future_timestamps: future(4), technical_signal: 1, regime: "trend" }],
      }],
      cost_assumptions: { commission_bps_per_side: 1, tax_bps_on_exit: 2, spread_bps_round_trip: 3, slippage_bps_per_side: 4 },
    };
    const response = unavailable("evaluate", request.request_id);
    const enqueue = vi.fn(async (input) => {
      const task = await input.task({
        signal: new AbortController().signal,
        throwIfCancelled: vi.fn(),
        updateProgress: vi.fn(),
      });
      expect(task.artifacts.map((artifact: { type: string }) => artifact.type)).toEqual([
        "scalping-evaluation-summary",
        "scalping-prediction-replay",
        "scalping-signal-comparison",
        "scalping-cost-ledger",
        "scalping-evaluation-diagnostics",
      ]);
      expect(task.result.evaluation.retrospective).toBe(true);
      return { run: { id: "run-1", kind: input.kind }, reused: false };
    });
    const service = new ScalpingAiService(
      { request: vi.fn(async () => response) } as never,
      { putPrediction: vi.fn() } as never,
      { enqueue } as never,
      20,
    );
    const result = await service.evaluate(request);
    expect(result.run).toMatchObject({ id: "run-1", kind: "scalping_prediction_evaluation" });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      allowInlineInExternal: true,
      totalCandidates: 1,
      config: expect.objectContaining({ retrospective: true, random_split: false }),
    }));
  });

  it("origin 전략 입력 변경을 evaluation run 재사용 키에 반영한다", async () => {
    const enqueue = vi.fn(async (input) => ({ run: { id: "run", kind: input.kind }, reused: false }));
    const service = new ScalpingAiService(
      { request: vi.fn() } as never,
      { putPrediction: vi.fn() } as never,
      { enqueue } as never,
      20,
    );
    const baseRequest: AiEvaluateRequest = {
      ...aiRequestBase("evaluate-dedupe"), mode: "evaluate",
      series: [{
        instrument_key: "005930", timezone: "Asia/Seoul", bars,
        origins: [{ origin: time(4), future_timestamps: future(4), technical_signal: 1, regime: "trend" }],
      }],
      cost_assumptions: { commission_bps_per_side: 1, tax_bps_on_exit: 2, spread_bps_round_trip: 3, slippage_bps_per_side: 4 },
    };
    await service.evaluate(baseRequest);
    await service.evaluate({
      ...baseRequest,
      series: [{
        ...baseRequest.series[0]!,
        origins: [{ ...baseRequest.series[0]!.origins[0]!, technical_signal: -1, regime: "mean_reversion" }],
      }],
    });
    const first = enqueue.mock.calls[0]![0];
    const second = enqueue.mock.calls[1]![0];
    expect(first.dataRevision).not.toBe(second.dataRevision);
    expect(first.config.instruments[0].origins_checksum).not.toBe(second.config.instruments[0].origins_checksum);
  });
});
