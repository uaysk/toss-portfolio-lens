import { describe, expect, it } from "vitest";
import {
  boundedConcurrency,
  parseRecoverableJsonLines,
  processInOrderedBatches,
} from "./high-vol-rust-concurrency.js";

describe("high-vol Rust bounded concurrency", () => {
  it("runs bounded work concurrently and commits every batch in input order", async () => {
    let active = 0;
    let maximumActive = 0;
    const committed: number[] = [];
    await processInOrderedBatches(
      [0, 1, 2, 3, 4, 5, 6],
      3,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, (3 - value % 3) * 2));
        active -= 1;
        return value * 10;
      },
      async (batch) => {
        committed.push(...batch.map(({ value }) => value));
      },
    );
    expect(maximumActive).toBe(3);
    expect(committed).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it("does not commit a batch that contains a failed work item", async () => {
    const committed: number[] = [];
    await expect(processInOrderedBatches(
      [0, 1, 2, 3],
      2,
      async (value) => {
        if (value === 3) throw new Error("origin failed");
        return value;
      },
      async (batch) => {
        committed.push(...batch.map(({ value }) => value));
      },
    )).rejects.toThrow("origin failed");
    expect(committed).toEqual([0, 1]);
  });

  it("recovers only a truncated final JSONL record", () => {
    expect(parseRecoverableJsonLines<{ id: number }>(
      '{"id":1}\n{"id":2}\n{"id":',
    )).toEqual([{ id: 1 }, { id: 2 }]);
    expect(() => parseRecoverableJsonLines(
      '{"id":1}\nnot-json\n{"id":3}\n',
    )).toThrow();
  });

  it("rejects invalid concurrency instead of silently changing it", () => {
    expect(boundedConcurrency(6)).toBe(6);
    expect(() => boundedConcurrency(0)).toThrow();
    expect(() => boundedConcurrency(1.5)).toThrow();
  });
});
