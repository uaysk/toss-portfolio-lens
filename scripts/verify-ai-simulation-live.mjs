import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.env.SIMULATION_VERIFY_URL || "http://127.0.0.1:3200").replace(/\/+$/, "");
const marketCountry = process.env.SIMULATION_VERIFY_MARKET === "KR" ? "KR" : "US";
const configuredSelectionMode = process.env.SIMULATION_VERIFY_SELECTION_MODE?.trim();
const manualSymbols = (process.env.SIMULATION_VERIFY_SYMBOLS || "")
  .split(",")
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const selectionMode = configuredSelectionMode
  ? configuredSelectionMode === "manual" ? "manual" : "auto"
  : manualSymbols.length ? "manual" : "auto";
const symbolCount = Number(process.env.SIMULATION_VERIFY_SYMBOL_COUNT || 1);
const criterion = process.env.SIMULATION_VERIFY_CRITERION || "trading_amount";
const preset = process.env.SIMULATION_VERIFY_PRESET || "risk_management";
const riskTolerance = Number(process.env.SIMULATION_VERIFY_RISK_TOLERANCE || 25);
const durationMinutes = Number(process.env.SIMULATION_VERIFY_DURATION_MINUTES || 1);
const observeMs = Number(process.env.SIMULATION_VERIFY_OBSERVE_MS || 15_000);
const timeoutMs = Number(process.env.SIMULATION_VERIFY_TIMEOUT_MS || 180_000);
const selection = selectionMode === "manual"
  ? { mode: "manual", symbols: manualSymbols }
  : { mode: "auto", criterion, symbolCount };
const requestedSymbolCount = selectionMode === "manual" ? manualSymbols.length : symbolCount;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function envValue(source, key) {
  const line = source.split(/\r?\n/).find((item) => item.startsWith(`${key}=`));
  if (!line) return "";
  const raw = line.slice(key.length + 1).trim();
  if (raw.length >= 2 && (
    raw.startsWith("\"") && raw.endsWith("\"")
    || raw.startsWith("'") && raw.endsWith("'")
  )) return raw.slice(1, -1);
  return raw;
}

async function dashboardPassword() {
  const configured = process.env.DASHBOARD_PASSWORD?.trim();
  if (configured) return configured;
  const source = await readFile(path.join(projectRoot, ".env"), "utf8");
  const value = envValue(source, "DASHBOARD_PASSWORD");
  if (!value) throw new Error("DASHBOARD_PASSWORD 또는 .env의 DASHBOARD_PASSWORD가 필요합니다.");
  return value;
}

async function json(response, context) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `${response.status}`;
    throw new Error(`${context}: ${message}`);
  }
  return payload;
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("로그인 응답에 세션 쿠키가 없습니다.");
  return value.split(";", 1)[0];
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function terminal(payload) {
  const status = payload?.run?.status || payload?.status;
  const phase = payload?.snapshot?.phase;
  return ["completed", "cancelled", "failed"].includes(status)
    || ["completed", "cancelled", "failed"].includes(phase);
}

function assertCausalTrades(snapshot) {
  for (const decision of snapshot?.decisions || []) {
    const decidedAt = Date.parse(decision.decidedAt);
    const eligibleAfter = Date.parse(decision.eligibleAfter);
    const inputEndAt = Date.parse(decision.inputEndAt);
    assert(Number.isFinite(decidedAt) && Number.isFinite(eligibleAfter), "AI 판단 시각이 올바르지 않습니다.");
    assert(eligibleAfter >= decidedAt, "체결 가능 시각이 판단 기록 시각보다 이릅니다.");
    if (Number.isFinite(inputEndAt)) {
      assert(eligibleAfter >= inputEndAt, "체결 가능 시각이 AI 입력 종료 시각보다 이릅니다.");
    }
    assert(Array.isArray(decision.chartPatterns), "AI 판단의 차트 패턴 근거가 배열이 아닙니다.");
    assert(
      ["bullish", "bearish", "neutral"].includes(decision.chartPatternBias),
      "AI 판단의 차트 패턴 방향이 올바르지 않습니다.",
    );
  }
  for (const trade of snapshot?.trades || []) {
    const executedAt = Date.parse(trade.executedAt);
    const eligibleAfter = Date.parse(trade.signalEligibleAfter);
    assert(Number.isFinite(executedAt) && Number.isFinite(eligibleAfter), "가상 체결 시각이 올바르지 않습니다.");
    assert(executedAt > eligibleAfter, "판단 시각과 같거나 과거인 가격으로 가상 체결했습니다.");
    assert(Number.isSafeInteger(trade.quantity) && trade.quantity > 0, "가상 체결 수량이 양의 정수가 아닙니다.");
    assert(Number.isFinite(trade.totalCosts) && trade.totalCosts >= 0, "가상 체결 비용이 올바르지 않습니다.");
  }
}

function assertEventDrivenCadence(snapshot) {
  assert(
    snapshot?.decisionIntervalSeconds === undefined,
    "고정 초 단위 decisionIntervalSeconds가 v3 snapshot에 남아 있습니다.",
  );
  const cadence = snapshot?.decisionCadence;
  assert(cadence?.trigger === "finalized_one_minute_bar", "판단 trigger가 새 확정 1분봉 이벤트가 아닙니다.");
  for (const key of ["triggeredEvents", "coalescedEvents", "duplicateEvents"]) {
    const value = Number(cadence?.[key]);
    assert(Number.isSafeInteger(value) && value >= 0, `판단 cadence ${key}가 음이 아닌 정수가 아닙니다.`);
  }
  if (cadence.triggeredEvents > 0) {
    assert(Number.isFinite(Date.parse(cadence.lastTriggeredAt)), "판단 이벤트 시각이 없습니다.");
  }
  for (const key of ["lastTriggeredAt", "lastStartedAt", "lastFinishedAt"]) {
    if (cadence[key] !== undefined) {
      assert(Number.isFinite(Date.parse(cadence[key])), `판단 cadence ${key} 시각이 올바르지 않습니다.`);
    }
  }
}

function assertSimulationCharts(snapshot, symbols) {
  assert(Array.isArray(snapshot?.charts), "시뮬레이션 차트 목록이 없습니다.");
  assert(snapshot.charts.length === symbols.length, "선정 종목별 차트 수가 일치하지 않습니다.");
  const selected = new Set(symbols);
  for (const chart of snapshot.charts) {
    assert(selected.has(chart.symbol), `선정되지 않은 종목 ${chart.symbol} 차트가 포함됐습니다.`);
    assert(chart.currency === snapshot.currency, `${chart.symbol} 차트 통화가 snapshot과 다릅니다.`);
    assert(Array.isArray(chart.bars) && chart.bars.length > 0, `${chart.symbol} OHLC 차트 봉이 없습니다.`);
    assert(chart.bars.length <= 180, `${chart.symbol} 차트 봉이 180개 경계를 초과했습니다.`);
    let previousTimestamp = Number.NEGATIVE_INFINITY;
    for (const bar of chart.bars) {
      const timestamp = Date.parse(bar.timestamp);
      assert(Number.isFinite(timestamp) && timestamp > previousTimestamp, `${chart.symbol} 차트 봉 시각이 정렬·중복 제거되지 않았습니다.`);
      previousTimestamp = timestamp;
      assert(
        [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0),
        `${chart.symbol} 차트 OHLC 값이 올바르지 않습니다.`,
      );
      assert(bar.high >= Math.max(bar.open, bar.close, bar.low), `${chart.symbol} 차트 고가 경계가 올바르지 않습니다.`);
      assert(bar.low <= Math.min(bar.open, bar.close, bar.high), `${chart.symbol} 차트 저가 경계가 올바르지 않습니다.`);
      assert(["forming", "final", "unknown"].includes(bar.status), `${chart.symbol} 차트 봉 상태가 올바르지 않습니다.`);
      assert(
        bar.indicatorValues && typeof bar.indicatorValues === "object" && !Array.isArray(bar.indicatorValues),
        `${chart.symbol} 봉별 지표 값이 없습니다.`,
      );
    }
    assert(Array.isArray(chart.indicators) && chart.indicators.length > 0, `${chart.symbol} 최신 지표 목록이 없습니다.`);
    assert(
      chart.bars.some((bar) => Object.values(bar.indicatorValues).some(Number.isFinite)),
      `${chart.symbol} 봉별 기술 지표 값이 모두 비어 있습니다.`,
    );
    assert(Array.isArray(chart.patterns), `${chart.symbol} 차트 패턴 목록이 없습니다.`);
    for (const pattern of chart.patterns) {
      assert(Number.isFinite(Date.parse(pattern.detectedAt)), `${chart.symbol} 패턴 감지 시각이 올바르지 않습니다.`);
      assert(["bullish", "bearish", "neutral"].includes(pattern.bias), `${chart.symbol} 패턴 방향이 올바르지 않습니다.`);
    }
  }
}

assert(!configuredSelectionMode || ["auto", "manual"].includes(configuredSelectionMode), "SIMULATION_VERIFY_SELECTION_MODE는 auto 또는 manual이어야 합니다.");
assert(selectionMode === "manual" || symbolCount === 1 || symbolCount === 2, "SIMULATION_VERIFY_SYMBOL_COUNT는 1 또는 2여야 합니다.");
assert(selectionMode === "auto" || manualSymbols.length === 1 || manualSymbols.length === 2, "수동 선택 종목은 1개 또는 2개여야 합니다.");
assert(
  selectionMode === "auto" || new Set(manualSymbols).size === manualSymbols.length,
  "수동 선택 종목은 중복될 수 없습니다.",
);
assert(
  manualSymbols.every((symbol) => /^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)),
  "SIMULATION_VERIFY_SYMBOLS에 올바르지 않은 종목 코드가 있습니다.",
);
assert(["trading_amount", "volume", "volatility"].includes(criterion), "SIMULATION_VERIFY_CRITERION이 올바르지 않습니다.");
assert(["trend", "breakout", "mean_reversion", "risk_management"].includes(preset), "SIMULATION_VERIFY_PRESET이 올바르지 않습니다.");
assert(Number.isSafeInteger(riskTolerance) && riskTolerance >= 0 && riskTolerance <= 100, "공격·방어 성향은 0..100 정수여야 합니다.");
assert(Number.isSafeInteger(durationMinutes) && durationMinutes >= 1, "검증 기간은 1분 이상의 정수여야 합니다.");
assert(Number.isFinite(observeMs) && observeMs >= 0 && observeMs <= 120_000, "관찰 시간은 0..120000ms여야 합니다.");
assert(Number.isFinite(timeoutMs) && timeoutMs >= 10_000 && timeoutMs <= 600_000, "timeout은 10000..600000ms여야 합니다.");

const password = await dashboardPassword();
const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password }),
});
await json(loginResponse, "로그인 실패");
const sessionCookie = cookie(loginResponse);
const headers = { accept: "application/json", cookie: sessionCookie };

const status = await json(await fetch(`${baseUrl}/api/portfolio/simulation/status`, { headers }), "상태 조회 실패");
assert(status.schemaVersion === "ai-paper-simulation/v3", "시뮬레이션 status 계약이 v3가 아닙니다.");
assert(status.enabled === true, "AI 시뮬레이션이 비활성 상태입니다.");
assert(status.capabilities?.realOrder === false, "realOrder capability가 false가 아닙니다.");
assert(status.capabilities?.orderApiDependency === false, "orderApiDependency capability가 false가 아닙니다.");
assert(status.capabilities?.mcp === false, "mcp capability가 false가 아닙니다.");
assert(status.capabilities?.manualSymbolSelection === true, "수동 종목 선택 capability가 활성 상태가 아닙니다.");
assert(status.capabilities?.deterministicChartPatterns === true, "차트 패턴 capability가 활성 상태가 아닙니다.");
assert(status.capabilities?.eventDrivenDecisions === true, "이벤트 기반 판단 capability가 활성 상태가 아닙니다.");
assert(
  status.policy?.cadence === "event_driven_immediately_after_each_new_finalized_one_minute_bar",
  "판단 cadence가 새 확정 1분봉 즉시 방식이 아닙니다.",
);
assert(
  status.policy?.initialPortfolio === "cash_only_zero_holdings",
  "시뮬레이션 초기 원장이 현금 100%·보유 0주 정책이 아닙니다.",
);
assert(status.policy?.decisionIntervalSeconds === undefined, "status에 legacy 고정 판단 간격이 남아 있습니다.");
assert(status.limits?.decisionIntervalSeconds === undefined, "limits에 legacy 고정 판단 간격이 남아 있습니다.");

const start = await json(await fetch(`${baseUrl}/api/portfolio/simulation/runs`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({
    marketCountry,
    initialCash: marketCountry === "US" ? 100_000 : 10_000_000,
    durationMinutes,
    selection,
    preset,
    riskTolerance,
    costs: {
      commissionBpsPerSide: 1.5,
      taxBpsOnExit: marketCountry === "KR" ? 18 : 0,
      spreadBpsRoundTrip: 5,
      slippageBpsPerSide: 2,
    },
  }),
}), "시뮬레이션 시작 실패");
const runId = start.runId;
assert(typeof runId === "string" && runId.length > 0, "시뮬레이션 run ID가 없습니다.");

let latest = start;
let cancelled = false;
try {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    latest = await json(await fetch(
      `${baseUrl}/api/portfolio/simulation/runs/${encodeURIComponent(runId)}`,
      { headers },
    ), "시뮬레이션 조회 실패");
    if (latest?.snapshot?.phase === "running" || terminal(latest)) break;
    await sleep(1_000);
  }
  if (latest?.run?.status === "failed" || latest?.snapshot?.phase === "failed") {
    const detail = latest?.run?.error?.message
      || latest?.run?.warnings?.join(" · ")
      || "unknown";
    throw new Error(`실제 데이터 시뮬레이션 실패: ${detail}`);
  }
  assert(latest?.snapshot, "시뮬레이션 snapshot을 받지 못했습니다.");
  assert(
    latest.snapshot.phase === "running" || latest.snapshot.phase === "completed",
    `시뮬레이션이 실행 상태에 도달하지 못했습니다: ${latest.snapshot.phase}`,
  );
  assert(latest.snapshot.schemaVersion === "ai-paper-simulation/v3", "run snapshot 계약이 v3가 아닙니다.");
  assert(latest.snapshot.selection?.mode === selection.mode, "run snapshot 선택 방식이 요청과 다릅니다.");
  if (selection.mode === "manual") {
    assert(
      JSON.stringify(latest.snapshot.selection.symbols) === JSON.stringify(selection.symbols),
      "run snapshot 직접 선택 종목이 요청과 다릅니다.",
    );
  } else {
    assert(latest.snapshot.selection.criterion === selection.criterion, "run snapshot 자동 선정 기준이 요청과 다릅니다.");
    assert(latest.snapshot.selection.symbolCount === selection.symbolCount, "run snapshot 자동 선정 종목 수가 요청과 다릅니다.");
  }
  assert(latest.snapshot.preset === preset, "run snapshot 프리셋이 요청과 다릅니다.");
  assert(latest.snapshot.riskTolerance === riskTolerance, "run snapshot 공격·방어 성향이 요청과 다릅니다.");
  assert(latest.snapshot.initialCash === (marketCountry === "US" ? 100_000 : 10_000_000), "run snapshot 시작 예수금이 요청과 다릅니다.");
  assert(latest.snapshot.selected?.length === requestedSymbolCount, "AI 선정 종목 수가 요청과 다릅니다.");
  assert(new Set(latest.snapshot.selected.map(({ symbol }) => symbol)).size === requestedSymbolCount, "AI 선정 종목이 중복되었습니다.");
  if (selection.mode === "manual") {
    const selectedSymbols = new Set(latest.snapshot.selected.map(({ symbol }) => symbol));
    assert(
      selection.symbols.every((symbol) => selectedSymbols.has(symbol)),
      "직접 선택하지 않은 종목이 시뮬레이션 universe에 포함됐습니다.",
    );
  }
  for (const selectedItem of latest.snapshot.selected) {
    assert(selectedItem.model?.loaded === true, `${selectedItem.symbol} 모델이 loaded 상태가 아닙니다.`);
    assert(["cuda", "cpu"].includes(selectedItem.model?.device), `${selectedItem.symbol} 모델 장치가 올바르지 않습니다.`);
    assert(typeof selectedItem.model?.modelId === "string", `${selectedItem.symbol} 모델 ID가 없습니다.`);
  }
  assert(latest.snapshot.capabilities?.realOrder === false, "run snapshot realOrder가 false가 아닙니다.");
  assert(latest.snapshot.capabilities?.orderApiDependency === false, "run snapshot orderApiDependency가 false가 아닙니다.");
  assert(latest.snapshot.capabilities?.mcp === false, "run snapshot mcp가 false가 아닙니다.");
  assertEventDrivenCadence(latest.snapshot);
  assertSimulationCharts(
    latest.snapshot,
    latest.snapshot.selected.map(({ symbol }) => symbol),
  );
  assertCausalTrades(latest.snapshot);

  if (!terminal(latest) && observeMs > 0) {
    const decisionCountBeforeObserve = latest.snapshot.decisions?.length || 0;
    const triggeredEventsBeforeObserve = Number(
      latest.snapshot.decisionCadence?.triggeredEvents ?? 0,
    );
    const coalescedEventsBeforeObserve = Number(
      latest.snapshot.decisionCadence?.coalescedEvents ?? 0,
    );
    const lastStartedAtBeforeObserve = latest.snapshot.decisionCadence?.lastStartedAt;
    const lastTriggeredAtBeforeObserve = latest.snapshot.decisionCadence?.lastTriggeredAt;
    await sleep(observeMs);
    latest = await json(await fetch(
      `${baseUrl}/api/portfolio/simulation/runs/${encodeURIComponent(runId)}`,
      { headers },
    ), "시뮬레이션 관찰 조회 실패");
    assertEventDrivenCadence(latest.snapshot);
    assertSimulationCharts(
      latest.snapshot,
      latest.snapshot.selected.map(({ symbol }) => symbol),
    );
    assertCausalTrades(latest.snapshot);
    const triggeredEventsAfterObserve = Number(
      latest.snapshot?.decisionCadence?.triggeredEvents ?? 0,
    );
    const coalescedEventsAfterObserve = Number(
      latest.snapshot?.decisionCadence?.coalescedEvents ?? 0,
    );
    assert(
      triggeredEventsAfterObserve >= triggeredEventsBeforeObserve,
      "판단 이벤트 누적 수가 관찰 전보다 감소했습니다.",
    );
    assert(
      coalescedEventsAfterObserve >= coalescedEventsBeforeObserve,
      "판단 coalescing 누적 수가 관찰 전보다 감소했습니다.",
    );
    const decisionCountAfterObserve = latest.snapshot?.decisions?.length || 0;
    assert(decisionCountAfterObserve >= decisionCountBeforeObserve, "AI 판단 기록 수가 관찰 전보다 감소했습니다.");
    if (!terminal(latest) && triggeredEventsAfterObserve > triggeredEventsBeforeObserve) {
      assert(
        latest.snapshot?.decisionCadence?.lastTriggeredAt !== lastTriggeredAtBeforeObserve,
        "새 확정봉 판단 이벤트가 증가했지만 마지막 trigger 시각이 갱신되지 않았습니다.",
      );
      assert(
        latest.snapshot?.decisionCadence?.lastStartedAt !== lastStartedAtBeforeObserve
          || latest.snapshot?.decisionCadence?.inFlight === true
          || coalescedEventsAfterObserve > coalescedEventsBeforeObserve,
        "새 확정봉 이벤트가 발생했지만 즉시 분석 시작 또는 coalescing 근거가 없습니다.",
      );
      if (decisionCountAfterObserve === decisionCountBeforeObserve) {
        assert(
          latest.snapshot?.decisionCadence?.inFlight === true
            || (latest.snapshot?.warnings?.length || 0) > 0
            || latest.snapshot?.decisionCadence?.lastFinishedAt !== undefined,
          "판단 이벤트는 실행됐지만 진행·완료·unavailable 근거가 없습니다.",
        );
      }
    }
  }
} finally {
  if (!terminal(latest)) {
    latest = await json(await fetch(
      `${baseUrl}/api/portfolio/simulation/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", headers },
    ), "시뮬레이션 취소 실패");
    cancelled = true;
  }
}

const snapshot = latest.snapshot || {};
console.log(JSON.stringify({
  baseUrl,
  marketCountry,
  selection,
  preset,
  riskTolerance,
  runId,
  phase: snapshot.phase,
  selected: (snapshot.selected || []).map((item) => ({
    symbol: item.symbol,
    modelId: item.model?.modelId,
    modelRevision: item.model?.modelRevision,
    device: item.model?.device,
  })),
  decisionCount: snapshot.decisions?.length || 0,
  decisionCadence: snapshot.decisionCadence,
  charts: (snapshot.charts || []).map((chart) => ({
    symbol: chart.symbol,
    bars: chart.bars?.length || 0,
    indicators: chart.indicators?.length || 0,
    patterns: chart.patterns?.length || 0,
  })),
  decisions: (snapshot.decisions || []).map((item) => ({
    symbol: item.symbol,
    action: item.action,
    reason: item.reason,
    eligibleAfter: item.eligibleAfter,
  })),
  tradeCount: snapshot.trades?.length || 0,
  openPositionCount: snapshot.positions?.length || 0,
  equity: snapshot.equity,
  cancelledByVerifier: cancelled,
  realOrder: snapshot.capabilities?.realOrder,
  orderApiDependency: snapshot.capabilities?.orderApiDependency,
  mcp: snapshot.capabilities?.mcp,
  warnings: snapshot.warnings || [],
}));
