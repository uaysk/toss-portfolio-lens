import { describe, expect, it } from "vitest";
import { enforceToolRequestLimits } from "./tool-request-limits.js";
import { ServiceError } from "./service-envelope.js";

describe("shared tool request limits", () => {
  it("Web과 MCP가 같은 중첩 backtest 기간 제한을 적용한다", () => {
    expect(() => enforceToolRequestLimits({
      baseConfig: { startDate: "2010-01-01", endDate: "2025-01-01", assets: [{ symbol: "AAA" }] },
    }, { maxAssets: 20, maxDateRangeYears: 10 })).toThrow(ServiceError);
  });

  it("symbols 기반 고급 분석의 종목 상한을 적용한다", () => {
    expect(() => enforceToolRequestLimits({ symbols: ["A", "B", "C"] }, {
      maxAssets: 2,
      maxDateRangeYears: 10,
    })).toThrowError(/최대 2개/);
    expect(() => enforceToolRequestLimits({ baseSymbols: ["A", "B"], candidateSymbols: ["C"] }, {
      maxAssets: 2,
      maxDateRangeYears: 10,
    })).toThrowError(/최대 2개/);
    expect(() => enforceToolRequestLimits({ currentWeights: { A: 0.5, B: 0.5 }, targetWeights: { A: 0.4, B: 0.4, C: 0.2 } }, {
      maxAssets: 2,
      maxDateRangeYears: 10,
    })).toThrowError(/최대 2개/);
  });

  it("상한 안의 요청은 통과시킨다", () => {
    expect(() => enforceToolRequestLimits({
      fromDate: "2020-01-01",
      toDate: "2025-01-01",
      symbols: ["A", "B"],
    }, { maxAssets: 20, maxDateRangeYears: 10 })).not.toThrow();
  });

  it("기술적 분석 batch는 공개 계약의 50종목 상한을 공통 HTTP·MCP 제한에서도 보존한다", () => {
    const symbols = Array.from({ length: 50 }, (_, index) => `S${index}`);
    expect(() => enforceToolRequestLimits({
      symbols,
      indicators: [{ id: "sma", kind: "sma" }],
      responseMode: "full_series",
    }, { maxAssets: 20, maxDateRangeYears: 10 })).not.toThrow();
    expect(() => enforceToolRequestLimits({
      symbols: [...symbols, "OVER"],
      indicators: [{ id: "sma", kind: "sma" }],
      responseMode: "latest_summary",
    }, { maxAssets: 20, maxDateRangeYears: 10 })).toThrowError(/최대 50개/);
  });

  it("기술 신호 요청은 signal-only 50종목, combined ledger 20종목과 중첩 기간 상한을 적용한다", () => {
    const symbols = Array.from({ length: 21 }, (_, index) => `S${index}`);
    expect(() => enforceToolRequestLimits({
      analysis: { symbols, fromDate: "2020-01-01", toDate: "2025-01-01" },
      strategy: {},
    }, { maxAssets: 20, maxDateRangeYears: 10 })).not.toThrow();
    expect(() => enforceToolRequestLimits({
      analysis: { symbols, fromDate: "2020-01-01", toDate: "2025-01-01" },
      strategy: {},
      backtest: { assets: symbols.map((symbol) => ({ symbol })), startDate: "2020-01-01", endDate: "2025-01-01" },
    }, { maxAssets: 20, maxDateRangeYears: 10 })).toThrowError(/최대 20개/);
    expect(() => enforceToolRequestLimits({
      analysis: { symbols: ["AAA"], fromDate: "2010-01-01", toDate: "2025-01-01" },
      strategy: {},
    }, { maxAssets: 20, maxDateRangeYears: 10 })).toThrowError(/최대 10년/);
  });

  it("stress 시나리오가 기준 기간을 확장해 상한을 우회하지 못하게 한다", () => {
    expect(() => enforceToolRequestLimits({
      baseConfig: { startDate: "2020-01-01", endDate: "2025-01-01", assets: [{ symbol: "AAA" }] },
      scenarios: [{ name: "long", startDate: "2010-01-01" }],
    }, { maxAssets: 20, maxDateRangeYears: 10 })).toThrowError(/최대 10년/);
  });

  it("음수 시작일 offset으로 확장된 실제 기간에도 상한을 적용한다", () => {
    expect(() => enforceToolRequestLimits({
      baseConfig: { startDate: "2015-01-01", endDate: "2025-01-01", assets: [{ symbol: "AAA" }] },
      offsetsDays: [-3_650, 0],
    }, { maxAssets: 20, maxDateRangeYears: 10 })).toThrowError(/최대 10년/);
  });
});
