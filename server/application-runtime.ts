import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { PortfolioAnalysisService } from "./analysis.js";
import { HistoricalPortfolioBackfill } from "./backfill.js";
import { PortfolioBacktestService } from "./backtest.js";
import type { AppConfig } from "./env.js";
import { KisExchangeRateClient } from "./kis-exchange-rate.js";
import { OpenAiReportWriter } from "./report-ai.js";
import { createReportStorage } from "./report-storage.js";
import { PortfolioReportService } from "./reports.js";
import { openConfiguredHistoryStore } from "./storage.js";
import { TossClient } from "./toss.js";
import type { McpOAuthRuntime } from "./auth/mcp-oauth-routes.js";
import { MarketDataService } from "./services/market-data-service.js";
import type { McpHttpRuntime } from "./mcp/transport.js";
import { EventLoopLagMonitor } from "./observability/event-loop-monitor.js";
import { RuntimeTelemetry } from "./observability/runtime-telemetry.js";
import { ApplicationSnapshotOrchestrator } from "./runtime/application-snapshots.js";
import {
  createCoreToolDependencies,
  initializeCorePersistence,
  initializeCoreServices,
} from "./runtime/core-services.js";
import { RustComputeClient } from "./worker/rust-client.js";
import { AiComputeClient } from "./worker/ai-client.js";
import type { ScalpingLiveRuntime } from "./scalping/live-runtime.js";
import type { MarketDataRecorder } from "./scalping/market-data-recorder.js";
import type { ScalpingService } from "./scalping/scalping-service.js";
import { createScalpingRouter } from "./scalping/router.js";
import type { AiTradingSimulationService } from "./simulation/simulation-service.js";
import { createSimulationRouter } from "./simulation/router.js";
import { PortfolioLiveHub } from "./portfolio/live-hub.js";
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
import { listenForStartup, StartupRollback } from "./startup-rollback.js";

export class ApplicationRuntime {
static async start(config: AppConfig): Promise<void> {
const startupRollback = new StartupRollback();
try {
  await ApplicationRuntime.startManaged(config, startupRollback);
} catch (error) {
  return startupRollback.rethrow(error);
}
}

private static async startManaged(
config: AppConfig,
startupRollback: StartupRollback,
): Promise<void> {
const eventLoopLag = new EventLoopLagMonitor();
startupRollback.defer("event loop lag monitor", () => eventLoopLag.stop());
eventLoopLag.start();
const runtimeTelemetry = new RuntimeTelemetry();
const toss = new TossClient(config);
const portfolioLive = new PortfolioLiveHub({
  getPortfolio: (_ownerSubject, accountId) => toss.getPortfolio(accountId),
});
startupRollback.defer("portfolio live hub", () => portfolioLive.close());
const historyStore = await openConfiguredHistoryStore(config);
startupRollback.defer("history storage", () => historyStore.close());
const historicalBackfill = new HistoricalPortfolioBackfill(toss, historyStore);
startupRollback.defer("historical backfill", () => historicalBackfill.waitForIdle());
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
    maxQueued: config.compute.rustComputeMaxQueued,
    queueTimeoutMs: config.compute.rustComputeQueueTimeoutMs,
  })
  : undefined;
if (rustCompute) startupRollback.defer("Rust client", () => rustCompute.close());
const reportWriter = config.bedrock
  ? new (await import("./bedrock-report-ai.js")).BedrockReportWriter(config.bedrock)
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
const persistence = await initializeCorePersistence({
  database,
  runtimeTelemetry,
  scalpingEnabled: config.scalping.enabled,
  // openConfiguredHistoryStore completed the migration pass above.
  migrationsAlreadyApplied: true,
});
const {
  runRepository,
  mcpAuditRepository,
  scalpingRepository,
  simulationCheckpoints,
} = persistence;
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
startupRollback.defer("MCP audit cleanup", async () => {
  if (mcpAuditCleanupTimer) clearInterval(mcpAuditCleanupTimer);
  await mcpAuditCleanupTask;
});
mcpAuditCleanupTimer.unref();

const coreServices = await initializeCoreServices({
  config,
  persistence,
  toss,
  historyStore,
  portfolioAnalysis,
  portfolioBacktest,
  marketData,
  portfolioReports,
  rustCompute,
});
const {
  artifactService,
  runService,
  simulationRunEvents,
  backtests,
  technicalTradeMarkerService,
} = coreServices;
startupRollback.defer("run service", () => runService.close("startup_failed"));
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
startupRollback.defer("FinCast AI client", () => cryptoFincastClient.close());
const cryptoChronos2Client = config.cryptoAi.chronos2
  ? new AiComputeClient(config.cryptoAi.chronos2)
  : undefined;
if (cryptoChronos2Client) {
  startupRollback.defer("Chronos-2 AI client", () => cryptoChronos2Client.close());
}
cryptoFincastClient.start();
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
  runEvents: simulationRunEvents,
  credentials: {
    configured: binanceSignedRead.configured,
    signedReadSucceeded: binanceSignedRead.signedReadSucceeded,
  },
  maintenanceMarginState: () => binanceMaintenanceMargin.status(),
  prepareRiskData: async (symbol, requiredMaximumNotional) => {
    await resolveBinanceRules(symbol, requiredMaximumNotional, true);
  },
  workerState: () => ({
    fincast: cryptoWorkerPublicState(cryptoFincastClient.snapshot()),
    chronos2: cryptoWorkerPublicState(cryptoChronos2Client?.snapshot()),
  }),
});
startupRollback.defer(
  "crypto simulation",
  () => cryptoSimulationService.close("startup_failed"),
);
let scalpingLiveRuntime: ScalpingLiveRuntime | undefined;
let scalpingService: ScalpingService | undefined;
let marketDataRecorder: MarketDataRecorder | undefined;
let simulationService: AiTradingSimulationService | undefined;
let aiComputeClient: AiComputeClient | undefined;
if (config.scalping.enabled && scalpingRepository) {
  const [
    { ScalpingAiService },
    { TossScalpingProvider },
    { KisRestClient },
    { KisWebSocketClient },
    { IntradayBarAggregator },
    { ScalpingScanner },
    { ScalpingLiveRuntime },
    { MarketDataRecorder },
    { ScalpingService },
    { AiTradingSimulationService },
    { krIntegratedSessionWindows },
  ] = await Promise.all([
    import("./services/scalping-ai-service.js"),
    import("./scalping/toss-provider.js"),
    import("./scalping/kis-rest-client.js"),
    import("./scalping/kis-websocket-client.js"),
    import("./scalping/intraday-bar-aggregator.js"),
    import("./scalping/scanner-service.js"),
    import("./scalping/live-runtime.js"),
    import("./scalping/market-data-recorder.js"),
    import("./scalping/scalping-service.js"),
    import("./simulation/simulation-service.js"),
    import("./scalping/market-session.js"),
  ]);
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
  const ownedScalpingLiveRuntime = scalpingLiveRuntime;
  startupRollback.defer("scalping runtime", async () => {
    ownedScalpingLiveRuntime.close();
    await ownedScalpingLiveRuntime.waitForIdle();
  });
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
  const ownedAiComputeClient = aiComputeClient;
  startupRollback.defer("stock AI client", () => ownedAiComputeClient.close());
  const stockFincastAi = new ScalpingAiService(
    aiComputeClient,
    scalpingRepository,
    runService,
    config.scalping.ai.maximumBatchSize,
  );
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
    undefined,
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
    const ownedMarketDataRecorder = marketDataRecorder;
    startupRollback.defer("market-data recorder", () => ownedMarketDataRecorder.close());
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
        runEvents: simulationRunEvents,
      },
      simulationCheckpoints,
    );
    const ownedSimulationService = simulationService;
    startupRollback.defer(
      "stock simulation",
      () => ownedSimulationService.close("startup_failed"),
    );
  }
}
const computeToolDependencies = createCoreToolDependencies({
  config,
  persistence,
  services: coreServices,
  portfolioBacktest,
  marketData,
  rustCompute,
});

if (config.mcp.enabled) {
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource", config.mcp.resourceUrl).toString();

  if (config.mcp.authMode === "oauth") {
    const { createMcpOAuthRuntime } = await import("./auth/mcp-oauth-routes.js");
    mcpOAuthRuntime = await createMcpOAuthRuntime({
      database,
      oauth: config.mcp.oauth!,
      resourceUrl: config.mcp.resourceUrl!,
      dashboardPassword: config.dashboardPassword,
      dashboardSessionSecret: config.sessionSecret,
      publicAppUrl: config.publicAppUrl,
      maxRequestsPerMinute: config.mcp.maxRequestsPerMinute,
    });
    startupRollback.defer("MCP OAuth cleanup", async () => {
      if (mcpCleanupTimer) clearInterval(mcpCleanupTimer);
      await mcpCleanupTask;
    });
    mcpCleanupTimer = setInterval(
      () => void runMcpOAuthCleanup().catch((error) => {
        console.warn("[mcp-oauth] 만료 데이터 정리 실패:", error instanceof Error ? error.message : "unknown error");
      }),
      5 * 60_000,
    );
    mcpCleanupTimer.unref();
  }

  const [{ createMcpServer }, { createMcpHttpRuntime }] = await Promise.all([
    import("./mcp/server.js"),
    import("./mcp/transport.js"),
  ]);
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
  const ownedMcpHttpRuntime = mcpHttpRuntime;
  startupRollback.defer("MCP transport", () => ownedMcpHttpRuntime.close());
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDirectory = path.resolve(__dirname, "../client");
const secureSessionCookie = new URL(config.publicAppUrl).protocol === "https:";
const oauthCallbackOrigin = config.mcp.oauth
  ? new URL(config.mcp.oauth.redirectUri).origin
  : undefined;
const shutdownGate = new ShutdownGate();
const sseConnections = new SseConnectionTracker({
  maximumConnections: config.sseMaximumConnections,
});
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
  events: simulationRunEvents,
  sseConnections,
  config: {
    // Public Binance scanning is independent of the stock scalping/KIS stack.
    // The deployed execution adapter remains paper-only and never sends orders.
    enabled: true,
    maxDurationMinutes: config.scalping.simulation.maximumDurationMinutes,
    ownerSubject: "owner",
    heartbeatMs: 15_000,
    backpressureEventLimit: 128,
  },
});
const healthRouter = createHealthRouter({
  storageBackend: "postgres",
  reportStorageBackend: portfolioReports.storageBackend,
  reportGenerationConfigured: portfolioReports.generationConfigured,
  exchangeRateFallback: kisExchangeRate ? "kis" : "disabled",
  kisEnvironment: config.kisExchangeRate?.environment,
  mcpEnabled: config.mcp.enabled,
  mcpAuthMode: config.mcp.authMode,
  appReplicaCount: config.appReplicaCount,
  buildInfo,
  executionMode: config.compute.executionMode,
  rustSocketPath: config.compute.rustSocketPath,
  rustSchedulerSnapshot: () => rustCompute?.snapshot(),
  eventLoopLagSnapshot: () => eventLoopLag.snapshot(),
  sseConnectionSnapshot: () => sseConnections.telemetry,
  simulationSseSnapshot: () => simulationRunEvents.telemetry,
  portfolioLiveSnapshot: () => portfolioLive.telemetry,
  runtimeTelemetrySnapshot: () => runtimeTelemetry.snapshot(),
  simulationEnabled: true,
});
const portfolioRouter = createPortfolioRouter({
  authenticate: requireSession,
  getPortfolio: (account, force) => toss.getPortfolio(account, force),
  recordPortfolio: (portfolio) => historyStore.recordPortfolio(portfolio),
  live: portfolioLive,
  sseConnections,
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
  requestTelemetry: runtimeTelemetry.middleware,
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
const snapshotOrchestrator = new ApplicationSnapshotOrchestrator({
  getAccountIds: async () => (await toss.getAccounts(true)).map((account) => account.id),
  collectAccount: async (accountId) => {
    const portfolio = await toss.getPortfolio(accountId, true, false);
    await historyStore.recordPortfolio(portfolio);
  },
  runBackfill: () => historicalBackfill.runAll(),
  refreshIntervalMs: config.snapshotRefreshHours * 60 * 60 * 1000,
});
startupRollback.defer("snapshot collection", async () => {
  snapshotOrchestrator.stopScheduling();
  await snapshotOrchestrator.waitForIdle();
});
snapshotOrchestrator.start();

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
    startupRollback.commit();
    applicationShuttingDown = true;
    snapshotOrchestrator.stopScheduling();
    eventLoopLag.stop();
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
        cryptoFincastClient.close();
      }),
      shutdownStep("Rust client", () => rustCompute?.close()),
      shutdownStep("portfolio live hub", () => portfolioLive.close()),
      shutdownStep("MCP transport", () => mcpHttpRuntime?.close()),
      shutdownStep("MCP OAuth cleanup tail", async () => {
        await mcpCleanupTask;
      }),
      shutdownStep("MCP audit cleanup tail", async () => {
        await mcpAuditCleanupTask;
      }),
      shutdownStep("backfill", () => historicalBackfill.waitForIdle()),
      shutdownStep("snapshot collection", () => snapshotOrchestrator.waitForIdle()),
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
startupRollback.defer("lifecycle listeners", () => lifecycle.dispose());
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
    startupRollback.commit();
    await lifecycle.shutdown("recorder-start-failed");
  }
}
if (!applicationShuttingDown) {
  await listenForStartup(server, config.port, config.host);
  startupRollback.commit();
  if (!applicationShuttingDown) {
    console.info("Portfolio Lens listening on http://" + config.host + ":" + config.port);
  }
}
}
}
