import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearSessionCookie,
  createSessionCookie,
  hasValidReadOnlyApiSecret,
  hasValidSession,
  passwordsMatch,
  setNoStore,
} from "./auth.js";
import {
  analysisStartDate,
  analysisToday,
  parseBenchmarkKeys,
  PortfolioAnalysisService,
  type AnalysisRange,
} from "./analysis.js";
import { HistoricalPortfolioBackfill } from "./backfill.js";
import { BacktestValidationError } from "./backtest-engine.js";
import {
  PortfolioBacktestService,
  type BacktestAssetInput,
  type BacktestBenchmarkKey,
  type BacktestRunRequest,
} from "./backtest.js";
import { loadConfig } from "./env.js";
import { BedrockReportWriter } from "./bedrock-report-ai.js";
import {
  isHistoryDate,
  type HistoryCurrency,
  type HistoryRange,
} from "./history.js";
import {
  MarketQueryError,
  type MarketQuery,
  type ReadOnlyMarketFeature,
} from "./market.js";
import { OrderHistoryQueryError, type OrderHistoryQuery } from "./orders.js";
import { OpenAiReportWriter, ReportGenerationError } from "./report-ai.js";
import { createReportStorage } from "./report-storage.js";
import { isReportId, PortfolioReportService } from "./reports.js";
import { openConfiguredHistoryStore } from "./storage.js";
import { TossApiError, TossClient } from "./toss.js";

const config = loadConfig();
const toss = new TossClient(config);
const historyStore = await openConfiguredHistoryStore(config);
const historicalBackfill = new HistoricalPortfolioBackfill(toss, historyStore);
const portfolioAnalysis = new PortfolioAnalysisService(toss, historyStore);
const portfolioBacktest = new PortfolioBacktestService(toss, historyStore);
const reportStorage = createReportStorage(config.reportStorage);
const reportWriter = config.bedrock
  ? new BedrockReportWriter(config.bedrock)
  : config.openAi
    ? new OpenAiReportWriter(config.openAi)
    : undefined;
const portfolioReports = new PortfolioReportService(
  reportStorage,
  config.publicAppUrl,
  reportWriter,
);
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDirectory = path.resolve(__dirname, "../client");
const secureSessionCookie = new URL(config.publicAppUrl).protocol === "https:";

type AttemptState = {
  count: number;
  resetAt: number;
};

const loginAttempts = new Map<string, AttemptState>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (request.path.startsWith("/reports/") || request.path.startsWith("/api/reports/")) {
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  next();
});

function clientIp(request: Request): string {
  return request.socket.remoteAddress || "unknown";
}

function requireSession(request: Request, response: Response, next: NextFunction): void {
  if (!hasValidSession(request, config.sessionSecret)) {
    setNoStore(response);
    response.status(401).json({ error: { code: "authentication-required", message: "로그인이 필요합니다." } });
    return;
  }
  next();
}

function requireReadOnlyApiToken(request: Request, response: Response, next: NextFunction): void {
  if (!hasValidReadOnlyApiSecret(request.get("authorization"), config.dashboardPassword)) {
    setNoStore(response);
    response.status(401).json({
      error: { code: "invalid-token", message: "DASHBOARD_PASSWORD Bearer 토큰이 필요합니다." },
    });
    return;
  }
  next();
}

app.get("/api/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "portfolio-lens",
    storage: historyStore.backend,
    reportStorage: portfolioReports.storageBackend,
    reportGeneration: portfolioReports.generationConfigured ? "configured" : "unavailable",
  });
});

app.get("/api/auth/session", (request, response) => {
  setNoStore(response);
  response.json({ authenticated: hasValidSession(request, config.sessionSecret) });
});

app.post("/api/auth/login", (request, response) => {
  setNoStore(response);
  const ip = clientIp(request);
  const now = Date.now();
  const previous = loginAttempts.get(ip);
  const attempts = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + LOGIN_WINDOW_MS };

  if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((attempts.resetAt - now) / 1000));
    response.setHeader("Retry-After", String(retryAfter));
    response.status(429).json({
      error: {
        code: "too-many-attempts",
        message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      },
    });
    return;
  }

  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!passwordsMatch(password, config.dashboardPassword)) {
    attempts.count += 1;
    loginAttempts.set(ip, attempts);
    response.status(401).json({ error: { code: "invalid-password", message: "비밀번호가 올바르지 않습니다." } });
    return;
  }

  loginAttempts.delete(ip);
  response.setHeader("Set-Cookie", createSessionCookie(request, config.sessionSecret, secureSessionCookie));
  response.json({ authenticated: true });
});

app.post("/api/auth/logout", (request, response) => {
  setNoStore(response);
  response.setHeader("Set-Cookie", clearSessionCookie(request, secureSessionCookie));
  response.json({ authenticated: false });
});

app.get("/api/portfolio", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const account = typeof request.query.account === "string" ? request.query.account : undefined;
    const force = request.query.refresh === "1";
    const portfolio = await toss.getPortfolio(account, force);
    if (request.query.snapshot !== "0") {
      try {
        await historyStore.recordPortfolio(portfolio);
      } catch (historyError) {
        console.error("[history] 일별 스냅샷 저장 실패:", historyError instanceof Error ? historyError.message : historyError);
      }
    }
    response.json(portfolio);
  } catch (error) {
    if (error instanceof TossApiError) {
      const status = error.status === 400 || error.status === 404 || error.status === 429
        ? error.status
        : 502;
      response.status(status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.requestId ? { requestId: error.requestId } : {}),
        },
      });
      return;
    }
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "토스증권 응답 시간이 초과되었습니다."
      : "포트폴리오를 불러오는 중 예기치 못한 오류가 발생했습니다.";
    console.error("[portfolio]", error instanceof Error ? error.message : error);
    response.status(502).json({ error: { code: "portfolio-unavailable", message } });
  }
});

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

async function compatibleMarket(
  feature: ReadOnlyMarketFeature,
  request: Request,
  response: Response,
  pathQuery: MarketQuery = {},
): Promise<void> {
  setNoStore(response);
  try {
    const query = { ...compatibleMarketQuery(request), ...pathQuery };
    const result = await toss.getReadOnlyMarketData(feature, query);
    response.json(result.data);
  } catch (error) {
    compatibleApiError(response, error, "토스증권 시장 데이터를 불러오지 못했습니다.");
  }
}

const compatibleMarketRoutes: Array<{ path: string; feature: ReadOnlyMarketFeature }> = [
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

for (const route of compatibleMarketRoutes) {
  app.get(route.path, requireReadOnlyApiToken, (request, response) => compatibleMarket(route.feature, request, response));
}

app.get("/api/v1/stocks/:symbol/warnings", requireReadOnlyApiToken, (request, response) => (
  compatibleMarket("warnings", request, response, { symbol: String(request.params.symbol ?? "") })
));
app.get("/api/v1/market-calendar/:country", requireReadOnlyApiToken, (request, response) => (
  compatibleMarket("market-calendar", request, response, { country: String(request.params.country ?? "") })
));
app.get("/api/v1/market-indicators/:symbol/candles", requireReadOnlyApiToken, (request, response) => (
  compatibleMarket("indicator-candles", request, response, { symbol: String(request.params.symbol ?? "") })
));
app.get("/api/v1/market-indicators/:symbol/investor-trading", requireReadOnlyApiToken, (request, response) => (
  compatibleMarket("investor-trading", request, response, { symbol: String(request.params.symbol ?? "") })
));

app.get("/api/v1/accounts", requireReadOnlyApiToken, async (_request, response) => {
  setNoStore(response);
  try {
    response.json(await toss.getCompatibleAccounts());
  } catch (error) {
    compatibleApiError(response, error, "토스증권 계좌 목록을 불러오지 못했습니다.");
  }
});

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

app.get("/api/v1/holdings", requireReadOnlyApiToken, async (request, response) => {
  setNoStore(response);
  const accountId = compatibleAccountId(request, response);
  if (!accountId) return;
  try {
    response.json(await toss.getCompatibleHoldings(accountId));
  } catch (error) {
    compatibleApiError(response, error, "토스증권 보유 자산을 불러오지 못했습니다.");
  }
});

app.get("/api/v1/orders", requireReadOnlyApiToken, async (request, response) => {
  setNoStore(response);
  const accountId = compatibleAccountId(request, response);
  if (!accountId) return;
  try {
    response.json(await toss.getCompatibleOrders(accountId, compatibleMarketQuery(request) as OrderHistoryQuery));
  } catch (error) {
    compatibleApiError(response, error, "토스증권 거래 내역을 불러오지 못했습니다.");
  }
});

app.get("/api/v1/orders/:orderId", requireReadOnlyApiToken, async (request, response) => {
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

app.all("/api/v1/{*path}", requireReadOnlyApiToken, (_request, response) => {
  setNoStore(response);
  response.status(404).json({
    error: {
      code: "operation-not-supported",
      message: "이 호환 API는 허용된 조회 전용 기능만 제공합니다.",
    },
  });
});

app.get("/api/portfolio/history", requireSession, async (request, response) => {
  setNoStore(response);
  const accountId = typeof request.query.account === "string" ? request.query.account.trim() : "";
  const currency = request.query.currency === "USD"
    ? "USD"
    : request.query.currency === "KRW"
      ? "KRW"
      : request.query.currency === "ALL"
        ? "ALL"
        : undefined;
  const range = ["7d", "30d", "90d", "all"].includes(String(request.query.range))
    ? request.query.range as HistoryRange
    : undefined;
  const fromDate = typeof request.query.from === "string" ? request.query.from.trim() : "";
  const toDate = typeof request.query.to === "string" ? request.query.to.trim() : "";
  const hasCustomRange = Boolean(fromDate || toDate);
  const validCustomRange = !hasCustomRange
    || (isHistoryDate(fromDate) && isHistoryDate(toDate) && fromDate <= toDate);

  if (!accountId || !currency || !range || !validCustomRange) {
    response.status(400).json({
      error: {
        code: "invalid-history-query",
        message: "account, currency(ALL/KRW/USD), range와 from/to(YYYY-MM-DD) 값을 확인해 주세요.",
      },
    });
    return;
  }

  try {
    response.json(currency === "ALL"
      ? await portfolioAnalysis.getCombinedHistory({
          accountId,
          range,
          ...(hasCustomRange ? { fromDate, toDate } : {}),
        })
      : await historyStore.getHistory(
          accountId,
          currency as HistoryCurrency,
          range,
          new Date(),
          hasCustomRange ? { from: fromDate, to: toDate } : undefined,
        ));
  } catch (error) {
    console.error("[history] 일별 기록 조회 실패:", error instanceof Error ? error.message : error);
    response.status(500).json({
      error: { code: "history-unavailable", message: "일별 포트폴리오 기록을 불러오지 못했습니다." },
    });
  }
});

function requestedAccount(request: Request): string {
  const account = typeof request.query.account === "string"
    ? request.query.account
    : typeof request.body?.account === "string"
      ? request.body.account
      : "";
  return account.trim();
}

app.get("/api/portfolio/history/status", requireSession, async (request, response) => {
  setNoStore(response);
  const accountId = requestedAccount(request);
  if (!accountId || accountId.length > 128) {
    response.status(400).json({
      error: { code: "invalid-account", message: "조회할 계좌를 선택해 주세요." },
    });
    return;
  }
  response.json(await historicalBackfill.getStatus(accountId));
});

app.post("/api/portfolio/history/backfill", requireSession, async (request, response) => {
  setNoStore(response);
  const accountId = requestedAccount(request);
  if (!accountId || accountId.length > 128) {
    response.status(400).json({
      error: { code: "invalid-account", message: "동기화할 계좌를 선택해 주세요." },
    });
    return;
  }
  try {
    const accounts = await toss.getAccounts();
    if (!accounts.some((account) => account.id === accountId)) {
      response.status(404).json({
        error: { code: "invalid-account", message: "선택한 계좌를 찾을 수 없습니다." },
      });
      return;
    }
    const started = historicalBackfill.start(accountId, true);
    response.status(202).json({
      started,
      status: await historicalBackfill.getStatus(accountId),
    });
  } catch (error) {
    const message = error instanceof TossApiError ? error.message : "과거 데이터 동기화를 시작하지 못했습니다.";
    response.status(502).json({ error: { code: "backfill-unavailable", message } });
  }
});

app.get("/api/portfolio/analysis", requireSession, async (request, response) => {
  setNoStore(response);
  const accountId = requestedAccount(request);
  const range = ["30d", "90d", "1y", "all"].includes(String(request.query.range))
    ? request.query.range as AnalysisRange
    : undefined;
  const fromQuery = typeof request.query.from === "string" ? request.query.from.trim() : "";
  const toQuery = typeof request.query.to === "string" ? request.query.to.trim() : "";
  const hasCustomRange = Boolean(fromQuery || toQuery);
  const riskFreeRateText = typeof request.query.riskFreeRate === "string" ? request.query.riskFreeRate.trim() : "0";
  const riskFreeRatePercent = Number(riskFreeRateText);
  const validCustomRange = !hasCustomRange
    || (isHistoryDate(fromQuery) && isHistoryDate(toQuery) && fromQuery <= toQuery);

  if (!accountId || accountId.length > 128 || !range || !validCustomRange
    || !Number.isFinite(riskFreeRatePercent) || riskFreeRatePercent < -10 || riskFreeRatePercent > 50) {
    response.status(400).json({
      error: {
        code: "invalid-analysis-query",
        message: "account, range와 from/to(YYYY-MM-DD) 값을 확인해 주세요.",
      },
    });
    return;
  }

  try {
    const benchmarkKeys = parseBenchmarkKeys(request.query.benchmarks);
    const today = analysisToday();
    const firstTradeDate = (await historyStore.getBackfillStatus(accountId)).firstTradeDate;
    const fromDate = hasCustomRange ? fromQuery : analysisStartDate(range, today, firstTradeDate);
    const toDate = hasCustomRange ? toQuery : today;
    response.json(await portfolioAnalysis.getAnalysis({
      accountId,
      range,
      fromDate,
      toDate,
      benchmarkKeys,
      riskFreeRatePercent,
    }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("지원하는 비교 지수")) {
      response.status(400).json({ error: { code: "invalid-benchmark", message: error.message } });
      return;
    }
    console.error("[analysis] 분석 데이터 조회 실패:", error instanceof Error ? error.message : error);
    response.status(502).json({
      error: { code: "analysis-unavailable", message: "포트폴리오 분석 데이터를 불러오지 못했습니다." },
    });
  }
});

function backtestError(response: Response, error: unknown): void {
  if (error instanceof BacktestValidationError) {
    response.status(400).json({ error: { code: "invalid-backtest", message: error.message } });
    return;
  }
  if (error instanceof TossApiError) {
    const status = error.status === 404 || error.status === 429 ? error.status : 502;
    response.status(status).json({
      error: { code: error.code, message: error.message, ...(error.requestId ? { requestId: error.requestId } : {}) },
    });
    return;
  }
  console.error("[backtest]", error instanceof Error ? error.message : error);
  response.status(502).json({ error: { code: "backtest-unavailable", message: "백테스트 데이터를 계산하지 못했습니다." } });
}

app.get("/api/portfolio/backtest/instruments", requireSession, async (request, response) => {
  setNoStore(response);
  const symbols = typeof request.query.symbols === "string"
    ? request.query.symbols.split(",").map((symbol) => symbol.trim()).filter(Boolean)
    : [];
  try {
    response.json({ instruments: await portfolioBacktest.resolveInstruments(symbols) });
  } catch (error) {
    backtestError(response, error);
  }
});

app.get("/api/portfolio/backtest/current", requireSession, async (request, response) => {
  setNoStore(response);
  const accountId = requestedAccount(request);
  if (!accountId || accountId.length > 128) {
    response.status(400).json({ error: { code: "invalid-account", message: "조회할 계좌를 선택해 주세요." } });
    return;
  }
  try {
    response.json(await portfolioBacktest.currentPortfolio(accountId));
  } catch (error) {
    backtestError(response, error);
  }
});

app.post("/api/portfolio/backtest", requireSession, async (request, response) => {
  setNoStore(response);
  const payload = parseBacktestPayload(request.body);
  try {
    response.json(await portfolioBacktest.run(payload));
  } catch (error) {
    backtestError(response, error);
  }
});

function parseBacktestPayload(value: unknown): BacktestRunRequest {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const assets: BacktestAssetInput[] = Array.isArray(body.assets)
    ? body.assets.map((value) => {
        const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
        return {
          symbol: typeof item.symbol === "string" ? item.symbol : "",
          weight: typeof item.weight === "number" ? item.weight : Number.NaN,
        };
      })
    : [];
  return {
    assets,
    startDate: typeof body.startDate === "string" ? body.startDate : "",
    endDate: typeof body.endDate === "string" ? body.endDate : "",
    initialAmount: typeof body.initialAmount === "number" ? body.initialAmount : Number.NaN,
    monthlyCashFlow: typeof body.monthlyCashFlow === "number" ? body.monthlyCashFlow : Number.NaN,
    riskFreeRatePercent: typeof body.riskFreeRatePercent === "number" ? body.riskFreeRatePercent : 0,
    transactionCostBps: typeof body.transactionCostBps === "number" ? body.transactionCostBps : 0,
    rebalanceFrequency: typeof body.rebalanceFrequency === "string"
      ? body.rebalanceFrequency as BacktestRunRequest["rebalanceFrequency"]
      : "none",
    benchmark: typeof body.benchmark === "string" ? body.benchmark as BacktestBenchmarkKey : "NONE",
    ...(typeof body.benchmarkSymbol === "string" ? { benchmarkSymbol: body.benchmarkSymbol } : {}),
  };
}

function reportError(response: Response, error: unknown): void {
  if (error instanceof ReportGenerationError) {
    response.status(error.retryable ? 503 : 422).json({
      error: { code: "report-generation-failed", message: error.message },
    });
    return;
  }
  console.error("[reports] 보고서 처리 실패:", error instanceof Error ? error.message : error);
  response.status(502).json({
    error: { code: "report-unavailable", message: "보고서를 생성하거나 저장하지 못했습니다." },
  });
}

app.post("/api/reports/portfolio-analysis", requireSession, async (request, response) => {
  setNoStore(response);
  const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  const accountId = typeof body.account === "string" ? body.account.trim() : "";
  const range = ["30d", "90d", "1y", "all"].includes(String(body.range))
    ? body.range as AnalysisRange
    : undefined;
  const fromDate = typeof body.from === "string" ? body.from.trim() : "";
  const toDate = typeof body.to === "string" ? body.to.trim() : "";
  const riskFreeRatePercent = typeof body.riskFreeRate === "number" ? body.riskFreeRate : 0;
  if (!accountId || accountId.length > 128 || !range || !isHistoryDate(fromDate) || !isHistoryDate(toDate)
    || fromDate > toDate || toDate > analysisToday() || !Number.isFinite(riskFreeRatePercent)
    || riskFreeRatePercent < -10 || riskFreeRatePercent > 50) {
    response.status(400).json({
      error: { code: "invalid-report-range", message: "계좌와 보고서 분석 기간을 확인해 주세요." },
    });
    return;
  }
  try {
    const benchmarkKeys = body.benchmarks === "" ? [] : parseBenchmarkKeys(body.benchmarks);
    const analysis = await portfolioAnalysis.getAnalysis({
      accountId,
      range,
      fromDate,
      toDate,
      benchmarkKeys,
      riskFreeRatePercent,
    });
    const report = await portfolioReports.createAnalysis(analysis);
    response.status(201).json({
      id: report.id,
      url: portfolioReports.publicUrl(report.id),
      createdAt: report.createdAt,
      storage: portfolioReports.storageBackend,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("지원하는 비교 지수")) {
      response.status(400).json({ error: { code: "invalid-benchmark", message: error.message } });
      return;
    }
    reportError(response, error);
  }
});

app.post("/api/reports/backtest", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const result = await portfolioBacktest.run(parseBacktestPayload(request.body));
    const report = await portfolioReports.createBacktest(result);
    response.status(201).json({
      id: report.id,
      url: portfolioReports.publicUrl(report.id),
      createdAt: report.createdAt,
      storage: portfolioReports.storageBackend,
    });
  } catch (error) {
    if (error instanceof BacktestValidationError || error instanceof TossApiError) {
      backtestError(response, error);
      return;
    }
    reportError(response, error);
  }
});

app.get("/api/reports/:reportId", async (request, response) => {
  setNoStore(response);
  const id = String(request.params.reportId ?? "");
  if (!isReportId(id)) {
    response.status(404).json({ error: { code: "report-not-found", message: "보고서를 찾을 수 없습니다." } });
    return;
  }
  try {
    const report = await portfolioReports.get(id);
    if (!report) {
      response.status(404).json({ error: { code: "report-not-found", message: "보고서를 찾을 수 없습니다." } });
      return;
    }
    response.json(report);
  } catch (error) {
    console.error("[reports] 저장된 보고서 조회 실패:", error instanceof Error ? error.message : error);
    response.status(500).json({ error: { code: "report-read-failed", message: "보고서를 불러오지 못했습니다." } });
  }
});

app.use(
  express.static(clientDirectory, {
    index: false,
    maxAge: config.nodeEnv === "production" ? "1y" : 0,
    immutable: config.nodeEnv === "production",
  }),
);

app.get("/{*path}", (_request, response) => {
  response.setHeader("Cache-Control", "no-cache");
  response.sendFile(path.join(clientDirectory, "index.html"));
});

const server = app.listen(config.port, config.host, () => {
  console.info("Portfolio Lens listening on http://" + config.host + ":" + config.port);
});

let collectingSnapshots = false;
async function collectDailySnapshots(): Promise<void> {
  if (collectingSnapshots) return;
  collectingSnapshots = true;
  try {
    const accounts = await toss.getAccounts(true);
    for (const account of accounts) {
      try {
        const portfolio = await toss.getPortfolio(account.id, true, false);
        await historyStore.recordPortfolio(portfolio);
      } catch (error) {
        console.warn(
          "[history] " + account.id + " 계좌 수집 실패:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  } catch (error) {
    console.warn("[history] 계좌 목록 수집 실패:", error instanceof Error ? error.message : error);
  } finally {
    collectingSnapshots = false;
  }
}

async function collectInitialData(): Promise<void> {
  await collectDailySnapshots();
  try {
    await historicalBackfill.runAll();
  } catch (error) {
    console.warn("[backfill] 초기 동기화 시작 실패:", error instanceof Error ? error.message : error);
  }
}

const initialCollectionTimer = setTimeout(() => void collectInitialData(), 2_000);
initialCollectionTimer.unref();
const collectionInterval = setInterval(
  () => void collectDailySnapshots(),
  config.snapshotRefreshHours * 60 * 60 * 1000,
);
collectionInterval.unref();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(initialCollectionTimer);
  clearInterval(collectionInterval);
  server.close(async () => {
    await historicalBackfill.waitForIdle();
    await historyStore.close();
    console.info("Portfolio Lens stopped by " + signal);
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
