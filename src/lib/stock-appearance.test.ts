import { describe, expect, it } from "vitest";
import { holdingKey, stockColor, stockColorMap, stockForeground } from "./stock-appearance";

function luminance(color: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(left: string, right: string): number {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

function parseColor(color: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255) as [number, number, number];
}

function compositeColor(color: string, background: string, opacity: number): string {
  const foreground = parseColor(color);
  const backdrop = parseColor(background);
  const channels = foreground.map((channel, index) => (
    Math.round((channel * opacity + backdrop[index] * (1 - opacity)) * 255)
  ));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function oklab(color: string): [number, number, number] {
  const [red, green, blue] = parseColor(color).map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  const l = Math.cbrt(red * 0.4122214708 + green * 0.5363325363 + blue * 0.0514459929);
  const m = Math.cbrt(red * 0.2119034982 + green * 0.6806995451 + blue * 0.1073969566);
  const s = Math.cbrt(red * 0.0883024619 + green * 0.2817188376 + blue * 0.6299787005);
  return [
    l * 0.2104542553 + m * 0.793617785 - s * 0.0040720468,
    l * 1.9779984951 - m * 2.428592205 + s * 0.4505937099,
    l * 0.0259040371 + m * 0.7827717662 - s * 0.808675766,
  ];
}

function perceptualDistance(left: string, right: string): number {
  const first = oklab(left);
  const second = oklab(right);
  return Math.hypot(...first.map((channel, index) => channel - second[index]));
}

describe("stock appearance", () => {
  it("market:symbol과 symbol 표기가 같은 종목 색을 사용한다", () => {
    const symbols = ["069500", "091160", "390390", "440340", "AAPL", "005930"];
    for (const theme of ["light", "dark"] as const) {
      const colors = symbols.map((symbol) => stockColor(symbol, theme));
      expect(new Set(colors).size).toBe(symbols.length);
      expect(stockColor(symbols[0], theme)).toBe(colors[0]);
      for (const symbol of symbols) {
        expect(stockColor(`KOSPI:${symbol}`, theme)).toBe(stockColor(symbol, theme));
        expect(stockColor(`  nasdaq:${symbol.toLowerCase()}  `, theme)).toBe(stockColor(symbol, theme));
        expect(contrast(stockColor(symbol, theme), stockForeground(symbol, theme))).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(stockColor(symbols[0], "light")).not.toBe(stockColor(symbols[0], "dark"));
  });

  it("22개 fixture의 색상을 집합과 순서에 무관하게 구분한다", () => {
    const symbols = Array.from({ length: 22 }, (_, index) => `T${String(index + 1).padStart(3, "0")}`);
    const expectedColors = {
      light: [
        "#245C11", "#954323", "#686200", "#5F2D00", "#34468E", "#00679A",
        "#007457", "#570020", "#253479", "#342C00", "#4C1B00", "#4C0642",
        "#6D4C96", "#003947", "#003700", "#104900", "#865200", "#376E26",
        "#49276E", "#005E6B", "#4559A2", "#953D52",
      ],
      dark: [
        "#9BD78B", "#FFBC9A", "#E1DD7C", "#DFA553", "#A6C0FF", "#86E3FF",
        "#7AF1CE", "#DD7D90", "#93ADFE", "#A8A340", "#CB923F", "#CC81BB",
        "#E7C4FF", "#00B3C1", "#76B066", "#89C479", "#FFCB7A", "#AEEB9E",
        "#C09EF0", "#4DDAE8", "#B9D4FF", "#FFB6C8",
      ],
    } as const;
    for (const theme of ["light", "dark"] as const) {
      const colors = stockColorMap(symbols, theme);
      const reversed = stockColorMap([...symbols].reverse(), theme);
      const subset = stockColorMap(symbols.filter((_, index) => index % 2 === 0), theme);
      expect([...colors.values()]).toEqual(expectedColors[theme]);
      expect(new Set(colors.values()).size).toBe(symbols.length);
      expect(symbols.every((symbol) => colors.get(symbol) === reversed.get(symbol))).toBe(true);
      expect([...subset].every(([symbol, color]) => colors.get(symbol) === color)).toBe(true);

      // --secondary: hsl(60 4% 93%) / hsl(0 0% 14%) from src/index.css.
      const background = theme === "light" ? "#EEEEEC" : "#242424";
      const visibleColors = [...colors.values()].map((color) => compositeColor(color, background, 0.78));
      for (const color of visibleColors) {
        expect(contrast(color, background)).toBeGreaterThanOrEqual(3);
      }
      for (let left = 0; left < visibleColors.length; left += 1) {
        for (let right = left + 1; right < visibleColors.length; right += 1) {
          expect(perceptualDistance(visibleColors[left], visibleColors[right])).toBeGreaterThanOrEqual(0.04);
        }
      }
    }
  });

  it("시장과 심볼을 함께 표시 설정 키로 사용한다", () => {
    expect(holdingKey({ market: "NASDAQ", symbol: "AAPL" })).toBe("NASDAQ:AAPL");
  });
});
