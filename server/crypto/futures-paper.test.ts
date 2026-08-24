import { describe, expect, it, vi } from "vitest";
import type { BinanceInstrumentRules } from "./contracts.js";
import {
  normalizeBinanceMaintenanceMarginSchedule,
  resolveConservativeMaintenanceMargin,
} from "./binance-maintenance-margin.js";
import {
  createConfiguredFuturesExecution,
  OfficialBinanceUsdmOrderTransport,
  type BinanceOfficialRestApi,
  type FuturesOrderRequest,
} from "./execution.js";
import {
  estimatedLiquidationPrice,
  FuturesPaperLedger,
} from "./futures-paper-ledger.js";
import {
  signalFromQuantileCdf,
  sizeFuturesPosition,
  updateDailyLossGate,
} from "./futures-risk.js";

const rules: BinanceInstrumentRules = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  marginAsset: "USDT",
  contractType: "PERPETUAL",
  onboardDate: 0,
  tickSize: 0.1,
  stepSize: 0.001,
  minQuantity: 0.001,
  minNotional: 5,
  maintenanceMarginRate: 0.004,
  maximumInitialLeverage: 125,
  maintenanceMarginMaximumNotional: 1_000_000,
  maintenanceMarginSource: "binance_user_data_brackets",
};

const request: FuturesOrderRequest = {
  runId: "run-1",
  clientOrderId: "order-1",
  symbol: "BTCUSDT",
  side: "BUY",
  quantity: 0.1,
  leverage: 3,
  reduceOnly: false,
  marginMode: "isolated",
  positionSide: "BOTH",
  modelLane: "chronos2_base",
  protectiveStopPrice: 95,
  typedConfirmation: "LIVE:run-1:BTCUSDT",
};

describe("futures paper execution and risk", () => {
  it("uses the isolated cum=0 liquidation equation for both directions", () => {
    expect(estimatedLiquidationPrice("long", 100, 10, 0.004))
      .toBeCloseTo(100 * 0.9 / 0.996, 12);
    expect(estimatedLiquidationPrice("short", 100, 10, 0.004))
      .toBeCloseTo(100 * 1.1 / 1.004, 12);
  });

  it("uses adverse tick rounding, isolated one-way positions, funding dedupe and liquidation reduce-only", () => {
    const ledger = new FuturesPaperLedger({
      initialCash: 10_000,
      feeBpsPerSide: 4,
      slippageBpsPerSide: 1,
    });
    const opened = ledger.open({
      fillId: "fill-open",
      clientOrderId: "paper-open",
      rules,
      side: "long",
      quantity: 1.2349,
      observedPrice: 100,
      leverage: 10,
      protectiveStopPrice: 95.05,
      decisionAt: 1_000,
      executedAt: 1_001,
    });
    expect(opened.price).toBe(100.1);
    expect(opened.quantity).toBe(1.234);
    expect(ledger.snapshot().positions[0]?.protectiveStopPrice).toBe(95);
    expect(() => ledger.open({
      fillId: "fill-average",
      clientOrderId: "paper-average",
      rules,
      side: "long",
      quantity: 1,
      observedPrice: 101,
      leverage: 3,
      protectiveStopPrice: 95,
      decisionAt: 2_000,
      executedAt: 2_001,
    })).toThrow("averaging");

    const funding = ledger.applyFunding({
      eventId: "funding-1",
      symbol: "BTCUSDT",
      rate: 0.001,
      eventAt: 2_000,
    });
    expect(funding).toBeLessThan(0);
    expect(ledger.snapshot().positions[0]?.accruedFunding).toBeCloseTo(funding, 12);
    expect(() => ledger.applyFunding({
      eventId: "funding-1",
      symbol: "BTCUSDT",
      rate: 0.001,
      eventAt: 2_001,
    })).toThrow("unique");

    const liquidationPrice = ledger.snapshot().positions[0]!.estimatedLiquidationPrice;
    expect(ledger.mark("BTCUSDT", liquidationPrice - 0.1, 3_000)).toBeUndefined();
    expect(ledger.snapshot().positions).toHaveLength(0);
    expect(ledger.snapshot().fills.at(-1)).toMatchObject({
      action: "reduce",
      reduceOnly: true,
      reason: "liquidation",
      funding,
    });
  });

  it("charges a nonzero exit tax on every reduce-only close and preserves its cost breakdown", () => {
    const ledger = new FuturesPaperLedger({
      initialCash: 10_000,
      feeBpsPerSide: 4,
      exitTaxBps: 10,
      slippageBpsPerSide: 0,
    });
    const opened = ledger.open({
      fillId: "tax-open-fill",
      clientOrderId: "tax-open-order",
      rules,
      side: "long",
      quantity: 1,
      observedPrice: 100,
      leverage: 3,
      protectiveStopPrice: 95,
      decisionAt: 1_000,
      executedAt: 1_001,
    });
    const closed = ledger.reduce({
      fillId: "tax-close-fill",
      clientOrderId: "tax-close-order",
      symbol: "BTCUSDT",
      quantity: 1,
      observedPrice: 110,
      decisionAt: 2_000,
      executedAt: 2_001,
      reduceOnly: true,
    });
    const snapshot = ledger.snapshot();

    expect(opened).toMatchObject({
      fee: 0.04,
      exitTax: 0,
    });
    expect(closed.exitTax).toBeCloseTo(0.11, 12);
    expect(closed.fee).toBeCloseTo(0.154, 12);
    expect(closed.realizedPnl).toBe(10);
    expect(snapshot).toMatchObject({
      realizedPnl: 10,
      exitTaxes: 0.11,
      positions: [],
    });
    expect(snapshot.fees).toBeCloseTo(0.194, 12);
    expect(snapshot.walletBalance).toBeCloseTo(10_009.806, 10);
    expect(snapshot.equity).toBeCloseTo(10_009.806, 10);
    expect(snapshot.equity - snapshot.initialCash).toBeCloseTo(
      closed.realizedPnl - opened.fee - closed.fee,
      10,
    );
  });

  it("sizes at 0.5% risk under exposure/margin/leverage and enforces a UTC 3% kill switch", () => {
    const sizing = sizeFuturesPosition({
      mode: "paper",
      side: "long",
      equity: 10_000,
      currentGrossExposure: 0,
      currentMargin: 0,
      price: 100,
      atr14: 1,
      adverseQuantileDistance: 2,
      spreadBps: 4,
      slippageBpsPerSide: 1,
      requestedLeverage: 15,
      rules,
    });
    expect(sizing.accepted).toBe(true);
    expect(sizing.riskBudget).toBe(50);
    expect(sizing.notional).toBeLessThanOrEqual(15_000);
    expect(sizing.isolatedMargin).toBeLessThanOrEqual(2_000);
    expect(sizing.liquidationBufferRate).toBeGreaterThanOrEqual(
      (sizing.protectiveStopDistance / 100) * 2,
    );

    const day = Date.parse("2026-07-25T00:00:00.000Z");
    const initial = updateDailyLossGate(undefined, 10_000, day);
    const blocked = updateDailyLossGate(initial, 9_700, day + 60_000);
    expect(blocked).toMatchObject({ blocked: true, closeAllReduceOnly: true });
    expect(updateDailyLossGate(blocked, 10_000, day + 86_400_000)).toMatchObject({
      blocked: false,
      drawdownRate: 0,
    });
    const insolvent = updateDailyLossGate(initial, -500, day + 120_000);
    expect(insolvent).toMatchObject({
      latestEquity: -500,
      drawdownRate: 1.05,
      blocked: true,
      closeAllReduceOnly: true,
    });
    expect(updateDailyLossGate(insolvent, -250, day + 180_000)).toMatchObject({
      blocked: true,
      closeAllReduceOnly: false,
    });
  });

  it("applies custom sizing caps and a custom UTC daily-loss threshold", () => {
    const sizing = sizeFuturesPosition({
      mode: "paper",
      side: "long",
      equity: 10_000,
      currentGrossExposure: 0,
      currentMargin: 0,
      price: 100,
      atr14: 1,
      adverseQuantileDistance: 2,
      spreadBps: 4,
      slippageBpsPerSide: 1,
      requestedLeverage: 15,
      limits: {
        riskPerTradeRate: 0.004,
        maximumLeverage: 4,
        grossExposureLimitRate: 0.8,
        marginUsageLimitRate: 0.1,
        liquidationBufferMultiple: 3,
      },
      rules,
    });
    expect(sizing).toMatchObject({
      accepted: true,
      leverage: 4,
      riskBudget: 40,
      notional: 2_000,
      isolatedMargin: 500,
      grossExposureLimit: 8_000,
      marginLimit: 1_000,
    });
    expect(sizing.liquidationBufferRate).toBeGreaterThanOrEqual(
      (sizing.protectiveStopDistance / 100) * 3,
    );
    expect(sizeFuturesPosition({
      ...({
        mode: "paper" as const,
        side: "long" as const,
        equity: 10_000,
        currentGrossExposure: 0,
        currentMargin: 0,
        price: 100,
        atr14: 1,
        adverseQuantileDistance: 2,
        spreadBps: 4,
        slippageBpsPerSide: 1,
        requestedLeverage: 15,
        rules,
      }),
      limits: {
        riskPerTradeRate: 0.005,
        maximumLeverage: 15,
        grossExposureLimitRate: 1.5,
        marginUsageLimitRate: 1,
        liquidationBufferMultiple: 2,
      },
    })).toMatchObject({
      accepted: true,
      marginLimit: 10_000,
    });

    const day = Date.parse("2026-07-25T00:00:00.000Z");
    const initial = updateDailyLossGate(undefined, 10_000, day, 0.02);
    const stillOpen = updateDailyLossGate(initial, 9_850, day + 60_000, 0.02);
    expect(stillOpen).toMatchObject({
      blocked: false,
      closeAllReduceOnly: false,
    });
    expect(stillOpen.drawdownRate).toBeCloseTo(0.015, 12);
    const blocked = updateDailyLossGate(stillOpen, 9_800, day + 120_000, 0.02);
    expect(blocked).toMatchObject({
      blocked: true,
      closeAllReduceOnly: true,
    });
    expect(blocked.drawdownRate).toBeCloseTo(0.02, 12);
    expect(updateDailyLossGate(blocked, 9_700, day + 180_000, 0.02)).toMatchObject({
      blocked: true,
      closeAllReduceOnly: false,
    });
  });

  it("rejects custom limits that would loosen the deployment hard envelope", () => {
    const base = {
      mode: "paper" as const,
      side: "long" as const,
      equity: 10_000,
      currentGrossExposure: 0,
      currentMargin: 0,
      price: 100,
      atr14: 1,
      adverseQuantileDistance: 2,
      spreadBps: 4,
      slippageBpsPerSide: 1,
      requestedLeverage: 15,
      rules,
    };
    for (const limits of [
      {
        riskPerTradeRate: 0.006,
        maximumLeverage: 15,
        grossExposureLimitRate: 1.5,
        marginUsageLimitRate: 0.2,
        liquidationBufferMultiple: 2,
      },
      {
        riskPerTradeRate: 0.005,
        maximumLeverage: 15,
        grossExposureLimitRate: 1.51,
        marginUsageLimitRate: 0.2,
        liquidationBufferMultiple: 2,
      },
      {
        riskPerTradeRate: 0.005,
        maximumLeverage: 15,
        grossExposureLimitRate: 1.5,
        marginUsageLimitRate: 1.01,
        liquidationBufferMultiple: 2,
      },
      {
        riskPerTradeRate: 0.005,
        maximumLeverage: 15,
        grossExposureLimitRate: 1.5,
        marginUsageLimitRate: 0.2,
        liquidationBufferMultiple: 1.9,
      },
    ]) {
      expect(sizeFuturesPosition({ ...base, limits })).toMatchObject({
        accepted: false,
        reason: "invalid_input",
      });
    }
    expect(() => updateDailyLossGate(
      undefined,
      10_000,
      Date.parse("2026-07-25T00:00:00.000Z"),
      0.031,
    )).toThrow("invalid");
  });

  it("fails closed when signed maintenance-margin brackets are unavailable", () => {
    const unavailableRules: BinanceInstrumentRules = {
      symbol: rules.symbol,
      baseAsset: rules.baseAsset,
      quoteAsset: rules.quoteAsset,
      marginAsset: rules.marginAsset,
      contractType: rules.contractType,
      onboardDate: rules.onboardDate,
      tickSize: rules.tickSize,
      stepSize: rules.stepSize,
      minQuantity: rules.minQuantity,
      minNotional: rules.minNotional,
      maintenanceMarginRate: 1,
      maintenanceMarginSource: "unavailable",
    };
    const sizing = sizeFuturesPosition({
      mode: "paper",
      side: "long",
      equity: 10_000,
      currentGrossExposure: 0,
      currentMargin: 0,
      price: 100,
      atr14: 1,
      adverseQuantileDistance: 2,
      spreadBps: 4,
      slippageBpsPerSide: 1,
      requestedLeverage: 3,
      rules: unavailableRules,
    });
    expect(sizing).toMatchObject({
      accepted: false,
      reason: "maintenance_margin_unavailable",
      quantity: 0,
      notional: 0,
    });

    const ledger = new FuturesPaperLedger({
      initialCash: 10_000,
      feeBpsPerSide: 4,
      slippageBpsPerSide: 1,
    });
    expect(() => ledger.open({
      fillId: "unavailable-bracket-fill",
      clientOrderId: "unavailable-bracket-order",
      rules: unavailableRules,
      side: "long",
      quantity: 1,
      observedPrice: 100,
      leverage: 3,
      protectiveStopPrice: 95,
      decisionAt: 1_000,
      executedAt: 1_001,
    })).toThrow("signed Binance maintenance-margin bracket");
  });

  it("caps leverage at the signed Binance bracket maximum", () => {
    const cappedRules: BinanceInstrumentRules = {
      ...rules,
      maximumInitialLeverage: 3,
      maintenanceMarginMaximumNotional: 500,
    };
    const sizing = sizeFuturesPosition({
      mode: "paper",
      side: "long",
      equity: 10_000,
      currentGrossExposure: 0,
      currentMargin: 0,
      price: 100,
      atr14: 1,
      adverseQuantileDistance: 2,
      spreadBps: 4,
      slippageBpsPerSide: 1,
      requestedLeverage: 15,
      rules: cappedRules,
    });
    expect(sizing.accepted).toBe(true);
    expect(sizing.leverage).toBeLessThanOrEqual(3);
    expect(sizing.grossExposureLimit).toBe(250);
    expect(sizing.notional).toBeLessThanOrEqual(250);

    const ledger = new FuturesPaperLedger({
      initialCash: 10_000,
      feeBpsPerSide: 4,
      slippageBpsPerSide: 1,
    });
    expect(() => ledger.open({
      fillId: "bracket-cap-fill",
      clientOrderId: "bracket-cap-order",
      rules: cappedRules,
      side: "long",
      quantity: 1,
      observedPrice: 100,
      leverage: 4,
      protectiveStopPrice: 95,
      decisionAt: 1_000,
      executedAt: 1_001,
    })).toThrow("signed Binance bracket cap");

    expect(() => ledger.open({
      fillId: "bracket-coverage-fill",
      clientOrderId: "bracket-coverage-order",
      rules: cappedRules,
      side: "long",
      quantity: 3,
      observedPrice: 100,
      leverage: 3,
      protectiveStopPrice: 95,
      decisionAt: 1_000,
      executedAt: 1_001,
    })).toThrow("maintenance-margin lifetime coverage");
  });

  it("keeps the higher bracket MMR through a short adverse-notional boundary", () => {
    const schedule = normalizeBinanceMaintenanceMarginSchedule({
      symbol: "BTCUSDT",
      brackets: [
        {
          bracket: 1,
          initialLeverage: 20,
          notionalFloor: 0,
          notionalCap: 160,
          maintMarginRatio: 0.004,
          cum: 0,
        },
        {
          bracket: 2,
          initialLeverage: 10,
          notionalFloor: 160,
          notionalCap: 1_000,
          maintMarginRatio: 0.01,
          cum: 0,
        },
      ],
    }, "BTCUSDT");
    const entryOnly = resolveConservativeMaintenanceMargin(schedule, 150);
    const lifetime = resolveConservativeMaintenanceMargin(schedule, 300);
    expect(entryOnly.maintenanceMarginRate).toBe(0.004);
    expect(lifetime).toMatchObject({
      maintenanceMarginRate: 0.01,
      maximumInitialLeverage: 10,
      maximumNotional: 300,
    });

    const lifetimeRules: BinanceInstrumentRules = {
      ...rules,
      maintenanceMarginRate: lifetime.maintenanceMarginRate,
      maximumInitialLeverage: lifetime.maximumInitialLeverage,
      maintenanceMarginMaximumNotional: lifetime.maximumNotional,
    };
    const ledger = new FuturesPaperLedger({
      initialCash: 100,
      feeBpsPerSide: 0,
      slippageBpsPerSide: 0,
    });
    ledger.open({
      fillId: "short-boundary-open",
      clientOrderId: "short-boundary-order",
      rules: lifetimeRules,
      side: "short",
      quantity: 1.5,
      observedPrice: 100,
      markPrice: 100,
      leverage: 3,
      protectiveStopPrice: 120,
      decisionAt: 1_000,
      executedAt: 1_001,
    });
    expect(ledger.snapshot().positions[0]).toMatchObject({
      side: "short",
      maintenanceMarginRate: 0.01,
      maintenanceMargin: 1.5,
    });

    ledger.mark("BTCUSDT", 110, 1_002);
    expect(ledger.snapshot().positions[0]).toMatchObject({
      markPrice: 110,
      maintenanceMarginRate: 0.01,
    });
    expect(ledger.snapshot().positions[0]!.maintenanceMargin).toBeCloseTo(1.65, 12);
    expect(ledger.snapshot().positions[0]!.quantity * 110).toBeGreaterThan(160);
  });

  it.each(["long", "short"] as const)(
    "sizes %s risk from the executable outward-rounded stop",
    (side) => {
      const coarseRules: BinanceInstrumentRules = {
        ...rules,
        tickSize: 5,
      };
      const sizing = sizeFuturesPosition({
        mode: "paper",
        side,
        equity: 10_000,
        currentGrossExposure: 0,
        currentMargin: 0,
        price: 100,
        atr14: 1,
        adverseQuantileDistance: 2,
        spreadBps: 4,
        slippageBpsPerSide: 1,
        requestedLeverage: 3,
        rules: coarseRules,
      });
      expect(sizing.accepted).toBe(true);
      expect(sizing.protectiveStopPrice).toBe(side === "long" ? 95 : 105);
      expect(sizing.protectiveStopDistance).toBe(5);
      expect(sizing.notional * sizing.protectiveStopDistance / 100)
        .toBeLessThanOrEqual(sizing.riskBudget);
      expect(sizing.liquidationBufferRate)
        .toBeGreaterThanOrEqual((sizing.protectiveStopDistance / 100) * 2);
    },
  );

  it("derives long/short probabilities from monotone quantiles and lowers leverage for wide spreads", () => {
    const signal = signalFromQuantileCdf({
      quantiles: [
        { quantile: 0.1, returnRate: -0.02 },
        { quantile: 0.5, returnRate: 0.01 },
        { quantile: 0.9, returnRate: 0.04 },
      ],
      roundTripCostRate: 0.002,
      realizedVolatilityRate: 0.005,
      spreadBps: 9,
    });
    expect(signal.direction).toBe("long");
    expect(signal.leverageTier).toBeLessThanOrEqual(2);
  });

  it("keeps configured execution paper-only", async () => {
    expect(createConfiguredFuturesExecution().status().realOrder).toBe(false);
    expect(() => createConfiguredFuturesExecution({ mode: "live" })).toThrow("paper-only");
  });

  it("releases paper order identity state by terminal run without touching other runs", async () => {
    const execution = createConfiguredFuturesExecution();
    await execution.submit(request);
    await execution.submit({
      ...request,
      runId: "run-2",
      clientOrderId: "order-2",
    });
    expect(await execution.reconcileUnknown("order-1", "BTCUSDT"))
      .toMatchObject({ status: "ACCEPTED" });
    expect(await execution.reconcileUnknown("order-2", "BTCUSDT"))
      .toMatchObject({ status: "ACCEPTED" });

    await execution.releaseRun?.("run-1");

    expect(await execution.reconcileUnknown("order-1", "BTCUSDT"))
      .toMatchObject({ status: "UNKNOWN" });
    expect(await execution.reconcileUnknown("order-2", "BTCUSDT"))
      .toMatchObject({ status: "ACCEPTED" });
    await expect(execution.submit(request)).resolves.toMatchObject({ status: "ACCEPTED" });
  });

  it("maps the official SDK transport to isolated market orders without retries", async () => {
    const response = (value: unknown) => ({ data: vi.fn().mockResolvedValue(value) });
    const rest: BinanceOfficialRestApi = {
      changeMarginType: vi.fn().mockRejectedValue({ code: -4046 }),
      changeInitialLeverage: vi.fn().mockResolvedValue(response({ leverage: 3 })),
      newOrder: vi.fn().mockResolvedValue(response({
        clientOrderId: "order-1",
        orderId: 123n,
        status: "FILLED",
      })),
      queryOrder: vi.fn().mockResolvedValue(response({
        clientOrderId: "order-1",
        orderId: 123n,
        status: "CANCELED",
      })),
      newAlgoOrder: vi.fn().mockResolvedValue(response({
        algoId: 456n,
        clientAlgoId: "order-1.SL",
        algoStatus: "NEW",
      })),
      queryAlgoOrder: vi.fn().mockResolvedValue(response({
        algoId: 456n,
        clientAlgoId: "order-1.SL",
        algoStatus: "NEW",
      })),
      positionInformationV2: vi.fn().mockResolvedValue(response([{
        symbol: "BTCUSDT",
        positionSide: "BOTH",
        positionAmt: "0.1",
        isolated: true,
      }])),
    };
    const official = new OfficialBinanceUsdmOrderTransport({
      environment: "testnet",
      apiKey: "api-value-1234567890",
      apiSecret: "secret-value-1234567890",
      rest,
    });
    await official.changeLeverage("BTCUSDT", 3);
    expect(rest.changeMarginType).toHaveBeenCalledTimes(1);
    expect(rest.changeInitialLeverage).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      leverage: 3,
    });
    expect(await official.submitOrder(request)).toEqual({
      clientOrderId: "order-1",
      status: "FILLED",
      venueOrderId: "123",
    });
    expect(rest.newOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "MARKET",
      positionSide: "BOTH",
      reduceOnly: "false",
      newClientOrderId: "order-1",
    }));
    expect(await official.queryOrder("BTCUSDT", "order-1")).toMatchObject({
      status: "CANCELLED",
    });
    await official.installProtectiveStop({
      symbol: "BTCUSDT",
      side: "SELL",
      quantity: 0.1,
      triggerPrice: 95,
      clientAlgoId: "protection-order-1",
      positionSide: "BOTH",
      reduceOnly: true,
    });
    expect(rest.newAlgoOrder).toHaveBeenCalledWith({
      algoType: "CONDITIONAL",
      symbol: "BTCUSDT",
      side: "SELL",
      type: "STOP_MARKET",
      positionSide: "BOTH",
      quantity: 0.1,
      triggerPrice: 95,
      workingType: "MARK_PRICE",
      priceProtect: "false",
      reduceOnly: "true",
      clientAlgoId: "protection-order-1",
      newOrderRespType: "RESULT",
    });
    expect(await official.queryProtectiveStop("protection-order-1")).toMatchObject({
      status: "ACTIVE",
    });
    expect(rest.queryAlgoOrder).toHaveBeenCalledWith({
      clientAlgoId: "protection-order-1",
    });
    expect(await official.queryPosition("BTCUSDT")).toEqual({
      symbol: "BTCUSDT",
      positionSide: "BOTH",
      positionAmount: 0.1,
      isolated: true,
    });
    expect(rest.newOrder).toHaveBeenCalledTimes(1);
    expect(rest.queryOrder).toHaveBeenCalledTimes(1);
    expect(rest.newAlgoOrder).toHaveBeenCalledTimes(1);
    expect(rest.queryAlgoOrder).toHaveBeenCalledTimes(1);
    expect(rest.positionInformationV2).toHaveBeenCalledTimes(1);
  });
});
