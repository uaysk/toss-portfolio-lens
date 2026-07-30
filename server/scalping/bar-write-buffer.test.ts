import { describe, expect, it, vi } from "vitest";
import type { IntradayBarRecord } from "../repositories/scalping-repository.js";
import { BarWriteBuffer } from "./bar-write-buffer.js";

function bar(
  openTime: string,
  state: "forming" | "final",
  updatedAt: number,
): IntradayBarRecord {
  return {
    marketCountry: "KR",
    symbol: "005930",
    intervalMinutes: 1,
    openTime,
    closeTime: new Date(Date.parse(openTime) + 60_000).toISOString(),
    sessionDate: openTime.slice(0, 10),
    source: "kis_ws",
    state,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    turnover: 100,
    tradeCount: 1,
    quality: "complete",
    updatedAt,
  };
}

describe("BarWriteBuffer", () => {
  it("coalesces revisions by bar key and never lets forming replace final", async () => {
    const batches: IntradayBarRecord[][] = [];
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.fn(async (records: readonly IntradayBarRecord[]) => {
      batches.push([...records]);
      if (batches.length === 1) await firstWrite;
    });
    const buffer = new BarWriteBuffer(write, { maximumEntries: 4, batchSize: 1 });
    buffer.enqueue([bar("2026-07-30T00:00:00.000Z", "forming", 1)]);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    buffer.enqueue([
      bar("2026-07-30T00:01:00.000Z", "forming", 2),
      bar("2026-07-30T00:01:00.000Z", "final", 3),
      bar("2026-07-30T00:01:00.000Z", "forming", 4),
    ]);
    expect(buffer.snapshot()).toMatchObject({ queueDepth: 1, coalescedTotal: 2 });

    release();
    await buffer.waitForIdle();
    expect(batches[1]).toEqual([
      expect.objectContaining({ openTime: "2026-07-30T00:01:00.000Z", state: "final", updatedAt: 3 }),
    ]);
  });

  it("keeps a hard bound and gives final bars priority over queued forming bars", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: IntradayBarRecord[][] = [];
    const buffer = new BarWriteBuffer(async (records) => {
      written.push([...records]);
      if (written.length === 1) await blocked;
    }, { maximumEntries: 2, batchSize: 1 });
    buffer.enqueue([bar("2026-07-30T00:00:00.000Z", "forming", 1)]);
    await vi.waitFor(() => expect(written).toHaveLength(1));
    buffer.enqueue([
      bar("2026-07-30T00:01:00.000Z", "forming", 2),
      bar("2026-07-30T00:02:00.000Z", "forming", 3),
    ]);
    expect(buffer.enqueue([
      bar("2026-07-30T00:03:00.000Z", "final", 4),
    ])).toBe(true);
    expect(buffer.snapshot()).toMatchObject({ queueDepth: 2, rejectedTotal: 1 });

    release();
    await buffer.waitForIdle();
    expect(written.flat().some((item) => item.openTime === "2026-07-30T00:03:00.000Z"
      && item.state === "final")).toBe(true);
  });

  it("reports write failures and still becomes idle", async () => {
    const onError = vi.fn();
    const buffer = new BarWriteBuffer(
      async () => {
        throw new Error("database unavailable");
      },
      { onError },
    );
    buffer.enqueue([bar("2026-07-30T00:00:00.000Z", "final", 1)]);
    await buffer.waitForIdle();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "database unavailable",
    }));
    expect(buffer.snapshot().queueDepth).toBe(0);
  });
});
