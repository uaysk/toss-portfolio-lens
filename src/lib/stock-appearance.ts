import type { Theme } from "@/types";

// These palettes are fixed visual contracts. Each slot has a matching hue in
// both themes, while its luminance is tuned for a `bg-secondary` chart card.
// The dark-theme values also keep 3:1 contrast after the history chart's 0.78
// fill opacity is composited over #242424.
const darkPalette = [
  "#DD7D90", "#DD8362", "#CB923F", "#A8A340", "#76B066", "#37B696",
  "#00B3C1", "#49A9E0", "#819AE9", "#AD8BDC", "#CC81BB",
  "#F290A2", "#F19674", "#DFA553", "#BBB655", "#89C479", "#4FCAA8",
  "#31C7D5", "#5EBCF4", "#93ADFE", "#C09EF0", "#E193CF",
  "#FFA3B5", "#FFA987", "#F3B867", "#CEC968", "#9BD78B", "#65DDBB",
  "#4DDAE8", "#72CFFF", "#A6C0FF", "#D3B1FF", "#F5A6E2",
  "#FFB6C8", "#FFBC9A", "#FFCB7A", "#E1DD7C", "#AEEB9E", "#7AF1CE",
  "#65EEFC", "#86E3FF", "#B9D4FF", "#E7C4FF", "#FFB9F6",
] as const;

const lightPalette = [
  "#570020", "#580500", "#4C1B00", "#342C00", "#003700", "#003C24",
  "#003947", "#002F5E", "#162166", "#38145B", "#4C0642",
  "#6C152F", "#6C1C00", "#5F2D00", "#453E00", "#104900", "#004E34",
  "#004B59", "#004172", "#253479", "#49276E", "#5F1C54",
  "#802A40", "#80300C", "#733F00", "#565000", "#245C11", "#006145",
  "#005E6B", "#005485", "#34468E", "#5B3982", "#732F66",
  "#953D52", "#954323", "#865200", "#686200", "#376E26", "#007457",
  "#00717E", "#00679A", "#4559A2", "#6D4C96", "#874179",
] as const;

const STOCK_COLOR_SEED = 519_252;

function hashStockKey(key: string): number {
  let hash = 2166136261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function canonicalStockColorKey(key: string): string {
  const normalized = key.trim().toUpperCase();
  const separator = normalized.lastIndexOf(":");
  const symbol = separator >= 0 ? normalized.slice(separator + 1).trim() : normalized;
  return symbol || normalized;
}

function mixStockHash(hash: number): number {
  let mixed = hash >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x85ebca6b);
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 0xc2b2ae35);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function stockColorIndex(key: string): number {
  const canonical = canonicalStockColorKey(key);
  return mixStockHash(hashStockKey(canonical) ^ STOCK_COLOR_SEED) % lightPalette.length;
}

export function stockColor(key: string, theme: Theme): string {
  const palette = theme === "dark" ? darkPalette : lightPalette;
  return palette[stockColorIndex(key)];
}

export function stockColorMap(keys: readonly string[], theme: Theme): ReadonlyMap<string, string> {
  return new Map(keys.map((key) => [key, stockColor(key, theme)]));
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function stockForeground(key: string, theme: Theme): string {
  const color = stockColor(key, theme);
  const luminance = relativeLuminance(color);
  const darkContrast = (luminance + 0.05) / (relativeLuminance("#111111") + 0.05);
  const lightContrast = (relativeLuminance("#ffffff") + 0.05) / (luminance + 0.05);
  return darkContrast >= lightContrast ? "#111111" : "#ffffff";
}

export function holdingKey(holding: { market: string; symbol: string }): string {
  return `${holding.market}:${holding.symbol}`;
}
