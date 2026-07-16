import { describe, expect, it } from "vitest";
import { removeBacktestAssetPreservingWeights } from "@/lib/backtest-assets";
import type { BacktestAsset } from "@/types";

describe("backtest asset weights", () => {
  it("종목을 삭제해도 남은 종목의 비중을 다시 배분하지 않는다", () => {
    const base = { market: "KRX", currency: "KRW" as const, listDate: "2020-01-01", securityType: "STOCK", status: "LISTED" };
    const assets: BacktestAsset[] = [
      { ...base, symbol: "AAA", name: "에이", weight: 50 },
      { ...base, symbol: "BBB", name: "비", weight: 30 },
      { ...base, symbol: "CCC", name: "씨", weight: 20 },
    ];

    expect(removeBacktestAssetPreservingWeights(assets, "BBB").map((asset) => [asset.symbol, asset.weight])).toEqual([
      ["AAA", 50],
      ["CCC", 20],
    ]);
  });
});
