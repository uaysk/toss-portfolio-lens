import { describe, expect, it } from "vitest";
import {
  isCalendarDate,
  isValidCalendarRange,
  presetCalendarRange,
  shiftCalendarDate,
} from "./date-range";

describe("calendar date range", () => {
  it("윤년을 포함해 날짜를 검증하고 일 단위로 이동한다", () => {
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(shiftCalendarDate("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("프리셋을 포함 범위로 계산하고 첫 거래일에 맞춰 자른다", () => {
    expect(presetCalendarRange("7d", "2026-07-15")).toEqual({ from: "2026-07-09", to: "2026-07-15" });
    expect(presetCalendarRange("30d", "2026-07-15", "2026-07-01")).toEqual({
      from: "2026-07-01",
      to: "2026-07-15",
    });
    expect(isValidCalendarRange({ from: "2026-07-01", to: "2026-07-15" }, "2026-07-15")).toBe(true);
    expect(isValidCalendarRange({ from: "2026-07-16", to: "2026-07-15" }, "2026-07-15")).toBe(false);
  });
});
