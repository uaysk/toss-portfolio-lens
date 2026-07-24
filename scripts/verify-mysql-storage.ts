import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openMySqlDatabase } from "../server/database.js";
import { PortfolioHistoryStore } from "../server/history.js";
import { openConfiguredHistoryStore } from "../server/storage.js";
import { RunRepository } from "../server/repositories/run-repository.js";
import type { Holding, Portfolio } from "../server/toss.js";
import { verificationConfigDefaults } from "./verification-config.js";

const databasePath = "/tmp/toss-portfolio-lens-mysql-integration.sqlite";
rmSync(databasePath, { force: true });
rmSync(`${databasePath}-wal`, { force: true });
rmSync(`${databasePath}-shm`, { force: true });

const legacyDatabase = new DatabaseSync(databasePath);
legacyDatabase.exec(`
  CREATE TABLE portfolio_cash_ledger (
    account_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    transaction_date TEXT NOT NULL,
    transaction_time TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    kind TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount REAL NOT NULL,
    balance REAL NOT NULL,
    instrument_name TEXT,
    quantity REAL,
    source TEXT NOT NULL DEFAULT 'WTS_PASTE',
    imported_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, entry_id)
  )
`);
legacyDatabase.prepare(`
  INSERT INTO portfolio_cash_ledger (
    account_id, entry_id, transaction_date, transaction_time, occurred_at, title,
    category, kind, currency, amount, balance, instrument_name, quantity, source, imported_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "integration-account",
  "legacy-entry-1",
  "2026-07-01",
  "09:00",
  "2026-07-01T09:00:00+09:00",
  "레거시 입출금",
  "이체입금",
  "DEPOSIT",
  "KRW",
  100,
  100,
  null,
  null,
  "WTS_PASTE",
  100,
);
legacyDatabase.close();

const mysqlConfig = {
  host: process.env.MYSQL_TEST_HOST || "127.0.0.1",
  port: Number.parseInt(process.env.MYSQL_TEST_PORT || "33306", 10),
  user: process.env.MYSQL_TEST_USER || "root",
  password: process.env.MYSQL_TEST_PASSWORD || "integration-password",
  database: process.env.MYSQL_TEST_DATABASE || `portfolio_lens_${process.pid}`,
  connectTimeoutMs: 5_000,
};

function holding(evaluationAmount: number): Holding {
  return {
    symbol: "AAA",
    name: "통합 테스트 종목",
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
  const account = { id: "integration-account", name: "통합 테스트", label: "통합 테스트", type: "STOCK" };
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
let mysql: PortfolioHistoryStore | undefined;
try {
  await sqlite.upsertInstruments([{ symbol: "AAA", name: "통합 테스트 종목", market: "KRX", currency: "KRW" }], 100);
  await sqlite.upsertOrders("integration-account", [{
    orderId: "order-1",
    symbol: "AAA",
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
  await sqlite.upsertDailyPrices("KRW:AAA", [{
    symbol: "AAA",
    date: "2026-07-01",
    timestamp: "2026-07-01T15:30:00+09:00",
    currency: "KRW",
    openPrice: 100,
    highPrice: 120,
    lowPrice: 90,
    closePrice: 110,
  }], 100);
  await sqlite.upsertBacktestPrices("KRW:AAA", [{
    symbol: "AAA",
    date: "2026-07-01",
    timestamp: "2026-07-01T15:30:00+09:00",
    currency: "KRW",
    openPrice: 100,
    highPrice: 120,
    lowPrice: 90,
    closePrice: 108,
  }], 100);
  await sqlite.upsertBenchmarkPrices("KOSPI", [{
    symbol: "KOSPI",
    date: "2026-07-01",
    timestamp: "2026-07-01T15:30:00+09:00",
    currency: "KRW",
    openPrice: 3000,
    highPrice: 3020,
    lowPrice: 2990,
    closePrice: 3010,
  }], 100);
  await sqlite.upsertExchangeRate("2026-07-01", 1400, "2026-07-01T15:30:00+09:00", 100);
  await sqlite.replaceHistoricalSnapshots("integration-account", [{
    date: "2026-07-01",
    capturedAt: Date.parse("2026-07-01T14:59:59.999Z"),
    items: [{
      symbol: "AAA",
      name: "통합 테스트 종목",
      market: "KRX",
      currency: "KRW",
      evaluationAmount: 220,
    }],
  }], "2026-07-02");
  await sqlite.recordPortfolio(portfolio(240), new Date("2026-07-02T10:00:00.000Z"));
  await sqlite.updateBackfillStatus("integration-account", {
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

  const configured = await openConfiguredHistoryStore({
    ...verificationConfigDefaults,
    tossApiAuthMode: "oauth_client_credentials",
    clientId: "integration-client",
    clientSecret: "integration-secret",
    dashboardPassword: "integration-dashboard-password",
    sessionSecret: "integration-session-secret-with-32-characters",
    host: "127.0.0.1",
    port: 3200,
    tossApiBaseUrl: "https://example.invalid",
    dbProvider: "mysql",
    databasePath,
    mysql: mysqlConfig,
    candleCacheLatestTtlMs: 300_000,
    snapshotRefreshHours: 6,
    nodeEnv: "test",
    publicAppUrl: "http://localhost:3200",
    reportStorage: { kind: "local", directory: "/tmp/reports" },
  });
  assert.equal(configured.backend, "mysql");
  assert.equal((await configured.getHistory("integration-account", "KRW", "all")).points.length, 2);
  await configured.close();

  const mysqlDatabase = await openMySqlDatabase(mysqlConfig);
  await new RunRepository(mysqlDatabase).initialize();
  const migrationRows = await mysqlDatabase.query<{ migration_id: string }>(
    "SELECT migration_id FROM portfolio_schema_migrations ORDER BY migration_id",
  );
  assert.deepEqual(migrationRows.map((row) => row.migration_id), [
    "20260718_001_run_management",
    "20260718_002_portfolio_presets",
    "20260718_003_canonical_local_owner",
    "20260718_004_canonical_local_owner_reconciliation",
  ]);
  const managementTables = await mysqlDatabase.query<{ table_name: string }>(`
    SELECT TABLE_NAME AS table_name FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name IN ('portfolio_schema_migrations', 'portfolio_presets', 'portfolio_preset_versions')
  `);
  assert.deepEqual(new Set(managementTables.map((row) => row.table_name)), new Set([
    "portfolio_schema_migrations", "portfolio_presets", "portfolio_preset_versions",
  ]));
  mysql = await PortfolioHistoryStore.open(mysqlDatabase);
  const first = await PortfolioHistoryStore.migrateSqliteData(sqlite, mysql, "integration-v1");
  assert.equal(first.skipped, false);
  assert.equal((await mysql.getHistory("integration-account", "KRW", "all")).points.length, 2);
  assert.equal((await mysql.getOrders("integration-account")).length, 1);
  assert.equal((await mysql.getDailyPrices(["KRW:AAA"], "2026-07-01", "2026-07-01")).get("KRW:AAA")?.get("2026-07-01"), 110);
  assert.deepEqual((await mysql.getBacktestPrices(["KRW:AAA"], "2026-07-01", "2026-07-01")).get("KRW:AAA"), [
    { date: "2026-07-01", close: 108 },
  ]);
  assert.equal((await mysql.getBenchmarkPrices("KOSPI", "2026-07-01", "2026-07-01"))[0]?.close, 3010);
  assert.equal((await mysql.getExchangeRates("2026-07-01", "2026-07-01")).get("2026-07-01"), 1400);
  assert.equal((await mysql.getBackfillStatus("integration-account")).status, "complete");
  assert.equal((await mysqlDatabase.query<{ total: number }>(
    "SELECT COUNT(*) AS total FROM portfolio_cash_ledger WHERE account_id = ?",
    ["integration-account"],
  ))[0]?.total, 1);

  const repeated = await PortfolioHistoryStore.migrateSqliteData(sqlite, mysql, "integration-v1");
  assert.equal(repeated.skipped, true);

  await sqlite.recordPortfolio(portfolio(260), new Date("2026-07-03T10:00:00.000Z"));
  const second = await PortfolioHistoryStore.migrateSqliteData(sqlite, mysql, "integration-v2");
  assert.equal(second.skipped, false);
  assert.equal((await mysql.getHistory("integration-account", "KRW", "all")).points.length, 3);

  assert.equal(await mysql.replaceHistoricalSnapshots("integration-account", [{
    date: "2026-06-30",
    capturedAt: Date.parse("2026-06-30T14:59:59.999Z"),
    items: [{
      symbol: "AAA",
      name: "통합 테스트 종목",
      market: "KRX",
      currency: "KRW",
      evaluationAmount: 210,
    }],
  }], "2026-07-01"), 1);
  await mysql.recordPortfolio(portfolio(280), new Date("2026-07-04T10:00:00.000Z"));
  await mysql.upsertDailyPrices("KRW:AAA", [{
    symbol: "AAA",
    date: "2026-07-04",
    timestamp: "2026-07-04T15:30:00+09:00",
    currency: "KRW",
    openPrice: 130,
    highPrice: 145,
    lowPrice: 125,
    closePrice: 140,
  }], 200);
  assert.equal((await mysql.getHistory("integration-account", "KRW", "all")).points.length, 5);
  assert.equal((await mysql.getPortfolioAnalysisCandles(
    "integration-account",
    "KRW",
    "2026-07-04",
    "2026-07-04",
  ))[0]?.close, 280);

  console.info(JSON.stringify({
    backend: mysql.backend,
    firstMigrationRows: Object.values(first.rows).reduce((sum, count) => sum + count, 0),
    repeatedMigrationSkipped: repeated.skipped,
    managementMigrations: migrationRows.length,
    snapshotsAfterRemigrationAndDirectWrites: 5,
  }));
} finally {
  await mysql?.close().catch(() => undefined);
  await sqlite.close().catch(() => undefined);
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}
