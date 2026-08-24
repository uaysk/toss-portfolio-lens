import { createHash } from "node:crypto";
import { AiComputeClient } from "../server/worker/ai-client.js";
import {
  AiForecastRequestSchema,
  SCALPING_AI_HORIZONS,
  SCALPING_AI_QUANTILES,
  SCALPING_AI_REALTIME_HORIZONS,
  aiRequestBase,
  type AiForecastRequest,
  type AiResponse,
} from "../server/worker/ai-contract.js";

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower]!;
  const fraction = position - lower;
  return ordered[lower]! * (1 - fraction) + ordered[upper]! * fraction;
}

function summary(values: readonly number[]) {
  return {
    minimum: Math.min(...values),
    median: percentile(values, 0.5),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    p95: percentile(values, 0.95),
    maximum: Math.max(...values),
  };
}

function requestFor(
  profile: "full" | "realtime_5_15",
  seriesCount: number,
  candleSeconds: 15 | 30 | 60,
  requestOrdinal: number,
): AiForecastRequest {
  const inputEnd = Date.parse(
    process.env.AI_BENCHMARK_INPUT_END ?? "2026-07-27T00:00:00.000Z",
  );
  if (!Number.isFinite(inputEnd)) throw new Error("AI_BENCHMARK_INPUT_END must be RFC3339");
  const contextBars = 512;
  const contextStepMs = candleSeconds * 1_000;
  const first = inputEnd - (contextBars - 1) * contextStepMs;
  const futureCount = profile === "realtime_5_15"
    ? SCALPING_AI_REALTIME_HORIZONS.at(-1)!
    : SCALPING_AI_HORIZONS.at(-1)!;
  const series = Array.from({ length: seriesCount }, (_, seriesIndex) => {
    let previousClose = 45_000 + seriesIndex * 3_500;
    const bars = Array.from({ length: contextBars }, (_unused, index) => {
      const open = previousClose;
      const drift = 0.00008
        + Math.sin((index + seriesIndex * 11) / 17) * 0.0007
        + Math.cos((index + seriesIndex * 7) / 43) * 0.00035;
      const close = open * (1 + drift);
      const volume = 10 + seriesIndex + index / 100;
      previousClose = close;
      return {
        timestamp: new Date(first + index * contextStepMs).toISOString(),
        open,
        high: Math.max(open, close) * 1.0008,
        low: Math.min(open, close) * 0.9992,
        close,
        volume,
        amount: volume * close,
        complete: true as const,
      };
    });
    return {
      instrument_key: `BENCH:${candleSeconds}:${seriesIndex}`,
      timezone: "UTC",
      input_end_at: new Date(inputEnd).toISOString(),
      future_timestamps: Array.from({ length: futureCount }, (_future, index) => (
        new Date(inputEnd + (index + 1) * 60_000).toISOString()
      )),
      bars,
      input_cadence: {
        candle_seconds: candleSeconds,
        gap_policy: "continuous" as const,
      },
    };
  });
  return AiForecastRequestSchema.parse({
    ...aiRequestBase(`speed-benchmark-${profile}-${requestOrdinal}`, 17),
    mode: "forecast",
    ...(profile === "realtime_5_15"
      ? {
        forecast_profile: profile,
        horizons_minutes: [...SCALPING_AI_REALTIME_HORIZONS],
      }
      : {}),
    series,
  });
}

function forecastDigest(response: AiResponse): string {
  return createHash("sha256")
    .update(JSON.stringify(response.series.map((series) => ({
      instrument_key: series.instrument_key,
      status: series.status,
      horizons: series.horizons,
      unavailable: series.unavailable ?? null,
    }))))
    .digest("hex");
}

function compareForecasts(reference: AiResponse, candidate: AiResponse) {
  if (reference.status !== "available" || candidate.status !== "available") {
    throw new Error("forecast comparison requires available responses");
  }
  if (reference.series.length !== candidate.series.length) {
    throw new Error("forecast comparison series counts do not match");
  }
  const returnQuantileDeltas: number[] = [];
  const upProbabilityDeltas: number[] = [];
  let medianDirectionDisagreements = 0;
  let upProbabilitySideDisagreements = 0;
  for (let seriesIndex = 0; seriesIndex < reference.series.length; seriesIndex += 1) {
    const referenceSeries = reference.series[seriesIndex]!;
    const candidateSeries = candidate.series[seriesIndex]!;
    if (
      referenceSeries.status !== "available"
      || candidateSeries.status !== "available"
      || referenceSeries.instrument_key !== candidateSeries.instrument_key
      || referenceSeries.horizons.length !== candidateSeries.horizons.length
    ) {
      throw new Error(`forecast comparison series ${seriesIndex} is not aligned`);
    }
    for (let horizonIndex = 0; horizonIndex < referenceSeries.horizons.length; horizonIndex += 1) {
      const referenceHorizon = referenceSeries.horizons[horizonIndex]!;
      const candidateHorizon = candidateSeries.horizons[horizonIndex]!;
      if (
        referenceHorizon.horizon_minutes !== candidateHorizon.horizon_minutes
        || referenceHorizon.return_quantiles.length !== candidateHorizon.return_quantiles.length
        || typeof referenceHorizon.up_probability !== "number"
        || typeof candidateHorizon.up_probability !== "number"
      ) {
        throw new Error(`forecast comparison horizon ${horizonIndex} is not aligned`);
      }
      upProbabilityDeltas.push(
        Math.abs(referenceHorizon.up_probability - candidateHorizon.up_probability),
      );
      if (
        (referenceHorizon.up_probability >= 0.5)
        !== (candidateHorizon.up_probability >= 0.5)
      ) {
        upProbabilitySideDisagreements += 1;
      }
      for (
        let quantileIndex = 0;
        quantileIndex < referenceHorizon.return_quantiles.length;
        quantileIndex += 1
      ) {
        const referenceQuantile = referenceHorizon.return_quantiles[quantileIndex]!;
        const candidateQuantile = candidateHorizon.return_quantiles[quantileIndex]!;
        if (referenceQuantile.quantile !== candidateQuantile.quantile) {
          throw new Error(`forecast comparison quantile ${quantileIndex} is not aligned`);
        }
        returnQuantileDeltas.push(
          Math.abs(referenceQuantile.value - candidateQuantile.value),
        );
        if (
          referenceQuantile.quantile === 0.5
          && (referenceQuantile.value >= 0) !== (candidateQuantile.value >= 0)
        ) {
          medianDirectionDisagreements += 1;
        }
      }
    }
  }
  const total = (values: readonly number[]) => (
    values.reduce((sum, value) => sum + value, 0)
  );
  return {
    exact_digest_match: forecastDigest(reference) === forecastDigest(candidate),
    compared_series: reference.series.length,
    compared_horizons: upProbabilityDeltas.length,
    compared_return_quantiles: returnQuantileDeltas.length,
    max_abs_up_probability_delta: Math.max(...upProbabilityDeltas),
    mean_abs_up_probability_delta: total(upProbabilityDeltas) / upProbabilityDeltas.length,
    max_abs_return_quantile_delta: Math.max(...returnQuantileDeltas),
    mean_abs_return_quantile_delta: total(returnQuantileDeltas) / returnQuantileDeltas.length,
    median_direction_disagreements: medianDirectionDisagreements,
    up_probability_side_disagreements: upProbabilitySideDisagreements,
    reference_model: {
      model_id: reference.model.model_id,
      loader_version: reference.model.loader_version,
    },
  };
}

async function main(): Promise<void> {
  const profileValue = process.env.AI_BENCHMARK_PROFILE ?? "full";
  if (profileValue !== "full" && profileValue !== "realtime_5_15") {
    throw new Error("AI_BENCHMARK_PROFILE must be full or realtime_5_15");
  }
  const profile = profileValue;
  const seriesCount = integerSetting("AI_BENCHMARK_SERIES_COUNT", 1, 1, 50);
  const iterations = integerSetting("AI_BENCHMARK_ITERATIONS", 3, 1, 20);
  const warmups = integerSetting("AI_BENCHMARK_WARMUPS", 0, 0, 5);
  const candleSeconds = integerSetting("AI_BENCHMARK_CANDLE_SECONDS", 60, 15, 60);
  if (![15, 30, 60].includes(candleSeconds)) {
    throw new Error("AI_BENCHMARK_CANDLE_SECONDS must be 15, 30, or 60");
  }
  const url = process.env.AI_BENCHMARK_URL
    ?? "ws://fincast-worker:8766/ws/scalping-ai/v2";
  const authTokenFile = process.env.AI_BENCHMARK_AUTH_TOKEN_FILE;
  if (!authTokenFile) throw new Error("AI_BENCHMARK_AUTH_TOKEN_FILE is required");
  const client = new AiComputeClient({
    url,
    authTokenFile,
    timeoutMs: integerSetting("AI_BENCHMARK_TIMEOUT_MS", 600_000, 1_000, 3_600_000),
    connectTimeoutMs: 10_000,
    reconnectBaseMs: 100,
    reconnectMaxMs: 5_000,
    maximumInFlight: 1,
    maximumRequestBytes: 64 * 1024 * 1024,
    maximumResponseBytes: 128 * 1024 * 1024,
  });
  const elapsed: number[] = [];
  const reported: number[] = [];
  const digests: string[] = [];
  let finalResponse: AiResponse | undefined;
  let finalRequest: AiForecastRequest | undefined;
  try {
    for (let ordinal = 0; ordinal < warmups + iterations; ordinal += 1) {
      const request = requestFor(
        profile,
        seriesCount,
        candleSeconds as 15 | 30 | 60,
        ordinal,
      );
      const started = performance.now();
      const response = await client.request(request);
      const duration = performance.now() - started;
      if (response.status !== "available"
        || response.series.some((series) => series.status !== "available")) {
        throw new Error(`worker returned ${response.status}: ${JSON.stringify(response.error)}`);
      }
      if (ordinal >= warmups) {
        elapsed.push(duration);
        reported.push(response.model_runs?.[0]?.latency_ms ?? duration);
        digests.push(forecastDigest(response));
      }
      finalResponse = response;
      finalRequest = request;
    }
  } finally {
    client.close();
  }
  if (!finalResponse || !finalRequest) throw new Error("benchmark did not receive a response");
  const referenceUrl = process.env.AI_BENCHMARK_REFERENCE_URL;
  const referenceAuthTokenFile = process.env.AI_BENCHMARK_REFERENCE_AUTH_TOKEN_FILE;
  if ((referenceUrl === undefined) !== (referenceAuthTokenFile === undefined)) {
    throw new Error(
      "AI_BENCHMARK_REFERENCE_URL and AI_BENCHMARK_REFERENCE_AUTH_TOKEN_FILE must be set together",
    );
  }
  let comparison: ReturnType<typeof compareForecasts> | undefined;
  if (referenceUrl && referenceAuthTokenFile) {
    const referenceClient = new AiComputeClient({
      url: referenceUrl,
      authTokenFile: referenceAuthTokenFile,
      timeoutMs: integerSetting("AI_BENCHMARK_TIMEOUT_MS", 600_000, 1_000, 3_600_000),
      connectTimeoutMs: 10_000,
      reconnectBaseMs: 100,
      reconnectMaxMs: 5_000,
      maximumInFlight: 1,
      maximumRequestBytes: 64 * 1024 * 1024,
      maximumResponseBytes: 128 * 1024 * 1024,
    });
    try {
      const reference = await referenceClient.request({
        ...finalRequest,
        request_id: `${finalRequest.request_id}-reference`,
      });
      comparison = compareForecasts(reference, finalResponse);
    } finally {
      referenceClient.close();
    }
  }
  const firstSeries = finalResponse.series[0]!;
  process.stdout.write(`${JSON.stringify({
    schema_version: "scalping-ai-speed-benchmark/v1",
    profile,
    candle_seconds: candleSeconds,
    series_count: seriesCount,
    iterations,
    warmups,
    elapsed_ms: summary(elapsed),
    model_latency_ms: summary(reported),
    stable_output_digest: new Set(digests).size === 1,
    output_digests: digests,
    model: {
      model_id: finalResponse.model.model_id,
      model_revision: finalResponse.model.model_revision,
      source_revision: finalResponse.model.source_revision,
      loader_version: finalResponse.model.loader_version,
      dtype: finalResponse.model.dtype,
      device: finalResponse.model.device,
    },
    ...(comparison ? { comparison } : {}),
    first_series: {
      instrument_key: firstSeries.instrument_key,
      horizons: firstSeries.horizons.map((horizon) => ({
        horizon_minutes: horizon.horizon_minutes,
        up_probability: horizon.up_probability,
        return_quantiles: SCALPING_AI_QUANTILES.map((quantile) => ({
          quantile,
          value: horizon.return_quantiles.find((item) => item.quantile === quantile)?.value,
        })),
      })),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
