import { createHash } from "node:crypto";
import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { setNoStore } from "../auth.js";
import type { PortfolioHistoryStore } from "../history.js";
import {
  buildReadOnlyMarketPath,
  MarketQueryError,
  type MarketQuery,
  type ReadOnlyMarketFeature,
} from "../market.js";
import { OrderHistoryQueryError, type OrderHistoryQuery } from "../orders.js";
import { normalizeCandlePage, TossApiError, type TossClient } from "../toss.js";

export type CompatibleApiDependencies = {
  authenticate: RequestHandler;
  toss: TossClient;
  historyStore: PortfolioHistoryStore;
  candleCacheLatestTtlMs: number;
};

function compatibleMarketQuery(request: Request): MarketQuery {
  const query: MarketQuery = {};
  for (const [key, value] of Object.entries(request.query)) {
    if (typeof value !== "string") {
      throw new MarketQueryError(`${key} 조회 조건의 형식이 올바르지 않습니다.`);
    }
    query[key] = value;
  }
  return query;
}

function compatibleApiError(response: Response, error: unknown, fallback: string): void {
  if (error instanceof MarketQueryError || error instanceof OrderHistoryQueryError) {
    response.status(400).json({ error: { code: "invalid-request", message: error.message } });
    return;
  }
  if (error instanceof TossApiError) {
    const status = [400, 404, 429].includes(error.status) ? error.status : 502;
    response.status(status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      },
    });
    return;
  }
  console.error("[compatible-api] 조회 실패:", error instanceof Error ? error.message : error);
  response.status(502).json({ error: { code: "upstream-unavailable", message: fallback } });
}

function compatibleAccountId(request: Request, response: Response): string | undefined {
  const accountId = request.get("X-Tossinvest-Account")?.trim() ?? "";
  if (!/^\d{1,19}$/.test(accountId)) {
    response.status(400).json({
      error: { code: "account-header-required", message: "X-Tossinvest-Account 헤더가 필요합니다." },
    });
    return undefined;
  }
  return accountId;
}

export function createCompatibleApiRouter({
  authenticate,
  toss,
  historyStore,
  candleCacheLatestTtlMs,
}: CompatibleApiDependencies): Router {
  const router = Router();

  async function compatibleMarket(
    feature: ReadOnlyMarketFeature,
    request: Request,
    response: Response,
    pathQuery: MarketQuery = {},
  ): Promise<void> {
    setNoStore(response);
    try {
      const query = { ...compatibleMarketQuery(request), ...pathQuery };
      if (feature === "candles" || feature === "indicator-candles") {
        const requestPath = buildReadOnlyMarketPath(feature, query);
        const requestKey = createHash("sha256").update(`${feature}\n${requestPath}`).digest("hex");
        const cached = await historyStore.getCachedCandleResponse(requestKey);
        if (cached !== undefined) {
          response.setHeader("X-Portfolio-Candle-Cache", "HIT");
          response.json(cached);
          return;
        }
        const result = await toss.getReadOnlyMarketData(feature, query);
        const fetchedAt = Date.now();
        const symbol = String(query.symbol).toUpperCase();
        const interval = query.interval as "1m" | "1d";
        const adjusted = feature === "candles" && query.adjusted === "true";
        const page = normalizeCandlePage(result.data, symbol);
        const expiresAt = query.before ? 0 : fetchedAt + candleCacheLatestTtlMs;
        try {
          await historyStore.cacheCandleResponse({
            requestKey,
            feature,
            requestPath,
            source: feature === "indicator-candles" ? "indicator" : "stock",
            symbol,
            interval,
            adjusted,
            payload: result.data,
            candles: page.candles,
            fetchedAt,
            expiresAt,
          });
        } catch (cacheError) {
          console.warn(
            "[candle-cache] candle 응답을 저장하지 못했습니다:",
            cacheError instanceof Error ? cacheError.message : cacheError,
          );
        }
        response.setHeader("X-Portfolio-Candle-Cache", "MISS");
        response.json(result.data);
        return;
      }
      const result = await toss.getReadOnlyMarketData(feature, query);
      response.json(result.data);
    } catch (error) {
      compatibleApiError(response, error, "토스증권 시장 데이터를 불러오지 못했습니다.");
    }
  }

  const marketRoutes: Array<{ path: string; feature: ReadOnlyMarketFeature }> = [
    { path: "/api/v1/orderbook", feature: "orderbook" },
    { path: "/api/v1/prices", feature: "prices" },
    { path: "/api/v1/trades", feature: "trades" },
    { path: "/api/v1/price-limits", feature: "price-limits" },
    { path: "/api/v1/candles", feature: "candles" },
    { path: "/api/v1/stocks", feature: "stocks" },
    { path: "/api/v1/exchange-rate", feature: "exchange-rate" },
    { path: "/api/v1/rankings", feature: "rankings" },
    { path: "/api/v1/market-indicators/prices", feature: "indicator-prices" },
  ];

  for (const route of marketRoutes) {
    router.get(route.path, authenticate, (request, response) => (
      compatibleMarket(route.feature, request, response)
    ));
  }

  router.get("/api/v1/stocks/:symbol/warnings", authenticate, (request, response) => (
    compatibleMarket("warnings", request, response, { symbol: String(request.params.symbol ?? "") })
  ));
  router.get("/api/v1/market-calendar/:country", authenticate, (request, response) => (
    compatibleMarket("market-calendar", request, response, { country: String(request.params.country ?? "") })
  ));
  router.get("/api/v1/market-indicators/:symbol/candles", authenticate, (request, response) => (
    compatibleMarket("indicator-candles", request, response, { symbol: String(request.params.symbol ?? "") })
  ));
  router.get("/api/v1/market-indicators/:symbol/investor-trading", authenticate, (request, response) => (
    compatibleMarket("investor-trading", request, response, { symbol: String(request.params.symbol ?? "") })
  ));

  router.get("/api/v1/accounts", authenticate, async (_request, response) => {
    setNoStore(response);
    try {
      response.json(await toss.getCompatibleAccounts());
    } catch (error) {
      compatibleApiError(response, error, "토스증권 계좌 목록을 불러오지 못했습니다.");
    }
  });

  router.get("/api/v1/holdings", authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = compatibleAccountId(request, response);
    if (!accountId) return;
    try {
      response.json(await toss.getCompatibleHoldings(accountId));
    } catch (error) {
      compatibleApiError(response, error, "토스증권 보유 자산을 불러오지 못했습니다.");
    }
  });

  router.get("/api/v1/orders", authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = compatibleAccountId(request, response);
    if (!accountId) return;
    try {
      response.json(await toss.getCompatibleOrders(
        accountId,
        compatibleMarketQuery(request) as OrderHistoryQuery,
      ));
    } catch (error) {
      compatibleApiError(response, error, "토스증권 거래 내역을 불러오지 못했습니다.");
    }
  });

  router.get("/api/v1/orders/:orderId", authenticate, async (request, response) => {
    setNoStore(response);
    const accountId = compatibleAccountId(request, response);
    if (!accountId) return;
    try {
      response.json(await toss.getCompatibleOrder(
        accountId,
        String(request.params.orderId ?? ""),
        compatibleMarketQuery(request) as OrderHistoryQuery,
      ));
    } catch (error) {
      compatibleApiError(response, error, "토스증권 거래 상세를 불러오지 못했습니다.");
    }
  });

  router.all("/api/v1/{*path}", authenticate, (_request, response) => {
    setNoStore(response);
    response.status(404).json({
      error: {
        code: "operation-not-supported",
        message: "이 호환 API는 허용된 조회 전용 기능만 제공합니다.",
      },
    });
  });

  return router;
}
