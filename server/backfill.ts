import {
  kstDateString,
  type BackfillStatus,
  type HistoricalSnapshot,
  type HistoryCurrency,
  PortfolioHistoryStore,
} from "./history.js";
import type {
  HistoricalOrder,
  Holding,
  InstrumentInfo,
  TossClient,
} from "./toss.js";

const API_PACING_MS = 230;
const QUANTITY_EPSILON = 0.000001;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function eachDate(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function tradeDate(order: HistoricalOrder): string {
  const timestamp = order.filledAt || order.orderedAt;
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime()) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) {
    return kstDateString(parsed);
  }
  return timestamp.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
}

function inferredCurrency(symbol: string, currency: string, holdings: Holding[]): HistoryCurrency {
  const normalized = currency.toUpperCase();
  if (normalized === "KRW" || normalized === "USD") return normalized;
  const holding = holdings.find((candidate) => candidate.symbol === symbol);
  if (holding?.currency === "USD") return "USD";
  if (holding?.currency === "KRW") return "KRW";
  return /^\d{6}$/.test(symbol) ? "KRW" : "USD";
}

export function instrumentKey(currency: string, symbol: string): string {
  return `${currency}:${symbol}`;
}

function currentHoldingsByKey(holdings: Holding[]): Map<string, Holding> {
  return new Map(
    holdings
      .filter((holding) => holding.currency === "KRW" || holding.currency === "USD")
      .map((holding) => [instrumentKey(holding.currency, holding.symbol), holding]),
  );
}

export type ReconstructionResult = {
  snapshots: HistoricalSnapshot[];
  reconciledSymbols: number;
  discrepancySymbols: number;
};

export function reconstructDailyPortfolio({
  orders,
  currentHoldings,
  instruments,
  prices,
  fromDate,
  toDate,
}: {
  orders: HistoricalOrder[];
  currentHoldings: Holding[];
  instruments: Map<string, InstrumentInfo>;
  prices: Map<string, Map<string, number>>;
  fromDate: string;
  toDate: string;
}): ReconstructionResult {
  const normalizedOrders = orders
    .filter((order) => order.symbol && order.filledQuantity > 0 && tradeDate(order))
    .map((order) => ({
      ...order,
      currency: inferredCurrency(order.symbol, order.currency, currentHoldings),
    }))
    .sort((left, right) => {
      const leftTime = left.filledAt || left.orderedAt;
      const rightTime = right.filledAt || right.orderedAt;
      return leftTime.localeCompare(rightTime) || left.orderId.localeCompare(right.orderId);
    });
  const current = currentHoldingsByKey(currentHoldings);
  const keys = new Set<string>([
    ...normalizedOrders.map((order) => instrumentKey(order.currency, order.symbol)),
    ...current.keys(),
  ]);

  const netQuantities = new Map<string, number>();
  for (const order of normalizedOrders) {
    const key = instrumentKey(order.currency, order.symbol);
    const direction = order.side === "SELL" ? -1 : 1;
    netQuantities.set(key, (netQuantities.get(key) ?? 0) + direction * order.filledQuantity);
  }

  const quantities = new Map<string, number>();
  let discrepancySymbols = 0;
  for (const key of keys) {
    const currentQuantity = current.get(key)?.quantity ?? 0;
    const baseline = currentQuantity - (netQuantities.get(key) ?? 0);
    if (Math.abs(baseline) > QUANTITY_EPSILON) discrepancySymbols += 1;
    quantities.set(key, baseline);
  }

  const ordersByDate = new Map<string, typeof normalizedOrders>();
  for (const order of normalizedOrders) {
    const date = tradeDate(order);
    const dailyOrders = ordersByDate.get(date) ?? [];
    dailyOrders.push(order);
    ordersByDate.set(date, dailyOrders);
  }

  const lastPrices = new Map<string, number>();
  const snapshots: HistoricalSnapshot[] = [];
  if (fromDate > toDate) {
    return { snapshots, reconciledSymbols: keys.size - discrepancySymbols, discrepancySymbols };
  }

  for (const date of eachDate(fromDate, toDate)) {
    for (const order of ordersByDate.get(date) ?? []) {
      const key = instrumentKey(order.currency, order.symbol);
      const direction = order.side === "SELL" ? -1 : 1;
      quantities.set(key, (quantities.get(key) ?? 0) + direction * order.filledQuantity);
      if (order.averageFilledPrice > 0) lastPrices.set(key, order.averageFilledPrice);
    }
    for (const key of keys) {
      const closePrice = prices.get(key)?.get(date);
      if (closePrice && closePrice > 0) lastPrices.set(key, closePrice);
    }

    const items: HistoricalSnapshot["items"] = [];
    for (const key of keys) {
      const quantity = quantities.get(key) ?? 0;
      const closePrice = lastPrices.get(key) ?? 0;
      if (quantity <= QUANTITY_EPSILON || closePrice <= 0) continue;
      const instrument = instruments.get(key);
      const separator = key.indexOf(":");
      const currency = key.slice(0, separator) as HistoryCurrency;
      const symbol = key.slice(separator + 1);
      const evaluationAmount = quantity * closePrice;
      if (!Number.isFinite(evaluationAmount) || evaluationAmount <= 0) continue;
      items.push({
        symbol,
        name: instrument?.name || current.get(key)?.name || symbol,
        market: instrument?.market || current.get(key)?.market || (currency === "USD" ? "미국" : "KRX"),
        currency,
        evaluationAmount,
      });
    }
    snapshots.push({
      date,
      capturedAt: Date.parse(`${date}T14:59:59.999Z`),
      items,
    });
  }

  return {
    snapshots,
    reconciledSymbols: keys.size - discrepancySymbols,
    discrepancySymbols,
  };
}

function messageForResult(discrepancySymbols: number, failedSymbols: number, metadataFailed: boolean): string {
  const notes: string[] = [];
  if (discrepancySymbols > 0) {
    notes.push(`현재 보유량과 체결 합계가 다른 ${discrepancySymbols}개 종목은 현재 보유량을 기준으로 보정했습니다.`);
  }
  if (failedSymbols > 0) notes.push(`${failedSymbols}개 종목의 일부 일봉을 가져오지 못해 체결가 또는 최근 종가를 사용했습니다.`);
  if (metadataFailed) notes.push("일부 종목 정보는 보유 정보 또는 종목 코드로 표시합니다.");
  return notes.join(" ") || "전체 체결 내역과 일봉을 SQLite에 저장하고 일별 포트폴리오를 복원했습니다.";
}

export class HistoricalPortfolioBackfill {
  private readonly running = new Map<string, Promise<BackfillStatus>>();

  constructor(
    private readonly toss: TossClient,
    private readonly store: PortfolioHistoryStore,
  ) {}

  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  getStatus(accountId: string): BackfillStatus {
    return this.store.getBackfillStatus(accountId);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(Array.from(this.running.values()));
  }

  start(accountId: string, force = false): boolean {
    if (this.running.has(accountId)) return false;
    const task = this.run(accountId, force).finally(() => this.running.delete(accountId));
    this.running.set(accountId, task);
    return true;
  }

  async runAll(force = false): Promise<void> {
    const accounts = await this.toss.getAccounts(true);
    for (const account of accounts) {
      if (this.running.has(account.id)) {
        await this.running.get(account.id);
        continue;
      }
      const task = this.run(account.id, force).finally(() => this.running.delete(account.id));
      this.running.set(account.id, task);
      await task;
    }
  }

  private async run(accountId: string, force: boolean): Promise<BackfillStatus> {
    const today = kstDateString(new Date());
    const yesterday = addDays(today, -1);
    const previous = this.store.getBackfillStatus(accountId);
    if (
      !force
      && (previous.status === "complete" || previous.status === "partial")
      && previous.lastBackfilledDate
      && previous.lastBackfilledDate >= yesterday
      && !this.store.hasIncompleteDailyOhlc()
    ) {
      return previous;
    }

    const startedAt = new Date().toISOString();
    this.store.updateBackfillStatus(accountId, {
      status: "running",
      phase: "orders",
      startedAt,
      completedAt: undefined,
      firstTradeDate: undefined,
      lastBackfilledDate: undefined,
      ordersImported: 0,
      symbolsTotal: 0,
      symbolsProcessed: 0,
      pricesImported: 0,
      snapshotsCreated: 0,
      reconciledSymbols: 0,
      discrepancySymbols: 0,
      failedSymbols: 0,
      message: "전체 체결 내역을 불러오는 중입니다.",
    });

    try {
      const portfolio = await this.toss.getPortfolio(accountId, true, false);
      const fetchedOrders: HistoricalOrder[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 200; pageIndex += 1) {
        if (pageIndex > 0) await sleep(API_PACING_MS);
        const page = await this.toss.getClosedOrders(accountId, cursor);
        fetchedOrders.push(...page.orders);
        this.store.updateBackfillStatus(accountId, {
          ordersImported: fetchedOrders.length,
          message: `체결 내역 ${fetchedOrders.length.toLocaleString("ko-KR")}건을 확인했습니다.`,
        });
        if (!page.hasNext) break;
        if (!page.nextCursor || cursors.has(page.nextCursor)) {
          throw new Error("체결 내역 페이지 커서가 반복되어 수집을 중단했습니다.");
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
        if (pageIndex === 199) throw new Error("체결 내역 페이지 수가 안전 한도를 초과했습니다.");
      }
      const uniqueOrders = Array.from(new Map(fetchedOrders.map((order) => [order.orderId, order])).values());
      this.store.upsertOrders(accountId, uniqueOrders);

      const filledOrders = uniqueOrders.filter((order) => order.symbol && order.filledQuantity > 0 && tradeDate(order));
      const dates = filledOrders.map(tradeDate).filter(Boolean).sort();
      const firstTradeDate = dates[0];
      if (!firstTradeDate) {
        const completedAt = new Date().toISOString();
        return this.store.updateBackfillStatus(accountId, {
          status: "partial",
          phase: "complete",
          completedAt,
          lastBackfilledDate: yesterday,
          message: "체결된 주문이 없어 과거 포트폴리오 시작일을 확인할 수 없습니다.",
        });
      }

      const normalizedOrders = filledOrders.map((order) => ({
        ...order,
        currency: inferredCurrency(order.symbol, order.currency, portfolio.holdings),
      }));
      const current = currentHoldingsByKey(portfolio.holdings);
      const keys = Array.from(new Set([
        ...normalizedOrders.map((order) => instrumentKey(order.currency, order.symbol)),
        ...current.keys(),
      ])).sort();
      const symbols = Array.from(new Set(keys.map((key) => key.slice(key.indexOf(":") + 1))));
      this.store.updateBackfillStatus(accountId, {
        phase: "instruments",
        firstTradeDate,
        symbolsTotal: keys.length,
        message: `${keys.length.toLocaleString("ko-KR")}개 종목 정보를 확인하는 중입니다.`,
      });

      let remoteInstruments: InstrumentInfo[] = [];
      let metadataFailed = false;
      try {
        remoteInstruments = await this.toss.getInstruments(symbols);
      } catch (error) {
        metadataFailed = true;
        console.warn("[backfill] 종목 정보 조회 실패:", error instanceof Error ? error.message : error);
      }
      const remoteBySymbol = new Map(remoteInstruments.map((instrument) => [instrument.symbol, instrument]));
      const instruments = new Map<string, InstrumentInfo>();
      for (const key of keys) {
        const separator = key.indexOf(":");
        const currency = key.slice(0, separator);
        const symbol = key.slice(separator + 1);
        const holding = current.get(key);
        const remote = remoteBySymbol.get(symbol);
        instruments.set(key, {
          symbol,
          name: holding?.name || remote?.name || symbol,
          market: holding?.market || remote?.market || (currency === "USD" ? "미국" : "KRX"),
          currency,
        });
      }
      this.store.upsertInstruments(Array.from(instruments.values()));

      let pricesImported = 0;
      let symbolsProcessed = 0;
      let failedSymbols = 0;
      this.store.updateBackfillStatus(accountId, {
        phase: "prices",
        message: `일봉을 불러오는 중입니다 · 0/${keys.length}`,
      });
      for (const key of keys) {
        const symbol = key.slice(key.indexOf(":") + 1);
        const cachedFirstDate = this.store.getEarliestDailyPriceDate(key);
        const cachedLastDate = this.store.getLatestDailyPriceDate(key);
        const cacheCoversHistory = Boolean(
          cachedFirstDate
          && cachedFirstDate <= firstTradeDate
          && !this.store.hasIncompleteDailyOhlc(key),
        );
        const seenBefore = new Set<string>();
        let before: string | undefined;
        try {
          for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
            await sleep(API_PACING_MS);
            const page = await this.toss.getDailyCandles(symbol, before);
            pricesImported += this.store.upsertDailyPrices(key, page.candles);
            const oldestDate = page.candles.map((candle) => candle.date).sort()[0];
            const reachedCache = cacheCoversHistory
              && cachedLastDate
              && page.candles.some((candle) => candle.date <= cachedLastDate);
            if (
              !page.nextBefore
              || !page.candles.length
              || reachedCache
              || (oldestDate && oldestDate <= firstTradeDate)
            ) break;
            if (seenBefore.has(page.nextBefore)) throw new Error("일봉 페이지 커서가 반복되었습니다.");
            seenBefore.add(page.nextBefore);
            before = page.nextBefore;
            if (pageIndex === 99) throw new Error("일봉 페이지 수가 안전 한도를 초과했습니다.");
          }
        } catch (error) {
          failedSymbols += 1;
          console.warn("[backfill] 일봉 조회 실패:", error instanceof Error ? error.message : error);
        }
        symbolsProcessed += 1;
        this.store.updateBackfillStatus(accountId, {
          symbolsProcessed,
          pricesImported,
          failedSymbols,
          message: `일봉을 불러오는 중입니다 · ${symbolsProcessed}/${keys.length}`,
        });
      }

      this.store.updateBackfillStatus(accountId, {
        phase: "reconstructing",
        message: "일 단위 포트폴리오를 계산해 SQLite에 저장하는 중입니다.",
      });
      const priceMap = this.store.getDailyPrices(keys, firstTradeDate, yesterday);
      const reconstruction = reconstructDailyPortfolio({
        orders: normalizedOrders,
        currentHoldings: portfolio.holdings,
        instruments,
        prices: priceMap,
        fromDate: firstTradeDate,
        toDate: yesterday,
      });
      const snapshotsCreated = this.store.replaceHistoricalSnapshots(
        accountId,
        reconstruction.snapshots,
        today,
      );
      this.store.recordPortfolio(portfolio);

      const partial = reconstruction.discrepancySymbols > 0 || failedSymbols > 0 || metadataFailed;
      const completedAt = new Date().toISOString();
      const result = this.store.updateBackfillStatus(accountId, {
        status: partial ? "partial" : "complete",
        phase: "complete",
        completedAt,
        firstTradeDate,
        lastBackfilledDate: yesterday,
        ordersImported: uniqueOrders.length,
        symbolsTotal: keys.length,
        symbolsProcessed,
        pricesImported,
        snapshotsCreated,
        reconciledSymbols: reconstruction.reconciledSymbols,
        discrepancySymbols: reconstruction.discrepancySymbols,
        failedSymbols,
        message: messageForResult(reconstruction.discrepancySymbols, failedSymbols, metadataFailed),
      });
      console.info(
        `[backfill] 완료: 주문 ${uniqueOrders.length}건, 종목 ${keys.length}개, 스냅샷 ${snapshotsCreated}일`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "과거 데이터 수집 중 알 수 없는 오류가 발생했습니다.";
      console.error("[backfill] 과거 데이터 수집 실패:", message);
      return this.store.updateBackfillStatus(accountId, {
        status: "error",
        completedAt: new Date().toISOString(),
        message,
      });
    }
  }
}
