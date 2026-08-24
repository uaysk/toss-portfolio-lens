import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AiResponseSchema,
  FINCAST_MODEL_ID,
  SCALPING_AI_HORIZONS,
  SCALPING_AI_QUANTILES,
  type AiForecastRequest,
} from "../worker/ai-contract.js";
import type {
  BinanceRestAggregateTradeRequest,
  BinanceRestKlineRequest,
} from "./binance-market-data.js";
import {
  FinCastCadenceComparisonReplay,
  type FinCastCadenceReplayClient,
} from "./fincast-cadence-replay.js";

const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-07-26T12:00:00.000Z");
const END_EXCLUSIVE = Date.parse("2026-07-26T11:00:00.000Z");
const ORIGIN_START = END_EXCLUSIVE - 4 * 60 * MINUTE_MS;
const CANONICAL_DATA_START = ORIGIN_START - 511 * MINUTE_MS;
const OUTCOME_END_EXCLUSIVE = END_EXCLUSIVE + 60 * MINUTE_MS;
const MICRO_DATA_START = ORIGIN_START - 255 * MINUTE_MS;
const COSTS = {
  commission_bps_per_side: 4,
  tax_bps_on_exit: 0,
  spread_bps_round_trip: 2,
  slippage_bps_per_side: 1,
} as const;

function qualificationObservations(overrides: Record<string, unknown> = {}) {
  return {
    row_count: 54_600,
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

function model() {
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
    dtype: "float32" as const,
    attention_backend: "math" as const,
    loaded: true,
    precision_validation: "fallback_fp32" as const,
    peak_vram_bytes: 1_000_000,
    peak_vram_measurement: "cuda_allocated_or_reserved" as const,
    memory_status: "ok" as const,
    quantile_monotonicity_policy: "fp32_monotone_rearrangement_v1" as const,
    fp32_quantile_observations: qualificationObservations(),
    mixed_quantile_observations: null,
    quantile_tail_policy: "tail_clamped_q10_q90" as const,
    precision_failure_reasons: ["mixed_unsupported_operation"],
  };
}

function rawMinuteBars() {
  return Array.from({ length: 811 }, (_unused, index) => {
    const openTime = CANONICAL_DATA_START + index * MINUTE_MS;
    return [
      openTime,
      "100",
      "100",
      "100",
      "100",
      "4",
      openTime + MINUTE_MS - 1,
      "400",
      4,
      "0",
      "0",
      "0",
    ];
  });
}

function rawAggregateTrades() {
  const count = (END_EXCLUSIVE - MICRO_DATA_START) / 15_000;
  return Array.from({ length: count }, (_unused, index) => ({
    a: index + 1,
    p: "100",
    q: "1",
    T: MICRO_DATA_START + index * 15_000 + 1,
    m: index % 2 === 0,
  }));
}

function restFixture() {
  const minutes = rawMinuteBars();
  const trades = rawAggregateTrades();
  const klineCalls: BinanceRestKlineRequest[] = [];
  const aggregateCalls: BinanceRestAggregateTradeRequest[] = [];
  return {
    klineCalls,
    aggregateCalls,
    rest: {
      async klines(request: BinanceRestKlineRequest) {
        klineCalls.push({ ...request });
        return minutes
          .filter((bar) => (
            Number(bar[0]) >= (request.startTime ?? Number.NEGATIVE_INFINITY)
            && Number(bar[0]) <= (request.endTime ?? Number.POSITIVE_INFINITY)
          ))
          .slice(0, request.limit ?? 1_024);
      },
      async aggregateTrades(request: BinanceRestAggregateTradeRequest) {
        aggregateCalls.push({ ...request });
        const firstId = request.fromId ?? 1;
        return trades
          .filter((trade) => (
            trade.a >= firstId
            && trade.T >= (request.startTime ?? Number.NEGATIVE_INFINITY)
            && trade.T <= (request.endTime ?? Number.POSITIVE_INFINITY)
          ))
          .slice(0, request.limit ?? 1_000);
      },
    },
  };
}

function responseFor(request: AiForecastRequest, mutate?: (value: any) => void) {
  const provenance = model();
  const series = request.series.map((source) => {
    const base = source.bars.at(-1)!.close;
    return {
      instrument_key: source.instrument_key,
      status: "available" as const,
      input_end_at: source.input_end_at,
      horizons: SCALPING_AI_HORIZONS.map((horizon) => {
        const returnQuantiles = SCALPING_AI_QUANTILES.map((quantile) => ({
          quantile,
          value: (quantile - 0.5) * 0.01,
        }));
        return {
          horizon_minutes: horizon,
          target_timestamp: source.future_timestamps[horizon - 1],
          return_quantiles: returnQuantiles,
          price_quantiles: returnQuantiles.map((item) => ({
            quantile: item.quantile,
            value: base * (1 + item.value),
          })),
          up_probability: 0.5,
          down_probability: 0.5,
          flat_probability: 0,
          probability_method: "derived_quantile_cdf" as const,
          expected_volatility: 0.01,
          volatility_method: "quantile_implied_sigma" as const,
          uncertainty_interval_width: 0.01,
          target_stop: {
            status: "unavailable" as const,
            reason: "marginal_quantiles_do_not_identify_first_passage_order",
          },
          valid_path_count: 0,
          invalid_path_count: 0,
        };
      }),
      input_quality: {
        status: "good" as const,
        bar_count: 512,
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
  });
  const response: any = {
    schema_version: request.schema_version,
    request_id: request.request_id,
    mode: "forecast",
    status: "available",
    model: provenance,
    generated_at: new Date(NOW).toISOString(),
    series,
    model_runs: [{
      role: "fincast",
      expected_model_id: FINCAST_MODEL_ID,
      status: "available",
      model: provenance,
      generated_at: new Date(NOW).toISOString(),
      latency_ms: request.series.length,
      degraded: false,
      fallback_used: false,
      fallback_reason: null,
      input_origins: request.series.map((source, index) => ({
        instrument_key: source.instrument_key,
        context_start_at: source.bars[0]!.timestamp,
        input_end_at: source.input_end_at,
        bar_count: 512,
        input_digest: index.toString(16).padStart(64, "0"),
      })),
      input_end_aligned: true,
      raw_series: series,
    }],
    evaluation: null,
    error: null,
  };
  mutate?.(response);
  return AiResponseSchema.parse(response);
}

function clientFixture(mutate?: (request: AiForecastRequest, response: any) => void) {
  const requests: AiForecastRequest[] = [];
  const client: FinCastCadenceReplayClient = {
    async request(request) {
      requests.push(request);
      return responseFor(request, (response) => mutate?.(request, response));
    },
  };
  return { requests, client };
}

function replay(input?: {
  mutate?: (request: AiForecastRequest, response: any) => void;
  rawInputArtifacts?: {
    root: string;
    modelSeed: number;
  };
}) {
  const rest = restFixture();
  const client = clientFixture(input?.mutate);
  return {
    rest,
    client,
    replay: new FinCastCadenceComparisonReplay({
      rest: rest.rest,
      client: client.client,
      clock: { now: () => NOW },
      monotonicNow: (() => {
        let now = 0;
        return () => now++;
      })(),
      requestId: () => "fincast-cadence-test",
      deadlineMs: 10_000,
      aggregateTradePageDelayMs: 0,
      aggregateTradePace: async () => undefined,
      ...(input?.rawInputArtifacts
        ? { rawInputArtifacts: input.rawInputArtifacts }
        : {}),
    }),
  };
}

describe("FinCast four-hour cadence comparison replay", () => {
  it("compares 15s, 30s, and 60s on 240 identical 1m origins and outcomes", async () => {
    const fixture = replay();
    const result = await fixture.replay.run({
      symbol: "eulusdt",
      endExclusive: END_EXCLUSIVE,
      costAssumptions: COSTS,
    });

    expect(fixture.rest.klineCalls).toEqual([{
      symbol: "EULUSDT",
      startTime: CANONICAL_DATA_START,
      endTime: OUTCOME_END_EXCLUSIVE - 1,
      limit: 1_024,
    }]);
    expect(fixture.rest.aggregateCalls).toHaveLength(33);
    expect(fixture.client.requests).toHaveLength(15);
    expect(fixture.client.requests.map((request) => request.series.length)).toEqual([
      50, 50, 50, 50, 40,
      50, 50, 50, 50, 40,
      50, 50, 50, 50, 40,
    ]);
    expect(fixture.client.requests.map((request) => (
      Date.parse(request.series[0]!.bars[1]!.timestamp)
      - Date.parse(request.series[0]!.bars[0]!.timestamp)
    ))).toEqual([
      15_000, 15_000, 15_000, 15_000, 15_000,
      30_000, 30_000, 30_000, 30_000, 30_000,
      60_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(fixture.client.requests.every((request) => request.series.every((series) => (
      series.future_timestamps.length === 60
      && Date.parse(series.future_timestamps[0]!) - Date.parse(series.input_end_at) === MINUTE_MS
      && Date.parse(series.future_timestamps[59]!) - Date.parse(series.input_end_at)
        === 60 * MINUTE_MS
    )))).toBe(true);
    expect(result).toMatchObject({
      schemaVersion: "crypto-fincast-cadence-comparison/v1",
      executionMode: "historical_replay",
      realOrder: false,
      symbol: "EULUSDT",
      window: {
        originStartAt: new Date(ORIGIN_START).toISOString(),
        originEndExclusiveAt: new Date(END_EXCLUSIVE).toISOString(),
        outcomeEndExclusiveAt: new Date(OUTCOME_END_EXCLUSIVE).toISOString(),
        originCount: 240,
        canonicalMinuteBarCount: 811,
      },
      roundTripCostRate: 0.0012,
      comparison: {
        sameOrigins: true,
        sameOutcomes: true,
        sameCosts: true,
        sameFillBarrier: true,
        sameModelIdentity: true,
        automaticWinner: null,
        outcome: "inconclusive",
      },
    });
    expect(result.provenance.aggregateTradeCount).toBe(1_980);
    expect(result.cadences["15"]).toMatchObject({
      contextBars: 512,
      contextSpanMinutes: 128,
      originCount: 240,
      recordCount: 960,
      requestCount: 5,
      modelLatencyMs: 240,
    });
    expect(result.cadences["30"].contextSpanMinutes).toBe(256);
    expect(result.cadences["60"].contextSpanMinutes).toBe(512);
    const commonRecordEvidence = (cadence: "15" | "30" | "60") => (
      result.cadences[cadence].records.map((record) => ({
        originAt: record.originAt,
        horizonMinutes: record.horizonMinutes,
        targetAt: record.targetAt,
        originClose: record.originClose,
        nextMinuteOpen: record.nextMinuteOpen,
        targetClose: record.targetClose,
        actualReturn: record.actualReturn,
        executionReturn: record.executionReturn,
        roundTripCostRate: record.roundTripCostRate,
      }))
    );
    expect(commonRecordEvidence("30")).toEqual(commonRecordEvidence("15"));
    expect(commonRecordEvidence("60")).toEqual(commonRecordEvidence("15"));
    for (const cadence of ["15", "30", "60"] as const) {
      const lane = result.cadences[cadence];
      expect(lane.records).toHaveLength(960);
      expect(lane.metrics).toHaveLength(4);
      expect(lane.metrics.every((metric) => metric.count === 240)).toBe(true);
      expect(lane.metrics.every((metric) => metric.directionAccuracy === 1)).toBe(true);
      expect(lane.metrics.every((metric) => metric.medianReturnMae === 0)).toBe(true);
      expect(lane.metrics.every((metric) => metric.upProbabilityBrier === 0.25)).toBe(true);
      expect(lane.metrics.every((metric) => metric.quantiles.length === 7)).toBe(true);
      expect(lane.records.every((record) => (
        Date.parse(record.targetAt) - Date.parse(record.originAt)
          === record.horizonMinutes * MINUTE_MS
      ))).toBe(true);
    }
    expect(result.cadences["15"].records[0]).toMatchObject({
      originAt: new Date(ORIGIN_START + MINUTE_MS - 1).toISOString(),
      horizonMinutes: 5,
      targetAt: new Date(ORIGIN_START + 6 * MINUTE_MS - 1).toISOString(),
      originClose: 100,
      nextMinuteOpen: 100,
      actualReturn: 0,
      executionReturn: 0,
      roundTripCostRate: 0.0012,
    });
  }, 15_000);

  it("can publish the exact replay contexts as three worker-local raw artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "fincast-cadence-raw-"));
    try {
      const fixture = replay({
        rawInputArtifacts: {
          root,
          modelSeed: 41,
        },
      });
      const result = await fixture.replay.run({
        symbol: "EULUSDT",
        endExclusive: END_EXCLUSIVE,
        costAssumptions: COSTS,
      });

      for (const cadence of ["15", "30", "60"] as const) {
        const evidence = result.cadences[cadence].rawInputArtifact;
        expect(evidence).toBeDefined();
        const manifest = JSON.parse(
          await readFile(join(root, cadence, "manifest.json"), "utf8"),
        ) as Record<string, any>;
        expect(manifest).toMatchObject({
          schema_version: "fincast-raw-input/v1",
          cadence_seconds: Number(cadence),
          row_count: 240,
          context_bars: 512,
          model_seed: 41,
        });
        expect(manifest.files.contexts.size_bytes).toBe(240 * 512 * 4);
        expect(evidence?.manifestPath).toBe(join(root, cadence, "manifest.json"));
        const origin = JSON.parse(
          (await readFile(join(root, cadence, "origins.jsonl"), "utf8"))
            .split("\n")[0]!,
        ) as Record<string, unknown>;
        expect(origin).not.toHaveProperty("close");
        expect(origin).not.toHaveProperty("closes");
      }
    } finally {
      await rm(root, { recursive: true });
    }
  }, 15_000);

  it("fails closed when a response changes the common target timestamp", async () => {
    let mutated = false;
    const fixture = replay({
      mutate(_request, response) {
        if (mutated) return;
        mutated = true;
        response.series[0].horizons[0].target_timestamp = response.series[0].horizons[1].target_timestamp;
        response.model_runs[0].raw_series = response.series;
      },
    });
    await expect(fixture.replay.run({
      symbol: "EULUSDT",
      endExclusive: END_EXCLUSIVE,
      costAssumptions: COSTS,
    })).rejects.toThrow();
  });

  it("rejects an end boundary whose 60-minute outcome tail is not complete", async () => {
    const fixture = replay();
    await expect(fixture.replay.run({
      symbol: "EULUSDT",
      endExclusive: NOW,
      costAssumptions: COSTS,
    })).rejects.toThrow("outcome tail");
    expect(fixture.rest.klineCalls).toHaveLength(0);
    expect(fixture.client.requests).toHaveLength(0);
  });
});
