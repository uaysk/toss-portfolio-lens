import { describe, expect, it } from "vitest";
import { normalizedBacktestWeights, parseNumberList, scaleBacktestAssetWeights } from "@/lib/backtest-config";
import type { BacktestAsset, BacktestRunConfiguration } from "@/types";

const base = { market: "KRX", currency: "KRW" as const, listDate: "2020-01-01", securityType: "STOCK", status: "LISTED" };

describe("advanced backtest configuration", () => {
  it("현금 목표를 제외한 투자 비중으로 종목 비중을 비례 조정한다", () => {
    const assets: BacktestAsset[] = [
      { ...base, symbol: "AAA", name: "A", weight: 60 },
      { ...base, symbol: "BBB", name: "B", weight: 40 },
    ];
    expect(scaleBacktestAssetWeights(assets, 85).map((asset) => asset.weight)).toEqual([51, 34]);
  });

  it("Monte Carlo용 비중은 투자 자산끼리 합계 1로 정규화한다", () => {
    const config = {
      assets: [{ symbol: "AAA", weight: 45 }, { symbol: "BBB", weight: 45 }],
      execution: { cashTargetPercent: 10 },
    } as Pick<BacktestRunConfiguration, "assets" | "execution">;
    expect(normalizedBacktestWeights(config)).toEqual({ AAA: 0.5, BBB: 0.5 });
  });

  it("쉼표와 공백으로 입력한 수치 목록에서 유효 숫자만 읽는다", () => {
    expect(parseNumberList("-30, 0 30 nope")).toEqual([-30, 0, 30]);
    expect(parseNumberList("   ")).toEqual([]);
    expect(parseNumberList("10,")).toEqual([10]);
  });
});
