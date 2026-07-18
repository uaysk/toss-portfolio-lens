import { describe, expect, it } from "vitest";
import { holdingKey, stockColor, stockForeground } from "./stock-appearance";

describe("stock appearance", () => {
  it("종목별 색상을 안정적으로 유지하고 저채도 팔레트로 구분한다", () => {
    const symbols = ["005930", "AAPL", "BRK.B", "035720"];
    const colors = symbols.map((symbol) => stockColor(symbol, "dark"));

    expect(stockColor(symbols[0], "dark")).toBe(colors[0]);
    expect(new Set(colors).size).toBe(symbols.length);
    colors.forEach((color) => {
      const [, red, green, blue] = color.match(/^#(..)(..)(..)$/) ?? [];
      const channels = [red, green, blue].map((value) => Number.parseInt(value, 16));
      expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(34);
    });
    expect(colors.some((color) => {
      const [, red, green, blue] = color.match(/^#(..)(..)(..)$/) ?? [];
      return new Set([red, green, blue]).size > 1;
    })).toBe(true);
    expect(stockColor(symbols[0], "light")).not.toBe(stockColor(symbols[0], "dark"));
    expect(["#111111", "#ffffff"]).toContain(stockForeground(symbols[0], "dark"));
  });

  it("시장과 심볼을 함께 표시 설정 키로 사용한다", () => {
    expect(holdingKey({ market: "NASDAQ", symbol: "AAPL" })).toBe("NASDAQ:AAPL");
  });
});
