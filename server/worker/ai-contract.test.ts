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
    model_id: "NeoQuasar/Kronos-base",
    model_revision: "kronos-base-pinned-revision",
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

function kronosForecastResponse(): unknown {
  const rawSeries = structuredClone(evaluatedResponse.series);
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
    request_id: "kronos-base-forecast",
    mode: "forecast",
    status: "unavailable",
    model: kronosModel,
    generated_at: "2026-07-21T01:30:02.000Z",
    series: rawSeries,
    model_runs: [
      {
        role: "kronos_base",
        expected_model_id: "NeoQuasar/Kronos-base",
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

function quantileObservations(overrides: Record<string, unknown> = {}) {
  return {
    row_count: 7_680,
    non_finite_value_count: 0,
    crossing_row_count: 65,
    crossing_adjacent_pair_count: 74,
    adjusted_row_count: 65,
    q50_adjustment_iqr_ratio_median: 0,
    q50_adjustment_iqr_ratio_p95: 0.06324,
    q50_adjustment_iqr_ratio_max: 0.1502,
    postprocessed_monotonic: true,
    ...overrides,
  };
}

function fincastForecastResponse(precision: "mixed_float16" | "float32" = "mixed_float16"): unknown {
  const response = structuredClone(kronosForecastResponse()) as {
    model: Record<string, unknown>;
    model_runs: Array<{
      role: string;
      expected_model_id: string;
      model: Record<string, unknown>;
    }>;
  };
  const model = {
    ...response.model,
    model_id: "Vincent05R/FinCast",
    model_revision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
    tokenizer_id: null,
    tokenizer_revision: null,
    source_revision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
    loader_version: "fincast-source-488b19d",
    license: "Apache-2.0",
    dtype: precision,
    precision_validation: precision === "mixed_float16" ? "passed" : "fallback_fp32",
    peak_vram_bytes: 4_294_967_296,
    peak_vram_measurement: "cuda_allocated_or_reserved",
    memory_status: "ok",
    quantile_monotonicity_policy: "fp32_monotone_rearrangement_v1",
    fp32_quantile_observations: quantileObservations(),
    mixed_quantile_observations: quantileObservations({
      crossing_row_count: 67,
      crossing_adjacent_pair_count: 79,
      adjusted_row_count: 67,
    }),
    quantile_tail_policy: "tail_clamped_q10_q90",
    precision_failure_reasons: precision === "mixed_float16"
      ? []
      : ["q50_p95_error_above_15pct_fp32_iqr"],
  };
  response.model = model;
  response.model_runs[0]!.role = "fincast";
  response.model_runs[0]!.expected_model_id = "Vincent05R/FinCast";
  response.model_runs[0]!.model = structuredClone(model);
  return response;
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

  it("Kronos-base 단일 origin run과 latency provenance를 검증한다", () => {
    const parsed = AiResponseSchema.parse(kronosForecastResponse());
    expect(parsed.model_runs?.map((run) => run.role)).toEqual(["kronos_base"]);
    expect(parsed.model_runs?.map((run) => run.expected_model_id)).toEqual([
      "NeoQuasar/Kronos-base",
    ]);
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

  it("Kronos-base origin/result 정렬과 top-level mirror 위변조를 거부한다", () => {
    const originDrift = structuredClone(AiResponseSchema.parse(kronosForecastResponse()));
    originDrift.model_runs![0]!.input_origins[0]!.input_end_at = "2026-07-21T01:28:00.000Z";
    expect(() => AiResponseSchema.parse(originDrift)).toThrow(/align exactly/);

    const mirrorDrift = structuredClone(AiResponseSchema.parse(kronosForecastResponse()));
    mirrorDrift.series[0]!.unavailable!.code = "FORGED";
    expect(() => AiResponseSchema.parse(mirrorDrift)).toThrow(/top-level response fields/);
  });

  it("Kronos-base run의 degraded·fallback 및 다른 모델 ID를 거부한다", () => {
    const response = structuredClone(AiResponseSchema.parse(kronosForecastResponse()));
    response.model_runs![0]!.degraded = true;
    expect(() => AiResponseSchema.parse(response)).toThrow(/cannot contain degraded or model fallback/);

    const fallback = structuredClone(AiResponseSchema.parse(kronosForecastResponse()));
    fallback.model_runs![0]!.fallback_used = true;
    fallback.model_runs![0]!.fallback_reason = "unexpected fallback";
    expect(() => AiResponseSchema.parse(fallback)).toThrow(/cannot contain degraded or model fallback/);

    const otherModel = structuredClone(evaluatedResponse);
    otherModel.model.model_id = "amazon/chronos-2";
    expect(() => AiResponseSchema.parse(otherModel)).toThrow(/supported pinned Kronos-base or FinCast/);
  });

  it("FinCast의 검증된 mixed FP16과 손실 없는 FP32 precision fallback을 각각 수용한다", () => {
    const fp16 = AiResponseSchema.parse(fincastForecastResponse());
    expect(fp16.model_runs?.[0]).toMatchObject({
      role: "fincast",
      expected_model_id: "Vincent05R/FinCast",
      model: {
        dtype: "mixed_float16",
        precision_validation: "passed",
        memory_status: "ok",
        quantile_monotonicity_policy: "fp32_monotone_rearrangement_v1",
        quantile_tail_policy: "tail_clamped_q10_q90",
      },
    });

    const fp32 = AiResponseSchema.parse(fincastForecastResponse("float32"));
    expect(fp32.model_runs?.[0]?.model).toMatchObject({
      model_id: "Vincent05R/FinCast",
      dtype: "float32",
      precision_validation: "fallback_fp32",
      precision_failure_reasons: ["q50_p95_error_above_15pct_fp32_iqr"],
    });
  });

  it("lane/model identity 불일치와 모델 대체 fallback을 FinCast에서도 거부한다", () => {
    const identityDrift = structuredClone(fincastForecastResponse()) as {
      model_runs: Array<{ expected_model_id: string }>;
    };
    identityDrift.model_runs[0]!.expected_model_id = "NeoQuasar/Kronos-base";
    expect(() => AiResponseSchema.parse(identityDrift)).toThrow(/role and expected model identity/);

    const modelFallback = structuredClone(fincastForecastResponse()) as {
      model: { fallback_from?: string };
      model_runs: Array<{ model: { fallback_from?: string } }>;
    };
    modelFallback.model.fallback_from = "NeoQuasar/Kronos-base";
    modelFallback.model_runs[0]!.model.fallback_from = "NeoQuasar/Kronos-base";
    expect(() => AiResponseSchema.parse(modelFallback)).toThrow(/cannot contain model fallback provenance/);
  });

  it("mixed FP16 검증 누락과 Kronos precision 위장을 거부한다", () => {
    const unvalidated = structuredClone(fincastForecastResponse()) as {
      model: { precision_validation: string };
      model_runs: Array<{ model: { precision_validation: string } }>;
    };
    unvalidated.model.precision_validation = "fallback_fp32";
    unvalidated.model_runs[0]!.model.precision_validation = "fallback_fp32";
    expect(() => AiResponseSchema.parse(unvalidated)).toThrow(/requires passed precision validation/);

    const disguisedKronos = structuredClone(kronosForecastResponse()) as {
      model: { dtype: string; precision_validation?: string };
      model_runs: Array<{ model: { dtype: string; precision_validation?: string } }>;
    };
    disguisedKronos.model.dtype = "mixed_float16";
    disguisedKronos.model.precision_validation = "passed";
    disguisedKronos.model_runs[0]!.model.dtype = "mixed_float16";
    disguisedKronos.model_runs[0]!.model.precision_validation = "passed";
    expect(() => AiResponseSchema.parse(disguisedKronos)).toThrow(/native float32 provenance/);
  });

  it("FinCast quantile monotonicity policy 누락이나 native 위장을 거부한다", () => {
    const missing = structuredClone(fincastForecastResponse()) as {
      model: { quantile_monotonicity_policy?: string };
      model_runs: Array<{ model: { quantile_monotonicity_policy?: string } }>;
    };
    delete missing.model.quantile_monotonicity_policy;
    delete missing.model_runs[0]!.model.quantile_monotonicity_policy;
    expect(() => AiResponseSchema.parse(missing)).toThrow(/complete validated precision and VRAM provenance/);

    const native = structuredClone(fincastForecastResponse()) as {
      model: { quantile_monotonicity_policy: string };
      model_runs: Array<{ model: { quantile_monotonicity_policy: string } }>;
    };
    native.model.quantile_monotonicity_policy = "native";
    native.model_runs[0]!.model.quantile_monotonicity_policy = "native";
    expect(() => AiResponseSchema.parse(native)).toThrow(/complete validated precision and VRAM provenance/);
  });

  it("FinCast qualification 관측치를 정확히 제한하고 FP32/mixed 모두 요구한다", () => {
    const missing = structuredClone(fincastForecastResponse()) as {
      model: { fp32_quantile_observations?: unknown };
      model_runs: Array<{ model: { fp32_quantile_observations?: unknown } }>;
    };
    delete missing.model.fp32_quantile_observations;
    delete missing.model_runs[0]!.model.fp32_quantile_observations;
    expect(() => AiResponseSchema.parse(missing)).toThrow(
      /complete validated precision and VRAM provenance/,
    );

    const unbounded = structuredClone(fincastForecastResponse()) as {
      model: { mixed_quantile_observations: { crossing_adjacent_pair_count: number } };
      model_runs: Array<{
        model: { mixed_quantile_observations: { crossing_adjacent_pair_count: number } };
      }>;
    };
    unbounded.model.mixed_quantile_observations.crossing_adjacent_pair_count = 61_441;
    unbounded.model_runs[0]!.model.mixed_quantile_observations
      .crossing_adjacent_pair_count = 61_441;
    expect(() => AiResponseSchema.parse(unbounded)).toThrow(
      /crossing adjacent-pair count exceeds/,
    );

    const invalidOrdering = structuredClone(fincastForecastResponse()) as {
      model: { fp32_quantile_observations: { q50_adjustment_iqr_ratio_p95: number } };
      model_runs: Array<{
        model: { fp32_quantile_observations: { q50_adjustment_iqr_ratio_p95: number } };
      }>;
    };
    invalidOrdering.model.fp32_quantile_observations.q50_adjustment_iqr_ratio_p95 = 0.2;
    invalidOrdering.model_runs[0]!.model.fp32_quantile_observations
      .q50_adjustment_iqr_ratio_p95 = 0.2;
    expect(() => AiResponseSchema.parse(invalidOrdering)).toThrow(
      /q50 adjustment summaries must be ordered/,
    );
  });

  it("FinCast mixed runtime failure만 null mixed 관측치를 허용한다", () => {
    const runtimeFailure = structuredClone(fincastForecastResponse("float32")) as {
      model: Record<string, unknown>;
      model_runs: Array<{ model: Record<string, unknown> }>;
    };
    for (const model of [runtimeFailure.model, runtimeFailure.model_runs[0]!.model]) {
      model.precision_failure_reasons = ["mixed_inference_failure"];
      model.mixed_quantile_observations = null;
    }
    expect(AiResponseSchema.parse(runtimeFailure).model).toMatchObject({
      precision_validation: "fallback_fp32",
      mixed_quantile_observations: null,
    });

    const hiddenCompleted = structuredClone(fincastForecastResponse()) as {
      model: Record<string, unknown>;
      model_runs: Array<{ model: Record<string, unknown> }>;
    };
    hiddenCompleted.model.mixed_quantile_observations = null;
    hiddenCompleted.model_runs[0]!.model.mixed_quantile_observations = null;
    expect(() => AiResponseSchema.parse(hiddenCompleted)).toThrow(
      /complete validated precision and VRAM provenance/,
    );
  });
});
