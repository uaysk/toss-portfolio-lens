import { describe, expect, it } from "vitest";
import { durationQuantiles } from "./duration-quantiles.js";

describe("durationQuantiles", () => {
  it("sorts once without mutating input and returns nearest-rank duration quantiles", () => {
    const values = Array.from({ length: 100 }, (_unused, index) => 99 - index);

    expect(durationQuantiles(values, (value) => value)).toEqual({
      sampleCount: 100,
      p50Ms: 49,
      p95Ms: 94,
      p99Ms: 98,
      maxMs: 99,
    });
    expect(values.slice(0, 3)).toEqual([99, 98, 97]);
  });

  it("returns a zeroed snapshot for an empty sample", () => {
    expect(durationQuantiles([], (value) => value)).toEqual({
      sampleCount: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });
  });
});
