import { describe, expect, it } from "vitest";
import { analysisStartDate, parseBenchmarkKeys } from "./analysis.js";

describe("portfolio analysis query", () => {
  it("기간 프리셋을 KST 달력 일수로 변환하고 첫 거래일을 넘지 않는다", () => {
    expect(analysisStartDate("30d", "2026-07-15")).toBe("2026-06-16");
    expect(analysisStartDate("90d", "2026-07-15", "2026-06-20")).toBe("2026-06-20");
    expect(analysisStartDate("all", "2026-07-15", "2025-03-31")).toBe("2025-03-31");
  });

  it("허용된 비교 지수만 중복 없이 선택한다", () => {
    expect(parseBenchmarkKeys("KOSPI,nasdaq100,KOSPI")).toEqual(["KOSPI", "NASDAQ100"]);
    expect(parseBenchmarkKeys(undefined)).toEqual(["KOSPI", "KOSDAQ", "NASDAQ100", "SP500"]);
    expect(() => parseBenchmarkKeys("DOW")).toThrow("지원하는 비교 지수");
  });
});
