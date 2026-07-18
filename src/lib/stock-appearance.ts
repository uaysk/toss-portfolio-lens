import type { Theme } from "@/types";

const darkPalette = [
  "#FAFAFA", "#E4E4E4", "#D4D4D4", "#B8B8B8", "#A1A1A1", "#8B8B8B",
  "#717171", "#5C5C5C", "#C7C7C7", "#959595", "#7C7C7C", "#626262",
  "#ECECEC", "#DBDBDB", "#ADADAD", "#858585", "#6A6A6A", "#525252",
];

const lightPalette = [
  "#090909", "#181818", "#272727", "#3F3F3F", "#525252", "#636363",
  "#717171", "#858585", "#202020", "#343434", "#494949", "#5B5B5B",
  "#111111", "#2D2D2D", "#454545", "#5F5F5F", "#797979", "#919191",
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
