import { describe, expect, it } from "vitest";
import type { BinanceInstrumentRules } from "./contracts.js";
import { FuturesPaperLedger } from "./futures-paper-ledger.js";

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

describe("FuturesPaperLedger hot-path accessors", () => {
  it("matches full snapshot values without exposing mutable ledger state", () => {
    const ledger = new FuturesPaperLedger({ initialCash: 10_000 });
    ledger.open({
      fillId: "fill-open",
      clientOrderId: "paper-open",
      rules,
      side: "long",
      quantity: 1,
      observedPrice: 100,
      leverage: 5,
      protectiveStopPrice: 95,
      decisionAt: 1_000,
      executedAt: 1_001,
    });
    ledger.mark("BTCUSDT", 105, 2_000);

    const snapshot = ledger.snapshot();
    expect(ledger.accountState()).toEqual({
      initialCash: snapshot.initialCash,
      walletBalance: snapshot.walletBalance,
      availableBalance: snapshot.availableBalance,
      equity: snapshot.equity,
      grossExposure: snapshot.grossExposure,
      totalIsolatedMargin: snapshot.totalIsolatedMargin,
      realizedPnl: snapshot.realizedPnl,
      unrealizedPnl: snapshot.unrealizedPnl,
      fees: snapshot.fees,
      exitTaxes: snapshot.exitTaxes,
      slippage: snapshot.slippage,
      funding: snapshot.funding,
    });
    expect(ledger.equity).toBe(snapshot.equity);
    expect(ledger.fillCount).toBe(snapshot.fills.length);
    expect(ledger.positionCount).toBe(snapshot.positions.length);
    expect(ledger.hasPosition("BTCUSDT")).toBe(true);

    const position = ledger.position("BTCUSDT")!;
    position.quantity = 999;
    const fills = ledger.fillsFrom(0);
    fills[0]!.quantity = 999;
    expect(ledger.position("BTCUSDT")?.quantity).toBe(1);
    expect(ledger.fillsFrom(0)[0]?.quantity).toBe(1);
  });

  it("keeps multi-symbol floating-point aggregation in snapshot symbol order", () => {
    const ledger = new FuturesPaperLedger({ initialCash: 1_000_000, feeBpsPerSide: 0 });
    const ethRules: BinanceInstrumentRules = {
      ...rules,
      symbol: "ETHUSDT",
      baseAsset: "ETH",
    };
    ledger.open({
      fillId: "eth-open",
      clientOrderId: "eth-open",
      rules: ethRules,
      side: "long",
      quantity: 1.337,
      observedPrice: 3_141.5,
      leverage: 5,
      protectiveStopPrice: 3_000,
      decisionAt: 1_000,
      executedAt: 1_001,
    });
    ledger.open({
      fillId: "btc-open",
      clientOrderId: "btc-open",
      rules,
      side: "short",
      quantity: 0.137,
      observedPrice: 98_765.4,
      leverage: 4,
      protectiveStopPrice: 110_000,
      decisionAt: 2_000,
      executedAt: 2_001,
    });
    ledger.mark("ETHUSDT", 3_217.8, 3_000);
    ledger.mark("BTCUSDT", 97_654.3, 3_001);

    const snapshot = ledger.snapshot();
    const account = ledger.accountState();
    expect(snapshot.positions.map(({ symbol }) => symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(account.equity).toBe(snapshot.equity);
    expect(account.unrealizedPnl).toBe(snapshot.unrealizedPnl);
    expect(account.grossExposure).toBe(snapshot.grossExposure);
    expect(account.totalIsolatedMargin).toBe(snapshot.totalIsolatedMargin);
    expect(ledger.equity).toBe(snapshot.equity);
  });
});
