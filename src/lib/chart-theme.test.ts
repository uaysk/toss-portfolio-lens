import { describe, expect, it } from "vitest";
import {
  CHART_DASHES,
  CHART_BAND_COLORS,
  CHART_COLORS,
  CHART_SERIES,
  chartBandColor,
  chartIndicatorColor,
  chartRangeSignature,
  chartRangeValue,
  chartSeriesColor,
  chartSeriesDash,
  isBollingerBandKind,
  splitChartIndicatorFields,
} from "./chart-theme";

describe("chart theme", () => {
  it("keeps multi-series colors and line patterns independently identifiable", () => {
    expect(CHART_SERIES).toHaveLength(6);
    expect(new Set(CHART_SERIES).size).toBe(CHART_SERIES.length);
    expect(new Set(CHART_DASHES.slice(0, CHART_SERIES.length)).size).toBe(CHART_SERIES.length);
    expect(new Set(CHART_BAND_COLORS).size).toBe(CHART_BAND_COLORS.length);
    expect(chartSeriesColor(CHART_SERIES.length)).toBe(CHART_SERIES[0]);
    expect(chartSeriesDash(CHART_DASHES.length)).toBe(CHART_DASHES[0]);
    expect(chartBandColor(CHART_BAND_COLORS.length)).toBe(CHART_BAND_COLORS[0]);
    expect(new Set([
      CHART_COLORS.primary,
      CHART_COLORS.positive,
      CHART_COLORS.negative,
      CHART_COLORS.bollinger,
      CHART_COLORS.rsi,
      CHART_COLORS.volume,
    ]).size).toBe(6);
  });

  it("keeps technical indicators on stable semantic colors", () => {
    expect(chartIndicatorColor("rsi")).toBe(CHART_COLORS.rsi);
    expect(chartIndicatorColor("volume_sma")).toBe(CHART_COLORS.volume);
    expect(chartIndicatorColor("macd", 0)).toBe(CHART_COLORS.primary);
    expect(chartIndicatorColor("macd", 1)).toBe(CHART_COLORS.positive);
    expect(chartIndicatorColor("macd", 2)).toBe(CHART_COLORS.neutral);
    expect(chartIndicatorColor("atr", 0, 2)).toBe(CHART_SERIES[2]);
  });

  it("represents Bollinger bounds as one range and keeps only the middle line", () => {
    for (const kind of ["bollinger", "bollinger-band", "bollinger_bands", "bollinger_band_width_percent_b"]) {
      expect(isBollingerBandKind(kind)).toBe(true);
      expect(splitChartIndicatorFields(kind, ["upper", "middle", "lower"])).toEqual({
        lineFields: ["middle"],
        band: { lowerField: "lower", upperField: "upper" },
      });
    }
    expect(splitChartIndicatorFields("donchian_channel", ["upper", "middle", "lower"])).toEqual({
      lineFields: ["upper", "middle", "lower"],
    });
  });

  it("omits incomplete or inverted chart ranges", () => {
    expect(chartRangeValue({ lower: 90, upper: 110 }, "lower", "upper")).toEqual([90, 110]);
    expect(chartRangeValue({ lower: 111, upper: 110 }, "lower", "upper")).toBeUndefined();
    expect(chartRangeValue({ lower: 90, upper: null }, "lower", "upper")).toBeUndefined();
    expect(chartRangeSignature([
      { lower: 90 },
      { upper: 110 },
    ], "lower", "upper")).toBeUndefined();
    expect(chartRangeSignature([
      { lower: 90, upper: 110 },
      { lower: 91, upper: 111 },
    ], "lower", "upper")).toBe("0:90:110|1:91:111");
  });
});
