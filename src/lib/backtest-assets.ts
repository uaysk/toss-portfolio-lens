import type { BacktestAsset } from "@/types";

export function removeBacktestAssetPreservingWeights(
  assets: BacktestAsset[],
  assetSymbol: string,
): BacktestAsset[] {
  return assets.filter((asset) => asset.symbol !== assetSymbol);
}
