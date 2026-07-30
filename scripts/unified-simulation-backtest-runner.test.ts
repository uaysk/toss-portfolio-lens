import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

describe("unified simulation backtest runner", () => {
  it("writes resumable atomic smoke artifacts for all three cases", () => {
    const runDirectory = mkdtempSync(path.join(tmpdir(), "unified-simulation-smoke-"));
    const arguments_ = [
      "scripts/run-unified-simulation-backtests.mjs",
      "--case",
      "all",
      "--run-dir",
      runDirectory,
      "--from",
      "2026-07-01",
      "--to",
      "2026-07-08",
      "--smoke",
    ];
    execFileSync(process.execPath, arguments_, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
    });
    const status = JSON.parse(
      readFileSync(path.join(runDirectory, "status.json"), "utf8"),
    ) as Record<string, unknown>;
    const result = JSON.parse(
      readFileSync(path.join(runDirectory, "result-manifest.json"), "utf8"),
    ) as { chunks: Array<Record<string, unknown>> };
    const configuration = JSON.parse(
      readFileSync(path.join(runDirectory, "configuration-manifest.json"), "utf8"),
    ) as {
      createdAt: string;
      workingTreeDigest: string;
      execution: { modelCallsPlanned: number };
    };
    expect(status).toMatchObject({
      state: "completed",
      completedChunks: status.totalChunks,
      error: null,
    });
    expect(new Set(result.chunks.map((chunk) => chunk.simulationCase))).toEqual(
      new Set(["btc_eth", "high_vol_crypto", "us_etf_pair"]),
    );
    expect(result.chunks.every((chunk) => (
      typeof chunk.detailArtifact === "string"
      && (chunk.costScenarios as unknown[]).length === 4
      && (chunk.evaluationSegments as unknown[]).length === 2
    ))).toBe(true);
    expect(result.chunks.every((chunk) => (
      (chunk.evaluationSegments as Array<Record<string, unknown>>)[0]?.id === "development"
      && (chunk.evaluationSegments as Array<Record<string, unknown>>)[1]?.id
        === "walk_forward_oos"
    ))).toBe(true);
    expect(configuration.execution.modelCallsPlanned).toBe(0);
    const semiconductor = result.chunks.find(
      (chunk) => chunk.chunkId === "us_etf_pair-semiconductor-soxl-soxs",
    )!;
    const etfDetail = JSON.parse(gunzipSync(
      readFileSync(semiconductor.detailArtifact as string),
    ).toString("utf8")) as {
      decisions: Array<{ reasons: string[] }>;
    };
    expect(etfDetail.decisions.some((decision) => (
      decision.reasons.some((reason) => reason.includes("COST_ADJUSTED_EDGE"))
    ))).toBe(true);
    const highVol = result.chunks.find(
      (chunk) => chunk.simulationCase === "high_vol_crypto",
    )!;
    const scans = JSON.parse(gunzipSync(
      readFileSync(highVol.scannerArtifact as string),
    ).toString("utf8")) as Array<{ selectedSymbols: string[] }>;
    expect(scans.some((scan) => scan.selectedSymbols.length > 0)).toBe(true);

    execFileSync(process.execPath, [...arguments_, "--resume"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
    });
    const resumed = JSON.parse(
      readFileSync(path.join(runDirectory, "status.json"), "utf8"),
    ) as Record<string, unknown>;
    const resumedConfiguration = JSON.parse(
      readFileSync(path.join(runDirectory, "configuration-manifest.json"), "utf8"),
    ) as {
      arguments: { resume: boolean };
      initialArguments: { resume: boolean };
      createdAt: string;
      workingTreeDigest: string;
      executionAttempts: { count: number; lastWasResume: boolean };
    };
    const resumedResult = JSON.parse(
      readFileSync(path.join(runDirectory, "result-manifest.json"), "utf8"),
    ) as {
      startedAt: string;
      executionAttemptCount: number;
      resumedFromCompletedResult: boolean;
    };
    expect(resumed).toMatchObject({
      state: "completed",
      completedChunks: resumed.totalChunks,
    });
    expect(resumedConfiguration).toMatchObject({
      arguments: { resume: true },
      initialArguments: { resume: false },
      createdAt: configuration.createdAt,
      workingTreeDigest: configuration.workingTreeDigest,
      executionAttempts: { count: 2, lastWasResume: true },
    });
    expect(resumedResult).toMatchObject({
      startedAt: configuration.createdAt,
      executionAttemptCount: 2,
      resumedFromCompletedResult: true,
    });
  }, 130_000);
});
