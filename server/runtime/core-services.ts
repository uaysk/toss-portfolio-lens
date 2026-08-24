import type { PortfolioAnalysisService } from "../analysis.js";
import type { PortfolioBacktestService } from "../backtest.js";
import type { RelationalDatabase } from "../database.js";
import type { AppConfig } from "../env.js";
import type { PortfolioHistoryStore } from "../history.js";
import { applyPortfolioMigrations } from "../migrations.js";
import type { RuntimeTelemetry } from "../observability/runtime-telemetry.js";
import { ArtifactRepository } from "../repositories/artifact-repository.js";
import { McpAuditRepository } from "../repositories/mcp-audit-repository.js";
import { OptimizationRepository } from "../repositories/optimization-repository.js";
import { PresetRepository } from "../repositories/preset-repository.js";
import { ReportRepository } from "../repositories/report-repository.js";
import { RunJobRepository } from "../repositories/run-job-repository.js";
import { RunRepository } from "../repositories/run-repository.js";
import { ScalpingRepository } from "../repositories/scalping-repository.js";
import type { PortfolioReportService } from "../reports.js";
import { AnalyticsService } from "../services/analytics-service.js";
import { ArtifactService } from "../services/artifact-service.js";
import { BacktestService } from "../services/backtest-service.js";
import { InstrumentService } from "../services/instrument-service.js";
import type { MarketDataService } from "../services/market-data-service.js";
import { PortfolioService } from "../services/portfolio-service.js";
import { PresetService } from "../services/preset-service.js";
import { ReportService } from "../services/report-service.js";
import { ResearchReportService } from "../services/research-report-service.js";
import { ReturnSeriesService } from "../services/return-series-service.js";
import { RunService } from "../services/run-service.js";
import { TechnicalAnalysisService } from "../services/technical-analysis-service.js";
import { TechnicalStrategyService } from "../services/technical-strategy-service.js";
import { TechnicalTradeMarkerService } from "../services/technical-trade-marker-service.js";
import { McpResourceRegistry } from "../mcp/resources.js";
import type { McpToolDependencies } from "../mcp/tools/handlers.js";
import { SimulationCheckpointStore } from "../simulation/checkpoint-store.js";
import { SimulationRunEventHub } from "../simulation/run-event-stream.js";
import type { TossClient } from "../toss.js";
import type { RustComputeClient } from "../worker/rust-client.js";

export type CorePersistenceRuntime = {
  runRepository: RunRepository;
  presetService: PresetService;
  artifactRepository: ArtifactRepository;
  optimizationRepository: OptimizationRepository;
  reportRepository: ReportRepository;
  runJobRepository: RunJobRepository;
  mcpAuditRepository: McpAuditRepository;
  scalpingRepository?: ScalpingRepository;
  simulationCheckpoints: SimulationCheckpointStore;
};

export async function initializeCorePersistence(input: {
  database: RelationalDatabase;
  runtimeTelemetry: RuntimeTelemetry;
  scalpingEnabled: boolean;
  migrationsAlreadyApplied?: boolean;
}): Promise<CorePersistenceRuntime> {
  if (!input.migrationsAlreadyApplied) await applyPortfolioMigrations(input.database);
  const runRepository = new RunRepository(input.database);
  const presetRepository = new PresetRepository(input.database);
  const artifactRepository = new ArtifactRepository(
    input.database,
    undefined,
    input.runtimeTelemetry,
  );
  const optimizationRepository = new OptimizationRepository(input.database);
  const reportRepository = new ReportRepository(input.database);
  const runJobRepository = new RunJobRepository(input.database);
  const mcpAuditRepository = new McpAuditRepository(input.database);
  const scalpingRepository = input.scalpingEnabled
    ? new ScalpingRepository(input.database)
    : undefined;
  const simulationCheckpoints = new SimulationCheckpointStore(input.database);

  // Migrations are owned by this composition boundary, so repositories do not
  // repeat the same ledger scan during a single startup.
  const initializedSchema = { migrationsAlreadyApplied: true } as const;
  await runRepository.initialize(initializedSchema);
  await simulationCheckpoints.initialize();
  const presetService = new PresetService(presetRepository);
  await presetService.initialize(initializedSchema);
  await artifactRepository.initialize();
  await optimizationRepository.initialize();
  await reportRepository.initialize();
  await runJobRepository.initialize();
  await mcpAuditRepository.initialize(initializedSchema);
  await scalpingRepository?.initialize(initializedSchema);

  return {
    runRepository,
    presetService,
    artifactRepository,
    optimizationRepository,
    reportRepository,
    runJobRepository,
    mcpAuditRepository,
    scalpingRepository,
    simulationCheckpoints,
  };
}

export type CoreServiceRuntime = {
  artifactService: ArtifactService;
  runService: RunService;
  simulationRunEvents: SimulationRunEventHub;
  reportService: ReportService;
  backtests: BacktestService;
  instrumentService: InstrumentService;
  returnSeries: ReturnSeriesService;
  analytics: AnalyticsService;
  portfolioService: PortfolioService;
  researchReportService: ResearchReportService;
  technicalAnalysisService: TechnicalAnalysisService;
  technicalStrategyService: TechnicalStrategyService;
  technicalTradeMarkerService: TechnicalTradeMarkerService;
};

export async function initializeCoreServices(input: {
  config: AppConfig;
  persistence: CorePersistenceRuntime;
  toss: TossClient;
  historyStore: PortfolioHistoryStore;
  portfolioAnalysis: PortfolioAnalysisService;
  portfolioBacktest: PortfolioBacktestService;
  portfolioReports: PortfolioReportService;
  marketData: MarketDataService;
  rustCompute?: RustComputeClient;
}): Promise<CoreServiceRuntime> {
  const artifactService = new ArtifactService(
    input.persistence.artifactRepository,
    input.config.mcp.inlineResultMaxRows,
    input.config.mcp.inlineResultMaxBytes,
  );
  const runService = new RunService(
    input.persistence.runRepository,
    artifactService,
    input.config.mcp.maxConcurrentRuns,
    input.config.mcp.maxRunsPerSubject,
    {
      maxQueuedRuns: input.config.mcp.maxQueuedRuns,
      runDeadlineMs: input.config.mcp.runDeadlineMs,
      executionMode: input.config.compute.executionMode,
      jobRepository: input.persistence.runJobRepository,
      resultPollMs: input.config.compute.resultPollMs,
      resultDeadlineMs: input.config.compute.resultDeadlineMs,
      optimizationRepository: input.persistence.optimizationRepository,
    },
  );
  const simulationRunEvents = new SimulationRunEventHub();
  const recoveredRuns = await runService.initialize();
  if (recoveredRuns > 0) {
    console.warn(`[compute] ${recoveredRuns}개의 stale 실행을 복구했습니다.`);
  }
  const reportService = new ReportService(
    input.portfolioReports,
    input.persistence.reportRepository,
    input.config.openAi?.model ?? input.config.bedrock?.modelId,
  );
  const backtests = new BacktestService(
    input.portfolioBacktest,
    input.marketData,
    runService,
    artifactService,
    reportService,
    input.rustCompute,
  );
  const instrumentService = new InstrumentService(input.marketData);
  const returnSeries = new ReturnSeriesService(input.marketData);
  const analytics = new AnalyticsService(returnSeries, input.marketData);
  const portfolioService = new PortfolioService(
    input.toss,
    input.portfolioBacktest,
    input.config.sessionSecret,
  );
  const researchReportService = new ResearchReportService();
  const technicalAnalysisService = new TechnicalAnalysisService(
    input.marketData,
    runService,
    artifactService,
    input.rustCompute,
  );
  const technicalStrategyService = new TechnicalStrategyService(
    technicalAnalysisService,
    input.portfolioBacktest,
    backtests,
    input.marketData,
    runService,
    artifactService,
    input.rustCompute,
  );
  const technicalTradeMarkerService = new TechnicalTradeMarkerService(
    input.historyStore,
    input.portfolioAnalysis,
  );

  return {
    artifactService,
    runService,
    simulationRunEvents,
    reportService,
    backtests,
    instrumentService,
    returnSeries,
    analytics,
    portfolioService,
    researchReportService,
    technicalAnalysisService,
    technicalStrategyService,
    technicalTradeMarkerService,
  };
}

export function createCoreToolDependencies(input: {
  config: AppConfig;
  persistence: CorePersistenceRuntime;
  services: CoreServiceRuntime;
  portfolioBacktest: PortfolioBacktestService;
  marketData: MarketDataService;
  rustCompute?: RustComputeClient;
}): McpToolDependencies {
  const resources = new McpResourceRegistry(
    input.services.artifactService,
    input.services.runService,
    input.config.mcp.authMode,
  );
  return {
    instruments: input.services.instrumentService,
    marketData: input.marketData,
    analytics: input.services.analytics,
    returnSeries: input.services.returnSeries,
    backtests: input.services.backtests,
    backtestEngine: input.portfolioBacktest,
    runs: input.services.runService,
    artifacts: input.services.artifactService,
    portfolio: input.services.portfolioService,
    reports: input.services.reportService,
    runRepository: input.persistence.runRepository,
    presets: input.persistence.presetService,
    researchReports: input.services.researchReportService,
    technicalAnalysis: input.services.technicalAnalysisService,
    technicalStrategies: input.services.technicalStrategyService,
    optimizationRepository: input.persistence.optimizationRepository,
    resources,
    rustCompute: input.rustCompute,
    maxCandidateBudget: input.config.mcp.maxCandidateBudget,
    maxAssets: input.config.mcp.maxAssets,
    maxDateRangeYears: input.config.mcp.maxDateRangeYears,
  };
}
