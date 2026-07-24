export const PAIR_SIZING_VERSION = "pair-exposure-sizing/v1" as const;

export type PairSizingInput = {
  equity: number;
  availableCash: number;
  executionPrice: number;
  executionPriceObservedAt: string;
  eligibleAfter: string;
  leverageMultiplier: number;
  predictedVolatility: number;
  targetVolatility: number;
  riskTolerance: number;
  ensembleExposureScale: number;
  maximumUnderlyingExposureRate: number;
  currentExecutionQuantity?: number;
  entryCostRate?: number;
  lotSize?: number;
};

export type PairSizingResult = {
  sizingVersion: typeof PAIR_SIZING_VERSION;
  status: "sized" | "cash" | "unavailable";
  reasonCodes: string[];
  quantity: number;
  targetExecutionQuantity: number;
  currentExecutionQuantity: number;
  executionPrice: number;
  executionGross: number;
  targetExecutionGross: number;
  underlyingExposure: number;
  targetUnderlyingExposure: number;
  underlyingExposureRate: number;
  leverageMultiplier: number;
  riskScale: number;
  volatilityScale: number;
  ensembleExposureScale: number;
};

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function finiteTimestamp(value: string): string | undefined {
  return Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : undefined;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function unavailable(
  input: PairSizingInput,
  reasons: readonly string[],
): PairSizingResult {
  return {
    sizingVersion: PAIR_SIZING_VERSION,
    status: "unavailable",
    reasonCodes: [...new Set(reasons)],
    quantity: 0,
    targetExecutionQuantity: 0,
    currentExecutionQuantity: Number.isSafeInteger(input.currentExecutionQuantity)
      ? Math.max(0, input.currentExecutionQuantity ?? 0) : 0,
    executionPrice: Number.isFinite(input.executionPrice) ? input.executionPrice : 0,
    executionGross: 0,
    targetExecutionGross: 0,
    underlyingExposure: 0,
    targetUnderlyingExposure: 0,
    underlyingExposureRate: 0,
    leverageMultiplier: Number.isFinite(input.leverageMultiplier) ? input.leverageMultiplier : 0,
    riskScale: 0,
    volatilityScale: 0,
    ensembleExposureScale: Number.isFinite(input.ensembleExposureScale)
      ? input.ensembleExposureScale : 0,
  };
}

export function calculatePairPositionSize(input: PairSizingInput): PairSizingResult {
  const reasons: string[] = [];
  if (!finitePositive(input.equity)) reasons.push("equity_invalid");
  if (!Number.isFinite(input.availableCash) || input.availableCash < 0) {
    reasons.push("available_cash_invalid");
  }
  if (!finitePositive(input.executionPrice)) reasons.push("execution_price_invalid");
  if (!Number.isFinite(input.leverageMultiplier) || input.leverageMultiplier === 0) {
    reasons.push("leverage_multiplier_invalid");
  }
  if (!finitePositive(input.predictedVolatility)) reasons.push("predicted_volatility_unavailable");
  if (!finitePositive(input.targetVolatility)) reasons.push("target_volatility_invalid");
  if (!Number.isSafeInteger(input.riskTolerance)
    || input.riskTolerance < 0 || input.riskTolerance > 100) {
    reasons.push("risk_tolerance_invalid");
  }
  if (!Number.isFinite(input.ensembleExposureScale)
    || input.ensembleExposureScale < 0 || input.ensembleExposureScale > 1) {
    reasons.push("ensemble_exposure_scale_invalid");
  }
  if (!Number.isFinite(input.maximumUnderlyingExposureRate)
    || input.maximumUnderlyingExposureRate <= 0
    || input.maximumUnderlyingExposureRate > 2) {
    reasons.push("maximum_underlying_exposure_rate_invalid");
  }
  const currentQuantity = input.currentExecutionQuantity ?? 0;
  if (!Number.isSafeInteger(currentQuantity) || currentQuantity < 0) {
    reasons.push("current_quantity_invalid");
  }
  const lotSize = input.lotSize ?? 1;
  if (!Number.isSafeInteger(lotSize) || lotSize < 1) reasons.push("lot_size_invalid");
  const entryCostRate = input.entryCostRate ?? 0;
  if (!Number.isFinite(entryCostRate) || entryCostRate < 0 || entryCostRate >= 1) {
    reasons.push("entry_cost_rate_invalid");
  }
  const observedAt = finiteTimestamp(input.executionPriceObservedAt);
  const eligibleAfter = finiteTimestamp(input.eligibleAfter);
  if (!observedAt || !eligibleAfter) {
    reasons.push("execution_timestamp_invalid");
  } else if (Date.parse(observedAt) <= Date.parse(eligibleAfter)) {
    reasons.push("execution_price_not_after_signal");
  }
  if (reasons.length) return unavailable(input, reasons);

  const riskScale = input.riskTolerance / 100;
  const volatilityScale = Math.max(
    0.25,
    Math.min(1.5, input.targetVolatility / input.predictedVolatility),
  );
  const targetUnderlyingExposure = Math.min(
    input.equity * input.maximumUnderlyingExposureRate,
    input.equity
      * input.maximumUnderlyingExposureRate
      * riskScale
      * volatilityScale
      * input.ensembleExposureScale,
  );
  if (targetUnderlyingExposure <= 0) {
    return {
      sizingVersion: PAIR_SIZING_VERSION,
      status: "cash",
      reasonCodes: ["zero_risk_or_exposure_scale"],
      quantity: 0,
      targetExecutionQuantity: 0,
      currentExecutionQuantity: currentQuantity,
      executionPrice: input.executionPrice,
      executionGross: 0,
      targetExecutionGross: 0,
      underlyingExposure: 0,
      targetUnderlyingExposure: 0,
      underlyingExposureRate: 0,
      leverageMultiplier: input.leverageMultiplier,
      riskScale: rounded(riskScale),
      volatilityScale: rounded(volatilityScale),
      ensembleExposureScale: input.ensembleExposureScale,
    };
  }
  const targetExecutionGross = targetUnderlyingExposure / Math.abs(input.leverageMultiplier);
  const rawTargetQuantity = Math.floor(targetExecutionGross / input.executionPrice / lotSize)
    * lotSize;
  const affordableQuantity = Math.floor(
    input.availableCash / (input.executionPrice * (1 + entryCostRate)) / lotSize,
  ) * lotSize;
  const targetExecutionQuantity = Math.max(0, rawTargetQuantity);
  const desiredAdditional = Math.max(0, targetExecutionQuantity - currentQuantity);
  const quantity = Math.min(desiredAdditional, Math.max(0, affordableQuantity));
  const executionGross = quantity * input.executionPrice;
  const underlyingExposure = executionGross * Math.abs(input.leverageMultiplier);
  return {
    sizingVersion: PAIR_SIZING_VERSION,
    status: quantity > 0 ? "sized" : "cash",
    reasonCodes: quantity > 0
      ? ["underlying_exposure_normalized"]
      : targetExecutionQuantity <= currentQuantity
        ? ["target_exposure_already_met"]
        : ["insufficient_cash_for_whole_lot"],
    quantity,
    targetExecutionQuantity,
    currentExecutionQuantity: currentQuantity,
    executionPrice: input.executionPrice,
    executionGross: rounded(executionGross),
    targetExecutionGross: rounded(targetExecutionGross),
    underlyingExposure: rounded(underlyingExposure),
    targetUnderlyingExposure: rounded(targetUnderlyingExposure),
    underlyingExposureRate: rounded(underlyingExposure / input.equity),
    leverageMultiplier: input.leverageMultiplier,
    riskScale: rounded(riskScale),
    volatilityScale: rounded(volatilityScale),
    ensembleExposureScale: input.ensembleExposureScale,
  };
}
