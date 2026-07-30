import type { BinanceInstrumentRules } from "./contracts.js";
import {
  ceilToStep,
  estimatedLiquidationPrice,
  floorToStep,
  type FuturesSide,
} from "./futures-paper-ledger.js";

export const FUTURES_TRADE_RISK_RATE = 0.005;
export const FUTURES_DAILY_LOSS_LIMIT_RATE = 0.03;
export const PAPER_MAX_GROSS_EXPOSURE_RATE = 1.5;
// A short's adverse mark can increase its notional until liquidation. With
// isolated leverage >= 1 and a positive maintenance rate, that mark remains
// strictly below 2x entry. Qualifying twice the entry gross cap therefore
// keeps one conservative bracket scalar valid for the whole paper position.
export const PAPER_MAINTENANCE_MARGIN_COVERAGE_MULTIPLIER = 2;
export const PAPER_MAINTENANCE_MARGIN_COVERAGE_RATE = (
  PAPER_MAX_GROSS_EXPOSURE_RATE
  * PAPER_MAINTENANCE_MARGIN_COVERAGE_MULTIPLIER
);
export const LIVE_MAX_GROSS_EXPOSURE_RATE = 1;
export const DEFAULT_MARGIN_USAGE_RATE = 0.2;
export const MAX_MARGIN_USAGE_RATE = 1;

export type ReturnQuantile = {
  quantile: number;
  returnRate: number;
};

export type QuantileDirectionSignal = {
  direction: FuturesSide | "flat";
  probabilityAboveCost: number;
  probabilityBelowNegativeCost: number;
  confidence: number;
  leverageTier: number;
};

function interpolateCdf(quantiles: readonly ReturnQuantile[], value: number): number {
  if (value <= quantiles[0]!.returnRate) return quantiles[0]!.quantile;
  if (value >= quantiles.at(-1)!.returnRate) return quantiles.at(-1)!.quantile;
  for (let index = 1; index < quantiles.length; index += 1) {
    const left = quantiles[index - 1]!;
    const right = quantiles[index]!;
    if (value > right.returnRate) continue;
    if (right.returnRate === left.returnRate) return right.quantile;
    const weight = (value - left.returnRate) / (right.returnRate - left.returnRate);
    return left.quantile + (right.quantile - left.quantile) * weight;
  }
  return 0.5;
}

export function signalFromQuantileCdf(input: {
  quantiles: readonly ReturnQuantile[];
  roundTripCostRate: number;
  realizedVolatilityRate: number;
  spreadBps: number;
  mode?: "paper" | "live";
}): QuantileDirectionSignal {
  if (input.quantiles.length < 3) throw new Error("At least three return quantiles are required.");
  const quantiles = [...input.quantiles].sort((left, right) => left.quantile - right.quantile);
  for (let index = 0; index < quantiles.length; index += 1) {
    const item = quantiles[index]!;
    if (!Number.isFinite(item.quantile) || item.quantile <= 0 || item.quantile >= 1
      || !Number.isFinite(item.returnRate)) {
      throw new Error("Return quantiles must be finite and strictly inside (0, 1).");
    }
    if (index > 0) {
      const previous = quantiles[index - 1]!;
      if (item.quantile <= previous.quantile || item.returnRate < previous.returnRate) {
        throw new Error("Return quantiles must be strictly keyed and value-monotone.");
      }
    }
  }
  if (!Number.isFinite(input.roundTripCostRate) || input.roundTripCostRate < 0) {
    throw new Error("roundTripCostRate must be non-negative.");
  }
  const probabilityAboveCost = Math.max(
    0,
    Math.min(1, 1 - interpolateCdf(quantiles, input.roundTripCostRate)),
  );
  const probabilityBelowNegativeCost = Math.max(
    0,
    Math.min(1, interpolateCdf(quantiles, -input.roundTripCostRate)),
  );
  const confidence = Math.max(probabilityAboveCost, probabilityBelowNegativeCost);
  const direction: FuturesSide | "flat" = confidence < 0.55
    ? "flat"
    : probabilityAboveCost >= probabilityBelowNegativeCost ? "long" : "short";
  const maximum = input.mode === "live" ? 10 : 15;
  let leverageTier = confidence >= 0.8 ? maximum
    : confidence >= 0.7 ? Math.min(maximum, 10)
      : confidence >= 0.62 ? 5
        : confidence >= 0.55 ? 2 : 1;
  if (input.realizedVolatilityRate >= 0.02) leverageTier = Math.min(leverageTier, 3);
  else if (input.realizedVolatilityRate >= 0.01) leverageTier = Math.min(leverageTier, 5);
  if (input.spreadBps >= 8) leverageTier = Math.min(leverageTier, 2);
  else if (input.spreadBps >= 5) leverageTier = Math.min(leverageTier, 3);
  return {
    direction,
    probabilityAboveCost,
    probabilityBelowNegativeCost,
    confidence,
    leverageTier,
  };
}

export type FuturesRiskSizingInput = {
  mode: "paper" | "live";
  side: FuturesSide;
  equity: number;
  currentGrossExposure: number;
  currentMargin: number;
  price: number;
  atr14: number;
  adverseQuantileDistance: number;
  spreadBps: number;
  slippageBpsPerSide: number;
  requestedLeverage: number;
  limits?: {
    riskPerTradeRate: number;
    maximumLeverage: number;
    grossExposureLimitRate: number;
    marginUsageLimitRate: number;
    liquidationBufferMultiple: number;
  };
  rules: BinanceInstrumentRules;
};

export type FuturesRiskSizingResult = {
  accepted: boolean;
  reason?:
    | "daily_loss_gate"
    | "invalid_input"
    | "maintenance_margin_unavailable"
    | "exposure_limit"
    | "margin_limit"
    | "minimum_notional"
    | "liquidation_buffer";
  leverage: number;
  quantity: number;
  notional: number;
  isolatedMargin: number;
  riskBudget: number;
  protectiveStopDistance: number;
  protectiveStopPrice: number;
  estimatedLiquidationPrice: number;
  liquidationBufferRate: number;
  grossExposureLimit: number;
  marginLimit: number;
};

function rejected(
  reason: NonNullable<FuturesRiskSizingResult["reason"]>,
  partial: Omit<FuturesRiskSizingResult, "accepted" | "reason">,
): FuturesRiskSizingResult {
  return { accepted: false, reason, ...partial };
}

export function sizeFuturesPosition(
  input: FuturesRiskSizingInput,
): FuturesRiskSizingResult {
  const limits = input.limits ?? {
    riskPerTradeRate: FUTURES_TRADE_RISK_RATE,
    maximumLeverage: input.mode === "paper" ? 15 : 10,
    grossExposureLimitRate: input.mode === "paper"
      ? PAPER_MAX_GROSS_EXPOSURE_RATE
      : LIVE_MAX_GROSS_EXPOSURE_RATE,
    marginUsageLimitRate: DEFAULT_MARGIN_USAGE_RATE,
    liquidationBufferMultiple: 2,
  };
  const finite = [
    input.equity,
    input.currentGrossExposure,
    input.currentMargin,
    input.price,
    input.atr14,
    input.adverseQuantileDistance,
    input.spreadBps,
    input.slippageBpsPerSide,
    limits.riskPerTradeRate,
    limits.maximumLeverage,
    limits.grossExposureLimitRate,
    limits.marginUsageLimitRate,
    limits.liquidationBufferMultiple,
  ].every(Number.isFinite);
  const hardMaximumLeverage = input.mode === "paper" ? 15 : 10;
  const hardGrossExposureLimitRate = input.mode === "paper"
    ? PAPER_MAX_GROSS_EXPOSURE_RATE
    : LIVE_MAX_GROSS_EXPOSURE_RATE;
  const deploymentMaximumLeverage = Math.min(
    hardMaximumLeverage,
    Math.trunc(limits.maximumLeverage),
  );
  const deploymentGrossExposureLimit = input.equity * Math.min(
    hardGrossExposureLimitRate,
    limits.grossExposureLimitRate,
  );
  const marginLimit = input.equity * Math.min(
    MAX_MARGIN_USAGE_RATE,
    limits.marginUsageLimitRate,
  );
  const riskBudget = input.equity * Math.min(
    FUTURES_TRADE_RISK_RATE,
    limits.riskPerTradeRate,
  );
  const unresolvedEmpty = {
    leverage: 1,
    quantity: 0,
    notional: 0,
    isolatedMargin: 0,
    riskBudget,
    protectiveStopDistance: 0,
    protectiveStopPrice: input.price,
    estimatedLiquidationPrice: input.price,
    liquidationBufferRate: 0,
    grossExposureLimit: deploymentGrossExposureLimit,
    marginLimit,
  };
  if (input.rules.maintenanceMarginSource !== "binance_user_data_brackets") {
    return rejected("maintenance_margin_unavailable", unresolvedEmpty);
  }
  const grossExposureLimit = Math.min(
    deploymentGrossExposureLimit,
    input.rules.maintenanceMarginMaximumNotional
      / PAPER_MAINTENANCE_MARGIN_COVERAGE_MULTIPLIER,
  );
  const empty = { ...unresolvedEmpty, grossExposureLimit };
  const maximumLeverage = Math.min(
    deploymentMaximumLeverage,
    input.rules.maximumInitialLeverage,
  );
  if (!finite || input.equity <= 0 || input.price <= 0 || input.atr14 < 0
    || input.adverseQuantileDistance < 0 || input.spreadBps < 0
    || input.slippageBpsPerSide < 0
    || limits.riskPerTradeRate <= 0
    || limits.riskPerTradeRate > FUTURES_TRADE_RISK_RATE
    || !Number.isInteger(limits.maximumLeverage)
    || limits.maximumLeverage > hardMaximumLeverage
    || deploymentMaximumLeverage < 1
    || limits.grossExposureLimitRate <= 0
    || limits.grossExposureLimitRate > hardGrossExposureLimitRate
    || limits.marginUsageLimitRate <= 0
    || limits.marginUsageLimitRate > MAX_MARGIN_USAGE_RATE
    || limits.liquidationBufferMultiple < 2) {
    return rejected("invalid_input", empty);
  }
  const observedCostDistance = input.price
    * (input.spreadBps + input.slippageBpsPerSide * 2) / 10_000;
  const requestedProtectiveStopDistance = Math.max(
    1.5 * input.atr14,
    input.adverseQuantileDistance,
    observedCostDistance,
  );
  if (requestedProtectiveStopDistance <= 0
    || requestedProtectiveStopDistance >= input.price) {
    return rejected("invalid_input", {
      ...empty,
      protectiveStopDistance: requestedProtectiveStopDistance,
    });
  }
  const protectiveStopPrice = input.side === "long"
    ? floorToStep(
      input.price - requestedProtectiveStopDistance,
      input.rules.tickSize,
    )
    : ceilToStep(
      input.price + requestedProtectiveStopDistance,
      input.rules.tickSize,
    );
  const protectiveStopDistance = Math.abs(input.price - protectiveStopPrice);
  if (protectiveStopPrice <= 0
    || protectiveStopDistance <= 0
    || protectiveStopDistance >= input.price) {
    return rejected("invalid_input", {
      ...empty,
      protectiveStopDistance,
      protectiveStopPrice,
    });
  }
  const stopRate = protectiveStopDistance / input.price;
  const desiredNotional = riskBudget / stopRate;
  const exposureHeadroom = Math.max(0, grossExposureLimit - input.currentGrossExposure);
  const marginHeadroom = Math.max(0, marginLimit - input.currentMargin);
  if (exposureHeadroom < input.rules.minNotional) {
    return rejected("exposure_limit", { ...empty, protectiveStopDistance });
  }
  if (marginHeadroom <= 0) {
    return rejected("margin_limit", { ...empty, protectiveStopDistance });
  }
  let leverage = Math.max(
    1,
    Math.min(maximumLeverage, Math.trunc(input.requestedLeverage)),
  );
  let liquidationPrice = estimatedLiquidationPrice(
    input.side,
    input.price,
    leverage,
    input.rules.maintenanceMarginRate,
  );
  let liquidationBufferRate = Math.abs(input.price - liquidationPrice) / input.price;
  while (
    leverage > 1
    && liquidationBufferRate < stopRate * limits.liquidationBufferMultiple
  ) {
    leverage -= 1;
    liquidationPrice = estimatedLiquidationPrice(
      input.side,
      input.price,
      leverage,
      input.rules.maintenanceMarginRate,
    );
    liquidationBufferRate = Math.abs(input.price - liquidationPrice) / input.price;
  }
  if (liquidationBufferRate < stopRate * limits.liquidationBufferMultiple) {
    return rejected("liquidation_buffer", {
      ...empty,
      leverage,
      protectiveStopDistance,
      estimatedLiquidationPrice: liquidationPrice,
      liquidationBufferRate,
    });
  }
  const notionalCap = Math.min(desiredNotional, exposureHeadroom, marginHeadroom * leverage);
  const quantity = floorToStep(notionalCap / input.price, input.rules.stepSize);
  const notional = quantity * input.price;
  const isolatedMargin = notional / leverage;
  const result = {
    leverage,
    quantity,
    notional,
    isolatedMargin,
    riskBudget,
    protectiveStopDistance,
    protectiveStopPrice,
    estimatedLiquidationPrice: liquidationPrice,
    liquidationBufferRate,
    grossExposureLimit,
    marginLimit,
  };
  if (quantity < input.rules.minQuantity || notional < input.rules.minNotional) {
    return rejected("minimum_notional", result);
  }
  return { accepted: true, ...result };
}

export type DailyLossGateState = {
  utcDate: string;
  dayStartEquity: number;
  latestEquity: number;
  drawdownRate: number;
  blocked: boolean;
};

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function updateDailyLossGate(
  previous: DailyLossGateState | undefined,
  equity: number,
  now: number,
  dailyLossLimitRate = FUTURES_DAILY_LOSS_LIMIT_RATE,
): DailyLossGateState & { closeAllReduceOnly: boolean } {
  if (!Number.isFinite(equity)
    || !Number.isSafeInteger(now)
    || now < 0
    || !Number.isFinite(dailyLossLimitRate)
    || dailyLossLimitRate <= 0
    || dailyLossLimitRate > FUTURES_DAILY_LOSS_LIMIT_RATE) {
    throw new Error("Daily loss gate input is invalid.");
  }
  const date = utcDate(now);
  if (!previous || previous.utcDate !== date) {
    const insolvent = equity <= 0;
    return {
      utcDate: date,
      dayStartEquity: equity,
      latestEquity: equity,
      drawdownRate: insolvent ? 1 : 0,
      blocked: insolvent,
      closeAllReduceOnly: insolvent,
    };
  }
  const drawdownRate = previous.dayStartEquity > 0
    ? Math.max(0, (previous.dayStartEquity - equity) / previous.dayStartEquity)
    : 1;
  const crossed = drawdownRate >= dailyLossLimitRate;
  return {
    utcDate: date,
    dayStartEquity: previous.dayStartEquity,
    latestEquity: equity,
    drawdownRate,
    blocked: previous.blocked || crossed,
    closeAllReduceOnly: !previous.blocked && crossed,
  };
}
