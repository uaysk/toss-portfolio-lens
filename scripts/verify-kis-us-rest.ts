import { loadScalpingConfig } from "../server/env.js";
import { marketLocalParts } from "../server/scalping/market-time.js";
import { KisRestClient } from "../server/scalping/kis-rest-client.js";

async function main(): Promise<void> {
  const config = loadScalpingConfig();
  if (!config.enabled) throw new Error("SCALPING_ENABLED must be true.");
  const client = new KisRestClient(config.kisRest);
  const sessionDate = marketLocalParts(Date.now(), "US").date;
  const startedAt = Date.now();
  const volume = await client.getOverseasVolumeRanking({ exchange: "NAS" });
  const tradingAmount = await client.getOverseasTradingAmountRanking({ exchange: "NAS" });
  const minutes = await client.getOverseasMinutes({
    symbol: "AAPL",
    exchange: "NAS",
    sessionDate,
    recordCount: 10,
  });
  process.stdout.write(`${JSON.stringify({
    schema_version: "kis-us-rest-verification/v1",
    elapsed_ms: Date.now() - startedAt,
    environment: config.kisRest.environment,
    session_date: sessionDate,
    volume_ranking: {
      quality: volume.quality,
      count: volume.items.length,
      sample_symbols: volume.items.slice(0, 3).map(({ symbol }) => symbol),
      diagnostic_count: volume.diagnostics.length,
    },
    trading_amount_ranking: {
      quality: tradingAmount.quality,
      count: tradingAmount.items.length,
      sample_symbols: tradingAmount.items.slice(0, 3).map(({ symbol }) => symbol),
      diagnostic_count: tradingAmount.diagnostics.length,
    },
    minute_recovery: {
      quality: minutes.quality,
      count: minutes.items.length,
      oldest_at: minutes.items[0]?.timestamp,
      newest_at: minutes.items.at(-1)?.timestamp,
      volume_available: minutes.items.some(({ volume }) => Number.isFinite(volume)),
      turnover_available: minutes.items.some(({ tradingAmount: amount }) => amount !== undefined),
      diagnostic_count: minutes.diagnostics.length,
    },
  }, null, 2)}\n`);
  if (!volume.items.length || !tradingAmount.items.length || !minutes.items.length) {
    throw new Error("KIS US REST verification returned no usable rows for a required source.");
  }
}

main().catch((error) => {
  process.stderr.write(`KIS US REST verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
