import type { Theme } from "@/types";

const darkPalette = [
  "#E7E8EA", "#C7CDD5", "#B8C2B0", "#C8B8AE", "#AAB8C0", "#B8AEBE",
  "#96AAA8", "#A69C84", "#7F8CA1", "#998487", "#788C7D", "#758691",
  "#8C8094", "#887F68", "#637884", "#75676E", "#657469", "#596873",
];

const lightPalette = [
  "#161718", "#252B33", "#29332B", "#382D2A", "#26333A", "#332B38",
  "#273A39", "#3A3627", "#2E384A", "#433235", "#2E4134", "#2D3B44",
  "#3D3244", "#45402D", "#334853", "#4A3D43", "#3B4C40", "#40515B",
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
