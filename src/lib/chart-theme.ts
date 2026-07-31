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
  border: 0,
  borderRadius: 16,
  background: "hsl(var(--card))",
  color: "hsl(var(--card-foreground))",
  boxShadow: "0 18px 50px hsl(var(--background) / 0.38)",
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
