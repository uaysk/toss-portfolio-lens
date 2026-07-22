import { loadScalpingConfig } from "../server/env.js";
import {
  KisWebSocketClient,
  type KisSubscriptionEvent,
  type KisWebSocketEvent,
} from "../server/scalping/kis-websocket-client.js";
import { normalizeUsExchange } from "../server/scalping/contracts.js";

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer in ${minimum}..=${maximum}.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const symbol = (process.env.KIS_VERIFY_US_SYMBOL ?? "AAPL").trim().toUpperCase();
  const exchange = normalizeUsExchange(process.env.KIS_VERIFY_US_EXCHANGE ?? "NAS");
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol) || !exchange) {
    throw new Error("KIS_VERIFY_US_SYMBOL or KIS_VERIFY_US_EXCHANGE is invalid.");
  }
  const waitMs = boundedInteger("KIS_VERIFY_WAIT_MS", 20_000, 1_000, 120_000);
  const config = loadScalpingConfig();
  if (!config.enabled) throw new Error("SCALPING_ENABLED must be true.");

  const client = new KisWebSocketClient(config.kisWebSocket);
  const events: KisWebSocketEvent[] = [];
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  const remove = client.onEvent((event) => {
    events.push(event);
    const standardExecution = events.some((candidate) => (
      candidate.type === "execution" && candidate.marketCountry === "US" && candidate.usFeed === "standard"
    ));
    const standardOrderbook = events.some((candidate) => (
      candidate.type === "orderbook" && candidate.marketCountry === "US"
    ));
    if (standardExecution && standardOrderbook) finish();
  });
  client.subscribe({ trId: "HDFSCNT0", symbol, exchange, usFeed: "standard" });
  client.subscribe({ trId: "HDFSCNT0", symbol, exchange, usFeed: "day" });
  client.subscribe({ trId: "HDFSASP0", symbol, exchange, usFeed: "standard" });

  const timeout = setTimeout(finish, waitMs);
  const startedAt = Date.now();
  try {
    await client.connect();
    await completed;
  } finally {
    clearTimeout(timeout);
    remove();
    client.disconnect();
  }

  const subscriptions = events.filter((event): event is KisSubscriptionEvent => event.type === "subscription");
  const standardExecutions = events.filter((event) => (
    event.type === "execution" && event.marketCountry === "US" && event.usFeed === "standard"
  ));
  const dayExecutions = events.filter((event) => (
    event.type === "execution" && event.marketCountry === "US" && event.usFeed === "day"
  ));
  const books = events.filter((event) => event.type === "orderbook" && event.marketCountry === "US");
  const parseErrors = events.filter((event) => event.type === "parse_error");
  const latestBook = books.at(-1);
  const latestExecution = standardExecutions.at(-1);
  const report = {
    schema_version: "kis-us-realtime-verification/v1",
    symbol,
    exchange,
    elapsed_ms: Date.now() - startedAt,
    connection_events: events.filter((event) => event.type === "connection").map((event) => event.state),
    subscriptions: subscriptions.map((event) => ({
      tr_id: event.trId,
      us_feed: event.usFeed,
      accepted: event.accepted,
      code: event.code,
    })),
    standard_execution: {
      count: standardExecutions.length,
      latest_at: latestExecution?.providerTimestamp,
      latest_price: latestExecution?.price,
    },
    day_execution: {
      count: dayExecutions.length,
      note: "The day feed is expected to be quiet outside the US day-market session.",
    },
    orderbook: {
      count: books.length,
      depth: latestBook?.depth,
      bid_levels: latestBook?.bids.length ?? 0,
      ask_levels: latestBook?.asks.length ?? 0,
      best_bid: latestBook?.bids[0]?.price,
      best_ask: latestBook?.asks[0]?.price,
      day_market_supported: false,
    },
    parse_error_count: parseErrors.length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!standardExecutions.length || !books.length || parseErrors.length) {
    throw new Error("KIS US standard execution/orderbook verification did not meet the required evidence threshold.");
  }
}

main().catch((error) => {
  process.stderr.write(`KIS US real-time verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
