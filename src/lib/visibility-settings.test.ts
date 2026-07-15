import { describe, expect, it } from "vitest";
import { buildVisibilityStocks, parseHiddenStockKeys, serializeHiddenStockKeys } from "./visibility-settings";
import type { Holding, PortfolioHistorySeries } from "@/types";

describe("visibility settings", () => {
  it("숨김 키를 중복 없이 안전하게 읽고 정렬해 저장한다", () => {
    expect(parseHiddenStockKeys('["KRX:AAA", "KRX:AAA", 12, ""]')).toEqual(["KRX:AAA"]);
    expect(parseHiddenStockKeys("not-json")).toEqual([]);
    expect(serializeHiddenStockKeys(["NYSE:B", "KRX:A", "NYSE:B"])).toBe('["KRX:A","NYSE:B"]');
  });

  it("현재 보유 종목과 선택 기간의 매도 완료 종목을 중복 없이 합친다", () => {
    const current = [{
      symbol: "AAA",
      name: "현재 종목",
      market: "KRX",
      currency: "KRW",
    }] as Holding[];
    const history: PortfolioHistorySeries[] = [
      { key: "KRX:AAA", symbol: "AAA", name: "이전 이름", market: "KRX", currency: "KRW", averageWeight: 60 },
      { key: "KRX:SOLD", symbol: "SOLD", name: "매도 종목", market: "KRX", currency: "KRW", averageWeight: 40 },
    ];

    expect(buildVisibilityStocks(current, history)).toEqual([
      { key: "KRX:AAA", symbol: "AAA", name: "현재 종목", market: "KRX", isCurrent: true },
      { key: "KRX:SOLD", symbol: "SOLD", name: "매도 종목", market: "KRX", isCurrent: false, averageWeight: 40 },
    ]);
  });
});
