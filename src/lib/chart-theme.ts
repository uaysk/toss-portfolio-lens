export const CHART_SERIES = [
  "hsl(var(--chart-series-1))",
  "hsl(var(--chart-series-2))",
  "hsl(var(--chart-series-3))",
  "hsl(var(--chart-series-4))",
  "hsl(var(--chart-series-5))",
  "hsl(var(--chart-series-6))",
] as const;

export const CHART_DASHES = [
  undefined,
  "8 4",
  "3 4",
  "10 3 2 3",
  "2 3",
  "12 4",
  "6 3 1 3",
  "1 3",
  "9 2 2 2",
  "14 4 3 4",
] as const;

export const CHART_BAND_COLORS = [
  "hsl(var(--chart-band))",
  "hsl(var(--chart-series-3))",
  "hsl(var(--chart-series-2))",
] as const;

/**
 * Semantic chart colors keep the same meaning across every dashboard surface.
 * The values themselves live in CSS so light and dark themes can tune contrast
 * independently without changing chart code.
 */
export const CHART_COLORS = Object.freeze({
  primary: "hsl(var(--chart-series-1))",
  positive: "hsl(var(--chart-positive))",
  negative: "hsl(var(--chart-negative))",
  bollinger: "hsl(var(--chart-band))",
  rsi: "hsl(var(--chart-rsi))",
  forecast: "hsl(var(--chart-series-4))",
  volume: "hsl(var(--chart-volume))",
  neutral: "hsl(var(--chart-neutral))",
  cursor: "hsl(var(--chart-cursor))",
});

export function chartSeriesColor(index: number): (typeof CHART_SERIES)[number] {
  const normalized = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return CHART_SERIES[normalized % CHART_SERIES.length];
}

export function chartSeriesDash(index: number): (typeof CHART_DASHES)[number] {
  const normalized = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return CHART_DASHES[normalized % CHART_DASHES.length];
}

export function chartBandColor(index: number): (typeof CHART_BAND_COLORS)[number] {
  const normalized = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return CHART_BAND_COLORS[normalized % CHART_BAND_COLORS.length];
}

export function chartIndicatorColor(kind: string, index = 0, paletteOffset = 0): string {
  const normalized = normalizedIndicatorKind(kind);
  if (normalized === "rsi") return CHART_COLORS.rsi;
  if (["mfi", "stochastic_oscillator", "williams_r"].includes(normalized)) {
    return index === 0 ? CHART_COLORS.rsi : CHART_COLORS.primary;
  }
  if ([
    "volume_sma",
    "relative_volume",
    "obv",
    "cmf",
    "accumulation_distribution_line",
  ].includes(normalized)) return index === 0 ? CHART_COLORS.volume : chartSeriesColor(index + 2);
  if (normalized === "macd") {
    return [CHART_COLORS.primary, CHART_COLORS.positive, CHART_COLORS.neutral][index % 3]!;
  }
  return chartSeriesColor(paletteOffset + index);
}

const BOLLINGER_BAND_KINDS = new Set([
  "bollinger",
  "bollinger_band",
  "bollinger_bands",
  "bollinger_band_width_percent_b",
]);

function normalizedIndicatorKind(kind: string): string {
  return kind.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isBollingerBandKind(kind: string): boolean {
  return BOLLINGER_BAND_KINDS.has(normalizedIndicatorKind(kind));
}

export function splitChartIndicatorFields(
  kind: string,
  fields: readonly string[],
): {
  lineFields: string[];
  band?: { lowerField: "lower"; upperField: "upper" };
} {
  if (!isBollingerBandKind(kind)) return { lineFields: [...fields] };
  const available = new Set(fields);
  return {
    lineFields: fields.filter((field) => field !== "lower" && field !== "upper"),
    ...(available.has("lower") && available.has("upper")
      ? { band: { lowerField: "lower" as const, upperField: "upper" as const } }
      : {}),
  };
}

export function chartRangeValue(
  row: Readonly<Record<string, unknown>>,
  lowerKey: string,
  upperKey: string,
): [number, number] | undefined {
  const lower = row[lowerKey];
  const upper = row[upperKey];
  if (
    typeof lower !== "number"
    || !Number.isFinite(lower)
    || typeof upper !== "number"
    || !Number.isFinite(upper)
    || lower > upper
  ) return undefined;
  return [lower, upper];
}

export function chartRangeSignature(
  rows: readonly Readonly<Record<string, unknown>>[],
  lowerKey: string,
  upperKey: string,
): string | undefined {
  const pairs = rows.flatMap((row, index) => {
    const range = chartRangeValue(row, lowerKey, upperKey);
    return range ? [`${index}:${range[0]}:${range[1]}`] : [];
  });
  return pairs.length ? pairs.join("|") : undefined;
}

export const chartTooltipStyle = {
  border: "1px solid hsl(var(--chart-grid))",
  borderRadius: 14,
  background: "hsl(var(--chart-tooltip) / 0.96)",
  color: "hsl(var(--card-foreground))",
  boxShadow: "0 12px 36px hsl(var(--chart-shadow) / 0.16)",
  backdropFilter: "blur(14px)",
  padding: "10px 12px",
  fontSize: 11,
};

export const chartTooltipLabelStyle = {
  color: "hsl(var(--card-foreground))",
  fontWeight: 800,
};

export const chartTooltipItemStyle = {
  color: "hsl(var(--card-foreground))",
  fontWeight: 700,
};

export function monochromeHeatmapStyle(value: number): { backgroundColor: string; color: string } {
  const opacity = Math.min(0.5, 0.1 + Math.abs(value) / 40);
  return {
    backgroundColor: `hsl(var(--foreground) / ${opacity})`,
    color: opacity >= 0.34 ? "hsl(var(--background))" : "hsl(var(--foreground))",
  };
}
