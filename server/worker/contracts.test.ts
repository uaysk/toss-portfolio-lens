import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decodeWorkerArtifact,
  encodeWorkerArtifact,
  WorkerInputSchema,
  WorkerJobKindSchema,
  WorkerOutputSchema,
} from "./contracts.js";

const input = {
  schema_version: "1.0" as const,
  engine_version: "portfolio-lens-test",
  run_id: "run-1",
  job_kind: "backtest" as const,
  data_revision: "revision-1",
  request_hash: "a".repeat(64),
  payload: { z: 2, a: { y: 1, x: [3, 2, 1] } },
};

describe("worker contract", () => {
  it("key 순서와 무관하게 canonical JSON과 checksum을 고정한다", () => {
    const unicodeKeys = { "é": 1, "é": 2 };
    const withUnicode = { ...input, payload: { ...input.payload, unicodeKeys } };
    const reordered = {
      ...input,
      payload: { unicodeKeys: { "é": 2, "é": 1 }, a: { x: [3, 2, 1], y: 1 }, z: 2 },
    };
    expect(canonicalJson(withUnicode)).toBe(canonicalJson(reordered));
    const encoded = encodeWorkerArtifact(withUnicode);
    const second = encodeWorkerArtifact(reordered);
    expect(encoded.checksum).toBe(second.checksum);
    expect(decodeWorkerArtifact(encoded.content, encoded.checksum)).toEqual(WorkerInputSchema.parse(withUnicode));
  });

  it("checksum 변조와 비유한 수를 거부한다", () => {
    const encoded = encodeWorkerArtifact(input);
    expect(() => decodeWorkerArtifact(encoded.content, "0".repeat(64))).toThrow("checksum");
    expect(() => decodeWorkerArtifact(encoded.content, encoded.checksum, {
      byteCount: encoded.byteCount,
      uncompressedByteCount: encoded.uncompressedByteCount + 1,
    })).toThrow("metadata");
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("유한한 숫자");
  });

  it("TypeScript와 공개 JSON Schema의 job kind 목록이 일치한다", () => {
    const inputSchema = JSON.parse(readFileSync(new URL("../../contracts/worker/input.schema.json", import.meta.url), "utf8"));
    const outputSchema = JSON.parse(readFileSync(new URL("../../contracts/worker/output.schema.json", import.meta.url), "utf8"));
    const expected = [...WorkerJobKindSchema.options];
    expect(inputSchema.$defs.job_kind.enum).toEqual(expected);
    expect(outputSchema.properties.job_kind.enum).toEqual(expected);
    expect(WorkerJobKindSchema.parse("technical_analysis")).toBe("technical_analysis");
    expect(WorkerJobKindSchema.parse("scalping_analysis")).toBe("scalping_analysis");
    expect(Object.keys(outputSchema.properties)).toEqual(expect.arrayContaining([
      "data_revision",
      "request_hash",
      "payload_hash",
    ]));
  });

  it("external technical_analysis 완료 결과와 artifact를 영구 저장 전에 strict 검증한다", () => {
    const calculation = {
      instrument_key: "AAA",
      indicator_id: "sma-main",
      kind: "sma",
      parameters: { period: 2 },
      availability: { status: "available", reason: "calculated" },
      warmup: {
        required_observations: 2,
        observed_observations: 2,
        state: "ready",
        first_available_date: "2024-01-02",
      },
      points: [{ date: "2024-01-02", state: "available", values: { value: 10 } }],
    };
    const diagnostics = { validation: "passed" };
    const output = {
      schema_version: "1.0",
      engine_version: "portfolio-lens-rust-2026.07.5",
      run_id: "run-technical",
      job_kind: "technical_analysis",
      status: "completed",
      result: {
        schema_version: "technical-analysis-result/v1",
        indicator_engine_version: "technical-indicators/1.5.0",
        response_mode: "full_series",
        adjustment_policy: "adjusted",
        calculations: [calculation],
        diagnostics,
      },
      summary: { calculation_count: 1 },
      warnings: [],
      artifacts: [
        { type: "technical-indicators", content: [calculation], row_count: 1 },
        { type: "technical-diagnostics", content: diagnostics, row_count: 1 },
      ],
    };
    expect(WorkerOutputSchema.parse(output)).toMatchObject({ status: "completed", job_kind: "technical_analysis" });
    expect(WorkerOutputSchema.safeParse({
      ...output,
      result: { ...output.result, indicator_engine_version: "technical-indicators/stale" },
    }).success).toBe(false);
    expect(WorkerOutputSchema.safeParse({
      ...output,
      result: {
        ...output.result,
        calculations: [{ ...calculation, points: undefined }],
      },
    }).success).toBe(false);
    expect(WorkerOutputSchema.safeParse({
      ...output,
      artifacts: [{ type: "technical-indicators", content: [], row_count: 0 }],
    }).success).toBe(false);
  });

  it("external technical_strategy는 four-date result, canonical artifact와 worker metrics를 저장 전에 strict 검증한다", () => {
    const calculation = {
      instrument_key: "AAA",
      indicator_id: "sma-main",
      kind: "sma",
      parameters: { period: 1 },
      availability: { status: "available", reason: "calculated" },
      warmup: { required_observations: 1, observed_observations: 2, state: "ready", first_available_date: "2024-01-01" },
      points: [{ date: "2024-01-02", state: "available", values: { value: 11 } }],
    };
    const indicatorDiagnostics = { validation: "passed" };
    const strategyDiagnostics = {
      validation: "passed",
      condition_value_policy: "unknown_is_false",
      between_policy: "inclusive",
      crossing_policy: "previous_and_current_available",
      signal_timing_policy: "next_safe_trade_date",
      safe_trade_date_source: "common_observation_dates",
      evaluation_start_date: "2024-01-01",
      evaluation_end_date: "2024-01-03",
      safe_trade_date_count: 3,
      condition_node_count: 2,
      active_unknown_count: 0,
      inactive_unknown_count: 0,
      minimum_holding_suppressed_count: 0,
      cooldown_suppressed_count: 0,
      pending_suppressed_count: 0,
    };
    const signal = {
      signal_id: "signal-1",
      transition: "activate",
      calculation_date: "2024-01-02",
      signal_date: "2024-01-02",
      planned_trade_date: "2024-01-03",
      actual_application_date: null,
      from_state: "inactive",
      to_state: "active",
      target_weights: { AAA: 100 },
      cash_target_percent: 0,
      status: "planned",
    };
    const result = {
      technical_analysis: {
        schema_version: "technical-analysis-result/v1",
        indicator_engine_version: "technical-indicators/1.5.0",
        response_mode: "full_series",
        adjustment_policy: "adjusted",
        calculations: [calculation],
        diagnostics: indicatorDiagnostics,
      },
      technical_strategy: {
        schema_version: "technical-strategy-result/v1",
        strategy_schema_version: "technical-strategy/v1",
        initial_state: "inactive",
        signals: [signal],
        target_weight_schedule: [{ date: "2024-01-03", weights: { AAA: 100 }, cashTargetPercent: 0, regime: "active", action: "signal-1" }],
        diagnostics: strategyDiagnostics,
      },
    };
    const metrics = {
      type: "worker-metrics",
      content: {
        compute_ms: 1.5,
        engine: "portfolio-lens-rust-2026.07.5",
        ipc: "unix_domain_socket_length_frame_v2",
        cancellation: "peer_disconnect_cooperative_checkpoints",
      },
      row_count: 1,
    };
    const output = {
      schema_version: "1.0",
      engine_version: "portfolio-lens-rust-2026.07.5",
      run_id: "run-strategy",
      job_kind: "technical_strategy",
      status: "completed",
      result,
      warnings: [],
      artifacts: [
        { type: "technical-indicators", content: [calculation], row_count: 1 },
        { type: "technical-signals", content: [signal], row_count: 1 },
        { type: "technical-diagnostics", content: { indicator: indicatorDiagnostics, strategy: strategyDiagnostics }, row_count: 1 },
        metrics,
      ],
    };

    expect(WorkerOutputSchema.safeParse(output).success).toBe(true);
    expect(WorkerOutputSchema.safeParse({ ...output, artifacts: output.artifacts.slice(0, -1) }).success).toBe(false);
    expect(WorkerOutputSchema.safeParse({ ...output, artifacts: [...output.artifacts.slice(0, -1), { ...metrics, row_count: 2 }] }).success).toBe(false);
    expect(WorkerOutputSchema.safeParse({
      ...output,
      artifacts: output.artifacts.map((artifact) => artifact.type === "technical-signals" ? { ...artifact, content: [] } : artifact),
    }).success).toBe(false);
    expect(WorkerOutputSchema.safeParse({
      ...output,
      artifacts: output.artifacts.map((artifact) => artifact.type === "technical-signals" ? { ...artifact, row_count: 99 } : artifact),
    }).success).toBe(false);
    expect(WorkerOutputSchema.safeParse({
      ...output,
      result: { ...result, technical_strategy: { ...result.technical_strategy, signals: [{ ...signal, planned_trade_date: "2024-01-02" }] } },
    }).success).toBe(false);
  });
});
