import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { PortfolioHistoryStore } from "../server/history.js";
import { openConfiguredHistoryStore } from "../server/storage.js";
import { ArtifactRepository } from "../server/repositories/artifact-repository.js";
import { OAuthRepository } from "../server/repositories/oauth-repository.js";
import { OptimizationRepository } from "../server/repositories/optimization-repository.js";
import { ReportRepository } from "../server/repositories/report-repository.js";
import { RunRepository } from "../server/repositories/run-repository.js";
import type { Holding, Portfolio } from "../server/toss.js";

const databasePath = "/tmp/toss-portfolio-lens-postgres-integration.sqlite";
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });

const postgresConfig = {
  host: process.env.POSTGRES_TEST_HOST || "127.0.0.1",
  port: Number.parseInt(process.env.POSTGRES_TEST_PORT || "35432", 10),
  user: process.env.POSTGRES_TEST_USER || "portfolio_test",
  password: process.env.POSTGRES_TEST_PASSWORD || "integration-password",
  database: process.env.POSTGRES_TEST_DATABASE || "portfolio_lens_test",
  connectTimeoutMs: 5_000,
};

function holding(evaluationAmount: number): Holding {
  return {
    symbol: "SYNTH",
    name: "합성 통합 종목",
    market: "KRX",
    currency: "KRW",
    quantity: 2,
    availableQuantity: 2,
    averagePrice: 100,
    currentPrice: evaluationAmount / 2,
    purchaseAmount: 200,
    evaluationAmount,
    profitLoss: evaluationAmount - 200,
    profitRate: ((evaluationAmount - 200) / 200) * 100,
    dailyProfitLoss: 0,
    dailyProfitRate: 0,
  };
}

function portfolio(evaluationAmount: number): Portfolio {
  const account = { id: "synthetic-integration-account", name: "합성 통합", label: "합성 통합", type: "STOCK" };
  return {
    asOf: "2026-07-02T15:00:00+09:00",
    accounts: [account],
    selectedAccountId: account.id,
    account,
    summary: {
      evaluationAmount: { KRW: evaluationAmount, USD: 0 },
      purchaseAmount: { KRW: 200, USD: 0 },
      profitLoss: { KRW: evaluationAmount - 200, USD: 0 },
      dailyProfitLoss: { KRW: 0, USD: 0 },
      profitRate: 0,
      dailyProfitRate: 0,
      positionCount: 1,
    },
    holdings: [holding(evaluationAmount)],
  };
}

const sqlite = await PortfolioHistoryStore.openSqlite(databasePath);
let postgres: PortfolioHistoryStore | undefined;
try {
  await sqlite.upsertInstruments([{ symbol: "SYNTH", name: "합성 통합 종목", market: "KRX", currency: "KRW" }], 100);
  await sqlite.upsertOrders("synthetic-integration-account", [{
    orderId: "synthetic-order-1",
    symbol: "SYNTH",
    side: "BUY",
    currency: "KRW",
    status: "CLOSED",
    orderedAt: "2026-07-01T09:00:00+09:00",
    filledAt: "2026-07-01T09:01:00+09:00",
    filledQuantity: 2,
    averageFilledPrice: 100,
    filledAmount: 200,
    commission: 1,
    tax: 0,
  }], 100);
  await sqlite.upsertDailyPrices("KRW:SYNTH", [{
    symbol: "SYNTH", date: "2026-07-01", timestamp: "2026-07-01T15:30:00+09:00", currency: "KRW",
    openPrice: 100, highPrice: 120, lowPrice: 90, closePrice: 110,
  }], 100);
  await sqlite.upsertBacktestPrices("KRW:SYNTH", [{
    symbol: "SYNTH", date: "2026-07-01", timestamp: "2026-07-01T15:30:00+09:00", currency: "KRW",
    openPrice: 100, highPrice: 120, lowPrice: 90, closePrice: 108,
  }], 100);
  await sqlite.upsertBenchmarkPrices("KOSPI", [{
    symbol: "KOSPI", date: "2026-07-01", timestamp: "2026-07-01T15:30:00+09:00", currency: "KRW",
    openPrice: 3000, highPrice: 3020, lowPrice: 2990, closePrice: 3010,
  }], 100);
  await sqlite.upsertExchangeRate("2026-07-01", 1400, "2026-07-01T15:30:00+09:00", 100);
  await sqlite.replaceHistoricalSnapshots("synthetic-integration-account", [{
    date: "2026-07-01",
    capturedAt: Date.parse("2026-07-01T14:59:59.999Z"),
    items: [{ symbol: "SYNTH", name: "합성 통합 종목", market: "KRX", currency: "KRW", evaluationAmount: 220 }],
  }], "2026-07-02");
  await sqlite.recordPortfolio(portfolio(240), new Date("2026-07-02T10:00:00.000Z"));
  await sqlite.updateBackfillStatus("synthetic-integration-account", {
    status: "complete",
    phase: "complete",
    firstTradeDate: "2026-07-01",
    lastBackfilledDate: "2026-07-01",
    ordersImported: 1,
    symbolsTotal: 1,
    symbolsProcessed: 1,
    pricesImported: 1,
    snapshotsCreated: 1,
    reconciledSymbols: 1,
  });

  postgres = await openConfiguredHistoryStore({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    dashboardPassword: "synthetic-dashboard-password",
    sessionSecret: "synthetic-session-secret-with-32-characters",
    host: "127.0.0.1",
    port: 3200,
    tossApiBaseUrl: "https://example.invalid",
    dbProvider: "postgresql",
    databasePath,
    postgres: postgresConfig,
    candleCacheLatestTtlMs: 300_000,
    snapshotRefreshHours: 6,
    nodeEnv: "test",
    publicAppUrl: "http://localhost:3200",
    reportStorage: { kind: "local", directory: "/tmp/reports" },
  });
  assert.equal(postgres.backend, "postgres");
  assert.equal((await postgres.getHistory("synthetic-integration-account", "KRW", "all")).points.length, 2);
  assert.equal((await postgres.getOrders("synthetic-integration-account")).length, 1);
  assert.equal((await postgres.getDailyPrices(["KRW:SYNTH"], "2026-07-01", "2026-07-01")).get("KRW:SYNTH")?.get("2026-07-01"), 110);
  assert.deepEqual((await postgres.getBacktestPrices(["KRW:SYNTH"], "2026-07-01", "2026-07-01")).get("KRW:SYNTH"), [
    { date: "2026-07-01", close: 108 },
  ]);
  assert.equal((await postgres.getBenchmarkPrices("KOSPI", "2026-07-01", "2026-07-01"))[0]?.close, 3010);
  assert.equal((await postgres.getExchangeRates("2026-07-01", "2026-07-01")).get("2026-07-01"), 1400);
  assert.equal((await postgres.getBackfillStatus("synthetic-integration-account")).status, "complete");

  const database = postgres.relationalDatabase;
  await new RunRepository(database).initialize();
  await new ArtifactRepository(database).initialize();
  await new OptimizationRepository(database).initialize();
  await new ReportRepository(database).initialize();
  await new OAuthRepository(database).ensureSchema();
  const expectedTables = [
    "portfolio_backtest_runs", "portfolio_backtest_artifacts", "portfolio_optimization_runs",
    "portfolio_optimization_candidates", "portfolio_run_events", "portfolio_report_links",
    "mcp_oauth_authorization_codes", "mcp_oauth_refresh_tokens", "mcp_oauth_revocations", "mcp_oauth_consents",
    "portfolio_schema_migrations", "portfolio_presets", "portfolio_preset_versions",
  ];
  const rows = await database.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY(?)",
    [expectedTables],
  );
  assert.deepEqual(new Set(rows.map((row) => row.table_name)), new Set(expectedTables));

  await postgres.close();
  postgres = undefined;
  const repeated = await openConfiguredHistoryStore({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    dashboardPassword: "synthetic-dashboard-password",
    sessionSecret: "synthetic-session-secret-with-32-characters",
    host: "127.0.0.1",
    port: 3200,
    tossApiBaseUrl: "https://example.invalid",
    dbProvider: "postgresql",
    databasePath,
    postgres: postgresConfig,
    candleCacheLatestTtlMs: 300_000,
    snapshotRefreshHours: 6,
    nodeEnv: "test",
    publicAppUrl: "http://localhost:3200",
    reportStorage: { kind: "local", directory: "/tmp/reports" },
  });
  assert.equal((await repeated.getHistory("synthetic-integration-account", "KRW", "all")).points.length, 2);
  postgres = repeated;
  console.info(JSON.stringify({ backend: postgres.backend, migrationRepeatedWithoutDuplicates: true, expectedTables: expectedTables.length }));
} finally {
  await postgres?.close().catch(() => undefined);
  await sqlite.close().catch(() => undefined);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });
}
