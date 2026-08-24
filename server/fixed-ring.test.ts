import { describe, expect, it } from "vitest";
import { FixedRing } from "./fixed-ring.js";

describe("FixedRing", () => {
  it("retains the newest values in insertion order", () => {
    const ring = new FixedRing<number>(3);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    expect(ring.values()).toEqual([1, 2, 3]);

    ring.push(4);
    ring.push(5);
    expect(ring.values()).toEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
  });

  it("validates capacity and does not expose its backing storage", () => {
    expect(() => new FixedRing(0)).toThrow("positive safe integer");
    const ring = new FixedRing<number>(1);
    ring.push(1);
    const copy = ring.values();
    copy[0] = 2;
    expect(ring.values()).toEqual([1]);
  });
});
