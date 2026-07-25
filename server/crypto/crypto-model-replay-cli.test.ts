import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCryptoReplayCliArguments,
  writeReplayResult,
} from "./crypto-model-replay-cli.js";
import type { CryptoModelReplayResult } from "./crypto-model-replay.js";

function result(): CryptoModelReplayResult {
  const lane = (id: "kronos_base" | "fincast") => ({
    lane: id,
    expectedModelId: id === "kronos_base"
      ? "NeoQuasar/Kronos-base" as const
      : "Vincent05R/FinCast" as const,
    observedModelId: id === "kronos_base"
      ? "NeoQuasar/Kronos-base"
      : "Vincent05R/FinCast",
    availability: "available" as const,
    identityVerified: true,
    inputDigest: "a".repeat(64),
    recordDigest: "b".repeat(64),
    effectiveContextDigest: "c".repeat(64),
    effectiveContextBars: 512,
    latencyMs: 1,
    fallbackUsed: false as const,
    metrics: [],
  });
  return {
    schemaVersion: "crypto-model-comparison-replay/v1",
    generatedAt: "2026-07-25T00:00:00.000Z",
    market: {
      kind: "crypto_futures",
      venue: "BINANCE_USDM",
      quoteAsset: "USDT",
      contractType: "PERPETUAL",
    },
    symbol: "BTCUSDT",
    window: {
      startAt: "2026-07-18T00:00:00.000Z",
      endExclusiveAt: "2026-07-25T00:00:00.000Z",
      completeUtcDays: 7,
      barCount: 10_080,
      contextPrefetchBarCount: 511,
      outcomeTailBarCount: 60,
      inputBarCount: 10_651,
      originCount: 672,
      originStrideMinutes: 15,
      futureBarsPerOrigin: 60,
    },
    requestId: "crypto-replay:test",
    inputDigest: "a".repeat(64),
    costAssumptions: {
      commission_bps_per_side: 4,
      tax_bps_on_exit: 0,
      spread_bps_round_trip: 2,
      slippage_bps_per_side: 1,
    },
    lanes: {
      kronos_base: lane("kronos_base"),
      fincast: lane("fincast"),
    },
    comparison: {
      identitiesVerified: true,
      sameInputDigest: true,
      sameRecords: true,
      sameOrigin: true,
      sameContext: true,
      sameCosts: true,
      sameFillBarrier: true,
      automaticWinner: null,
      outcome: "review_required",
    },
  };
}

describe("crypto model replay CLI", () => {
  it("accepts one Binance USDT symbol, absolute output, and a bounded deadline", () => {
    expect(parseCryptoReplayCliArguments([
      "--symbol", "btcusdt",
      "--output", "/tmp/replay.json",
      "--deadline-ms", "3600000",
    ])).toEqual({
      symbol: "BTCUSDT",
      output: "/tmp/replay.json",
      deadlineMs: 3_600_000,
    });
    expect(() => parseCryptoReplayCliArguments([
      "--symbol", "BTCUSD",
      "--output", "/tmp/replay.json",
    ])).toThrow("USDT");
    expect(() => parseCryptoReplayCliArguments([
      "--symbol", "BTCUSDT",
      "--output", "relative.json",
    ])).toThrow("absolute");
  });

  it("publishes mode-0600 replay evidence atomically and never overwrites it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crypto-replay-cli-"));
    try {
      const output = join(directory, "replay.json");
      await writeReplayResult(output, result());
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
        schemaVersion: "crypto-model-comparison-replay/v1",
        symbol: "BTCUSDT",
        window: {
          completeUtcDays: 7,
          barCount: 10_080,
          contextPrefetchBarCount: 511,
          outcomeTailBarCount: 60,
          inputBarCount: 10_651,
          originCount: 672,
        },
      });
      await expect(writeReplayResult(output, result())).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
