import { describe, expect, it, vi } from "vitest";
import type { BinanceRestMarketData } from "./binance-market-data.js";
import { BinanceUsdmScanner } from "./binance-scanner.js";

const NOW = Date.parse("2026-07-25T00:00:30.000Z");

function symbolInfo(symbol: string) {
  return {
    symbol,
    baseAsset: symbol.replace("USDT", ""),
    quoteAsset: "USDT",
    marginAsset: "USDT",
    contractType: "PERPETUAL",
    status: "TRADING",
    onboardDate: NOW - 30 * 86_400_000,
    maintMarginPercent: "0.4",
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.01" },
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
  };
}

function bars(gap = false) {
  return Array.from({ length: 62 }, (_, index) => {
    const adjusted = gap && index >= 40 ? index + 1 : index;
    const openTime = NOW - (63 - adjusted) * 60_000;
    const price = 100 + Math.sin(index / 3);
    return [
      openTime,
      String(price),
      String(price + 1),
      String(price - 1),
      String(price + 0.2),
      String(10 + index),
      openTime + 59_999,
      String((10 + index) * price),
      10,
      "0",
      "0",
      "0",
    ];
  });
}

function rest(input: { gap?: boolean } = {}): BinanceRestMarketData {
  return {
    exchangeInformation: vi.fn().mockResolvedValue({
      symbols: [symbolInfo("BTCUSDT")],
    }),
    tickers24h: vi.fn().mockResolvedValue([{
      symbol: "BTCUSDT",
      lastPrice: "100",
      priceChangePercent: "3",
      volume: "10000",
      quoteVolume: "1000000",
      closeTime: NOW,
    }]),
    bookTickers: vi.fn().mockResolvedValue([{
      symbol: "BTCUSDT",
      bidPrice: "99.99",
      bidQty: "10",
      askPrice: "100.01",
      askQty: "10",
      time: NOW,
    }]),
    klines: vi.fn().mockResolvedValue(bars(input.gap)),
  };
}

describe("Binance USDⓈ-M scanner", () => {
  it("returns a 60-second evidence snapshot and selects only available data", async () => {
    const scanner = new BinanceUsdmScanner({ rest: rest(), now: () => NOW });
    const snapshot = await scanner.candidates("volatility");
    expect(snapshot).toMatchObject({
      market: { kind: "crypto_futures", venue: "BINANCE_USDM" },
      scannerSnapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      criterion: "volatility",
      evidence: {
        universeSize: 1,
        spreadQualifiedSize: 1,
      },
    });
    expect(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.generatedAt)).toBe(60_000);
    expect(snapshot.candidates[0]).toMatchObject({
      symbol: "BTCUSDT",
      dataQuality: { status: "available", missingFields: [] },
    });
    expect((await scanner.selectionSnapshot("volatility")).selected.symbol).toBe("BTCUSDT");
  });

  it("exposes gap evidence as partial but fails closed for automatic selection", async () => {
    const scanner = new BinanceUsdmScanner({ rest: rest({ gap: true }), now: () => NOW });
    const snapshot = await scanner.candidates("volatility");
    expect(snapshot.candidates[0]?.dataQuality).toMatchObject({
      status: "partial",
      missingFields: expect.arrayContaining(["60m_realized_volatility"]),
      reasons: expect.arrayContaining([
        "60m realized-volatility window has a one-minute gap",
      ]),
    });
    expect(snapshot.candidates[0]?.realizedVolatility60m).toBe(0);
    await expect(scanner.selectionSnapshot("volatility")).rejects.toThrow(
      "No Binance USDⓈ-M candidate",
    );
  });

  it("uses relative volume—not incomparable raw base volume—for the volume ranking", async () => {
    const lowRelative = bars();
    const highRelative = bars();
    lowRelative.at(-1)![5] = "10";
    lowRelative.at(-1)![7] = "1000";
    highRelative.at(-1)![5] = "1000";
    highRelative.at(-1)![7] = "100000";
    const marketData: BinanceRestMarketData = {
      exchangeInformation: vi.fn().mockResolvedValue({
        symbols: [symbolInfo("BTCUSDT"), symbolInfo("ETHUSDT")],
      }),
      tickers24h: vi.fn().mockResolvedValue([
        {
          symbol: "BTCUSDT",
          lastPrice: "100",
          priceChangePercent: "3",
          volume: "100000000",
          quoteVolume: "2000000",
          closeTime: NOW,
        },
        {
          symbol: "ETHUSDT",
          lastPrice: "100",
          priceChangePercent: "3",
          volume: "10",
          quoteVolume: "1000000",
          closeTime: NOW,
        },
      ]),
      bookTickers: vi.fn().mockResolvedValue([
        {
          symbol: "BTCUSDT",
          bidPrice: "99.99",
          bidQty: "10",
          askPrice: "100.01",
          askQty: "10",
          time: NOW,
        },
        {
          symbol: "ETHUSDT",
          bidPrice: "99.99",
          bidQty: "10",
          askPrice: "100.01",
          askQty: "10",
          time: NOW,
        },
      ]),
      klines: vi.fn(async ({ symbol }) => (
        symbol === "ETHUSDT" ? highRelative : lowRelative
      )),
    };
    const snapshot = await new BinanceUsdmScanner({
      rest: marketData,
      now: () => NOW,
    }).candidates("volume");
    expect(snapshot.candidates.map(({ symbol }) => symbol)).toEqual([
      "ETHUSDT",
      "BTCUSDT",
    ]);
    expect(snapshot.candidates[0]!.relativeVolume)
      .toBeGreaterThan(snapshot.candidates[1]!.relativeVolume);
  });

  it("fails closed after a rate-limited refresh instead of resurrecting invalidated cache", async () => {
    const marketData = rest();
    const scanner = new BinanceUsdmScanner({
      rest: marketData,
      now: () => NOW,
    });
    expect((await scanner.selectionSnapshot("volatility")).selected.symbol).toBe("BTCUSDT");

    const rateLimited = Object.assign(new Error("Binance request rate limited"), {
      status: 429,
    });
    vi.mocked(marketData.exchangeInformation).mockRejectedValue(rateLimited);

    await expect(scanner.candidates("volatility", true)).rejects.toBe(rateLimited);
    await expect(scanner.selectionSnapshot("volatility")).rejects.toBe(rateLimited);
    expect(marketData.exchangeInformation).toHaveBeenCalledTimes(3);
  });
});
