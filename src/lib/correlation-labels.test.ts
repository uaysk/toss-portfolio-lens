import { describe, expect, it } from "vitest";
import { correlationAssetLabel, correlationCellStyle } from "./correlation-labels";

describe("correlationAssetLabel", () => {
  it("상관행렬 머리글에 종목명을 우선 표시한다", () => {
    expect(correlationAssetLabel({ name: "삼성전자", symbol: "005930" })).toBe("삼성전자");
    expect(correlationAssetLabel({ name: "Apple", symbol: "AAPL" })).toBe("Apple");
  });

  it("종목명이 비어 있으면 종목 코드를 대신 표시한다", () => {
    expect(correlationAssetLabel({ name: "   ", symbol: "005930" })).toBe("005930");
  });

  it("상관계수 셀을 값의 절댓값에 따른 무채색 명도로 표현한다", () => {
    expect(correlationCellStyle(null)).toEqual({
      backgroundColor: "hsl(var(--secondary))",
      color: "hsl(var(--muted-foreground))",
    });
    expect(correlationCellStyle(0.2).backgroundColor).toBe("hsl(var(--foreground) / 0.17)");
    expect(correlationCellStyle(-0.8).backgroundColor).toBe("hsl(var(--foreground) / 0.45)");
    expect(correlationCellStyle(1).color).toBe("hsl(var(--background))");
  });
});
