import { describe, expect, it } from "vitest";
import {
  AiEvaluateRequestSchema,
  AiForecastRequestSchema,
  AiResponseSchema,
  aiRequestBase,
  type AiResponse,
} from "./ai-contract.js";

const evaluatedResponse: AiResponse = {
  schema_version: "scalping-ai/v1",
  request_id: "evaluation-1",
  mode: "evaluate",
  status: "available",
  model: {
    model_id: "NeoQuasar/Kronos-small",
    model_revision: "901c26c1332695a2a8f243eb2f37243a37bea320",
    tokenizer_id: "NeoQuasar/Kronos-Tokenizer-base",
    tokenizer_revision: "0e0117387f39004a9016484a186a908917e22426",
    source_revision: "67b630e67f6a18c9e9be918d9b4337c960db1e9a",
    loader_version: "kronos-source-67b630e",
    license: "MIT",
    device: "cuda",
    dtype: "float32",
    attention_backend: "math",
    loaded: true,
  },
  generated_at: "2026-07-21T01:30:00.000Z",
  series: [{
    instrument_key: "005930",
    status: "unavailable",
    input_end_at: "2026-07-21T01:29:00.000Z",
    horizons: [],
    input_quality: {
      status: "partial", bar_count: 60, missing_volume_ratio: 0,
      missing_amount_ratio: 1, irregular_interval_count: 0, warnings: ["fixture"],
    },
    distribution_shift: { status: "unavailable", reason: "reference_statistics_not_published" },
    unavailable: { code: "fixture", message: "fixture result" },
  }],
  evaluation: {
    retrospective: true,
    cost_assumptions: {
      commission_bps_per_side: 1,
      tax_bps_on_exit: 18,
      spread_bps_round_trip: 4,
      slippage_bps_per_side: 2,
    },
    records: [{
      instrument_key: "005930",
      origin: "2026-07-21T01:24:00.000Z",
      horizon_minutes: 5,
      target_timestamp: "2026-07-21T01:29:00.000Z",
      status: "available",
      predicted_median_return: 0.003,
      predicted_quantiles: [
        { quantile: 0.05, value: -0.01 },
        { quantile: 0.1, value: -0.008 },
        { quantile: 0.25, value: -0.002 },
        { quantile: 0.5, value: 0.003 },
        { quantile: 0.75, value: 0.008 },
        { quantile: 0.9, value: 0.012 },
        { quantile: 0.95, value: 0.016 },
      ],
      actual_return: 0.004,
      execution_return: 0.0048,
      up_probability: 0.7,
      predicted_first_passage: "target",
      actual_first_passage: "target",
      technical_signal: 1,
      regime: "trend",
      round_trip_cost_rate: 0.0028,
      technical_net_return: 0.002,
      ai_filtered_net_return: 0.002,
      unavailable: null,
    }],
    metrics: [{
      horizon_minutes: 5,
      overall: { count: 1, direction_accuracy: 1, mae: 0.001, rmse: 0.001 },
      quantile_coverage: [],
      up_probability_brier: 0.04,
      target_stop_first_count: 1,
      target_stop_first_accuracy: 1,
      calibration: [],
      by_symbol: {},
      by_time: {},
      by_regime: {},
      strategy_comparison: {
        technical_trade_count: 1,
        ai_filtered_trade_count: 1,
        technical_net_return: 0.002,
        ai_filtered_net_return: 0.002,
        technical_max_drawdown: 0,
        ai_filtered_max_drawdown: 0,
      },
    }],
  },
};

describe("AI worker response contract", () => {
  it("Python walk-forward target/stop first-hit metrics와 동일한 필드를 검증한다", () => {
    const response = AiResponseSchema.parse(evaluatedResponse);
    expect(response.evaluation?.metrics[0]).toMatchObject({
      target_stop_first_count: 1,
      target_stop_first_accuracy: 1,
    });
    expect(response.evaluation?.records[0]).toMatchObject({
      execution_return: 0.0048,
      round_trip_cost_rate: 0.0028,
      technical_net_return: 0.002,
      ai_filtered_net_return: 0.002,
      predicted_first_passage: "target",
      actual_first_passage: "target",
    });
    expect(response.evaluation?.records[0]?.predicted_quantiles).toHaveLength(7);
  });

  it("unavailable 모델은 실제 기술 baseline은 보존하지만 예측 필드를 허용하지 않는다", () => {
    const input = structuredClone(evaluatedResponse);
    input.status = "unavailable";
    const record = input.evaluation!.records[0]!;
    record.status = "unavailable";
    record.predicted_median_return = null;
    record.predicted_quantiles = [];
    record.up_probability = null;
    record.predicted_first_passage = null;
    record.ai_filtered_net_return = null;
    record.unavailable = { code: "MODEL_UNAVAILABLE", message: "offline model missing" };
    const parsed = AiResponseSchema.parse(input);
    expect(parsed.evaluation?.records[0]).toMatchObject({
      status: "unavailable",
      actual_return: 0.004,
      execution_return: 0.0048,
      technical_net_return: 0.002,
      ai_filtered_net_return: null,
    });

    record.predicted_median_return = 0.003;
    expect(() => AiResponseSchema.parse(input)).toThrow(/cannot contain model predictions/);
  });

  it("replay record의 고정 quantile·비용·net return 위변조를 거부한다", () => {
    const quantileDrift = structuredClone(evaluatedResponse);
    quantileDrift.evaluation!.records[0]!.predicted_quantiles[0]!.quantile = 0.1;
    expect(() => AiResponseSchema.parse(quantileDrift)).toThrow(/fixed ordered levels/);

    const costDrift = structuredClone(evaluatedResponse);
    costDrift.evaluation!.records[0]!.round_trip_cost_rate = 0.003;
    costDrift.evaluation!.records[0]!.technical_net_return = 0.0018;
    costDrift.evaluation!.records[0]!.ai_filtered_net_return = 0.0018;
    expect(() => AiResponseSchema.parse(costDrift)).toThrow(/cost rate must match cost assumptions/);

    const netDrift = structuredClone(evaluatedResponse);
    netDrift.evaluation!.records[0]!.technical_net_return = 0.1;
    expect(() => AiResponseSchema.parse(netDrift)).toThrow(/technical net return/);
  });

  it("first-hit 표본이 없을 때 정확도 null을 허용한다", () => {
    const input = structuredClone(evaluatedResponse);
    input.evaluation!.metrics[0]!.target_stop_first_count = 0;
    input.evaluation!.metrics[0]!.target_stop_first_accuracy = null;
    expect(AiResponseSchema.parse(input).evaluation?.metrics[0]?.target_stop_first_accuracy).toBeNull();
  });

  it("unavailable evaluate protocol response는 evaluation 없이도 보존한다", () => {
    const input = structuredClone(evaluatedResponse);
    input.status = "unavailable";
    delete (input as { evaluation?: unknown }).evaluation;
    input.series = [];
    (input as { error?: unknown }).error = { code: "protocol_error", message: "request rejected" };
    expect(AiResponseSchema.parse(input).evaluation).toBeUndefined();
  });

  it("평가 origin 이후 실제 60개 봉과 다른 future timestamp를 거부한다", () => {
    const start = Date.parse("2026-07-21T00:00:00.000Z");
    const time = (index: number) => new Date(start + index * 60_000).toISOString();
    const bars = Array.from({ length: 62 }, (_, index) => ({
      timestamp: time(index), open: 100, high: 101, low: 99, close: 100, complete: true as const,
    }));
    const request = {
      ...aiRequestBase("causal-evaluation"),
      mode: "evaluate" as const,
      series: [{
        instrument_key: "005930",
        timezone: "Asia/Seoul",
        bars,
        origins: [{
          origin: time(1),
          future_timestamps: Array.from({ length: 60 }, (_, index) => time(index + 2)),
        }],
      }],
      cost_assumptions: {
        commission_bps_per_side: 1,
        tax_bps_on_exit: 18,
        spread_bps_round_trip: 4,
        slippage_bps_per_side: 2,
      },
    };
    expect(AiEvaluateRequestSchema.parse(request).series[0]?.origins).toHaveLength(1);
    request.series[0]!.origins[0]!.future_timestamps[12] = time(61);
    expect(() => AiEvaluateRequestSchema.parse(request)).toThrow(/next 60 bars exactly/);
  });

  it("동일 instant의 offset 표기가 달라도 중복 origin으로 거부한다", () => {
    const bars = Array.from({ length: 61 }, (_, index) => ({
      timestamp: new Date(Date.parse("2026-07-21T00:00:00Z") + index * 60_000).toISOString(),
      open: 100, high: 101, low: 99, close: 100, complete: true as const,
    }));
    const future = bars.slice(1).map((bar) => bar.timestamp);
    const request = {
      ...aiRequestBase("duplicate-origin"), mode: "evaluate" as const,
      series: [{
        instrument_key: "005930", timezone: "Asia/Seoul", bars,
        origins: [
          { origin: "2026-07-21T09:00:00+09:00", future_timestamps: future },
          { origin: "2026-07-21T00:00:00Z", future_timestamps: future },
        ],
      }],
      cost_assumptions: { commission_bps_per_side: 1, tax_bps_on_exit: 18, spread_bps_round_trip: 4, slippage_bps_per_side: 2 },
    };
    expect(() => AiEvaluateRequestSchema.parse(request)).toThrow(/strictly increasing by instant/);
  });

  it("batch request의 중복 instrument key를 거부한다", () => {
    const at = "2026-07-21T00:00:00.000Z";
    const series = {
      instrument_key: "005930", timezone: "Asia/Seoul", input_end_at: at,
      bars: [{ timestamp: at, open: 100, high: 101, low: 99, close: 100, complete: true as const }],
      future_timestamps: Array.from({ length: 60 }, (_, index) => (
        new Date(Date.parse(at) + (index + 1) * 60_000).toISOString()
      )),
    };
    expect(() => AiForecastRequestSchema.parse({
      ...aiRequestBase("duplicate-series"), mode: "forecast", series: [series, series],
    })).toThrow(/must be unique/);
  });

  it("model loaded 상태와 runtime provenance 불일치를 거부한다", () => {
    const input = structuredClone(evaluatedResponse);
    input.model.loaded = false;
    expect(() => AiResponseSchema.parse(input)).toThrow(/runtime must be unavailable/);
  });

  it("protocol error에 series 또는 evaluation 결과가 섞이는 것을 거부한다", () => {
    const input = structuredClone(evaluatedResponse);
    input.status = "unavailable";
    (input as { error?: unknown }).error = { code: "INVALID_REQUEST", message: "invalid" };
    expect(() => AiResponseSchema.parse(input)).toThrow(/without series or evaluation/);
  });
});
