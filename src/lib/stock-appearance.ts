import type { Theme } from "@/types";

const darkPalette = [
  "#60a5fa", "#fb923c", "#34d399", "#a78bfa", "#fb7185", "#22d3ee",
  "#fbbf24", "#818cf8", "#a3e635", "#f472b6", "#2dd4bf", "#f87171",
  "#38bdf8", "#c084fc", "#facc15", "#4ade80", "#e879f9", "#d946ef",
];

const lightPalette = [
  "#2563eb", "#ea580c", "#059669", "#7c3aed", "#e11d48", "#0891b2",
  "#b45309", "#4f46e5", "#65a30d", "#db2777", "#0f766e", "#dc2626",
  "#0284c7", "#9333ea", "#ca8a04", "#16a34a", "#c026d3", "#be123c",
];

function hashStockKey(key: string): number {
  let hash = 2166136261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function stockColor(key: string, theme: Theme): string {
  const palette = theme === "dark" ? darkPalette : lightPalette;
  return palette[hashStockKey(key) % palette.length];
}

export function stockForeground(key: string, theme: Theme): string {
  const color = stockColor(key, theme);
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 155 ? "#111111" : "#ffffff";
}

export function holdingKey(holding: { market: string; symbol: string }): string {
  return `${holding.market}:${holding.symbol}`;
}
