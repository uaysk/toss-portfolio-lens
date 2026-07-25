import type { BinanceInstrumentRules } from "./contracts.js";

export type FuturesSide = "long" | "short";

export type FuturesPosition = {
  symbol: string;
  side: FuturesSide;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  isolatedMargin: number;
  maintenanceMargin: number;
  maintenanceMarginRate: number;
  estimatedLiquidationPrice: number;
  liquidationBufferRate: number;
  protectiveStopPrice: number;
  unrealizedPnl: number;
  accruedFunding: number;
  openedAt: number;
};

export type FuturesPaperFill = {
  fillId: string;
  clientOrderId: string;
  symbol: string;
  action: "open" | "reduce";
  side: FuturesSide;
  quantity: number;
  price: number;
  notional: number;
  leverage: number;
  reduceOnly: boolean;
  realizedPnl: number;
  fee: number;
  slippageCost: number;
  funding: number;
  reason?:
    | "signal"
    | "liquidation"
    | "daily_loss_gate"
    | "protection"
    | "terminal_settlement";
  decisionAt: number;
  executedAt: number;
};

export type FuturesPaperLedgerSnapshot = {
  mode: "paper";
  marginMode: "isolated";
  positionMode: "one_way";
  initialCash: number;
  walletBalance: number;
  availableBalance: number;
  equity: number;
  grossExposure: number;
  totalIsolatedMargin: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  slippage: number;
  funding: number;
  positions: FuturesPosition[];
  fills: FuturesPaperFill[];
};

export type FuturesPaperLedgerOptions = {
  initialCash: number;
  feeBpsPerSide?: number;
  slippageBpsPerSide?: number;
};

export type OpenFuturesPositionInput = {
  fillId: string;
  clientOrderId: string;
  rules: BinanceInstrumentRules;
  side: FuturesSide;
  quantity: number;
  observedPrice: number;
  markPrice?: number;
  leverage: number;
  protectiveStopPrice: number;
  decisionAt: number;
  executedAt: number;
};

export type ReduceFuturesPositionInput = {
  fillId: string;
  clientOrderId: string;
  symbol: string;
  quantity: number;
  observedPrice: number;
  decisionAt: number;
  executedAt: number;
  reduceOnly: true;
  reason?: FuturesPaperFill["reason"];
};

function assertFinite(value: number, field: string, minimum = 0, inclusive = false): number {
  if (!Number.isFinite(value) || (inclusive ? value < minimum : value <= minimum)) {
    throw new Error(`${field} must be ${inclusive ? "non-negative" : "positive"} and finite.`);
  }
  return value;
}

function precision(value: number): number {
  const text = value.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.split(".")[1]!.length : 0;
}

export function floorToStep(value: number, step: number): number {
  assertFinite(value, "value", 0, true);
  assertFinite(step, "step");
  const digits = Math.min(12, precision(step));
  const units = Math.floor((value + step * 1e-9) / step);
  return Number((units * step).toFixed(digits));
}

export function ceilToStep(value: number, step: number): number {
  assertFinite(value, "value", 0, true);
  assertFinite(step, "step");
  const digits = Math.min(12, precision(step));
  const units = Math.ceil((value - step * 1e-9) / step);
  return Number((units * step).toFixed(digits));
}

export function estimatedLiquidationPrice(
  side: FuturesSide,
  entryPrice: number,
  leverage: number,
  maintenanceMarginRate: number,
): number {
  assertFinite(entryPrice, "entryPrice");
  assertFinite(leverage, "leverage");
  if (!Number.isFinite(maintenanceMarginRate)
    || maintenanceMarginRate <= 0
    || maintenanceMarginRate >= 1) {
    throw new Error("maintenanceMarginRate must be finite and inside (0, 1).");
  }
  // Isolated, one-way, cum=0 approximation:
  // initial margin + position PnL = maintenance rate × liquidation notional.
  // The signed bracket layer deliberately selects the highest applicable rate
  // and ignores Binance's positive `cum` deduction, so this remains the
  // conservative scalar estimate used by the sizing buffer.
  const ratio = side === "long"
    ? (1 - 1 / leverage) / (1 - maintenanceMarginRate)
    : (1 + 1 / leverage) / (1 + maintenanceMarginRate);
  return Math.max(0, entryPrice * ratio);
}

function positionPnl(position: FuturesPosition, markPrice: number): number {
  const sign = position.side === "long" ? 1 : -1;
  return sign * (markPrice - position.entryPrice) * position.quantity;
}

function liquidationBufferRate(position: FuturesPosition, markPrice: number): number {
  return markPrice > 0
    ? Math.abs(markPrice - position.estimatedLiquidationPrice) / markPrice
    : 0;
}

export class FuturesPaperLedger {
  private readonly initialCash: number;
  private readonly feeRate: number;
  private readonly slippageRate: number;
  private walletBalance: number;
  private realizedPnl = 0;
  private fees = 0;
  private slippage = 0;
  private funding = 0;
  private readonly positions = new Map<string, FuturesPosition>();
  private readonly quantitySteps = new Map<string, number>();
  private readonly priceTicks = new Map<string, number>();
  private readonly fills: FuturesPaperFill[] = [];
  private readonly fillIds = new Set<string>();
  private readonly clientOrderIds = new Set<string>();
  private readonly fundingEventIds = new Set<string>();
  private readonly lastFundingAt = new Map<string, number>();

  constructor(options: FuturesPaperLedgerOptions) {
    this.initialCash = assertFinite(options.initialCash, "initialCash");
    this.walletBalance = this.initialCash;
    const feeBps = options.feeBpsPerSide ?? 4;
    const slippageBps = options.slippageBpsPerSide ?? 1;
    assertFinite(feeBps, "feeBpsPerSide", 0, true);
    assertFinite(slippageBps, "slippageBpsPerSide", 0, true);
    this.feeRate = feeBps / 10_000;
    this.slippageRate = slippageBps / 10_000;
  }

  open(input: OpenFuturesPositionInput): FuturesPaperFill {
    this.assertIdentifiers(input.fillId, input.clientOrderId);
    if (input.rules.maintenanceMarginSource !== "binance_user_data_brackets") {
      throw new Error(
        "A signed Binance maintenance-margin bracket is required before opening a position.",
      );
    }
    if (input.leverage > input.rules.maximumInitialLeverage) {
      throw new Error("Paper leverage exceeds the signed Binance bracket cap.");
    }
    if (this.positions.has(input.rules.symbol)) {
      throw new Error("A symbol may have only one position and averaging is disabled.");
    }
    if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 15) {
      throw new Error("Paper leverage must be an integer between 1 and 15.");
    }
    this.assertCausalFill(input.decisionAt, input.executedAt);
    const quantity = floorToStep(input.quantity, input.rules.stepSize);
    if (quantity < input.rules.minQuantity || quantity <= 0) {
      throw new Error("Quantity is below the Binance step/minimum quantity.");
    }
    const observedPrice = assertFinite(input.observedPrice, "observedPrice");
    const direction = input.side === "long" ? 1 : -1;
    const price = input.side === "long"
      ? ceilToStep(observedPrice * (1 + direction * this.slippageRate), input.rules.tickSize)
      : floorToStep(observedPrice * (1 + direction * this.slippageRate), input.rules.tickSize);
    const notional = price * quantity;
    if (notional < input.rules.minNotional) {
      throw new Error("Order notional is below Binance minimum notional.");
    }
    if (notional * 2 > input.rules.maintenanceMarginMaximumNotional) {
      throw new Error(
        "Order notional exceeds half of the signed maintenance-margin lifetime coverage.",
      );
    }
    const markPrice = assertFinite(input.markPrice ?? observedPrice, "markPrice");
    const isolatedMargin = notional / input.leverage;
    const availableBefore = this.snapshot().availableBalance;
    const fee = notional * this.feeRate;
    if (isolatedMargin + fee > availableBefore) {
      throw new Error("Insufficient available balance for isolated margin.");
    }
    const liquidationPrice = estimatedLiquidationPrice(
      input.side,
      price,
      input.leverage,
      input.rules.maintenanceMarginRate,
    );
    const position: FuturesPosition = {
      symbol: input.rules.symbol,
      side: input.side,
      quantity,
      entryPrice: price,
      markPrice,
      leverage: input.leverage,
      isolatedMargin,
      maintenanceMargin: notional * input.rules.maintenanceMarginRate,
      maintenanceMarginRate: input.rules.maintenanceMarginRate,
      estimatedLiquidationPrice: liquidationPrice,
      liquidationBufferRate: 0,
      protectiveStopPrice: input.side === "long"
        ? floorToStep(
          assertFinite(input.protectiveStopPrice, "protectiveStopPrice"),
          input.rules.tickSize,
        )
        : ceilToStep(
          assertFinite(input.protectiveStopPrice, "protectiveStopPrice"),
          input.rules.tickSize,
        ),
      unrealizedPnl: 0,
      accruedFunding: 0,
      openedAt: input.executedAt,
    };
    if (input.side === "long" && position.protectiveStopPrice >= price) {
      throw new Error("Long protective stop must be below entry.");
    }
    if (input.side === "short" && position.protectiveStopPrice <= price) {
      throw new Error("Short protective stop must be above entry.");
    }
    position.unrealizedPnl = positionPnl(position, markPrice);
    position.liquidationBufferRate = liquidationBufferRate(position, markPrice);
    const slippageCost = Math.abs(price - observedPrice) * quantity;
    this.walletBalance -= fee;
    this.fees += fee;
    this.slippage += slippageCost;
    this.positions.set(position.symbol, position);
    this.quantitySteps.set(position.symbol, input.rules.stepSize);
    this.priceTicks.set(position.symbol, input.rules.tickSize);
    const fill: FuturesPaperFill = {
      fillId: input.fillId,
      clientOrderId: input.clientOrderId,
      symbol: input.rules.symbol,
      action: "open",
      side: input.side,
      quantity,
      price,
      notional,
      leverage: input.leverage,
      reduceOnly: false,
      realizedPnl: 0,
      fee,
      slippageCost,
      funding: 0,
      decisionAt: input.decisionAt,
      executedAt: input.executedAt,
    };
    this.recordFill(fill);
    return { ...fill };
  }

  reduce(input: ReduceFuturesPositionInput): FuturesPaperFill {
    this.assertIdentifiers(input.fillId, input.clientOrderId);
    if (input.reduceOnly !== true) {
      throw new Error("All opposite and closing orders must be reduce-only.");
    }
    this.assertCausalFill(input.decisionAt, input.executedAt);
    const position = this.positions.get(input.symbol);
    if (!position) throw new Error("Cannot reduce a missing position.");
    const quantity = floorToStep(input.quantity, this.quantityStep(position));
    if (quantity <= 0 || quantity > position.quantity) {
      throw new Error("Reduce-only quantity cannot exceed the open position.");
    }
    const observedPrice = assertFinite(input.observedPrice, "observedPrice");
    const closeDirection = position.side === "long" ? -1 : 1;
    const rawPrice = observedPrice * (1 + closeDirection * this.slippageRate);
    const priceTick = this.priceTicks.get(input.symbol) ?? Number.EPSILON;
    const price = position.side === "long"
      ? floorToStep(rawPrice, priceTick)
      : ceilToStep(rawPrice, priceTick);
    const notional = price * quantity;
    const sign = position.side === "long" ? 1 : -1;
    const realizedPnl = sign * (price - position.entryPrice) * quantity;
    const funding = position.accruedFunding * (quantity / position.quantity);
    const fee = notional * this.feeRate;
    const slippageCost = Math.abs(price - observedPrice) * quantity;
    this.walletBalance += realizedPnl - fee;
    this.realizedPnl += realizedPnl;
    this.fees += fee;
    this.slippage += slippageCost;
    const remaining = floorToStep(position.quantity - quantity, this.quantityStep(position));
    if (remaining <= 0) {
      this.positions.delete(input.symbol);
      this.quantitySteps.delete(input.symbol);
      this.priceTicks.delete(input.symbol);
    } else {
      const ratio = remaining / position.quantity;
      position.quantity = remaining;
      position.isolatedMargin *= ratio;
      position.maintenanceMargin *= ratio;
      position.accruedFunding -= funding;
      position.unrealizedPnl = positionPnl(position, position.markPrice);
      this.positions.set(input.symbol, position);
    }
    const fill: FuturesPaperFill = {
      fillId: input.fillId,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      action: "reduce",
      side: position.side,
      quantity,
      price,
      notional,
      leverage: position.leverage,
      reduceOnly: true,
      realizedPnl,
      fee,
      slippageCost,
      funding,
      ...(input.reason ? { reason: input.reason } : {}),
      decisionAt: input.decisionAt,
      executedAt: input.executedAt,
    };
    this.recordFill(fill);
    return { ...fill };
  }

  mark(symbol: string, markPrice: number, eventAt?: number): FuturesPosition | undefined {
    const position = this.positions.get(symbol);
    if (!position) return undefined;
    position.markPrice = assertFinite(markPrice, "markPrice");
    position.unrealizedPnl = positionPnl(position, position.markPrice);
    position.maintenanceMargin = position.markPrice
      * position.quantity
      * position.maintenanceMarginRate;
    position.liquidationBufferRate = liquidationBufferRate(position, position.markPrice);
    this.positions.set(symbol, position);
    const liquidated = position.side === "long"
      ? position.markPrice <= position.estimatedLiquidationPrice
      : position.markPrice >= position.estimatedLiquidationPrice;
    if (liquidated) {
      if (!Number.isSafeInteger(eventAt) || eventAt! <= position.openedAt) {
        throw new Error("A liquidation mark requires a causal eventAt.");
      }
      this.reduce({
        fillId: `liquidation:${symbol}:${eventAt}`,
        clientOrderId: `liq-${symbol.slice(0, 10)}-${eventAt}`,
        symbol,
        quantity: position.quantity,
        observedPrice: position.markPrice,
        decisionAt: position.openedAt,
        executedAt: eventAt!,
        reduceOnly: true,
        reason: "liquidation",
      });
      return undefined;
    }
    return { ...position };
  }

  applyFunding(input: {
    eventId: string;
    symbol: string;
    rate: number;
    eventAt: number;
  }): number {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(input.eventId)
      || this.fundingEventIds.has(input.eventId)) {
      throw new Error("funding eventId must be unique and bounded.");
    }
    if (!Number.isFinite(input.rate)) throw new Error("funding rate must be finite.");
    if (!Number.isSafeInteger(input.eventAt) || input.eventAt < 0) {
      throw new Error("eventAt is invalid.");
    }
    const previousAt = this.lastFundingAt.get(input.symbol);
    if (previousAt !== undefined && input.eventAt <= previousAt) {
      throw new Error("Funding events must be strictly time-ordered per symbol.");
    }
    const position = this.positions.get(input.symbol);
    if (position && input.eventAt <= position.openedAt) {
      throw new Error("Funding cannot be applied before a position is opened.");
    }
    this.fundingEventIds.add(input.eventId);
    this.lastFundingAt.set(input.symbol, input.eventAt);
    if (!position) return 0;
    const sign = position.side === "long" ? -1 : 1;
    const cashFlow = sign * position.markPrice * position.quantity * input.rate;
    this.walletBalance += cashFlow;
    this.funding += cashFlow;
    position.accruedFunding += cashFlow;
    this.positions.set(input.symbol, position);
    return cashFlow;
  }

  snapshot(): FuturesPaperLedgerSnapshot {
    const positions = Array.from(this.positions.values())
      .sort((left, right) => left.symbol.localeCompare(right.symbol))
      .map((position) => ({ ...position }));
    const unrealizedPnl = positions.reduce((sum, item) => sum + item.unrealizedPnl, 0);
    const grossExposure = positions.reduce(
      (sum, item) => sum + item.markPrice * item.quantity,
      0,
    );
    const totalIsolatedMargin = positions.reduce(
      (sum, item) => sum + item.isolatedMargin,
      0,
    );
    return {
      mode: "paper",
      marginMode: "isolated",
      positionMode: "one_way",
      initialCash: this.initialCash,
      walletBalance: this.walletBalance,
      availableBalance: this.walletBalance - totalIsolatedMargin,
      equity: this.walletBalance + unrealizedPnl,
      grossExposure,
      totalIsolatedMargin,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
      fees: this.fees,
      slippage: this.slippage,
      funding: this.funding,
      positions,
      fills: this.fills.map((fill) => ({ ...fill })),
    };
  }

  private quantityStep(position: FuturesPosition): number {
    return this.quantitySteps.get(position.symbol) ?? 1e-8;
  }

  private assertIdentifiers(fillId: string, clientOrderId: string): void {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(fillId) || this.fillIds.has(fillId)) {
      throw new Error("fillId must be unique and bounded.");
    }
    if (!/^[A-Za-z0-9._:-]{1,36}$/.test(clientOrderId)
      || this.clientOrderIds.has(clientOrderId)) {
      throw new Error("clientOrderId must be unique and bounded.");
    }
  }

  private assertCausalFill(decisionAt: number, executedAt: number): void {
    if (!Number.isSafeInteger(decisionAt) || !Number.isSafeInteger(executedAt)
      || executedAt <= decisionAt) {
      throw new Error("A fill must occur on an event strictly after its decision.");
    }
  }

  private recordFill(fill: FuturesPaperFill): void {
    this.fillIds.add(fill.fillId);
    this.clientOrderIds.add(fill.clientOrderId);
    this.fills.push(fill);
  }
}
