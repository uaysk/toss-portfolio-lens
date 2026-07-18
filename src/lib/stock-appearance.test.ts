import { describe, expect, it } from "vitest";
import { holdingKey, stockColor, stockForeground } from "./stock-appearance";

describe("stock appearance", () => {
  it("종목별 색상을 안정적으로 유지하고 무채색 팔레트를 사용한다", () => {
    const keys = ["KRX:005930", "NASDAQ:AAPL", "NYSE:BRK.B", "KOSDAQ:035720"];
    const colors = keys.map((key) => stockColor(key, "dark"));

    expect(stockColor(keys[0], "dark")).toBe(colors[0]);
    expect(new Set(colors).size).toBe(keys.length);
    colors.forEach((color) => {
      const [, red, green, blue] = color.match(/^#(..)(..)(..)$/) ?? [];
      expect(red === green && green === blue).toBe(true);
    });
    expect(stockColor(keys[0], "light")).not.toBe(stockColor(keys[0], "dark"));
    expect(["#111111", "#ffffff"]).toContain(stockForeground(keys[0], "dark"));
  });

  it("시장과 심볼을 함께 표시 설정 키로 사용한다", () => {
    expect(holdingKey({ market: "NASDAQ", symbol: "AAPL" })).toBe("NASDAQ:AAPL");
  });
});
