import type { BacktestAsset, BacktestRunConfiguration } from "@/types";

function roundWeight(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function scaleBacktestAssetWeights(assets: BacktestAsset[], investedPercent: number): BacktestAsset[] {
  if (!assets.length) return [];
  const boundedTarget = Math.min(100, Math.max(0, investedPercent));
  const positiveTotal = assets.reduce((sum, asset) => sum + Math.max(0, asset.weight), 0);
  const source = positiveTotal > 0 ? assets.map((asset) => Math.max(0, asset.weight) / positiveTotal) : assets.map(() => 1 / assets.length);
  let assigned = 0;
  return assets.map((asset, index) => {
    const weight = index === assets.length - 1
      ? roundWeight(boundedTarget - assigned)
      : roundWeight(source[index] * boundedTarget);
    assigned += weight;
    return { ...asset, weight };
  });
}

export function backtestWeightTotal(config: Pick<BacktestRunConfiguration, "assets" | "execution">): number {
  return config.assets.reduce((sum, asset) => sum + asset.weight, 0) + config.execution.cashTargetPercent;
}

export function normalizedBacktestWeights(config: Pick<BacktestRunConfiguration, "assets" | "execution">): Record<string, number> {
  const invested = Math.max(0, 100 - config.execution.cashTargetPercent);
  if (invested <= 0) return {};
  return Object.fromEntries(config.assets.map((asset) => [asset.symbol, asset.weight / invested]));
}

export function parseNumberList(value: string): number[] {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
}

export function parseSymbolList(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,]+/).map((item) => item.trim().toUpperCase()).filter(Boolean)));
}
