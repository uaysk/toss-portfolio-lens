import express, { type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
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
import { KisExchangeRateClient } from "./kis-exchange-rate.js";
import { BedrockReportWriter } from "./bedrock-report-ai.js";
import {
  isHistoryDate,
  type HistoryCurrency,
  type HistoryRange,
} from "./history.js";
import {
  buildReadOnlyMarketPath,
  MarketQueryError,
  type MarketQuery,
  type ReadOnlyMarketFeature,
} from "./market.js";
import { OrderHistoryQueryError, type OrderHistoryQuery } from "./orders.js";
import { OpenAiReportWriter, ReportGenerationError } from "./report-ai.js";
import { createReportStorage } from "./report-storage.js";
import { isReportId, PortfolioReportService } from "./reports.js";
import { openConfiguredHistoryStore } from "./storage.js";
import { normalizeCandlePage, TossApiError, TossClient } from "./toss.js";
import { createMcpOAuthRuntime, type McpOAuthRuntime } from "./auth/mcp-oauth-routes.js";
import { ArtifactRepository } from "./repositories/artifact-repository.js";
import { OptimizationRepository } from "./repositories/optimization-repository.js";
import { ReportRepository } from "./repositories/report-repository.js";
import { RunRepository } from "./repositories/run-repository.js";
import { PresetRepository } from "./repositories/preset-repository.js";
import { RunJobRepository } from "./repositories/run-job-repository.js";
import { ScalpingRepository } from "./repositories/scalping-repository.js";
import { McpAuditRepository } from "./repositories/mcp-audit-repository.js";
import { AnalyticsService } from "./services/analytics-service.js";
import { ArtifactService } from "./services/artifact-service.js";
import { BacktestService } from "./services/backtest-service.js";
import { InstrumentService } from "./services/instrument-service.js";
import { MarketDataService } from "./services/market-data-service.js";
import { PortfolioService } from "./services/portfolio-service.js";
import { ReportService } from "./services/report-service.js";
import { ReturnSeriesService } from "./services/return-series-service.js";
import { RunService } from "./services/run-service.js";
import { PresetService } from "./services/preset-service.js";
import { ResearchReportService } from "./services/research-report-service.js";
import { TechnicalAnalysisService } from "./services/technical-analysis-service.js";
import { TechnicalStrategyService } from "./services/technical-strategy-service.js";
import { TechnicalTradeMarkerService } from "./services/technical-trade-marker-service.js";
import { McpResourceRegistry } from "./mcp/resources.js";
import { createMcpServer } from "./mcp/server.js";
import { createMcpHttpRuntime, type McpHttpRuntime } from "./mcp/transport.js";
import { EventLoopLagMonitor } from "./observability/event-loop-monitor.js";
import { RustComputeClient } from "./worker/rust-client.js";
import { AiComputeClient } from "./worker/ai-client.js";
import { ScalpingAiService } from "./services/scalping-ai-service.js";
import { TossScalpingProvider } from "./scalping/toss-provider.js";
import { KisRestClient } from "./scalping/kis-rest-client.js";
import { KisWebSocketClient } from "./scalping/kis-websocket-client.js";
import { IntradayBarAggregator } from "./scalping/intraday-bar-aggregator.js";
import { ScalpingScanner } from "./scalping/scanner-service.js";
import { ScalpingLiveRuntime } from "./scalping/live-runtime.js";
import { ScalpingService } from "./scalping/scalping-service.js";
import { createScalpingRouter } from "./scalping/router.js";
import { krIntegratedSessionWindows } from "./scalping/market-session.js";
import {
  createDashboardAnalysisExecutor,
  dashboardAnalysisError,
  parseDashboardRunId,
} from "./dashboard-analysis.js";
import { ARTIFACT_TYPES, type ArtifactType } from "./repositories/artifact-repository.js";
import { buildInfo } from "./build-info.js";
import { createToolHandlers } from "./mcp/tools/handlers.js";
import { toolSchemas, type ToolName } from "./mcp/schemas.js";
import { ServiceError } from "./services/service-envelope.js";
import { enforceToolRequestLimits } from "./services/tool-request-limits.js";

const config = loadConfig();
const eventLoopLag = new EventLoopLagMonitor();
eventLoopLag.start();
const toss = new TossClient(config);
const historyStore = await openConfiguredHistoryStore(config);
const historicalBackfill = new HistoricalPortfolioBackfill(toss, historyStore);
const portfolioAnalysis = new PortfolioAnalysisService(toss, historyStore);
const kisExchangeRate = config.kisExchangeRate
  ? new KisExchangeRateClient(config.kisExchangeRate)
  : undefined;
const marketData = new MarketDataService(toss, historyStore, kisExchangeRate);
const portfolioBacktest = new PortfolioBacktestService(toss, historyStore, marketData);
const reportStorage = createReportStorage(config.reportStorage);
const rustCompute = config.compute.executionMode === "rust_socket"
  ? new RustComputeClient({
    socketPath: config.compute.rustSocketPath,
    poolSize: config.compute.rustSocketPoolSize,
    timeoutMs: config.compute.rustSocketTimeoutMs,
  })
  : undefined;
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
let mcpHttpRuntime: McpHttpRuntime | undefined;
let mcpOAuthRuntime: McpOAuthRuntime | undefined;
let mcpCleanupTimer: NodeJS.Timeout | undefined;
let mcpAuditCleanupTimer: NodeJS.Timeout | undefined;

const database = historyStore.relationalDatabase;
const runRepository = new RunRepository(database);
const presetRepository = new PresetRepository(database);
const artifactRepository = new ArtifactRepository(database);
const optimizationRepository = new OptimizationRepository(database);
const reportRepository = new ReportRepository(database);
const runJobRepository = database.dialect === "postgres" ? new RunJobRepository(database) : undefined;
const mcpAuditRepository = new McpAuditRepository(database);
const scalpingRepository = config.scalping.enabled ? new ScalpingRepository(database) : undefined;
await runRepository.initialize();
const presetService = new PresetService(presetRepository);
await presetService.initialize();
await artifactRepository.initialize();
await optimizationRepository.initialize();
await reportRepository.initialize();
await runJobRepository?.initialize();
await mcpAuditRepository.initialize();
await scalpingRepository?.initialize();
const mcpAuditRetentionMs = config.mcp.auditRetentionDays * 86_400_000;
await mcpAuditRepository.deleteBefore(Date.now() - mcpAuditRetentionMs);
mcpAuditCleanupTimer = setInterval(
  () => void mcpAuditRepository.deleteBefore(Date.now() - mcpAuditRetentionMs).catch((error) => {
    console.warn("[mcp-audit] 보존기간 정리 실패:", error instanceof Error ? error.message : "unknown error");
  }),
  24 * 60 * 60_000,
);
mcpAuditCleanupTimer.unref();

const artifactService = new ArtifactService(
  artifactRepository,
  config.mcp.inlineResultMaxRows,
  config.mcp.inlineResultMaxBytes,
);
const runService = new RunService(
  runRepository,
  artifactService,
  config.mcp.maxConcurrentRuns,
  config.mcp.maxRunsPerSubject,
  {
    maxQueuedRuns: config.mcp.maxQueuedRuns,
    runDeadlineMs: config.mcp.runDeadlineMs,
    executionMode: config.compute.executionMode,
    jobRepository: runJobRepository,
    resultPollMs: config.compute.resultPollMs,
    resultDeadlineMs: config.compute.resultDeadlineMs,
    optimizationRepository,
  },
);
const recoveredRuns = await runService.initialize();
if (recoveredRuns > 0) console.warn(`[compute] ${recoveredRuns}개의 stale 실행을 복구했습니다.`);
const reportService = new ReportService(
  portfolioReports,
  reportRepository,
  config.openAi?.model ?? config.bedrock?.modelId,
);
const backtests = new BacktestService(portfolioBacktest, marketData, runService, artifactService, reportService, rustCompute);

const instrumentService = new InstrumentService(marketData);
const returnSeries = new ReturnSeriesService(marketData);
const analytics = new AnalyticsService(returnSeries, marketData);
const portfolioService = new PortfolioService(toss, portfolioBacktest, config.sessionSecret);
const researchReportService = new ResearchReportService();
const technicalAnalysisService = new TechnicalAnalysisService(marketData, runService, artifactService, rustCompute);
const technicalStrategyService = new TechnicalStrategyService(
  technicalAnalysisService,
  portfolioBacktest,
  backtests,
  marketData,
  runService,
  artifactService,
  rustCompute,
);
const technicalTradeMarkerService = new TechnicalTradeMarkerService(historyStore, portfolioAnalysis);
let scalpingLiveRuntime: ScalpingLiveRuntime | undefined;
let scalpingService: ScalpingService | undefined;
let aiComputeClient: AiComputeClient | undefined;
if (config.scalping.enabled && scalpingRepository) {
  const tossScalping = new TossScalpingProvider(toss, config.scalping.toss);
  const kisScalpingRest = new KisRestClient(config.scalping.kisRest);
  const kisScalpingSocket = new KisWebSocketClient(config.scalping.kisWebSocket);
  scalpingLiveRuntime = new ScalpingLiveRuntime(
    kisScalpingSocket,
    kisScalpingRest,
    new IntradayBarAggregator(config.scalping.aggregator),
    scalpingRepository,
    {
      replayEventLimit: config.scalping.sseReplayEvents,
      disconnectWhenIdle: true,
      watermarkAdvanceMs: config.scalping.barWatermarkAdvanceMs,
      recoveryMaximumRequests: config.scalping.recoveryMaximumRequests,
      recoveryBarLimit: config.scalping.recoveryBarLimit,
      snapshotStaleAfterMs: config.scalping.scanner.staleAfterMs,
      krSessionWindows: krIntegratedSessionWindows({
        preMarketOpenMinuteKst: config.scalping.service.preMarketOpenMinuteKst,
        preMarketCloseMinuteKst: config.scalping.service.preMarketCloseMinuteKst,
        regularMarketOpenMinuteKst: config.scalping.service.sessionOpenMinuteKst,
        regularMarketCloseMinuteKst: config.scalping.service.sessionCloseMinuteKst,
        afterMarketOpenMinuteKst: config.scalping.service.afterMarketOpenMinuteKst,
        afterMarketCloseMinuteKst: config.scalping.service.afterMarketCloseMinuteKst,
      }),
    },
  );
  aiComputeClient = new AiComputeClient({
    url: config.scalping.ai.url,
    authTokenFile: config.scalping.ai.authTokenFile,
    timeoutMs: config.scalping.ai.timeoutMs,
    connectTimeoutMs: config.scalping.ai.connectTimeoutMs,
    reconnectBaseMs: config.scalping.ai.reconnectBaseMs,
    reconnectMaxMs: config.scalping.ai.reconnectMaxMs,
    maximumInFlight: config.scalping.ai.maximumInFlight,
    maximumRequestBytes: config.scalping.ai.maximumRequestBytes,
    maximumResponseBytes: config.scalping.ai.maximumResponseBytes,
    tlsCa: config.scalping.ai.tlsCa,
  });
  const scalpingAi = new ScalpingAiService(
    aiComputeClient,
    scalpingRepository,
    runService,
    config.scalping.ai.maximumBatchSize,
  );
  scalpingService = new ScalpingService(
    tossScalping,
    kisScalpingRest,
    new ScalpingScanner(config.scalping.scanner),
    scalpingLiveRuntime,
    scalpingRepository,
    rustCompute,
    scalpingAi,
    toss,
    technicalTradeMarkerService,
    config.scalping.service,
  );
}
const resources = new McpResourceRegistry(artifactService, runService, config.mcp.authMode);
const computeToolDependencies = {
  instruments: instrumentService,
  marketData,
  analytics,
  returnSeries,
  backtests,
  backtestEngine: portfolioBacktest,
  runs: runService,
  artifacts: artifactService,
  portfolio: portfolioService,
  reports: reportService,
  runRepository,
  presets: presetService,
  researchReports: researchReportService,
  technicalAnalysis: technicalAnalysisService,
  technicalStrategies: technicalStrategyService,
  optimizationRepository,
  resources,
  rustCompute,
  maxCandidateBudget: config.mcp.maxCandidateBudget,
  maxAssets: config.mcp.maxAssets,
  maxDateRangeYears: config.mcp.maxDateRangeYears,
};
const executeDashboardAnalysis = createDashboardAnalysisExecutor(computeToolDependencies);

if (config.mcp.enabled) {
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource", config.mcp.resourceUrl).toString();

  if (config.mcp.authMode === "oauth") {
    mcpOAuthRuntime = await createMcpOAuthRuntime({
      database,
      oauth: config.mcp.oauth!,
      resourceUrl: config.mcp.resourceUrl!,
      dashboardPassword: config.dashboardPassword,
      dashboardSessionSecret: config.sessionSecret,
      publicAppUrl: config.publicAppUrl,
      maxRequestsPerMinute: config.mcp.maxRequestsPerMinute,
    });
    mcpCleanupTimer = setInterval(
      () => void mcpOAuthRuntime?.cleanup().catch((error) => {
        console.warn("[mcp-oauth] 만료 데이터 정리 실패:", error instanceof Error ? error.message : "unknown error");
      }),
      5 * 60_000,
    );
    mcpCleanupTimer.unref();
  }

  mcpHttpRuntime = createMcpHttpRuntime({
    serverFactory: () => createMcpServer({
      dependencies: computeToolDependencies,
      authMode: config.mcp.authMode,
      resourceMetadataUrl,
      audit: mcpAuditRepository,
      auditSubjectSalt: config.sessionSecret,
    }),
    authMode: config.mcp.authMode,
    verifier: mcpOAuthRuntime?.verifier,
    resourceMetadataUrl,
    allowedOrigins: config.mcp.allowedOrigins,
    maxRequestsPerMinute: config.mcp.maxRequestsPerMinute,
    audit: mcpAuditRepository,
    auditSubjectSalt: config.sessionSecret,
  });
}
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDirectory = path.resolve(__dirname, "../client");
const secureSessionCookie = new URL(config.publicAppUrl).protocol === "https:";
const oauthCallbackOrigin = config.mcp.oauth
  ? new URL(config.mcp.oauth.redirectUri).origin
  : undefined;

type AttemptState = {
  count: number;
  resetAt: number;
};

const loginAttempts = new Map<string, AttemptState>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

app.disable("x-powered-by");
const portfolioComputeJson = express.json({ limit: "1mb" });
app.use("/api/portfolio/backtest", portfolioComputeJson);
app.use("/api/portfolio/advanced", portfolioComputeJson);
app.use("/api/portfolio/presets", portfolioComputeJson);
app.use("/api/portfolio/tools", portfolioComputeJson);
app.use("/api/reports/backtest", portfolioComputeJson);
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use((request, response, next) => {
  const formAction = request.path === "/oauth/authorize" && oauthCallbackOrigin
    ? `'self' ${oauthCallbackOrigin}`
    : "'self'";
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action ${formAction}`,
  );
  if (request.path.startsWith("/reports/") || request.path.startsWith("/api/reports/")) {
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  next();
});

if (mcpOAuthRuntime) app.use(mcpOAuthRuntime.router);
if (mcpHttpRuntime) app.use(mcpHttpRuntime.router);
if (!config.mcp.enabled) {
  app.all("/mcp", (_request, response) => {
    response.status(404).json({ error: { code: "mcp-disabled", message: "MCP endpoint is disabled." } });
  });
}

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

app.use("/api/portfolio/scalping", createScalpingRouter({
  authenticate: requireSession,
  service: scalpingService,
  live: scalpingLiveRuntime,
  config: {
    enabled: config.scalping.enabled,
    maximumSymbols: config.scalping.maximumTopCount,
    heartbeatMs: config.scalping.enabled ? config.scalping.sseHeartbeatMs : 15_000,
    analysisDebounceMs: config.scalping.enabled ? config.scalping.realtimeAnalysisDebounceMs : 250,
    backpressureEventLimit: config.scalping.enabled ? config.scalping.sseReplayEvents : 100,
  },
}));

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
    reportGeneration: portfolioReports.generationConfigured ? "configured" : "unconfigured",
    marketData: {
      exchangeRateFallback: kisExchangeRate ? "kis" : "disabled",
      kisEnvironment: config.kisExchangeRate?.environment,
    },
    mcp: config.mcp.enabled ? "enabled" : "disabled",
    mcpAuth: !config.mcp.enabled
      ? "disabled"
      : config.mcp.authMode === "oauth" ? "oauth" : "local-none",
    build: buildInfo(),
    compute: {
      executionMode: config.compute.executionMode,
      rustSocket: config.compute.executionMode === "rust_socket" ? config.compute.rustSocketPath : undefined,
      eventLoopLagMs: eventLoopLag.snapshot(),
    },
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
      const expiresAt = query.before ? 0 : fetchedAt + config.candleCacheLatestTtlMs;
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
    const completed = await backtests.runRawWithMetadata({ ownerSubject: "owner", request: payload });
    response.json({ ...completed.result, runId: completed.runId, reused: completed.reused });
  } catch (error) {
    backtestError(response, error);
  }
});

const DASHBOARD_RUN_OWNER = "owner";
const dashboardManagementHandlers = createToolHandlers(computeToolDependencies);
const dashboardArtifactTypes = new Set<ArtifactType>(ARTIFACT_TYPES);

function sendDashboardAnalysisError(response: Response, error: unknown): void {
  const adapted = dashboardAnalysisError(error);
  if (error instanceof ServiceError) {
    if (["PRESET_NOT_FOUND", "CANDIDATE_NOT_FOUND"].includes(error.detail.code)) adapted.status = 404;
    if (["PRESET_REVISION_CONFLICT", "RUN_NOT_TERMINAL", "RUN_ALREADY_ACTIVE"].includes(error.detail.code)) adapted.status = 409;
  }
  if (adapted.status >= 500) {
    console.error("[dashboard-analysis]", error instanceof Error ? error.message : error);
  }
  response.status(adapted.status).json(adapted.body);
}

function dashboardRunResponse(run: NonNullable<Awaited<ReturnType<typeof runService.get>>>, includeResult = false) {
  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    progress: run.progress,
    completedCandidates: run.completedCandidates,
    totalCandidates: run.totalCandidates,
    ...(run.currentValidationWindow ? { currentValidationWindow: run.currentValidationWindow } : {}),
    ...(run.summary !== undefined ? { summary: run.summary } : {}),
    ...(includeResult && run.result !== undefined ? { result: run.result } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    warnings: run.warnings,
  };
}

app.post("/api/portfolio/advanced/:operation", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const result = await executeDashboardAnalysis(String(request.params.operation ?? ""), request.body, DASHBOARD_RUN_OWNER);
    const runResult = (result as { result?: { status?: string; result?: unknown; result_externalized?: boolean } })?.result;
    if (runResult?.result !== undefined && artifactService.shouldExternalize(runResult.result)) {
      delete runResult.result;
      runResult.result_externalized = true;
    }
    const status = runResult?.status;
    response.status(status && ["queued", "running", "cancel_requested"].includes(status) ? 202 : 200).json(result);
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/advanced/runs/:runId", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const runId = parseDashboardRunId(request.params.runId);
    const run = await runService.get(runId, DASHBOARD_RUN_OWNER);
    if (!run) {
      response.status(404).json({ error: { code: "RUN_NOT_FOUND", message: "실행 기록을 찾을 수 없습니다." } });
      return;
    }
    response.json(dashboardRunResponse(run));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/advanced/runs/:runId/result", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const runId = parseDashboardRunId(request.params.runId);
    const run = await runService.get(runId, DASHBOARD_RUN_OWNER);
    if (!run) {
      response.status(404).json({ error: { code: "RUN_NOT_FOUND", message: "실행 기록을 찾을 수 없습니다." } });
      return;
    }
    const artifacts = await artifactService.list(run.id);
    const resultExternalized = run.result !== undefined && artifactService.shouldExternalize(run.result);
    response.status(["queued", "running", "cancel_requested"].includes(run.status) ? 202 : 200).json({
      ...dashboardRunResponse(run, !resultExternalized),
      ...(resultExternalized ? { resultExternalized: true } : {}),
      artifacts,
    });
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.post("/api/portfolio/advanced/runs/:runId/cancel", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const runId = parseDashboardRunId(request.params.runId);
    const accepted = await runService.cancel(runId, DASHBOARD_RUN_OWNER);
    const run = await runService.get(runId, DASHBOARD_RUN_OWNER);
    if (!run) {
      response.status(404).json({ error: { code: "RUN_NOT_FOUND", message: "실행 기록을 찾을 수 없습니다." } });
      return;
    }
    response.json({ ...dashboardRunResponse(run), cancelRequested: accepted });
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/advanced/runs/:runId/artifacts/:type", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const runId = parseDashboardRunId(request.params.runId);
    const type = String(request.params.type ?? "") as ArtifactType;
    if (!dashboardArtifactTypes.has(type)) {
      response.status(404).json({ error: { code: "ARTIFACT_NOT_FOUND", message: "지원하지 않는 결과 자료입니다." } });
      return;
    }
    const run = await runService.get(runId, DASHBOARD_RUN_OWNER);
    if (!run) {
      response.status(404).json({ error: { code: "RUN_NOT_FOUND", message: "실행 기록을 찾을 수 없습니다." } });
      return;
    }
    const artifact = await artifactService.get(run.id, type);
    if (!artifact) {
      response.status(404).json({ error: { code: "ARTIFACT_NOT_FOUND", message: "결과 자료를 찾을 수 없습니다." } });
      return;
    }
    response.json(artifact);
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/advanced/resources/market/:requestHash", requireSession, (request, response) => {
  setNoStore(response);
  const requestHash = String(request.params.requestHash ?? "");
  if (!/^[a-f0-9]{64}$/.test(requestHash)) {
    response.status(400).json({ error: { code: "INVALID_RESOURCE_ID", message: "시장 자료 식별자가 올바르지 않습니다." } });
    return;
  }
  const stored = resources.getMarket(requestHash, DASHBOARD_RUN_OWNER);
  if (!stored) {
    response.status(404).json({ error: { code: "RESOURCE_NOT_FOUND", message: "시장 자료가 만료되었거나 없습니다." } });
    return;
  }
  response.json({ descriptor: stored.descriptor, data: stored.content });
});

function queryValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(queryValues);
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function queryValue(value: unknown): string | undefined {
  return queryValues(value)[0];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

app.get("/api/portfolio/technical/trades", requireSession, async (request, response) => {
  setNoStore(response);
  const accountId = queryValue(request.query.account) ?? "";
  const fromDate = queryValue(request.query.from);
  const toDate = queryValue(request.query.to);
  const symbols = queryValues(request.query.symbols).map((symbol) => symbol.toUpperCase());
  try {
    response.json(await technicalTradeMarkerService.getMarkers({
      accountId,
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {}),
      ...(symbols.length ? { symbols } : {}),
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

async function executeDashboardManagement(name: ToolName, input: unknown): Promise<unknown> {
  const parsed = toolSchemas[name].parse(input);
  enforceToolRequestLimits(parsed, computeToolDependencies);
  return dashboardManagementHandlers[name](parsed, DASHBOARD_RUN_OWNER);
}

app.post("/api/portfolio/tools/:toolName", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const name = String(request.params.toolName ?? "");
    if (!Object.hasOwn(toolSchemas, name)) {
      response.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "지원하지 않는 portfolio 도구입니다." } });
      return;
    }
    const result = await executeDashboardManagement(name as ToolName, request.body);
    const status = objectValue(objectValue(result).result).status;
    response.status(typeof status === "string" && ["queued", "running", "cancel_requested"].includes(status) ? 202 : 200).json(result);
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/runs", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const archivedQuery = queryValue(request.query.archived);
    const archived = archivedQuery === "true" || archivedQuery === "archived"
      ? "archived"
      : archivedQuery === "all" ? "all" : "active";
    response.json(await executeDashboardManagement("list_runs", {
      ...(queryValue(request.query.query) ? { query: queryValue(request.query.query) } : {}),
      kinds: [...queryValues(request.query.kind), ...queryValues(request.query.kinds)],
      statuses: [...queryValues(request.query.status), ...queryValues(request.query.statuses)],
      tags: [...queryValues(request.query.tag), ...queryValues(request.query.tags)],
      archived,
      ...(queryValue(request.query.cursor) ? { cursor: queryValue(request.query.cursor) } : {}),
      limit: Number(queryValue(request.query.limit) ?? 25),
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.patch("/api/portfolio/runs/:runId", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.json(await executeDashboardManagement("update_run", {
      ...objectValue(request.body),
      runId: request.params.runId,
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.delete("/api/portfolio/runs/:runId", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.json(await executeDashboardManagement("delete_run", { runId: request.params.runId }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.post("/api/portfolio/runs/:runId/duplicate", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.status(201).json(await executeDashboardManagement("duplicate_run", {
      ...objectValue(request.body),
      runId: request.params.runId,
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.post("/api/portfolio/runs/:runId/rerun", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const result = await executeDashboardManagement("rerun_run", { runId: request.params.runId });
    const run = objectValue(objectValue(result).result).run;
    const status = objectValue(run).status;
    response.status(typeof status === "string" && ["queued", "running", "cancel_requested"].includes(status) ? 202 : 200).json(result);
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/runs/:runId/events", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.json(await executeDashboardManagement("get_run_events", {
      runId: request.params.runId,
      ...(queryValue(request.query.cursor) ? { cursor: queryValue(request.query.cursor) } : {}),
      limit: Number(queryValue(request.query.limit) ?? 100),
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/runs/:runId/manifest", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.json(await executeDashboardManagement("export_run_manifest", { runId: request.params.runId }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/presets", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.json(await executeDashboardManagement("list_portfolio_presets", {
      ...(queryValue(request.query.query) ? { query: queryValue(request.query.query) } : {}),
      tags: [...queryValues(request.query.tag), ...queryValues(request.query.tags)],
      ...(queryValue(request.query.cursor) ? { cursor: queryValue(request.query.cursor) } : {}),
      limit: Number(queryValue(request.query.limit) ?? 25),
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.post("/api/portfolio/presets", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.status(201).json(await executeDashboardManagement("create_portfolio_preset", request.body));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.post("/api/portfolio/presets/import", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const body = objectValue(request.body);
    response.status(201).json(await executeDashboardManagement("import_portfolio_presets", {
      document: body.document,
      conflictMode: body.conflictMode ?? "rename",
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/presets/:presetId", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.json(await executeDashboardManagement("get_portfolio_preset", {
      presetId: request.params.presetId,
      includeHistory: queryValue(request.query.includeHistory) === "true",
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/presets/:presetId/history", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.json(await executeDashboardManagement("get_portfolio_preset", {
      presetId: request.params.presetId,
      includeHistory: true,
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.patch("/api/portfolio/presets/:presetId", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const body = objectValue(request.body);
    response.json(await executeDashboardManagement("update_portfolio_preset", {
      ...body,
      presetId: request.params.presetId,
      revision: body.revision ?? body.version,
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.delete("/api/portfolio/presets/:presetId", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.json(await executeDashboardManagement("delete_portfolio_preset", { presetId: request.params.presetId }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.post("/api/portfolio/presets/:presetId/duplicate", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    response.status(201).json(await executeDashboardManagement("duplicate_portfolio_preset", {
      ...objectValue(request.body),
      presetId: request.params.presetId,
    }));
  } catch (error) {
    sendDashboardAnalysisError(response, error);
  }
});

app.get("/api/portfolio/presets/:presetId/export", requireSession, async (request, response) => {
  setNoStore(response);
  try {
    const output = objectValue(await executeDashboardManagement("export_portfolio_preset", { presetId: request.params.presetId }));
    const document = objectValue(output.result).document;
    response.json(document);
  } catch (error) {
    sendDashboardAnalysisError(response, error);
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
          ...(typeof item.lotSize === "number" ? { lotSize: item.lotSize } : {}),
          ...(typeof item.delistDate === "string" ? { delistDate: item.delistDate } : {}),
          ...(typeof item.universeMemberFrom === "string" ? { universeMemberFrom: item.universeMemberFrom } : {}),
          ...(typeof item.universeMemberTo === "string" ? { universeMemberTo: item.universeMemberTo } : {}),
        };
      })
    : [];
  return {
    assets,
    startDate: typeof body.startDate === "string" ? body.startDate : "",
    endDate: typeof body.endDate === "string" ? body.endDate : "",
    initialAmount: typeof body.initialAmount === "number" ? body.initialAmount : Number.NaN,
    monthlyCashFlow: typeof body.monthlyCashFlow === "number" ? body.monthlyCashFlow : Number.NaN,
    cashFlowFrequency: typeof body.cashFlowFrequency === "string"
      ? body.cashFlowFrequency as BacktestRunRequest["cashFlowFrequency"]
      : "monthly",
    cashFlowTiming: typeof body.cashFlowTiming === "string"
      ? body.cashFlowTiming as BacktestRunRequest["cashFlowTiming"]
      : "period_start",
    riskFreeRatePercent: typeof body.riskFreeRatePercent === "number" ? body.riskFreeRatePercent : 0,
    transactionCostBps: typeof body.transactionCostBps === "number" ? body.transactionCostBps : 0,
    currencyMode: body.currencyMode === "local" ? "local" : "KRW",
    baseCurrency: "KRW",
    rebalanceFrequency: typeof body.rebalanceFrequency === "string"
      ? body.rebalanceFrequency as BacktestRunRequest["rebalanceFrequency"]
      : "none",
    ...(typeof body.rebalanceThresholdPercent === "number" ? { rebalanceThresholdPercent: body.rebalanceThresholdPercent } : {}),
    cashFlows: Array.isArray(body.cashFlows) ? body.cashFlows.map((value) => {
      const flow = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        date: typeof flow.date === "string" ? flow.date : "",
        amount: typeof flow.amount === "number" ? flow.amount : Number.NaN,
        ...(typeof flow.memo === "string" ? { memo: flow.memo } : {}),
      };
    }) : [],
    targetWeightSchedule: Array.isArray(body.targetWeightSchedule) ? body.targetWeightSchedule.map((value) => {
      const entry = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const rawWeights = entry.weights && typeof entry.weights === "object" && !Array.isArray(entry.weights)
        ? entry.weights as Record<string, unknown>
        : {};
      return {
        date: typeof entry.date === "string" ? entry.date : "",
        weights: Object.fromEntries(Object.entries(rawWeights).map(([symbol, weight]) => [
          symbol,
          typeof weight === "number" ? weight : Number.NaN,
        ])),
        cashTargetPercent: typeof entry.cashTargetPercent === "number" ? entry.cashTargetPercent : 0,
        ...(typeof entry.regime === "string" ? { regime: entry.regime } : {}),
        ...(typeof entry.action === "string" ? { action: entry.action } : {}),
      };
    }) : [],
    execution: body.execution && typeof body.execution === "object" ? {
      cashTargetPercent: typeof (body.execution as Record<string, unknown>).cashTargetPercent === "number"
        ? Number((body.execution as Record<string, unknown>).cashTargetPercent) : 0,
      quantityMode: (body.execution as Record<string, unknown>).quantityMode === "whole" ? "whole" : "fractional",
      cashFlowRebalanceMode: ["target_weights", "drift_reduction", "full"].includes(String((body.execution as Record<string, unknown>).cashFlowRebalanceMode))
        ? (body.execution as Record<string, unknown>).cashFlowRebalanceMode as "target_weights" | "drift_reduction" | "full" : "target_weights",
      tradeDatePolicy: "next_common_observation",
      cashAnnualYieldPercent: typeof (body.execution as Record<string, unknown>).cashAnnualYieldPercent === "number"
        ? Number((body.execution as Record<string, unknown>).cashAnnualYieldPercent) : 0,
    } : undefined,
    ...(body.realism && typeof body.realism === "object" && !Array.isArray(body.realism)
      ? { realism: body.realism as BacktestRunRequest["realism"] }
      : {}),
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
    const result = await backtests.runRaw({ ownerSubject: "owner", request: parseBacktestPayload(request.body) });
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
  eventLoopLag.stop();
  clearInterval(collectionInterval);
  scalpingLiveRuntime?.close();
  if (mcpCleanupTimer) clearInterval(mcpCleanupTimer);
  if (mcpAuditCleanupTimer) clearInterval(mcpAuditCleanupTimer);
  server.close(async () => {
    await mcpHttpRuntime?.close();
    await mcpOAuthRuntime?.cleanup().catch(() => undefined);
    aiComputeClient?.close();
    rustCompute?.close();
    await scalpingLiveRuntime?.waitForIdle();
    await historicalBackfill.waitForIdle();
    await historyStore.close();
    console.info("Portfolio Lens stopped by " + signal);
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
