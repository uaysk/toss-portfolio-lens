import { describe, expect, it } from "vitest";
import { normalizePairModelOutputs } from "./model-output-normalization.js";

const ORIGIN = "2026-07-24T14:30:00.000Z";
const GENERATED = "2026-07-24T14:30:01.000Z";

function run(
  modelId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    component: modelId.includes("Kronos") ? "kronos" : "chronos2",
    latency_ms: modelId.includes("Kronos") ? 180 : 120,
    response: {
      model: {
        model_id: modelId,
        model_revision: "revision-a",
        source_revision: "source-a",
        loader_version: "loader-a",
        tokenizer_id: `${modelId}-tokenizer`,
        tokenizer_revision: "tokenizer-revision-a",
        license: "Apache-2.0",
        device: "cuda",
        device_name: "Tesla P40",
        cuda_capability: "6.1",
        dtype: "float32",
        attention_backend: "math",
        loaded: true,
      },
      generated_at: GENERATED,
      series: [{
        instrument_key: "TSLA",
        status: "available",
        input_end_at: ORIGIN,
        input_quality: { status: "good", warnings: [] },
        horizons: [{
          horizon_minutes: 5,
          target_timestamp: "2026-07-24T14:35:00.000Z",
          return_quantiles: [
            { quantile: 0.1, value: -0.01 },
            { quantile: 0.5, value: 0.01 },
            { quantile: 0.9, value: 0.03 },
          ],
          up_probability: 0.7,
          down_probability: 0.25,
          flat_probability: 0.05,
          expected_volatility: 0.02,
          calibration: { status: "good", brier_score: 0.18 },
        }],
      }],
      ...overrides,
    },
  };
}

describe("pair model output normalization", () => {
  it("normalizes Chronos-2 and Kronos at one origin while preserving raw output", () => {
    const input = {
      model_runs: [
        run("amazon/chronos-2"),
        run("NeoQuasar/Kronos-small"),
      ],
    };
    const output = normalizePairModelOutputs(input, {
      signalSymbol: "tsla",
      expectedOrigin: ORIGIN,
      now: "2026-07-24T14:30:30.000Z",
    });
    expect(output.alignmentStatus).toBe("aligned");
    expect(output.alignedOrigin).toBe(ORIGIN);
    expect(output.chronos2).toMatchObject({
      status: "available",
      medianReturn: 0.01,
      q10Return: -0.01,
      q90Return: 0.03,
      upProbability: 0.7,
      downProbability: 0.25,
      uncertaintyWidth: 0.04,
      calibration: { status: "good", brierScore: 0.18 },
      provenance: {
        modelId: "amazon/chronos-2",
        deviceName: "Tesla P40",
        latencyMs: 120,
      },
    });
    expect(output.kronos.rawOutput).toEqual(input.model_runs[1]);
    expect(output.rawResponse).toEqual(input);
  });

  it("supports a legacy top-level response without fabricating Kronos", () => {
    const legacy = run("amazon/chronos-2").response;
    const output = normalizePairModelOutputs(legacy, {
      signalSymbol: "TSLA",
      requireCuda: true,
    });
    expect(output.chronos2.status).toBe("available");
    expect(output.kronos).toMatchObject({
      status: "unavailable",
      reasonCodes: ["model_run_missing"],
    });
    expect(output.alignmentStatus).toBe("unavailable");
  });

  it("accepts the production model_runs role, model, generated_at, latency, raw_series shape", () => {
    const chronos = run("amazon/chronos-2");
    const kronos = run("NeoQuasar/Kronos-small");
    const productionRun = (
      source: ReturnType<typeof run>,
      role: "chronos2" | "kronos",
    ) => ({
      role: role === "kronos" ? "kronos_small" : role,
      expected_model_id: role === "kronos"
        ? "NeoQuasar/Kronos-small"
        : "amazon/chronos-2",
      fallback_used: false,
      degraded: false,
      model: source.response.model,
      generated_at: source.response.generated_at,
      latency_ms: source.latency_ms,
      raw_series: source.response.series,
      input_origins: [{
        instrument_key: "TSLA",
        input_end_at: ORIGIN,
        context_start_at: "2026-07-24T12:30:00.000Z",
        bar_count: 121,
        input_digest: "a".repeat(64),
      }],
    });
    const output = normalizePairModelOutputs({
      model_runs: [
        productionRun(chronos, "chronos2"),
        productionRun(kronos, "kronos"),
      ],
    }, { signalSymbol: "TSLA", expectedOrigin: ORIGIN });
    expect(output.alignmentStatus).toBe("aligned");
    expect(output.chronos2).toMatchObject({
      status: "available",
      provenance: {
        modelId: "amazon/chronos-2",
        latencyMs: 120,
        expectedModelId: "amazon/chronos-2",
        fallbackUsed: false,
        tokenizerRevision: "tokenizer-revision-a",
        license: "Apache-2.0",
        cudaCapability: "6.1",
        inputInstrumentKey: "TSLA",
        inputOriginAt: ORIGIN,
        contextStartAt: "2026-07-24T12:30:00.000Z",
        barCount: 121,
        inputDigest: "a".repeat(64),
      },
    });
    expect(output.kronos).toMatchObject({
      status: "available",
      provenance: { modelId: "NeoQuasar/Kronos-small", latencyMs: 180 },
    });
  });

  it("fails alignment when model origins differ or the requested origin is stale", () => {
    const kronos = run("NeoQuasar/Kronos-small");
    const response = kronos.response as {
      series: Array<{ input_end_at: string }>;
    };
    response.series[0]!.input_end_at = "2026-07-24T14:29:00.000Z";
    const output = normalizePairModelOutputs({
      model_runs: [run("amazon/chronos-2"), kronos],
    }, {
      signalSymbol: "TSLA",
      expectedOrigin: ORIGIN,
      now: "2026-07-24T14:40:00.000Z",
      maximumOriginAgeMs: 120_000,
    });
    expect(output.alignmentStatus).toBe("misaligned");
    expect(output.reasonCodes).toContain("model_origin_mismatch");
    expect(output.chronos2.reasonCodes).toContain("stale_origin");
    expect(output.kronos.reasonCodes).toContain("origin_mismatch");
  });

  it("requires both production runs to report the exact same input origin context", () => {
    const chronos = run("amazon/chronos-2");
    const kronos = run("NeoQuasar/Kronos-small");
    const production = (source: ReturnType<typeof run>, role: string, barCount: number) => ({
      role,
      expected_model_id: role === "kronos_small"
        ? "NeoQuasar/Kronos-small"
        : "amazon/chronos-2",
      fallback_used: false,
      degraded: false,
      model: source.response.model,
      generated_at: source.response.generated_at,
      raw_series: source.response.series,
      input_origins: [{
        instrument_key: "TSLA",
        input_end_at: ORIGIN,
        context_start_at: "2026-07-24T12:30:00.000Z",
        bar_count: barCount,
        input_digest: "b".repeat(64),
      }],
    });
    const output = normalizePairModelOutputs({
      model_runs: [
        production(chronos, "chronos2", 121),
        production(kronos, "kronos_small", 120),
      ],
    }, { signalSymbol: "TSLA", expectedOrigin: ORIGIN });
    expect(output.alignmentStatus).toBe("misaligned");
    expect(output.reasonCodes).toContain("model_input_context_mismatch");
  });

  it("does not align models that predict different target timestamps", () => {
    const kronos = run("NeoQuasar/Kronos-small");
    const response = kronos.response as {
      series: Array<{ horizons: Array<{ target_timestamp: string }> }>;
    };
    response.series[0]!.horizons[0]!.target_timestamp = "2026-07-24T14:36:00.000Z";
    const output = normalizePairModelOutputs({
      model_runs: [run("amazon/chronos-2"), kronos],
    }, { signalSymbol: "TSLA", expectedOrigin: ORIGIN });
    expect(output.alignmentStatus).toBe("misaligned");
    expect(output.reasonCodes).toContain("model_target_timestamp_mismatch");
  });

  it("marks explicit Chronos fallback degraded only when policy allows it", () => {
    const fallback = run("amazon/chronos-bolt-small");
    const denied = normalizePairModelOutputs({
      model_runs: [fallback, run("NeoQuasar/Kronos-small")],
    }, { signalSymbol: "TSLA" });
    expect(denied.chronos2.status).toBe("unavailable");
    expect(denied.chronos2.reasonCodes).toContain("chronos_fallback_used");

    const allowed = normalizePairModelOutputs({
      model_runs: [fallback, run("NeoQuasar/Kronos-small")],
    }, { signalSymbol: "TSLA", allowChronosFallback: true });
    expect(allowed.chronos2.status).toBe("degraded");
    expect(allowed.chronos2.provenance.modelId).toBe("amazon/chronos-bolt-small");
  });

  it("validates the exact production fallback provenance invariant", () => {
    const fallback = run("amazon/chronos-bolt-small");
    Object.assign(fallback.response.model, {
      fallback_from: "amazon/chronos-2",
      fallback_reason: "chronos_2_cache_missing",
    });
    const wrapped = {
      role: "chronos2",
      expected_model_id: "amazon/chronos-2",
      fallback_used: true,
      degraded: true,
      fallback_reason: "chronos_2_cache_missing",
      model: fallback.response.model,
      generated_at: fallback.response.generated_at,
      raw_series: fallback.response.series,
    };
    const accepted = normalizePairModelOutputs({
      model_runs: [wrapped, run("NeoQuasar/Kronos-small")],
    }, { signalSymbol: "TSLA", allowChronosFallback: true });
    expect(accepted.chronos2.status).toBe("degraded");

    const invalid = normalizePairModelOutputs({
      model_runs: [{ ...wrapped, fallback_reason: "different_reason" }, run("NeoQuasar/Kronos-small")],
    }, { signalSymbol: "TSLA", allowChronosFallback: true });
    expect(invalid.chronos2.status).toBe("unavailable");
    expect(invalid.chronos2.reasonCodes).toContain("model_run_provenance_inconsistent");
  });

  it("fails closed for bad calibration, CPU execution, invalid quantiles, and duplicates", () => {
    const poor = run("amazon/chronos-2");
    const poorResponse = poor.response as {
      model: { device: string };
      series: Array<{ horizons: Array<{
        calibration: { status: string };
        return_quantiles: Array<{ quantile: number; value: number }>;
      }> }>;
    };
    poorResponse.model.device = "cpu";
    poorResponse.series[0]!.horizons[0]!.calibration.status = "poor";
    poorResponse.series[0]!.horizons[0]!.return_quantiles[1]!.value = -0.02;
    const output = normalizePairModelOutputs({
      model_runs: [poor, run("NeoQuasar/Kronos-small"), run("NeoQuasar/Kronos-small")],
    }, { signalSymbol: "TSLA" });
    expect(output.chronos2.status).toBe("unavailable");
    expect(output.chronos2.reasonCodes).toEqual(expect.arrayContaining([
      "calibration_poor",
      "cuda_required",
      "return_quantiles_invalid",
    ]));
    expect(output.kronos.reasonCodes).toEqual(["duplicate_model_runs"]);
  });

  it("does not admit a non-P40 CUDA device when the runtime identity is required", () => {
    const chronos = run("amazon/chronos-2");
    const response = chronos.response as {
      model: { device_name: string; cuda_capability: string };
    };
    response.model.device_name = "NVIDIA A10";
    response.model.cuda_capability = "8.6";
    const output = normalizePairModelOutputs({
      model_runs: [chronos, run("NeoQuasar/Kronos-small")],
    }, {
      signalSymbol: "TSLA",
      requiredDeviceName: "Tesla P40",
    });
    expect(output.chronos2.status).toBe("unavailable");
    expect(output.chronos2.reasonCodes).toContain("required_accelerator_mismatch");
  });
});
