export const MONOCHROME_SERIES = [
  "hsl(var(--foreground))",
  "hsl(var(--muted-foreground))",
  "hsl(var(--foreground) / 0.72)",
  "hsl(var(--foreground) / 0.5)",
] as const;

export const MONOCHROME_DASHES = [undefined, "7 5", "3 5", "10 4 2 4"] as const;

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
