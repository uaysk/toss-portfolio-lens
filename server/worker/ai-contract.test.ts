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
    device_name: "Tesla P40",
    cuda_capability: "6.1",
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

function dualForecastResponse(): unknown {
  const rawSeries = structuredClone(evaluatedResponse.series);
  const chronosModel = {
    ...structuredClone(evaluatedResponse.model),
    model_id: "amazon/chronos-2",
    model_revision: "254b5357164a84326913b0695216f690752ac55d",
    tokenizer_id: null,
    tokenizer_revision: null,
    source_revision: "chronos-forecasting-2.1.0",
    loader_version: "chronos-forecasting-2.1.0",
    license: "Apache-2.0",
  };
  const kronosModel = structuredClone(evaluatedResponse.model);
  const inputOrigins = [{
    instrument_key: rawSeries[0]!.instrument_key,
    context_start_at: "2026-07-21T00:30:00.000Z",
    input_end_at: rawSeries[0]!.input_end_at,
    bar_count: 60,
    input_digest: "a".repeat(64),
  }];
  return {
    schema_version: "scalping-ai/v1",
    request_id: "dual-model-forecast",
    mode: "forecast",
    status: "unavailable",
    model: chronosModel,
    generated_at: "2026-07-21T01:30:02.000Z",
    series: rawSeries,
    model_runs: [
      {
        role: "chronos2",
        expected_model_id: "amazon/chronos-2",
        status: "unavailable",
        model: chronosModel,
        generated_at: "2026-07-21T01:30:01.000Z",
        latency_ms: 10.5,
        degraded: false,
        fallback_used: false,
        fallback_reason: null,
        input_origins: inputOrigins,
        input_end_aligned: true,
        raw_series: rawSeries,
      },
      {
        role: "kronos_small",
        expected_model_id: "NeoQuasar/Kronos-small",
        status: "unavailable",
        model: kronosModel,
        generated_at: "2026-07-21T01:30:02.000Z",
        latency_ms: 20.25,
        degraded: false,
        fallback_used: false,
        fallback_reason: null,
        input_origins: inputOrigins,
        input_end_aligned: true,
        raw_series: rawSeries,
      },
    ],
  };
}

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

    const partialCuda = structuredClone(evaluatedResponse);
    delete partialCuda.model.cuda_capability;
    expect(() => AiResponseSchema.parse(partialCuda)).toThrow(/recorded together/);

    const unavailableWithCuda = structuredClone(evaluatedResponse);
    unavailableWithCuda.model.loaded = false;
    unavailableWithCuda.model.device = "unavailable";
    unavailableWithCuda.model.attention_backend = "unavailable";
    expect(() => AiResponseSchema.parse(unavailableWithCuda)).toThrow(/CUDA metadata requires/);
  });

  it("protocol error에 series 또는 evaluation 결과가 섞이는 것을 거부한다", () => {
    const input = structuredClone(evaluatedResponse);
    input.status = "unavailable";
    (input as { error?: unknown }).error = { code: "INVALID_REQUEST", message: "invalid" };
    expect(() => AiResponseSchema.parse(input)).toThrow(/without series or evaluation/);
  });

  it("Chronos-2와 Kronos-small의 동일 origin run과 latency provenance를 검증한다", () => {
    const parsed = AiResponseSchema.parse(dualForecastResponse());
    expect(parsed.model_runs?.map((run) => run.role)).toEqual(["chronos2", "kronos_small"]);
    expect(parsed.model_runs?.map((run) => run.expected_model_id)).toEqual([
      "amazon/chronos-2",
      "NeoQuasar/Kronos-small",
    ]);
    expect(parsed.model_runs?.[0]?.input_origins).toEqual(parsed.model_runs?.[1]?.input_origins);
    expect(parsed.model_runs?.every((run) => run.input_end_aligned && run.latency_ms >= 0)).toBe(true);
    expect(parsed.model_runs?.[0]?.input_origins[0]).toMatchObject({
      context_start_at: "2026-07-21T00:30:00.000Z",
      bar_count: 60,
      input_digest: "a".repeat(64),
    });
    expect(parsed.model_runs?.[0]?.model).toMatchObject({
      device_name: "Tesla P40",
      cuda_capability: "6.1",
    });
  });

  it("모델 간 input 범위·digest drift와 legacy Chronos mirror 위변조를 거부한다", () => {
    const originDrift = structuredClone(AiResponseSchema.parse(dualForecastResponse()));
    originDrift.model_runs![1]!.input_origins[0]!.input_end_at = "2026-07-21T01:28:00.000Z";
    originDrift.model_runs![1]!.raw_series[0]!.input_end_at = "2026-07-21T01:28:00.000Z";
    expect(() => AiResponseSchema.parse(originDrift)).toThrow(/identical input origins/);

    const digestDrift = structuredClone(AiResponseSchema.parse(dualForecastResponse()));
    digestDrift.model_runs![1]!.input_origins[0]!.input_digest = "b".repeat(64);
    expect(() => AiResponseSchema.parse(digestDrift)).toThrow(/identical input origins/);

    const rangeDrift = structuredClone(AiResponseSchema.parse(dualForecastResponse()));
    rangeDrift.model_runs![1]!.input_origins[0]!.bar_count -= 1;
    expect(() => AiResponseSchema.parse(rangeDrift)).toThrow(/identical input origins/);

    const legacyDrift = structuredClone(AiResponseSchema.parse(dualForecastResponse()));
    legacyDrift.series[0]!.unavailable!.code = "FORGED";
    expect(() => AiResponseSchema.parse(legacyDrift)).toThrow(/legacy response fields/);
  });

  it("명시적 Bolt fallback은 실제 모델 ID와 degraded 원인을 요구한다", () => {
    const fallback = structuredClone(AiResponseSchema.parse(dualForecastResponse()));
    const chronos = fallback.model_runs![0]!;
    chronos.model.model_id = "amazon/chronos-bolt-small";
    chronos.model.model_revision = "772f3d25d38aec6d914c8949dab4462e2d46f5d8";
    chronos.model.fallback_from = "amazon/chronos-2";
    chronos.model.fallback_reason = "Chronos-2 cache missing";
    chronos.degraded = true;
    chronos.fallback_used = true;
    chronos.fallback_reason = "Chronos-2 cache missing";
    fallback.model = structuredClone(chronos.model);
    expect(AiResponseSchema.parse(fallback).model_runs?.[0]).toMatchObject({
      expected_model_id: "amazon/chronos-2",
      degraded: true,
      fallback_used: true,
      fallback_reason: "Chronos-2 cache missing",
      model: { model_id: "amazon/chronos-bolt-small" },
    });

    const wrongSource = structuredClone(fallback);
    wrongSource.model_runs![0]!.model.fallback_from = "unexpected/model";
    wrongSource.model = structuredClone(wrongSource.model_runs![0]!.model);
    expect(() => AiResponseSchema.parse(wrongSource)).toThrow(/degraded Chronos-2 fallback/);

    chronos.degraded = false;
    expect(() => AiResponseSchema.parse(fallback)).toThrow(/degraded Chronos-2 fallback/);
  });

  it("fallback_used=false run에 fallback provenance가 섞이는 것을 거부한다", () => {
    const response = structuredClone(AiResponseSchema.parse(dualForecastResponse()));
    const chronos = response.model_runs![0]!;
    chronos.model.fallback_from = "amazon/chronos-2";
    chronos.model.fallback_reason = "unexpected fallback marker";
    chronos.fallback_reason = "unexpected fallback marker";
    response.model = structuredClone(chronos.model);
    expect(() => AiResponseSchema.parse(response)).toThrow(/cannot contain fallback provenance/);
  });
});
