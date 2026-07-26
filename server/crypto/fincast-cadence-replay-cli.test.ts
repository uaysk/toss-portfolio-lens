import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseFinCastCadenceReplayCliArguments,
  writeFinCastCadenceReplayResult,
} from "./fincast-cadence-replay-cli.js";
import type { FinCastCadenceComparisonResult } from "./fincast-cadence-replay.js";

const END_EXCLUSIVE = Date.parse("2026-07-26T11:00:00.000Z");

function result(): FinCastCadenceComparisonResult {
  return {
    schemaVersion: "crypto-fincast-cadence-comparison/v1",
    executionMode: "historical_replay",
    realOrder: false,
  } as FinCastCadenceComparisonResult;
}

describe("FinCast cadence replay CLI", () => {
  it("requires a symbol, absolute output, exact UTC end minute, and bounded deadline", () => {
    expect(parseFinCastCadenceReplayCliArguments([
      "--symbol", "eulusdt",
      "--output", "/tmp/fincast-cadence.json",
      "--end-exclusive", "2026-07-26T11:00:00Z",
      "--deadline-ms", "14400000",
    ])).toEqual({
      symbol: "EULUSDT",
      output: "/tmp/fincast-cadence.json",
      endExclusive: END_EXCLUSIVE,
      deadlineMs: 14_400_000,
    });
    expect(() => parseFinCastCadenceReplayCliArguments([
      "--symbol", "EULUSDT",
      "--output", "/tmp/fincast-cadence.json",
      "--end-exclusive", "2026-07-26T11:00:01Z",
    ])).toThrow("exact UTC minute");
    expect(() => parseFinCastCadenceReplayCliArguments([
      "--symbol", "EULUSDT",
      "--output", "relative.json",
      "--end-exclusive", "2026-07-26T11:00:00Z",
    ])).toThrow("absolute");
    expect(() => parseFinCastCadenceReplayCliArguments([
      "--symbol", "EULUSDT",
      "--output", "/tmp/fincast-cadence.json",
    ])).toThrow("required");
  });

  it("publishes a mode-0600 artifact atomically and never overwrites evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fincast-cadence-cli-"));
    try {
      const output = join(directory, "replay.json");
      await writeFinCastCadenceReplayResult(output, result());
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
        schemaVersion: "crypto-fincast-cadence-comparison/v1",
        executionMode: "historical_replay",
        realOrder: false,
      });
      await expect(writeFinCastCadenceReplayResult(output, result()))
        .rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
