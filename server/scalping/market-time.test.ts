import { describe, expect, it } from "vitest";
import { localPartsAt, zonedTimestamp } from "./market-time.js";

describe("market timezone conversion", () => {
  it("resolves winter and daylight-saving New York timestamps", () => {
    expect(zonedTimestamp("20260121", "093000", "America/New_York"))
      .toBe("2026-01-21T14:30:00.000Z");
    expect(zonedTimestamp("20260721", "093000", "America/New_York"))
      .toBe("2026-07-21T13:30:00.000Z");
  });

  it("preserves the first occurrence of an overlapping time and rejects a DST gap", () => {
    expect(zonedTimestamp("20261101", "013000", "America/New_York"))
      .toBe("2026-11-01T05:30:00.000Z");
    expect(zonedTimestamp("20260308", "023000", "America/New_York"))
      .toBeUndefined();
  });

  it("reuses conversion for exact local parts without changing their shape", () => {
    expect(localPartsAt(Date.parse("2026-08-23T15:00:00.000Z"), "Asia/Seoul"))
      .toEqual({ date: "20260824", time: "000000" });
  });
});
