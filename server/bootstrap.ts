import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { PortfolioAnalysisService } from "./analysis.js";
import { HistoricalPortfolioBackfill } from "./backfill.js";
import { PortfolioBacktestService } from "./backtest.js";
import type { AppConfig } from "./env.js";
import { KisExchangeRateClient } from "./kis-exchange-rate.js";
import { BedrockReportWriter } from "./bedrock-report-ai.js";
import { OpenAiReportWriter } from "./report-ai.js";
import { createReportStorage } from "./report-storage.js";
import { PortfolioReportService } from "./reports.js";
import { openConfiguredHistoryStore } from "./storage.js";
import { TossClient } from "./toss.js";
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
import { MarketDataRecorder } from "./scalping/market-data-recorder.js";
import { ScalpingService } from "./scalping/scalping-service.js";
import { createScalpingRouter } from "./scalping/router.js";
import { AiTradingSimulationService } from "./simulation/simulation-service.js";
import { createSimulationRouter } from "./simulation/router.js";
import {
  normalizeBinanceUniverse,
  OfficialBinanceUsdmPublicStreams,
  OfficialBinanceUsdmRestMarketData,
} from "./crypto/binance-market-data.js";
import { BinanceUsdmScanner } from "./crypto/binance-scanner.js";
import {
  BinanceSignedReadProbe,
  loadBinanceServerCredentials,
} from "./crypto/binance-credentials.js";
import { BinanceMaintenanceMarginProvider } from "./crypto/binance-maintenance-margin.js";
import {
  CryptoSimulationCoordinator,
  SimulationServiceMultiplexer,
} from "./crypto/crypto-simulation-service.js";
import { CryptoPaperRuntime } from "./crypto/crypto-paper-runtime.js";
import { CryptoRustTechnicalAnalyzer } from "./crypto/crypto-rust-technical.js";
import { createConfiguredFuturesExecution } from "./crypto/execution.js";
import { cryptoWorkerPublicState } from "./crypto/worker-public-state.js";
import { krIntegratedSessionWindows } from "./scalping/market-session.js";
import { buildInfo } from "./build-info.js";
import { GracefulLifecycle, ShutdownGate, SseConnectionTracker } from "./lifecycle.js";
import { createAuthRouteRuntime } from "./routes/auth.js";
import { createHealthRouter } from "./routes/health.js";
import { createPortfolioRouter } from "./routes/portfolio.js";
import { createReportsRouter } from "./routes/reports.js";
import {
  registerApiAndSpaFallbacks,
  registerMcpFallback,
} from "./routes/fallback.js";
import { createCompatibleApiRouter } from "./routes/compatible-api.js";
import { createPortfolioDataRouter } from "./routes/portfolio-data.js";
import { createDashboardToolsRouter } from "./routes/dashboard-tools.js";
import { createAiQualificationRouter } from "./routes/ai-qualification.js";
import { warnReadOnlyApiTokenFallbackOnce } from "./startup-warning.js";

export async function bootstrap(config: AppConfig): Promise<void> {
warnReadOnlyApiTokenFallbackOnce(config.readOnlyApiTokenSource);
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
let mcpCleanupTask: Promise<void> | undefined;
let mcpAuditCleanupTask: Promise<void> | undefined;

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

function runMcpAuditCleanup(): Promise<void> {
  if (mcpAuditCleanupTask) return mcpAuditCleanupTask;
  const task = mcpAuditRepository
    .deleteBefore(Date.now() - mcpAuditRetentionMs)
    .then(() => undefined);
  mcpAuditCleanupTask = task;
  void task.then(
    () => {
      if (mcpAuditCleanupTask === task) mcpAuditCleanupTask = undefined;
    },
    () => {
      if (mcpAuditCleanupTask === task) mcpAuditCleanupTask = undefined;
    },
  );
  return task;
}

function runMcpOAuthCleanup(): Promise<void> {
  if (mcpCleanupTask) return mcpCleanupTask;
  const runtime = mcpOAuthRuntime;
  if (!runtime) return Promise.resolve();
  const task = Promise.resolve().then(() => runtime.cleanup());
  mcpCleanupTask = task;
  void task.then(
    () => {
      if (mcpCleanupTask === task) mcpCleanupTask = undefined;
    },
    () => {
      if (mcpCleanupTask === task) mcpCleanupTask = undefined;
    },
  );
  return task;
}

await runMcpAuditCleanup();
mcpAuditCleanupTimer = setInterval(
  () => void runMcpAuditCleanup().catch((error) => {
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
const binanceCredentialLoad = loadBinanceServerCredentials({
  BINANCE_API_KEY: process.env.BINANCE_API_KEY,
  BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
  BINANCE_API_KEY_FILE: process.env.BINANCE_API_KEY_FILE,
  BINANCE_SECRET_KEY_FILE: process.env.BINANCE_SECRET_KEY_FILE,
});
const binanceSignedRead = await new BinanceSignedReadProbe({
  credentials: binanceCredentialLoad.credentials,
  environment: "live",
}).probe();
const binanceMaintenanceMargin = new BinanceMaintenanceMarginProvider({
  credentials: binanceCredentialLoad.credentials,
  environment: "live",
});
const binanceMarketData = new OfficialBinanceUsdmRestMarketData();
const cryptoFincastClient = new AiComputeClient(config.cryptoAi.fincast);
const cryptoKronosClient = config.cryptoAi.kronos
  ? new AiComputeClient(config.cryptoAi.kronos)
  : undefined;
const cryptoChronos2Client = config.cryptoAi.chronos2
  ? new AiComputeClient(config.cryptoAi.chronos2)
  : undefined;
cryptoFincastClient.start();
cryptoKronosClient?.start();
cryptoChronos2Client?.start();
const cryptoRuntimeSnapshots = new Map<string, unknown>();
let binanceRulesCache:
  | { loadedAt: number; rules: ReturnType<typeof normalizeBinanceUniverse> }
  | undefined;
const resolveBinanceRules = async (
  symbol: string,
  requiredMaximumNotional: number,
  forceRefresh = false,
) => {
  const now = Date.now();
  if (!binanceRulesCache || now - binanceRulesCache.loadedAt > 60 * 60_000) {
    binanceRulesCache = {
      loadedAt: now,
      rules: normalizeBinanceUniverse(await binanceMarketData.exchangeInformation(), now),
    };
  }
  const publicRules = binanceRulesCache.rules.find(
    (candidate) => candidate.symbol === symbol,
  );
  if (!publicRules) throw new Error("Selected Binance instrument rules are unavailable.");
  // Every run obtains fresh account-applicable brackets before it may open a
  // position. The provider retains only a strict credential-free projection.
  return (await binanceMaintenanceMargin.resolveInstrumentRules(
    publicRules,
    requiredMaximumNotional,
    { forceRefresh },
  )).rules;
};
const cryptoPaperRuntime = new CryptoPaperRuntime({
  rest: binanceMarketData,
  streams: new OfficialBinanceUsdmPublicStreams(),
  laneClients: {
    fincast: cryptoFincastClient,
    ...(cryptoKronosClient ? { kronos_base: cryptoKronosClient } : {}),
    ...(cryptoChronos2Client ? { chronos2: cryptoChronos2Client } : {}),
  },
  executionLane: "fincast",
  ...(rustCompute
    ? { technicalAnalyzer: new CryptoRustTechnicalAnalyzer(rustCompute) }
    : {}),
  instrumentRules: resolveBinanceRules,
  contextBars: 1024,
  inferenceDeadlineMs: config.cryptoAi.sequentialDeadlineMs,
  circuitBreaker: config.cryptoAi.circuitBreaker,
  onSnapshot: (runId, snapshot) => {
    cryptoRuntimeSnapshots.set(runId, snapshot);
  },
});
const cryptoSimulationService = new CryptoSimulationCoordinator({
  scanner: new BinanceUsdmScanner({
    rest: binanceMarketData,
  }),
  execution: createConfiguredFuturesExecution(),
  runService,
  repository: runRepository,
  artifacts: artifactService,
  runtime: cryptoPaperRuntime,
  runtimeSnapshots: cryptoRuntimeSnapshots,
  maximumActiveSessions: config.cryptoSimulation.maximumActiveSessions,
  credentials: {
    configured: binanceSignedRead.configured,
    signedReadSucceeded: binanceSignedRead.signedReadSucceeded,
  },
  maintenanceMarginState: () => binanceMaintenanceMargin.status(),
  prepareRiskData: async (symbol, requiredMaximumNotional) => {
    await resolveBinanceRules(symbol, requiredMaximumNotional, true);
  },
  workerState: () => ({
    kronos_base: cryptoWorkerPublicState(cryptoKronosClient?.snapshot()),
    fincast: cryptoWorkerPublicState(cryptoFincastClient.snapshot()),
    chronos2: cryptoWorkerPublicState(cryptoChronos2Client?.snapshot()),
  }),
});
let scalpingLiveRuntime: ScalpingLiveRuntime | undefined;
let scalpingService: ScalpingService | undefined;
let marketDataRecorder: MarketDataRecorder | undefined;
let simulationService: AiTradingSimulationService | undefined;
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
  const stockFincastAi = new ScalpingAiService(
    aiComputeClient,
    scalpingRepository,
    runService,
    config.scalping.ai.maximumBatchSize,
  );
  const stockKronosAi = cryptoKronosClient
    ? new ScalpingAiService(
        cryptoKronosClient,
        scalpingRepository,
        runService,
        config.scalping.ai.maximumBatchSize,
      )
    : undefined;
  const stockChronos2Ai = cryptoChronos2Client
    ? new ScalpingAiService(
        cryptoChronos2Client,
        scalpingRepository,
        runService,
        config.scalping.ai.maximumBatchSize,
      )
    : undefined;
  scalpingService = new ScalpingService(
    tossScalping,
    kisScalpingRest,
    new ScalpingScanner(config.scalping.scanner),
    scalpingLiveRuntime,
    scalpingRepository,
    rustCompute,
    stockKronosAi,
    toss,
    technicalTradeMarkerService,
    config.scalping.service,
    undefined,
    stockFincastAi,
    "fincast",
    stockChronos2Ai,
  );
  if (config.scalping.recorder.enabled) {
    marketDataRecorder = new MarketDataRecorder(
      scalpingLiveRuntime,
      scalpingRepository,
      {
        ...config.scalping.recorder,
        closeTimeoutMs: Math.max(1, config.gracefulShutdownTimeoutMs - 3_000),
      },
    );
  }
  if (config.scalping.maximumTopCount >= 2) {
    simulationService = new AiTradingSimulationService(
      scalpingService,
      scalpingLiveRuntime,
      runService,
      runRepository,
      artifactService,
      {
        maximumDurationMinutes: config.scalping.simulation.maximumDurationMinutes,
        maximumActiveSessions: config.scalping.simulation.maximumActiveSessions,
        candidatePoolSize: Math.max(2, config.scalping.minimumTopCount),
        selectionMaximumAttempts: config.scalping.simulation.selectionMaximumAttempts,
        selectionRetryDelayMs: config.scalping.simulation.selectionRetryDelayMs,
      },
    );
  }
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
      () => void runMcpOAuthCleanup().catch((error) => {
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDirectory = path.resolve(__dirname, "../client");
const secureSessionCookie = new URL(config.publicAppUrl).protocol === "https:";
const oauthCallbackOrigin = config.mcp.oauth
  ? new URL(config.mcp.oauth.redirectUri).origin
  : undefined;
const shutdownGate = new ShutdownGate();
const sseConnections = new SseConnectionTracker();
const {
  router: authRouter,
  requireSession,
  requireReadOnlyApiToken,
} = createAuthRouteRuntime({
  dashboardPassword: config.dashboardPassword,
  readOnlyApiToken: config.readOnlyApiToken,
  sessionSecret: config.sessionSecret,
  secureSessionCookie,
});

const scalpingRouter = createScalpingRouter({
  authenticate: requireSession,
  service: scalpingService,
  live: scalpingLiveRuntime,
  recorder: marketDataRecorder,
  sseConnections,
  config: {
    enabled: config.scalping.enabled,
    maximumSymbols: config.scalping.maximumTopCount,
    heartbeatMs: config.scalping.enabled ? config.scalping.sseHeartbeatMs : 15_000,
    analysisDebounceMs: config.scalping.enabled ? config.scalping.realtimeAnalysisDebounceMs : 250,
    backpressureEventLimit: config.scalping.enabled ? config.scalping.sseReplayEvents : 100,
  },
});
const simulationRouter = createSimulationRouter({
  authenticate: requireSession,
  service: new SimulationServiceMultiplexer(cryptoSimulationService, simulationService),
  config: {
    // Public Binance scanning is independent of the stock scalping/KIS stack.
    // The deployed execution adapter remains paper-only and never sends orders.
    enabled: true,
    maxDurationMinutes: config.scalping.simulation.maximumDurationMinutes,
    ownerSubject: "owner",
  },
});
const healthRouter = createHealthRouter({
  storageBackend: historyStore.backend,
  reportStorageBackend: portfolioReports.storageBackend,
  reportGenerationConfigured: portfolioReports.generationConfigured,
  exchangeRateFallback: kisExchangeRate ? "kis" : "disabled",
  kisEnvironment: config.kisExchangeRate?.environment,
  mcpEnabled: config.mcp.enabled,
  mcpAuthMode: config.mcp.authMode,
  buildInfo,
  executionMode: config.compute.executionMode,
  rustSocketPath: config.compute.rustSocketPath,
  eventLoopLagSnapshot: () => eventLoopLag.snapshot(),
  simulationEnabled: true,
});
const portfolioRouter = createPortfolioRouter({
  authenticate: requireSession,
  getPortfolio: (account, force) => toss.getPortfolio(account, force),
  recordPortfolio: (portfolio) => historyStore.recordPortfolio(portfolio),
});
const compatibleApiRouter = createCompatibleApiRouter({
  authenticate: requireReadOnlyApiToken,
  toss,
  historyStore,
  candleCacheLatestTtlMs: config.candleCacheLatestTtlMs,
});
const portfolioDataRouter = createPortfolioDataRouter({
  authenticate: requireSession,
  toss,
  historyStore,
  historicalBackfill,
  portfolioAnalysis,
  portfolioBacktest,
  backtests,
});
const dashboardToolsRouter = createDashboardToolsRouter({
  authenticate: requireSession,
  tools: computeToolDependencies,
  technicalTradeMarkerService,
});
const aiQualificationRouter = createAiQualificationRouter({
  authenticate: requireSession,
  sseConnections,
});
const reportsRouter = createReportsRouter({
  authenticate: requireSession,
  portfolioAnalysis,
  portfolioReports,
  backtests,
});
const app = createApp({
  trustProxy: config.trustProxy,
  oauthCallbackOrigin,
  shutdownGate: shutdownGate.middleware,
  routeRegistrars: [
    (application) => {
      if (mcpOAuthRuntime) application.use(mcpOAuthRuntime.router);
    },
    (application) => {
      if (mcpHttpRuntime) application.use(mcpHttpRuntime.router);
    },
    (application) => registerMcpFallback(application, config.mcp.enabled),
    (application) => application.use("/api/portfolio/scalping", scalpingRouter),
    (application) => application.use("/api/portfolio/simulation", simulationRouter),
    (application) => application.use(healthRouter),
    (application) => application.use(authRouter),
    (application) => application.use(portfolioRouter),
    (application) => application.use(compatibleApiRouter),
    (application) => application.use(portfolioDataRouter),
    (application) => application.use(dashboardToolsRouter),
    (application) => application.use(aiQualificationRouter),
    (application) => application.use(reportsRouter),
    (application) => registerApiAndSpaFallbacks(application, {
      clientDirectory,
      production: config.nodeEnv === "production",
    }),
  ],
});

const server = createServer(app);

let applicationShuttingDown = false;
let activeSnapshotCollection: Promise<void> | undefined;
async function collectDailySnapshots(): Promise<void> {
  if (activeSnapshotCollection) return activeSnapshotCollection;
  if (applicationShuttingDown) return;
  const task = (async () => {
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
  })().catch((error) => {
    console.warn("[history] 계좌 목록 수집 실패:", error instanceof Error ? error.message : error);
  });
  activeSnapshotCollection = task;
  try {
    await task;
  } finally {
    if (activeSnapshotCollection === task) activeSnapshotCollection = undefined;
  }
}

async function collectInitialData(): Promise<void> {
  await collectDailySnapshots();
  if (applicationShuttingDown) return;
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

async function shutdownStep(name: string, operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn(
      `[shutdown] ${name} failed:`,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

let recorderStartupFailed = false;
const lifecycle = new GracefulLifecycle({
  server,
  gate: shutdownGate,
  sseConnections,
  deadlineMs: config.gracefulShutdownTimeoutMs,
  onShutdownStart: (signal) => {
    applicationShuttingDown = true;
    clearTimeout(initialCollectionTimer);
    eventLoopLag.stop();
    clearInterval(collectionInterval);
    if (mcpCleanupTimer) clearInterval(mcpCleanupTimer);
    if (mcpAuditCleanupTimer) clearInterval(mcpAuditCleanupTimer);
    return Promise.all([
      shutdownStep("run service", () => runService.close(signal)),
      shutdownStep("simulation", () => simulationService?.close(signal)),
      shutdownStep("crypto simulation", () => cryptoSimulationService.close(signal)),
      shutdownStep("scalping runtime", async () => {
        await marketDataRecorder?.close();
        scalpingLiveRuntime?.close();
        await scalpingLiveRuntime?.waitForIdle();
      }),
      shutdownStep("AI client", () => aiComputeClient?.close()),
      shutdownStep("crypto AI clients", () => {
        cryptoChronos2Client?.close();
        cryptoKronosClient?.close();
        cryptoFincastClient.close();
      }),
      shutdownStep("Rust client", () => rustCompute?.close()),
      shutdownStep("MCP transport", () => mcpHttpRuntime?.close()),
      shutdownStep("MCP OAuth cleanup tail", async () => {
        await mcpCleanupTask;
      }),
      shutdownStep("MCP audit cleanup tail", async () => {
        await mcpAuditCleanupTask;
      }),
      shutdownStep("backfill", () => historicalBackfill.waitForIdle()),
      shutdownStep("snapshot collection", async () => {
        await activeSnapshotCollection;
      }),
    ]).then(() => undefined);
  },
  onDrained: async () => {
    await shutdownStep("MCP OAuth cleanup", () => runMcpOAuthCleanup());
    await shutdownStep("history storage", () => historyStore.close());
  },
  onStopped: (signal) => {
    console.info("Portfolio Lens stopped by " + signal);
  },
  exit: (code) => process.exit(recorderStartupFailed ? 1 : code),
});
lifecycle.installSignalHandlers();
if (marketDataRecorder && !applicationShuttingDown) {
  try {
    await marketDataRecorder.start();
    console.info(
      `[scalping-recorder] 미국 시세 기록 시작: ${marketDataRecorder.status.instruments
        .map(({ symbol, exchange }) => `${symbol}:${exchange}`)
        .join(", ")}`,
    );
  } catch (error) {
    recorderStartupFailed = true;
    console.error(
      "[scalping-recorder] 시작 실패:",
      error instanceof Error ? error.message : "unknown error",
    );
    await lifecycle.shutdown("recorder-start-failed");
  }
}
if (!applicationShuttingDown) {
  server.listen(config.port, config.host, () => {
    console.info("Portfolio Lens listening on http://" + config.host + ":" + config.port);
  });
}
}
