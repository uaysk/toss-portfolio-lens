import { describe, expect, it } from "vitest";
import { analyzePortfolioExposures } from "./exposure-service.js";

describe("portfolio exposure service", () => {
  it("ETF 구성종목을 원본 비중으로 look-through하고 누락을 숨기지 않는다", () => {
    const result = analyzePortfolioExposures([{
      symbol: "ETF", weight: 0.6, currency: "USD", assetType: "ETF", constituents: [
        { symbol: "A", weight: 0.5, sector: "Tech", country: "US", currency: "USD" },
        { symbol: "B", weight: 0.25, sector: "Finance", country: "US", currency: "USD" },
      ],
    }, {
      symbol: "C", weight: 0.4, currency: "KRW", sector: "Industry", country: "KR", assetType: "STOCK", hedged: false,
    }]);
    expect(result.exposures.sector).toContainEqual({ name: "Tech", weight: 0.3 });
    expect(result.exposures.sector).toContainEqual({ name: "UNKNOWN", weight: 0.15 });
    expect(result.exposures.assetType).toContainEqual({ name: "UNKNOWN", weight: 0.6 });
    expect(result.exposures.currency).toContainEqual({ name: "UNKNOWN", weight: 0.15 });
    expect(result.coverage.lookThrough).toBeCloseTo(0.45);
    expect(result.warnings).toEqual([expect.stringContaining("75%만 제공")]);
    expect(result.dataQuality.providerEstimatedFields).toEqual([]);
  });

  it("구성종목의 asset type·factor·환헤지를 부모 ETF 대신 집계한다", () => {
    const result = analyzePortfolioExposures([{
      symbol: "PARENT", weight: 1, currency: "KRW", sector: "Parent sector", country: "KR",
      assetType: "ETF", hedged: false, factors: { value: 99 },
      constituents: [{
        symbol: "A", weight: 0.6, sector: "Technology", country: "US", currency: "USD",
        assetType: "STOCK", hedged: true, factors: { value: 1, momentum: 0.5 },
      }, {
        symbol: "B", weight: 0.4, sector: "Utilities", country: "GB", currency: "GBP",
        assetType: "BOND", hedged: false, factors: { value: -1 },
      }],
    }]);

    expect(result.exposures.assetType).toEqual([
      { name: "STOCK", weight: 0.6 },
      { name: "BOND", weight: 0.4 },
    ]);
    expect(result.exposures.currency).toEqual([
      { name: "USD", weight: 0.6 },
      { name: "GBP", weight: 0.4 },
    ]);
    expect(result.factorExposures).toEqual([
      { factor: "momentum", value: 0.3, coverage: 0.6 },
      { factor: "value", value: 0.19999999999999996, coverage: 1 },
    ]);
    expect(result.currencyHedge).toEqual({ hedgedWeight: 0.6, unhedgedWeight: 0.4, unknownWeight: 0 });
    expect(result.exposures.assetType).not.toContainEqual(expect.objectContaining({ name: "ETF" }));
    expect(result.factorExposures.find((item) => item.factor === "value")?.value).not.toBe(99);
  });

  it("100%를 초과하는 구성종목 비중은 서비스 경계에서도 거부한다", () => {
    expect(() => analyzePortfolioExposures([{
      symbol: "ETF", weight: 1, currency: "USD", assetType: "ETF",
      constituents: [{ symbol: "A", weight: 0.7 }, { symbol: "B", weight: 0.4 }],
    }])).toThrow("구성종목 비중 합계는 1을 초과할 수 없습니다");
  });

  it("UI 최대 입력인 6개 ETF × 5,000개 구성종목을 빠짐없이 집계한다", () => {
    const constituents = Array.from({ length: 5_000 }, (_, index) => ({
      symbol: `C${index}`,
      weight: 1 / 5_000,
      sector: `Sector-${index % 12}`,
      industry: `Industry-${index % 30}`,
      country: `Country-${index % 20}`,
      currency: ["USD", "KRW", "JPY", "EUR"][index % 4],
      assetType: "STOCK",
      hedged: index % 2 === 0,
      factors: { value: 0.25, momentum: -0.1 },
    }));
    const result = analyzePortfolioExposures(Array.from({ length: 6 }, (_, index) => ({
      symbol: `ETF${index}`,
      weight: 1 / 6,
      currency: "USD",
      assetType: "ETF",
      constituents,
    })));

    expect(result.exposures.sector).toHaveLength(12);
    expect(result.exposures.industry).toHaveLength(30);
    expect(result.exposures.country).toHaveLength(20);
    expect(result.coverage).toMatchObject({
      sector: expect.closeTo(1, 10),
      industry: expect.closeTo(1, 10),
      country: expect.closeTo(1, 10),
      currency: expect.closeTo(1, 10),
      assetType: expect.closeTo(1, 10),
      lookThrough: expect.closeTo(1, 10),
    });
    expect(result.factorExposures).toEqual([
      { factor: "momentum", value: expect.closeTo(-0.1, 10), coverage: expect.closeTo(1, 10) },
      { factor: "value", value: expect.closeTo(0.25, 10), coverage: expect.closeTo(1, 10) },
    ]);
    expect(result.dataQuality.byAsset).toHaveLength(6);
    expect(result.warnings).toEqual([]);
  });
});
