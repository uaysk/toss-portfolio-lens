import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedMoney,
} from "./format";

const legacyUsdt = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const legacyCompactUsdt = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
  notation: "compact",
  compactDisplay: "short",
});
const legacyKrw = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 0,
});
const legacyCompactKrw = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 0,
  notation: "compact",
  compactDisplay: "short",
});
const legacyUsd = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 2,
});
const legacyCompactUsd = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 2,
  notation: "compact",
  compactDisplay: "short",
});
const legacyPercent = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const legacyQuantity = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 6,
});

function legacyMoney(value: number, currency = "KRW", compact = false): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  if (currency === "USDT") {
    return `${(compact ? legacyCompactUsdt : legacyUsdt).format(safeValue)} USDT`;
  }
  if (currency === "USD") {
    return (compact ? legacyCompactUsd : legacyUsd).format(safeValue);
  }
  return (compact ? legacyCompactKrw : legacyKrw).format(safeValue);
}

describe("shared number formatters", () => {
  it("preserves currency, compact notation, fallback currency, and invalid-value output", () => {
    const values = [0, -0, 1, -1, 1_234.567_89, 1_234_567.89, Number.NaN, Infinity, -Infinity];
    const currencies = ["KRW", "USD", "USDT", "EUR"];

    for (const value of values) {
      for (const currency of currencies) {
        for (const compact of [false, true]) {
          expect(formatMoney(value, currency, compact)).toBe(legacyMoney(value, currency, compact));
        }
      }
      expect(formatSignedMoney(value, "KRW")).toBe(`${value > 0 ? "+" : ""}${legacyMoney(value)}`);
    }
  });

  it("preserves percent and quantity formatting, including invalid values", () => {
    const values = [0, -0, 1.234_567_89, -1.234_567_89, Number.NaN, Infinity, -Infinity];
    for (const value of values) {
      const safeValue = Number.isFinite(value) ? value : 0;
      expect(formatPercent(value)).toBe(`${legacyPercent.format(safeValue)}%`);
      expect(formatPercent(value, true)).toBe(`${safeValue > 0 ? "+" : ""}${legacyPercent.format(safeValue)}%`);
      expect(formatQuantity(value)).toBe(legacyQuantity.format(safeValue));
    }
  });
});
