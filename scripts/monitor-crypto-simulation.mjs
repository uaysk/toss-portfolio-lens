import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

class MonitorError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "MonitorError";
    this.exitCode = exitCode;
  }
}

function usage() {
  return "usage: node scripts/monitor-crypto-simulation.mjs <runId> [output.jsonl]";
}

function requiredInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MonitorError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function envValue(source, key) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match || match[1] !== key) continue;
    const raw = match[2].trim();
    if (raw.length >= 2 && (
      (raw.startsWith("\"") && raw.endsWith("\""))
      || (raw.startsWith("'") && raw.endsWith("'"))
    )) {
      return raw.slice(1, -1);
    }
    return raw.replace(/\s+#.*$/, "").trim();
  }
  return "";
}

async function dashboardPassword() {
  const configured = process.env.DASHBOARD_PASSWORD?.trim();
  if (configured) return configured;
  let source = "";
  try {
    source = await readFile(path.join(projectRoot, ".env"), "utf8");
  } catch {
    throw new MonitorError("DASHBOARD_PASSWORD is required in the process environment or .env.");
  }
  const value = envValue(source, "DASHBOARD_PASSWORD");
  if (!value) {
    throw new MonitorError("DASHBOARD_PASSWORD is required in the process environment or .env.");
  }
  return value;
}

function normalizedBaseUrl() {
  const configured = process.env.SIMULATION_MONITOR_URL?.trim()
    || "http://127.0.0.1:3200";
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new MonitorError("SIMULATION_MONITOR_URL must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new MonitorError("SIMULATION_MONITOR_URL must be a credential-free HTTP(S) URL.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integer(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function text(value, maximum = 500) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;
}

function boolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function stringList(value, maximum = 50) {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const normalized = text(item);
      return normalized ? [normalized] : [];
    }).slice(-maximum)
    : [];
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
    item === undefined ? [] : [[key, compact(item)]]
  )));
}

function projectWorker(value) {
  return compact({
    status: text(value?.status, 40),
    precision: text(value?.precision, 20),
  });
}

function projectStatus(payload) {
  const crypto = payload?.cryptoFutures ?? payload;
  return compact({
    schemaVersion: text(payload?.schemaVersion, 80),
    enabled: boolean(payload?.enabled ?? crypto?.enabled),
    capabilities: {
      paper: boolean(crypto?.capabilities?.paper),
      autonomousPaperTrading: boolean(crypto?.capabilities?.autonomousPaperTrading),
      orderApiDependency: boolean(crypto?.capabilities?.orderApiDependency),
      testnet: boolean(crypto?.capabilities?.testnet),
      live: boolean(crypto?.capabilities?.live),
      realOrder: boolean(crypto?.capabilities?.realOrder),
    },
    credentials: {
      configured: boolean(crypto?.credentials?.configured),
      signedReadSucceeded: boolean(crypto?.credentials?.signedReadSucceeded),
    },
    maintenanceMargin: {
      configured: boolean(crypto?.maintenanceMargin?.configured),
      ready: boolean(crypto?.maintenanceMargin?.ready),
      state: text(crypto?.maintenanceMargin?.state, 40),
    },
    executionGates: {
      paper: boolean(crypto?.executionGates?.paper),
      testnet: boolean(crypto?.executionGates?.testnet),
      live: boolean(crypto?.executionGates?.live),
      realOrder: boolean(crypto?.executionGates?.realOrder),
    },
    workers: {
      kronos_base: projectWorker(crypto?.workers?.kronos_base),
      fincast: projectWorker(crypto?.workers?.fincast),
    },
    activeSessions: integer(crypto?.activeSessions),
  });
}

function projectRiskStream(value) {
  return compact({
    status: text(value?.status, 20),
    maximumAgeMs: integer(value?.maximumAgeMs),
    lastObservedAt: text(value?.lastObservedAt, 40),
  });
}

function projectPosition(value) {
  return compact({
    symbol: text(value?.symbol, 32),
    side: text(value?.side, 12),
    marginMode: text(value?.marginMode, 20),
    quantity: finite(value?.quantity),
    leverage: integer(value?.leverage),
    entryPrice: finite(value?.entryPrice),
    markPrice: finite(value?.markPrice),
    notional: finite(value?.notional),
    initialMargin: finite(value?.initialMargin),
    maintenanceMargin: finite(value?.maintenanceMargin),
    liquidationPrice: finite(value?.liquidationPrice),
    liquidationBufferRatio: finite(value?.liquidationBufferRatio),
    protectiveStopPrice: finite(value?.protectiveStopPrice),
    unrealizedPnl: finite(value?.unrealizedPnl),
    funding: finite(value?.funding),
    fees: finite(value?.fees),
    slippage: finite(value?.slippage),
    entryBlocked: boolean(value?.entryBlocked),
    riskWarnings: stringList(value?.riskWarnings, 20),
  });
}

function projectTrade(value) {
  return compact({
    id: text(value?.id, 80),
    lane: text(value?.lane, 32),
    symbol: text(value?.symbol, 32),
    side: text(value?.side, 12),
    action: text(value?.action, 16),
    reduceOnly: boolean(value?.reduceOnly),
    quantity: finite(value?.quantity),
    price: finite(value?.price),
    notional: finite(value?.notional),
    leverage: integer(value?.leverage),
    cost: finite(value?.cost),
    fee: finite(value?.fee),
    slippage: finite(value?.slippage),
    funding: finite(value?.funding),
    realizedPnl: finite(value?.realizedPnl),
    reason: text(value?.reason, 120),
    decisionAt: text(value?.decisionAt, 40),
    executedAt: text(value?.executedAt, 40),
  });
}

function projectDecision(value) {
  return compact({
    id: text(value?.id, 100),
    lane: text(value?.lane, 32),
    symbol: text(value?.symbol, 32),
    originAt: text(value?.originAt, 40),
    generatedAt: text(value?.generatedAt, 40),
    decisionAt: text(value?.decisionAt, 40),
    fillEligibleAfter: text(value?.fillEligibleAfter, 40),
    action: text(value?.action, 24),
    direction: text(value?.direction, 12),
    confidence: finite(value?.confidence),
    leverage: integer(value?.leverage),
    quantity: finite(value?.quantity),
    notional: finite(value?.notional),
    protectiveStopPrice: finite(value?.protectiveStopPrice),
    probabilityAboveCost: finite(value?.probabilityAboveCost),
    probabilityBelowNegativeCost: finite(value?.probabilityBelowNegativeCost),
    roundTripCostRate: finite(value?.roundTripCostRate),
    status: text(value?.status, 24),
    reason: text(value?.reason, 160),
    requestDigest: text(value?.requestDigest, 80),
    fillId: text(value?.fillId, 80),
    executedAt: text(value?.executedAt, 40),
  });
}

function projectMetrics(value) {
  return compact({
    netPnl: finite(value?.netPnl),
    profitFactor: finite(value?.profitFactor),
    winRate: finite(value?.winRate),
    maxDrawdown: finite(value?.maxDrawdown),
    turnover: finite(value?.turnover),
    funding: finite(value?.funding),
    fees: finite(value?.fees),
    latencyMs: finite(value?.latencyMs),
    availabilityRatio: finite(value?.availabilityRatio),
    timeoutCount: integer(value?.timeoutCount),
    peakVramMb: finite(value?.peakVramMb),
    leverageDistribution: Array.isArray(value?.leverageDistribution)
      ? value.leverageDistribution.map(integer).filter((item) => item !== undefined)
      : [],
  });
}

function projectComparison(value) {
  return compact({
    comparisonId: text(value?.comparisonId, 160),
    outcome: text(value?.outcome, 32),
    sameOrigin: boolean(value?.sameOrigin),
    sameContext: boolean(value?.sameContext),
    sameCosts: boolean(value?.sameCosts),
    sameFillBarrier: boolean(value?.sameFillBarrier),
    symbol: text(value?.symbol, 32),
    lanes: Array.isArray(value?.lanes) ? value.lanes.map((lane) => ({
      id: text(lane?.id, 32),
      status: text(lane?.status, 24),
      precision: text(lane?.precision, 20),
      unavailableReason: text(lane?.unavailableReason, 160),
      metrics: projectMetrics(lane?.metrics),
      provenance: compact({
        modelId: text(lane?.provenance?.modelId, 160),
        modelRevision: text(lane?.provenance?.modelRevision, 160),
      }),
    })) : [],
  });
}

function projectCharts(values) {
  return Array.isArray(values) ? values.map((chart) => {
    const timestamps = Array.isArray(chart?.bars)
      ? chart.bars.map((bar) => Date.parse(bar?.timestamp)).filter(Number.isFinite)
      : [];
    let gaps = 0;
    let duplicatesOrReversals = 0;
    for (let index = 1; index < timestamps.length; index += 1) {
      const delta = timestamps[index] - timestamps[index - 1];
      if (delta <= 0) duplicatesOrReversals += 1;
      else if (delta !== 60_000) gaps += 1;
    }
    return compact({
      symbol: text(chart?.symbol, 32),
      updatedAt: text(chart?.updatedAt, 40),
      barCount: Array.isArray(chart?.bars) ? chart.bars.length : 0,
      validTimestampCount: timestamps.length,
      firstBarAt: timestamps.length ? new Date(timestamps[0]).toISOString() : undefined,
      lastBarAt: timestamps.length ? new Date(timestamps.at(-1)).toISOString() : undefined,
      oneMinuteGapCount: gaps,
      duplicateOrReversalCount: duplicatesOrReversals,
    });
  }) : [];
}

function projectRun(payload) {
  const run = payload?.run ?? {};
  const snapshot = payload?.snapshot ?? {};
  return compact({
    run: {
      id: text(run?.id, 80),
      status: text(run?.status, 32),
      progress: finite(run?.progress),
      completedCandidates: integer(run?.completedCandidates),
      totalCandidates: integer(run?.totalCandidates),
      currentValidationWindow: text(run?.currentValidationWindow, 160),
      startedAt: finite(run?.startedAt),
      updatedAt: finite(run?.updatedAt),
      finishedAt: finite(run?.finishedAt),
      warnings: stringList(run?.warnings, 20),
      error: compact({
        code: text(run?.error?.code, 100),
        retryable: boolean(run?.error?.retryable),
        realOrderApiUsed: boolean(run?.error?.realOrderApiUsed),
      }),
    },
    snapshot: {
      phase: text(snapshot?.phase, 32),
      startedAt: text(snapshot?.startedAt, 40),
      expiresAt: text(snapshot?.expiresAt, 40),
      progress: finite(snapshot?.progress),
      initialCash: finite(snapshot?.initialCash),
      cash: finite(snapshot?.cash),
      equity: finite(snapshot?.equity),
      selected: Array.isArray(snapshot?.selected)
        ? snapshot.selected.map((item) => compact({
          symbol: text(item?.symbol, 32),
          rank: integer(item?.rank),
          score: finite(item?.score),
          price: finite(item?.price),
          reason: text(item?.reason, 160),
        }))
        : [],
      modelLanes: Array.isArray(snapshot?.modelLanes)
        ? snapshot.modelLanes.map((item) => text(item, 32)).filter(Boolean)
        : [],
      executionMode: text(snapshot?.executionMode, 20),
      executionLane: text(snapshot?.executionLane, 32),
      futuresRisk: compact({
        dailyLossRatio: finite(snapshot?.futuresRisk?.dailyLossRatio),
        dailyLossLimitRatio: finite(snapshot?.futuresRisk?.dailyLossLimitRatio),
        newEntriesBlocked: boolean(snapshot?.futuresRisk?.newEntriesBlocked),
        blockReason: text(snapshot?.futuresRisk?.blockReason, 160),
        grossExposureRatio: finite(snapshot?.futuresRisk?.grossExposureRatio),
        marginUsageRatio: finite(snapshot?.futuresRisk?.marginUsageRatio),
        riskPerTradeRatio: finite(snapshot?.futuresRisk?.riskPerTradeRatio),
        riskStreams: {
          healthy: boolean(snapshot?.futuresRisk?.riskStreams?.healthy),
          bookTicker: projectRiskStream(snapshot?.futuresRisk?.riskStreams?.bookTicker),
          markPrice: projectRiskStream(snapshot?.futuresRisk?.riskStreams?.markPrice),
        },
      }),
      futuresPositions: Array.isArray(snapshot?.futuresPositions)
        ? snapshot.futuresPositions.map(projectPosition)
        : [],
      trades: Array.isArray(snapshot?.trades) ? snapshot.trades.map(projectTrade) : [],
      decisions: Array.isArray(snapshot?.decisions)
        ? snapshot.decisions.slice(-20).map(projectDecision)
        : [],
      modelComparison: projectComparison(snapshot?.modelComparison),
      decisionCadence: compact({
        trigger: text(snapshot?.decisionCadence?.trigger, 80),
        triggeredEvents: integer(snapshot?.decisionCadence?.triggeredEvents),
        coalescedFinalKlines: integer(snapshot?.decisionCadence?.coalescedFinalKlines),
        lastTriggeredAt: text(snapshot?.decisionCadence?.lastTriggeredAt, 40),
        inFlight: boolean(snapshot?.decisionCadence?.inFlight),
      }),
      warnings: stringList(snapshot?.warnings, 30),
      capabilities: compact({
        paper: boolean(snapshot?.capabilities?.paper),
        testnet: boolean(snapshot?.capabilities?.testnet),
        live: boolean(snapshot?.capabilities?.live),
        realOrder: boolean(snapshot?.capabilities?.realOrder),
        isolatedMargin: boolean(snapshot?.capabilities?.isolatedMargin),
        oneWayPosition: boolean(snapshot?.capabilities?.oneWayPosition),
        maximumPaperLeverage: integer(snapshot?.capabilities?.maximumPaperLeverage),
      }),
      charts: projectCharts(snapshot?.charts),
    },
  });
}

function assertPaperOnly(statusPayload, runPayload, expectedRunId) {
  const crypto = statusPayload?.cryptoFutures ?? statusPayload;
  if (crypto?.capabilities?.paper !== true
    || crypto?.executionGates?.paper !== true
    || crypto?.capabilities?.realOrder !== false
    || crypto?.executionGates?.realOrder !== false
    || crypto?.capabilities?.testnet !== false
    || crypto?.capabilities?.live !== false
    || crypto?.executionGates?.testnet !== false
    || crypto?.executionGates?.live !== false) {
    throw new MonitorError("Paper-only safety gate violation.", 2);
  }
  const run = runPayload?.run;
  const snapshot = runPayload?.snapshot;
  const hasSnapshot = snapshot !== null
    && typeof snapshot === "object"
    && !Array.isArray(snapshot);
  if (run?.id !== expectedRunId
    || run?.input?.market?.kind !== "crypto_futures"
    || run?.input?.execution?.mode !== "paper"
    || run?.input?.realOrder !== false
    || (hasSnapshot && snapshot.executionMode !== "paper")
    || (hasSnapshot && snapshot.capabilities !== undefined
      && (snapshot.capabilities.paper !== true || snapshot.capabilities.realOrder !== false))
    || (run?.summary?.realOrderApiUsed !== undefined
      && run.summary.realOrderApiUsed !== false)) {
    throw new MonitorError("Run paper-only invariant violation.", 2);
  }
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new MonitorError("Dashboard login did not establish a session.");
  const session = value.split(";", 1)[0]?.trim();
  if (!session) throw new MonitorError("Dashboard login did not establish a session.");
  return session;
}

async function fetchJson(url, options, label, lifecycleSignal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout, lifecycleSignal]);
  let response;
  try {
    response = await fetch(url, { ...options, redirect: "error", signal });
  } catch {
    if (lifecycleSignal.aborted) throw lifecycleSignal.reason;
    throw new MonitorError(`${label} request failed.`);
  }
  if (!response.ok) {
    const retryable = response.status === 408
      || response.status === 429
      || response.status >= 500;
    throw new MonitorError(
      `${label} returned HTTP ${response.status}.`,
      retryable ? 1 : 2,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new MonitorError(`${label} returned invalid JSON.`);
  }
}

async function loginSession(url, password, lifecycleSignal) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ password }),
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        lifecycleSignal,
      ]),
    });
  } catch {
    if (lifecycleSignal.aborted) throw lifecycleSignal.reason;
    throw new MonitorError("Dashboard login request failed.");
  }
  if (!response.ok) {
    throw new MonitorError(`Dashboard login returned HTTP ${response.status}.`, 2);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new MonitorError("Dashboard login returned invalid JSON.", 2);
  }
  if (payload?.authenticated !== true) throw new MonitorError("Dashboard login failed.", 2);
  return cookie(response);
}

function isTerminal(payload) {
  return TERMINAL_STATUSES.has(payload?.run?.status)
    || TERMINAL_STATUSES.has(payload?.snapshot?.phase);
}

function safeSummary(sample, failures = 0) {
  const run = sample?.run?.run;
  const snapshot = sample?.run?.snapshot;
  const status = run?.status ?? snapshot?.phase ?? "unknown";
  const progress = finite(run?.progress ?? snapshot?.progress);
  const triggered = integer(snapshot?.decisionCadence?.triggeredEvents);
  const blocked = boolean(snapshot?.futuresRisk?.newEntriesBlocked);
  return [
    new Date().toISOString(),
    `status=${status}`,
    `progress=${progress === undefined ? "unknown" : progress.toFixed(4)}`,
    `triggered=${triggered ?? "unknown"}`,
    `blocked=${blocked ?? "unknown"}`,
    `failures=${failures}`,
  ].join(" ");
}

function abortableSleep(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const [runId, configuredOutput, ...extra] = process.argv.slice(2);
if (!runId || extra.length > 0) throw new MonitorError(usage(), 64);
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
  throw new MonitorError(`runId must be a UUID. ${usage()}`, 64);
}

const intervalMs = requiredInteger("INTERVAL_MS", DEFAULT_INTERVAL_MS, 1_000, 300_000);
const timeoutMs = requiredInteger("TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 10_000, 24 * 60 * 60_000);
const baseUrl = normalizedBaseUrl();
const outputPath = path.resolve(
  configuredOutput
    || path.join(projectRoot, "data", `crypto-simulation-${runId}.jsonl`),
);
const lifecycle = new AbortController();
let receivedSignal;
for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    if (receivedSignal) return;
    receivedSignal = signalName;
    process.exitCode = signalName === "SIGINT" ? 130 : 143;
    lifecycle.abort(new MonitorError(`Monitor stopped by ${signalName}.`, signalName === "SIGINT" ? 130 : 143));
  });
}

let output;
try {
  await mkdir(path.dirname(outputPath), { recursive: true });
  output = await open(outputPath, "a", 0o600);
  await output.chmod(0o600);
  const sessionCookie = await loginSession(
    `${baseUrl}/api/auth/login`,
    await dashboardPassword(),
    lifecycle.signal,
  );
  const headers = { accept: "application/json", cookie: sessionCookie };
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;

  while (!lifecycle.signal.aborted) {
    if (Date.now() >= deadline) throw new MonitorError("Simulation monitor timed out.", 1);
    try {
      const [statusPayload, runPayload] = await Promise.all([
        fetchJson(
          `${baseUrl}/api/portfolio/simulation/status`,
          { headers },
          "Simulation status",
          lifecycle.signal,
        ),
        fetchJson(
          `${baseUrl}/api/portfolio/simulation/runs/${encodeURIComponent(runId)}`,
          { headers },
          "Simulation run",
          lifecycle.signal,
        ),
      ]);
      assertPaperOnly(statusPayload, runPayload, runId);
      consecutiveFailures = 0;
      const sample = compact({
        schemaVersion: "crypto-simulation-monitor/v1",
        kind: "poll",
        observedAt: new Date().toISOString(),
        status: projectStatus(statusPayload),
        run: projectRun(runPayload),
      });
      await output.appendFile(`${JSON.stringify(sample)}\n`, "utf8");
      process.stdout.write(`${safeSummary(sample)}\n`);
      if (isTerminal(runPayload)) break;
    } catch (error) {
      if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
      if (error instanceof MonitorError && error.exitCode === 2) throw error;
      consecutiveFailures += 1;
      process.stdout.write(
        `${new Date().toISOString()} status=retry progress=unknown triggered=unknown blocked=unknown failures=${consecutiveFailures}\n`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new MonitorError(
          `Simulation API failed ${MAX_CONSECUTIVE_FAILURES} consecutive times.`,
          1,
        );
      }
    }
    await abortableSleep(intervalMs, lifecycle.signal);
  }
} catch (error) {
  const safeError = error instanceof MonitorError
    ? error
    : new MonitorError("Simulation monitor failed.");
  process.stderr.write(`monitor-error: ${safeError.message}\n`);
  process.exitCode = safeError.exitCode;
} finally {
  await output?.close().catch(() => undefined);
}
