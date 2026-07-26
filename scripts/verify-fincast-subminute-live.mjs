import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 10_000;

function fail(message) {
  throw new Error(message);
}

function valueFromEnvFile(source, key) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match || match[1] !== key) continue;
    const raw = match[2].trim();
    if (raw.length >= 2 && (
      (raw.startsWith("\"") && raw.endsWith("\""))
      || (raw.startsWith("'") && raw.endsWith("'"))
    )) return raw.slice(1, -1);
    return raw.replace(/\s+#.*$/, "").trim();
  }
  return "";
}

async function dashboardPassword() {
  if (process.env.DASHBOARD_PASSWORD?.trim()) return process.env.DASHBOARD_PASSWORD.trim();
  const source = await readFile(path.join(projectRoot, ".env"), "utf8");
  const value = valueFromEnvFile(source, "DASHBOARD_PASSWORD");
  if (!value) fail("DASHBOARD_PASSWORD is required.");
  return value;
}

function parseArguments(arguments_) {
  const parsed = {
    baseUrl: "http://127.0.0.1:3200",
    symbol: "EULUSDT",
    seconds: undefined,
    timeoutMs: 30 * 60_000,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (!next || next.startsWith("--")) fail(`${argument} requires a value.`);
    if (argument === "--base-url") parsed.baseUrl = next;
    else if (argument === "--symbol") parsed.symbol = next.toUpperCase();
    else if (argument === "--seconds") parsed.seconds = Number(next);
    else if (argument === "--timeout-ms") parsed.timeoutMs = Number(next);
    else fail(`Unknown argument: ${argument}`);
    index += 1;
  }
  const url = new URL(parsed.baseUrl);
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    fail("--base-url must be a credential-free HTTP(S) URL.");
  }
  if (![15, 30].includes(parsed.seconds)) fail("--seconds must be 15 or 30.");
  if (!/^[A-Z0-9]{2,32}USDT$/.test(parsed.symbol)) {
    fail("--symbol must be a Binance USDT futures symbol.");
  }
  if (!Number.isSafeInteger(parsed.timeoutMs)
    || parsed.timeoutMs < 60_000
    || parsed.timeoutMs > 60 * 60_000) {
    fail("--timeout-ms must be an integer between 60000 and 3600000.");
  }
  return {
    ...parsed,
    baseUrl: url.toString().replace(/\/+$/, ""),
  };
}

function sessionCookie(response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0]?.trim();
  if (!value) fail("Dashboard login did not establish a session.");
  return value;
}

async function json(response, label) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(`${label} returned invalid JSON.`);
  }
  if (!response.ok) {
    fail(`${label} returned HTTP ${response.status}: ${payload?.error?.message ?? "unknown"}`);
  }
  return payload;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function snapshotOf(payload) {
  return payload?.snapshot
    ?? payload?.run?.result?.snapshot
    ?? payload?.run?.summary?.snapshot;
}

function assertPaperOnly(statusPayload, runPayload) {
  const status = statusPayload?.cryptoFutures ?? statusPayload;
  const run = runPayload?.run;
  const snapshot = snapshotOf(runPayload);
  if (status?.capabilities?.paper !== true
    || status?.capabilities?.realOrder !== false
    || status?.executionGates?.paper !== true
    || status?.executionGates?.realOrder !== false
    || run?.input?.execution?.mode !== "paper"
    || run?.input?.realOrder !== false
    || (snapshot && (
      snapshot.executionMode !== "paper"
      || snapshot.capabilities?.realOrder !== false
    ))) {
    fail("Paper-only or realOrder=false invariant failed.");
  }
}

function validateCompleted(payload, seconds, symbol) {
  const run = payload?.run;
  const snapshot = snapshotOf(payload);
  if (run?.status !== "completed" || snapshot?.phase !== "completed") {
    fail(`FinCast ${seconds}s run did not complete.`);
  }
  if (snapshot?.decisionCadence?.modelCandleSeconds !== seconds
    || snapshot?.decisionCadence?.trigger !== `final_fincast_${seconds}s_aggtrade_bar`
    || snapshot?.capabilities?.modelCandleSeconds !== seconds
    || snapshot?.capabilities?.chartCandleSeconds !== 60) {
    fail(`FinCast ${seconds}s cadence or 1m chart contract mismatch.`);
  }
  const lane = snapshot?.modelComparison?.lanes?.find((item) => item?.id === "fincast");
  const operations = lane?.aggregationBasis?.operations;
  const provenance = lane?.provenance;
  if (!operations
    || !Number.isSafeInteger(operations.attempts)
    || !Number.isSafeInteger(operations.successes)
    || operations.successes < 1
    || operations.attempts !== operations.successes
    || operations.timeoutCount !== 0) {
    fail(`FinCast ${seconds}s inference did not complete without errors.`);
  }
  if (provenance?.modelId !== "Vincent05R/FinCast"
    || provenance?.loaded !== true
    || provenance?.device !== "cuda") {
    fail(`FinCast ${seconds}s model provenance is invalid.`);
  }
  if (!snapshot?.selected?.some((item) => item?.symbol === symbol)) {
    fail(`FinCast ${seconds}s run did not select ${symbol}.`);
  }
  return {
    runId: run.id,
    status: run.status,
    symbol,
    modelCandleSeconds: seconds,
    chartCandleSeconds: 60,
    trigger: snapshot.decisionCadence.trigger,
    triggeredEvents: snapshot.decisionCadence.triggeredEvents,
    coalescedFinalKlines: snapshot.decisionCadence.coalescedFinalKlines,
    attempts: operations.attempts,
    successes: operations.successes,
    timeoutCount: operations.timeoutCount,
    latencyMs: lane.metrics?.latencyMs,
    modelId: provenance.modelId,
    precision: lane.precision,
    realOrder: snapshot.capabilities.realOrder,
  };
}

const options = parseArguments(process.argv.slice(2));
const loginResponse = await fetch(`${options.baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ password: await dashboardPassword() }),
});
await json(loginResponse.clone(), "Dashboard login");
const headers = {
  accept: "application/json",
  cookie: sessionCookie(loginResponse),
};
const status = await json(
  await fetch(`${options.baseUrl}/api/portfolio/simulation/status`, { headers }),
  "Simulation status",
);
const cryptoStatus = status?.cryptoFutures ?? status;
if (cryptoStatus?.activeSessions !== 0
  || cryptoStatus?.credentials?.signedReadSucceeded !== true
  || cryptoStatus?.workers?.fincast?.status !== "healthy"
  || cryptoStatus?.capabilities?.realOrder !== false) {
  fail("FinCast smoke preflight failed or another simulation is active.");
}

let runId;
let latest;
try {
  const started = await json(await fetch(
    `${options.baseUrl}/api/portfolio/simulation/runs`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        market: {
          kind: "crypto_futures",
          venue: "BINANCE_USDM",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
        },
        initialCash: 10_000,
        durationMinutes: 1,
        selection: { mode: "manual", symbols: [options.symbol] },
        strategy: { mode: "single" },
        preset: "breakout",
        riskTolerance: 100,
        costs: {
          commissionBpsPerSide: 4,
          taxBpsOnExit: 0,
          spreadBpsRoundTrip: 2,
          slippageBpsPerSide: 1,
        },
        modelLanes: ["fincast"],
        fincastCandleSeconds: options.seconds,
        execution: { mode: "paper" },
      }),
    },
  ), "Simulation start");
  runId = started.runId ?? started.run?.id;
  if (typeof runId !== "string") fail("Simulation start returned no runId.");
  process.stdout.write(JSON.stringify({
    event: "started",
    runId,
    symbol: options.symbol,
    seconds: options.seconds,
    realOrder: false,
  }) + "\n");

  const deadline = Date.now() + options.timeoutMs;
  let lastHeartbeat = 0;
  while (Date.now() < deadline) {
    const [statusPayload, runPayload] = await Promise.all([
      json(
        await fetch(`${options.baseUrl}/api/portfolio/simulation/status`, { headers }),
        "Simulation status poll",
      ),
      json(
        await fetch(
          `${options.baseUrl}/api/portfolio/simulation/runs/${encodeURIComponent(runId)}`,
          { headers },
        ),
        "Simulation run poll",
      ),
    ]);
    latest = runPayload;
    assertPaperOnly(statusPayload, runPayload);
    const runStatus = runPayload?.run?.status;
    if (TERMINAL.has(runStatus)) break;
    if (Date.now() - lastHeartbeat >= 60_000) {
      lastHeartbeat = Date.now();
      process.stdout.write(JSON.stringify({
        event: "heartbeat",
        runId,
        status: runStatus,
        progress: runPayload?.run?.progress,
        snapshotPhase: snapshotOf(runPayload)?.phase,
      }) + "\n");
    }
    await sleep(POLL_MS);
  }
  if (!latest || !TERMINAL.has(latest?.run?.status)) {
    fail(`FinCast ${options.seconds}s smoke timed out.`);
  }
  if (latest.run.status !== "completed") {
    fail(
      `FinCast ${options.seconds}s smoke failed: `
      + `${latest.run?.error?.message ?? latest.run.status}`,
    );
  }
  process.stdout.write(JSON.stringify({
    event: "validated",
    ...validateCompleted(latest, options.seconds, options.symbol),
  }) + "\n");
} finally {
  if (runId && !TERMINAL.has(latest?.run?.status)) {
    latest = await json(await fetch(
      `${options.baseUrl}/api/portfolio/simulation/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", headers },
    ), "Simulation cleanup cancel");
    for (let attempt = 0; attempt < 12 && !TERMINAL.has(latest?.run?.status); attempt += 1) {
      await sleep(1_000);
      latest = await json(await fetch(
        `${options.baseUrl}/api/portfolio/simulation/runs/${encodeURIComponent(runId)}`,
        { headers },
      ), "Simulation cleanup poll");
    }
  }
}
