export type CorrelationAssetLabelInput = {
  name: string;
  symbol: string;
};

export function correlationAssetLabel(asset: CorrelationAssetLabelInput): string {
  return asset.name.trim() || asset.symbol;
}

export function correlationCellStyle(value: number | null): { backgroundColor: string; color: string } {
  if (value === null) {
    return {
      backgroundColor: "hsl(var(--secondary))",
      color: "hsl(var(--muted-foreground))",
    };
  }
  const opacity = Math.round((0.07 + Math.min(1, Math.abs(value)) * 0.48) * 100) / 100;
  return {
    backgroundColor: `hsl(var(--foreground) / ${opacity})`,
    color: opacity >= 0.34 ? "hsl(var(--background))" : "hsl(var(--foreground))",
  };
}
