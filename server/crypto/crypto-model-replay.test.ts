import { describe, expect, it } from "vitest";
import {
  AiResponseSchema,
  FINCAST_MODEL_ID,
  KRONOS_BASE_MODEL_ID,
  SCALPING_AI_HORIZONS,
  SCALPING_AI_QUANTILES,
  type AiEvaluateRequest,
} from "../worker/ai-contract.js";
import {
  CryptoModelComparisonReplay,
  CryptoModelReplayError,
  type CryptoReplayLane,
  type CryptoReplayLaneClient,
} from "./crypto-model-replay.js";

const NOW = Date.parse("2026-07-25T12:34:56.000Z");
const END_EXCLUSIVE = Date.parse("2026-07-25T00:00:00.000Z");
const START = Date.parse("2026-07-18T00:00:00.000Z");
const MINUTE_MS = 60_000;
const CONTEXT_BARS = 512;
const CONTEXT_PREFIX_BARS = CONTEXT_BARS - 1;
const OUTCOME_TAIL_BARS = 60;
const EVALUATION_BARS = 7 * 24 * 60;
const INPUT_BARS = CONTEXT_PREFIX_BARS + EVALUATION_BARS + OUTCOME_TAIL_BARS;
const ORIGINS = 7 * 24 * 4;
const DATA_START = START - CONTEXT_PREFIX_BARS * MINUTE_MS;
const DATA_END_EXCLUSIVE = END_EXCLUSIVE + OUTCOME_TAIL_BARS * MINUTE_MS;
const MAXIMUM_REQUEST_BYTES = 64 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 128 * 1024 * 1024;
const COSTS = {
  commission_bps_per_side: 2,
  tax_bps_on_exit: 0,
  spread_bps_round_trip: 1,
  slippage_bps_per_side: 1,
} as const;

function qualificationObservations(overrides: Record<string, unknown> = {}) {
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

type RawBar = [
  number, string, string, string, string, string,
  number, string, number, string, string, string,
];

function rawBars(): RawBar[] {
  return Array.from({ length: INPUT_BARS }, (_unused, index) => {
    const openTime = DATA_START + index * MINUTE_MS;
    const open = 100 + index * 0.01;
    const close = open + 0.004;
    return [
      openTime,
      open.toFixed(6),
      (close + 0.01).toFixed(6),
      (open - 0.01).toFixed(6),
      close.toFixed(6),
      "10",
      openTime + MINUTE_MS - 1,
      (open * 10).toFixed(6),
      12,
      "0",
      "0",
      "0",
    ];
  });
}

const COMPLETE_BARS = rawBars();

function restWith(
  mutate?: (bars: RawBar[]) => RawBar[],
): {
  rest: { klines(input: { startTime?: number; endTime?: number; limit?: number }): Promise<unknown> };
  calls: Array<{ startTime?: number; endTime?: number; limit?: number }>;
} {
  const source = mutate ? mutate(COMPLETE_BARS.map((bar) => [...bar] as RawBar)) : COMPLETE_BARS;
  const calls: Array<{ startTime?: number; endTime?: number; limit?: number }> = [];
  return {
    calls,
    rest: {
      async klines(input) {
        calls.push({ ...input });
        const start = input.startTime ?? DATA_START;
        const end = input.endTime ?? DATA_END_EXCLUSIVE - 1;
        return source
          .filter((bar) => bar[0] >= start && bar[0] <= end)
          .slice(0, input.limit ?? 1_024)
          .reverse();
      },
    },
  };
}

function model(role: CryptoReplayLane) {
  if (role === "kronos_base") {
    return {
      model_id: KRONOS_BASE_MODEL_ID,
      model_revision: "2b554741eca47781b64468546e77fef3e85130e6",
      tokenizer_id: "NeoQuasar/Kronos-Tokenizer-base",
      tokenizer_revision: "0e0117387f39004a9016484a186a908917e22426",
      source_revision: "67b630e67f6a18c9e9be918d9b4337c960db1e9a",
      loader_version: "kronos-source-67b630e",
      license: "MIT",
      device: "cuda" as const,
      device_name: "Tesla P40",
      cuda_capability: "6.1",
      dtype: "float32" as const,
      attention_backend: "math" as const,
      loaded: true,
      precision_validation: "not_required" as const,
      memory_status: "ok" as const,
      quantile_monotonicity_policy: "native" as const,
      quantile_tail_policy: "native" as const,
    };
  }
  return {
    model_id: FINCAST_MODEL_ID,
    model_revision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
    tokenizer_id: null,
    tokenizer_revision: null,
    source_revision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
    loader_version: "fincast-source-488b19d",
    license: "Apache-2.0",
    device: "cuda" as const,
    device_name: "Tesla P40",
    cuda_capability: "6.1",
    dtype: "mixed_float16" as const,
    attention_backend: "math" as const,
    loaded: true,
    precision_validation: "passed" as const,
    peak_vram_bytes: 1_000_000,
    peak_vram_measurement: "cuda_allocated_or_reserved" as const,
    memory_status: "ok" as const,
    quantile_monotonicity_policy: "fp32_monotone_rearrangement_v1" as const,
    fp32_quantile_observations: qualificationObservations(),
    mixed_quantile_observations: qualificationObservations({
      crossing_row_count: 67,
      crossing_adjacent_pair_count: 79,
      adjusted_row_count: 67,
    }),
    quantile_tail_policy: "tail_clamped_q10_q90" as const,
    precision_failure_reasons: [],
  };
}

function responseFor(
  role: CryptoReplayLane,
  request: AiEvaluateRequest,
  predictionShift = role === "kronos_base" ? 0.0001 : 0.0002,
) {
  const source = request.series[0]!;
  const indexes = new Map(source.bars.map((bar, index) => [bar.timestamp, index]));
  const costRate = (
    request.cost_assumptions.commission_bps_per_side * 2
    + request.cost_assumptions.tax_bps_on_exit
    + request.cost_assumptions.spread_bps_round_trip
    + request.cost_assumptions.slippage_bps_per_side * 2
  ) / 10_000;
  const records = source.origins.flatMap((origin) => {
    const index = indexes.get(origin.origin)!;
    return SCALPING_AI_HORIZONS.map((horizon) => {
      const originBar = source.bars[index]!;
      const nextBar = source.bars[index + 1]!;
      const targetBar = source.bars[index + horizon]!;
      const actualReturn = targetBar.close / originBar.close - 1;
      const executionReturn = targetBar.close / nextBar.open - 1;
      const predictedQuantiles = SCALPING_AI_QUANTILES.map((quantile) => ({
        quantile,
        value: predictionShift + (quantile - 0.5) * 0.01,
      }));
      return {
        instrument_key: source.instrument_key,
        origin: origin.origin,
        horizon_minutes: horizon,
        target_timestamp: targetBar.timestamp,
        status: "available" as const,
        predicted_median_return: predictionShift,
        predicted_quantiles: predictedQuantiles,
        actual_return: actualReturn,
        execution_return: executionReturn,
        up_probability: 0.6,
        predicted_first_passage: null,
        actual_first_passage: null,
        technical_signal: null,
        regime: null,
        round_trip_cost_rate: costRate,
        technical_net_return: null,
        ai_filtered_net_return: null,
        unavailable: null,
      };
    });
  });
  const provenance = model(role);
  return AiResponseSchema.parse({
    schema_version: request.schema_version,
    request_id: request.request_id,
    mode: "evaluate",
    status: "available",
    model: provenance,
    generated_at: new Date(NOW).toISOString(),
    series: source.origins.map((origin, originIndex) => {
      const index = indexes.get(origin.origin)!;
      const close = source.bars[index]!.close;
      return {
        instrument_key: `${source.instrument_key}@${originIndex}`,
        status: "available" as const,
        input_end_at: origin.origin,
        horizons: SCALPING_AI_HORIZONS.map((horizon) => ({
          horizon_minutes: horizon,
          target_timestamp: origin.future_timestamps[horizon - 1],
          return_quantiles: SCALPING_AI_QUANTILES.map((quantile) => ({
            quantile,
            value: predictionShift + (quantile - 0.5) * 0.01,
          })),
          price_quantiles: SCALPING_AI_QUANTILES.map((quantile) => ({
            quantile,
            value: close * (1 + predictionShift + (quantile - 0.5) * 0.01),
          })),
          up_probability: 0.6,
          down_probability: 0.4,
          flat_probability: 0,
          probability_method: "derived_quantile_cdf" as const,
          expected_volatility: 0.01,
          volatility_method: "quantile_implied_sigma" as const,
          uncertainty_interval_width: 0.01,
          target_stop: { status: "unavailable" as const, reason: "not configured" },
          valid_path_count: 0,
          invalid_path_count: 0,
        })),
        input_quality: {
          status: "good" as const,
          bar_count: CONTEXT_BARS,
          missing_volume_ratio: 0,
          missing_amount_ratio: 0,
          irregular_interval_count: 0,
          warnings: [],
        },
        distribution_shift: {
          status: "unavailable" as const,
          reason: "reference_statistics_not_published" as const,
        },
        unavailable: null,
      };
    }),
    evaluation: {
      retrospective: true,
      cost_assumptions: request.cost_assumptions,
      records,
      metrics: [],
    },
    error: null,
  });
}

function lane(
  role: CryptoReplayLane,
  onRequest?: (
    request: AiEvaluateRequest,
    response: ReturnType<typeof responseFor>,
  ) => void,
): CryptoReplayLaneClient {
  return {
    async request(request) {
      const response = responseFor(role, request);
      onRequest?.(request, response);
      return response;
    },
  };
}

function replay(
  rest: ReturnType<typeof restWith>["rest"],
  lanes?: Partial<Record<CryptoReplayLane, CryptoReplayLaneClient>>,
  deadlineMs = 10_000,
  requestId: () => string = () => "crypto-replay:test",
) {
  return new CryptoModelComparisonReplay({
    rest,
    lanes: {
      kronos_base: lanes?.kronos_base ?? lane("kronos_base"),
      fincast: lanes?.fincast ?? lane("fincast"),
    },
    clock: { now: () => NOW },
    deadlineMs,
    requestId,
  });
}

describe("CryptoModelComparisonReplay", () => {
  it("paginates seven complete UTC days and compares two strict independent lanes", async () => {
    const fixture = restWith();
    const order: string[] = [];
    const responseWireBytes: number[] = [];
    const responseShapes: Array<{ series: number; records: number }> = [];
    let firstRequest: AiEvaluateRequest | undefined;
    let secondRequest: AiEvaluateRequest | undefined;
    const result = await replay(fixture.rest, {
      kronos_base: lane("kronos_base", (request, response) => {
        order.push("kronos");
        firstRequest = request;
        responseWireBytes.push(Buffer.byteLength(JSON.stringify(response), "utf8"));
        responseShapes.push({
          series: response.series.length,
          records: response.evaluation?.records.length ?? 0,
        });
      }),
      fincast: lane("fincast", (request, response) => {
        order.push("fincast");
        secondRequest = request;
        responseWireBytes.push(Buffer.byteLength(JSON.stringify(response), "utf8"));
        responseShapes.push({
          series: response.series.length,
          records: response.evaluation?.records.length ?? 0,
        });
      }),
    }).run({ symbol: "btcusdt", costAssumptions: COSTS });

    expect(fixture.calls).toHaveLength(11);
    expect(fixture.calls.every((call) => call.limit === 1_024)).toBe(true);
    expect(fixture.calls[0]).toMatchObject({
      startTime: DATA_START,
      endTime: DATA_END_EXCLUSIVE - 1,
      limit: 1_024,
    });
    expect(order).toEqual(["kronos", "fincast"]);
    expect(firstRequest).toBe(secondRequest);
    expect(Object.isFrozen(firstRequest)).toBe(true);
    expect(firstRequest?.series[0]?.bars).toHaveLength(INPUT_BARS);
    expect(firstRequest?.series[0]?.origins).toHaveLength(ORIGINS);
    expect(firstRequest?.series[0]?.origins.every((origin, index, origins) => (
      origin.future_timestamps.length === 60
      && (index === 0
        || Date.parse(origin.origin) - Date.parse(origins[index - 1]!.origin) === 15 * MINUTE_MS)
    ))).toBe(true);
    expect((Date.parse(firstRequest!.series[0]!.origins[0]!.origin) + 1) % (15 * MINUTE_MS)).toBe(0);
    expect(firstRequest?.series[0]?.origins[0]?.origin).toBe("2026-07-18T00:14:59.999Z");
    expect(firstRequest?.series[0]?.origins.at(-1)?.origin).toBe("2026-07-24T23:59:59.999Z");
    expect(Buffer.byteLength(JSON.stringify(firstRequest), "utf8"))
      .toBeLessThanOrEqual(MAXIMUM_REQUEST_BYTES);
    expect(responseShapes).toEqual([
      { series: ORIGINS, records: ORIGINS * SCALPING_AI_HORIZONS.length },
      { series: ORIGINS, records: ORIGINS * SCALPING_AI_HORIZONS.length },
    ]);
    expect(responseWireBytes).toHaveLength(2);
    expect(Math.max(...responseWireBytes)).toBeLessThanOrEqual(MAXIMUM_RESPONSE_BYTES);
    expect(result.window).toEqual({
      startAt: "2026-07-18T00:00:00.000Z",
      endExclusiveAt: "2026-07-25T00:00:00.000Z",
      completeUtcDays: 7,
      barCount: EVALUATION_BARS,
      contextPrefetchBarCount: CONTEXT_PREFIX_BARS,
      outcomeTailBarCount: OUTCOME_TAIL_BARS,
      inputBarCount: INPUT_BARS,
      originCount: ORIGINS,
      originStrideMinutes: 15,
      futureBarsPerOrigin: 60,
    });
    expect(result.lanes.kronos_base).toMatchObject({
      availability: "available",
      identityVerified: true,
      effectiveContextBars: CONTEXT_BARS,
      fallbackUsed: false,
      provenance: {
        modelId: KRONOS_BASE_MODEL_ID,
        modelRevision: "2b554741eca47781b64468546e77fef3e85130e6",
        sourceRevision: "67b630e67f6a18c9e9be918d9b4337c960db1e9a",
        device: "cuda",
        deviceName: "Tesla P40",
        cudaCapability: "6.1",
        precision: "fp32",
        precisionValidation: "not_required",
        precisionFallbackUsed: false,
        quantileMonotonicityPolicy: "native",
        fp32QuantileObservations: null,
        mixedQuantileObservations: null,
      },
    });
    expect(result.lanes.fincast).toMatchObject({
      availability: "available",
      identityVerified: true,
      effectiveContextBars: CONTEXT_BARS,
      fallbackUsed: false,
      provenance: {
        modelId: FINCAST_MODEL_ID,
        modelRevision: "2d7d90b159db8961d27c2cf165d51195902ef92b",
        sourceRevision: "488b19d1d85fa2b3d4b93469530cefdcf1cc97a4",
        device: "cuda",
        deviceName: "Tesla P40",
        cudaCapability: "6.1",
        precision: "fp16",
        precisionValidation: "passed",
        precisionFallbackUsed: false,
        quantileMonotonicityPolicy: "fp32_monotone_rearrangement_v1",
        fp32QuantileObservations: {
          rowCount: 7_680,
          crossingRowCount: 65,
          crossingAdjacentPairCount: 74,
          adjustedRowCount: 65,
          q50AdjustmentIqrRatioP95: 0.06324,
          postprocessedMonotonic: true,
        },
        mixedQuantileObservations: {
          rowCount: 7_680,
          crossingRowCount: 67,
          crossingAdjacentPairCount: 79,
          adjustedRowCount: 67,
          postprocessedMonotonic: true,
        },
        peakVramBytes: 1_000_000,
      },
    });
    expect(result.lanes.kronos_base.effectiveContextDigest)
      .toMatch(/^[0-9a-f]{64}$/);
    expect(result.lanes.kronos_base.effectiveContextDigest)
      .toBe(result.lanes.fincast.effectiveContextDigest);
    expect(result.lanes.kronos_base.metrics).toHaveLength(4);
    expect(result.lanes.kronos_base.metrics[0]).toMatchObject({
      horizonMinutes: 5,
      count: ORIGINS,
    });
    expect(result.lanes.kronos_base.metrics[0]!.meanPinballLoss).toBeGreaterThanOrEqual(0);
    expect(result.lanes.kronos_base.metrics[0]!.medianReturnMae).toBeGreaterThanOrEqual(0);
    expect(result.lanes.kronos_base.metrics[0]!.directionAccuracy).toBeGreaterThanOrEqual(0);
    expect(result.lanes.kronos_base.metrics[0]!.quantiles).toHaveLength(7);
    expect(result.comparison).toEqual({
      identitiesVerified: true,
      sameInputDigest: true,
      sameRecords: true,
      sameOrigin: true,
      sameContext: true,
      sameCosts: true,
      sameFillBarrier: true,
      automaticWinner: null,
      outcome: "review_required",
    });
  });

  it("keeps the semantic input digest deterministic across transport request IDs", async () => {
    const fixture = restWith();
    let requestOrdinal = 0;
    const unavailable: CryptoReplayLaneClient = {
      async request() {
        throw new Error("intentionally unavailable");
      },
    };
    const worker = replay(fixture.rest, {
      kronos_base: unavailable,
      fincast: unavailable,
    }, 10_000, () => `crypto-replay:semantic-${requestOrdinal += 1}`);
    const first = await worker.run({ symbol: "BTCUSDT", costAssumptions: COSTS });
    const second = await worker.run({ symbol: "BTCUSDT", costAssumptions: COSTS });

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.inputDigest).toBe(second.inputDigest);
    expect(first.lanes.kronos_base.inputDigest).toBe(first.inputDigest);
    expect(second.lanes.fincast.inputDigest).toBe(second.inputDigest);
  });

  it("fails closed when a lane reports different effective context evidence", async () => {
    const fixture = restWith();
    const result = await replay(fixture.rest, {
      kronos_base: {
        async request(request) {
          const raw = responseFor("kronos_base", request);
          raw.series[0]!.input_quality.bar_count = CONTEXT_BARS - 1;
          return raw;
        },
      },
      fincast: lane("fincast"),
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(result.lanes.kronos_base).toMatchObject({
      availability: "unavailable",
      identityVerified: false,
      error: { code: "CONTEXT_EVIDENCE_MISMATCH" },
    });
    expect(result.comparison).toMatchObject({
      sameContext: false,
      outcome: "inconclusive",
    });
  });

  it("fails closed on revision drift and preserves a validated FinCast FP32 fallback", async () => {
    const revisionFixture = restWith();
    const revisionResult = await replay(revisionFixture.rest, {
      kronos_base: {
        async request(request) {
          const raw = responseFor("kronos_base", request);
          raw.model.model_revision = "unpinned-revision";
          return raw;
        },
      },
      fincast: lane("fincast"),
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(revisionResult.lanes.kronos_base).toMatchObject({
      availability: "unavailable",
      identityVerified: false,
      error: { code: "MODEL_PROVENANCE_MISMATCH" },
    });
    expect(revisionResult.lanes.kronos_base).not.toHaveProperty("provenance");

    const fallbackFixture = restWith();
    const fallbackResult = await replay(fallbackFixture.rest, {
      kronos_base: lane("kronos_base"),
      fincast: {
        async request(request) {
          const raw = responseFor("fincast", request);
          raw.model.dtype = "float32";
          raw.model.precision_validation = "fallback_fp32";
          raw.model.precision_failure_reasons = [
            "q50_median_error_above_5pct_fp32_iqr",
          ];
          return raw;
        },
      },
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(fallbackResult.lanes.fincast).toMatchObject({
      availability: "available",
      identityVerified: true,
      provenance: {
        precision: "fp32",
        precisionValidation: "fallback_fp32",
        precisionFallbackUsed: true,
        precisionFailureReasons: [
          "q50_median_error_above_5pct_fp32_iqr",
        ],
      },
    });
    expect(fallbackResult.comparison.outcome).toBe("review_required");
  });

  it.each([
    ["tokenizer_id", "/tmp/private-fincast-tokenizer-id"],
    ["tokenizer_revision", "/tmp/private-fincast-tokenizer-revision"],
  ] as const)(
    "requires FinCast null %s provenance and does not persist drifted values",
    async (field, unsafeTokenizer) => {
      const fixture = restWith();
      const result = await replay(fixture.rest, {
        kronos_base: lane("kronos_base"),
        fincast: {
          async request(request) {
            const raw = responseFor("fincast", request);
            raw.model[field] = unsafeTokenizer;
            return raw;
          },
        },
      }).run({
        symbol: "BTCUSDT",
        costAssumptions: COSTS,
      });

      expect(result.lanes.fincast).toMatchObject({
        availability: "unavailable",
        identityVerified: false,
        error: { code: "MODEL_TOKENIZER_PROVENANCE_MISMATCH" },
      });
      expect(result.lanes.fincast).not.toHaveProperty("provenance");
      expect(JSON.stringify(result)).not.toContain(unsafeTokenizer);
    },
  );

  it.each([
    ["device_name", "NVIDIA A100"],
    ["cuda_capability", "8.0"],
  ] as const)("requires pinned Tesla P40 runtime provenance when %s drifts", async (field, value) => {
    const fixture = restWith();
    const result = await replay(fixture.rest, {
      kronos_base: lane("kronos_base"),
      fincast: {
        async request(request) {
          const raw = responseFor("fincast", request);
          raw.model[field] = value;
          return raw;
        },
      },
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(result.lanes.fincast).toMatchObject({
      availability: "unavailable",
      identityVerified: false,
      error: { code: "MODEL_RUNTIME_PROVENANCE_INVALID" },
    });
    expect(result.lanes.fincast).not.toHaveProperty("provenance");
  });

  it("requires FinCast to disclose FP32 monotone rearrangement provenance", async () => {
    const fixture = restWith();
    const result = await replay(fixture.rest, {
      kronos_base: lane("kronos_base"),
      fincast: {
        async request(request) {
          const raw = responseFor("fincast", request);
          raw.model.quantile_monotonicity_policy = "native";
          return raw;
        },
      },
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(result.lanes.fincast).toMatchObject({
      availability: "unavailable",
      identityVerified: false,
      error: { code: "INVALID_RESPONSE_CONTRACT" },
    });
    expect(result.lanes.fincast).not.toHaveProperty("provenance");
  });

  it("fails closed when FinCast omits or overflows qualification observations", async () => {
    const missingFixture = restWith();
    const missing = await replay(missingFixture.rest, {
      kronos_base: lane("kronos_base"),
      fincast: {
        async request(request) {
          const raw = responseFor("fincast", request);
          delete (raw.model as Record<string, unknown>).fp32_quantile_observations;
          return raw;
        },
      },
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });
    expect(missing.lanes.fincast).toMatchObject({
      availability: "unavailable",
      identityVerified: false,
      error: { code: "INVALID_RESPONSE_CONTRACT" },
    });
    expect(missing.lanes.fincast).not.toHaveProperty("provenance");

    const overflowFixture = restWith();
    const overflow = await replay(overflowFixture.rest, {
      kronos_base: lane("kronos_base"),
      fincast: {
        async request(request) {
          const raw = responseFor("fincast", request);
          raw.model.mixed_quantile_observations!.crossing_row_count = 7_681;
          return raw;
        },
      },
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });
    expect(overflow.lanes.fincast).toMatchObject({
      availability: "unavailable",
      identityVerified: false,
      error: { code: "INVALID_RESPONSE_CONTRACT" },
    });
  });

  it("persists null mixed observations only for a bounded mixed runtime failure", async () => {
    const fixture = restWith();
    const result = await replay(fixture.rest, {
      kronos_base: lane("kronos_base"),
      fincast: {
        async request(request) {
          const raw = responseFor("fincast", request);
          raw.model.dtype = "float32";
          raw.model.precision_validation = "fallback_fp32";
          raw.model.precision_failure_reasons = ["mixed_inference_failure"];
          raw.model.mixed_quantile_observations = null;
          return raw;
        },
      },
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });
    expect(result.lanes.fincast).toMatchObject({
      availability: "available",
      identityVerified: true,
      provenance: {
        precision: "fp32",
        precisionValidation: "fallback_fp32",
        fp32QuantileObservations: {
          rowCount: 7_680,
          crossingRowCount: 65,
        },
        mixedQuantileObservations: null,
        precisionFailureReasons: ["mixed_inference_failure"],
      },
    });
  });

  it("deduplicates identical bars but fails closed on a missing minute", async () => {
    const duplicate = restWith((bars) => [bars[0]!, ...bars]);
    const complete = await replay(duplicate.rest).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });
    expect(complete.window).toMatchObject({
      barCount: EVALUATION_BARS,
      inputBarCount: INPUT_BARS,
      originCount: ORIGINS,
    });

    const gap = restWith((bars) => bars.filter((_bar, index) => index !== 4_000));
    await expect(replay(gap.rest).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    })).rejects.toMatchObject({ code: "data_gap" });
  });

  it("rejects a non-final historical tuple before invoking either model", async () => {
    let requests = 0;
    const fixture = restWith((bars) => {
      bars[100]![6] = NOW + MINUTE_MS;
      return bars;
    });
    const worker = lane("kronos_base", () => {
      requests += 1;
    });
    await expect(replay(fixture.rest, {
      kronos_base: worker,
      fincast: worker,
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    })).rejects.toMatchObject({ code: "non_final_bar" });
    expect(requests).toBe(0);
  });

  it("marks a model identity mismatch unavailable without borrowing the other lane", async () => {
    const fixture = restWith();
    const result = await replay(fixture.rest, {
      kronos_base: {
        async request(request) {
          return responseFor("fincast", request);
        },
      },
      fincast: lane("fincast"),
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(result.lanes.kronos_base).toMatchObject({
      availability: "unavailable",
      expectedModelId: KRONOS_BASE_MODEL_ID,
      observedModelId: FINCAST_MODEL_ID,
      identityVerified: false,
      fallbackUsed: false,
      error: { code: "MODEL_IDENTITY_MISMATCH" },
    });
    expect(result.lanes.fincast).toMatchObject({
      availability: "available",
      expectedModelId: FINCAST_MODEL_ID,
      observedModelId: FINCAST_MODEL_ID,
      identityVerified: true,
      fallbackUsed: false,
    });
    expect(result.comparison.outcome).toBe("inconclusive");
    expect(result.comparison.sameContext).toBe(false);
    expect(result.comparison.sameFillBarrier).toBe(false);
  });

  it("accepts Python-equivalent UTC serialization for the exact same millisecond instants", async () => {
    const fixture = restWith();
    const pythonSerialization = (value: string, index: number) => {
      const expanded = value.replace(/(\.\d{3})Z$/, "$1000Z");
      return index % 2 === 0 ? expanded : expanded.replace(/Z$/, "+00:00");
    };
    const result = await replay(fixture.rest, {
      kronos_base: {
        async request(request) {
          const raw = responseFor("kronos_base", request);
          for (const [index, record] of raw.evaluation!.records.entries()) {
            record.origin = pythonSerialization(record.origin, index);
            record.target_timestamp = pythonSerialization(record.target_timestamp, index + 1);
          }
          return raw;
        },
      },
      fincast: lane("fincast"),
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(result.lanes.kronos_base).toMatchObject({
      availability: "available",
      identityVerified: true,
    });
    expect(result.comparison).toMatchObject({
      sameRecords: true,
      sameOrigin: true,
      sameFillBarrier: true,
      outcome: "review_required",
    });
  });

  it("rejects a worker timestamp with non-zero sub-millisecond drift", async () => {
    const fixture = restWith();
    const result = await replay(fixture.rest, {
      kronos_base: {
        async request(request) {
          const raw = responseFor("kronos_base", request);
          raw.evaluation!.records[0]!.origin = raw.evaluation!.records[0]!.origin
            .replace(/(\.\d{3})Z$/, "$1001Z");
          return raw;
        },
      },
      fincast: lane("fincast"),
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(result.lanes.kronos_base).toMatchObject({
      availability: "unavailable",
      error: { code: "RECORD_TIMESTAMP_INVALID" },
    });
    expect(result.comparison.outcome).toBe("inconclusive");
  });

  it("rejects duplicate evaluation keys even when the response record count matches", async () => {
    const fixture = restWith();
    const result = await replay(fixture.rest, {
      kronos_base: {
        async request(request) {
          const raw = responseFor("kronos_base", request);
          const records = raw.evaluation!.records;
          records[1] = structuredClone(records[0]!);
          return raw;
        },
      },
      fincast: lane("fincast"),
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(result.lanes.kronos_base).toMatchObject({
      availability: "unavailable",
      identityVerified: false,
      error: {
        code: "INVALID_RESPONSE_CONTRACT",
        message: "The model lane returned an invalid response contract.",
      },
    });
    expect(result.comparison.outcome).toBe("inconclusive");
  });

  it("enforces one overall deadline and never starts the second lane after cancellation", async () => {
    const fixture = restWith();
    let fincastRequests = 0;
    const never = new Promise<never>(() => undefined);
    await expect(replay(fixture.rest, {
      kronos_base: { request: () => never },
      fincast: lane("fincast", () => {
        fincastRequests += 1;
      }),
    }, 5).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    })).rejects.toEqual(expect.objectContaining({
      name: "CryptoModelReplayError",
      code: "deadline_exceeded",
    } satisfies Partial<CryptoModelReplayError>));
    expect(fincastRequests).toBe(0);
  });

  it("honors caller cancellation before starting Binance pagination", async () => {
    let restRequests = 0;
    const controller = new AbortController();
    controller.abort(new Error("caller stopped replay"));
    await expect(replay({
      async klines() {
        restRequests += 1;
        return [];
      },
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
      signal: controller.signal,
    })).rejects.toMatchObject({
      name: "CryptoModelReplayError",
      code: "cancelled",
      message: "caller stopped replay",
    });
    expect(restRequests).toBe(0);
  });

  it("continues after an ordinary lane failure but keeps the lanes independent", async () => {
    const fixture = restWith();
    let fincastRequests = 0;
    const result = await replay(fixture.rest, {
      kronos_base: {
        async request() {
          throw new Error("/models/private/checkpoint and bearer-token-like-detail");
        },
      },
      fincast: lane("fincast", () => {
        fincastRequests += 1;
      }),
    }).run({
      symbol: "BTCUSDT",
      costAssumptions: COSTS,
    });

    expect(fincastRequests).toBe(1);
    expect(result.lanes.kronos_base).toMatchObject({
      availability: "unavailable",
      fallbackUsed: false,
      error: {
        code: "LANE_UNAVAILABLE",
        message: "The model lane was unavailable during replay.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("/models/private");
    expect(JSON.stringify(result)).not.toContain("bearer-token");
    expect(result.lanes.fincast.observedModelId).toBe(FINCAST_MODEL_ID);
    expect(result.comparison.automaticWinner).toBeNull();
    expect(result.comparison.outcome).toBe("inconclusive");
  });
});
