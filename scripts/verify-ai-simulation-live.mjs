import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.env.SIMULATION_VERIFY_URL || "http://127.0.0.1:3200").replace(/\/+$/, "");
const marketCountry = process.env.SIMULATION_VERIFY_MARKET === "KR" ? "KR" : "US";
const symbolCount = Number(process.env.SIMULATION_VERIFY_SYMBOL_COUNT || 1);
const durationMinutes = Number(process.env.SIMULATION_VERIFY_DURATION_MINUTES || 1);
const observeMs = Number(process.env.SIMULATION_VERIFY_OBSERVE_MS || 15_000);
const timeoutMs = Number(process.env.SIMULATION_VERIFY_TIMEOUT_MS || 180_000);

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

assert(symbolCount === 1 || symbolCount === 2, "SIMULATION_VERIFY_SYMBOL_COUNT는 1 또는 2여야 합니다.");
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
assert(status.enabled === true, "AI 시뮬레이션이 비활성 상태입니다.");
assert(status.capabilities?.realOrder === false, "realOrder capability가 false가 아닙니다.");
assert(status.capabilities?.orderApiDependency === false, "orderApiDependency capability가 false가 아닙니다.");
assert(status.capabilities?.mcp === false, "mcp capability가 false가 아닙니다.");
const decisionIntervalSeconds = Number(
  status.policy?.decisionIntervalSeconds
  ?? status.limits?.decisionIntervalSeconds,
);
assert(
  Number.isSafeInteger(decisionIntervalSeconds)
    && decisionIntervalSeconds >= 10
    && decisionIntervalSeconds <= 30,
  "AI 판단 간격이 10~30초 범위를 벗어났습니다.",
);

const start = await json(await fetch(`${baseUrl}/api/portfolio/simulation/runs`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({
    marketCountry,
    criterion: "trading_amount",
    initialCash: marketCountry === "US" ? 100_000 : 10_000_000,
    durationMinutes,
    symbolCount,
    preset: "risk_management",
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
  assert(latest.snapshot.selected?.length === symbolCount, "AI 선정 종목 수가 요청과 다릅니다.");
  assert(new Set(latest.snapshot.selected.map(({ symbol }) => symbol)).size === symbolCount, "AI 선정 종목이 중복되었습니다.");
  for (const selection of latest.snapshot.selected) {
    assert(selection.model?.loaded === true, `${selection.symbol} 모델이 loaded 상태가 아닙니다.`);
    assert(["cuda", "cpu"].includes(selection.model?.device), `${selection.symbol} 모델 장치가 올바르지 않습니다.`);
    assert(typeof selection.model?.modelId === "string", `${selection.symbol} 모델 ID가 없습니다.`);
  }
  assert(latest.snapshot.capabilities?.realOrder === false, "run snapshot realOrder가 false가 아닙니다.");
  assert(latest.snapshot.capabilities?.orderApiDependency === false, "run snapshot orderApiDependency가 false가 아닙니다.");
  assert(latest.snapshot.capabilities?.mcp === false, "run snapshot mcp가 false가 아닙니다.");
  assert(
    latest.snapshot.decisionIntervalSeconds === decisionIntervalSeconds,
    "run snapshot 판단 간격이 status 설정과 다릅니다.",
  );
  assertCausalTrades(latest.snapshot);

  if (!terminal(latest) && observeMs > 0) {
    const decisionCountBeforeObserve = latest.snapshot.decisions?.length || 0;
    const scheduledTicksBeforeObserve = Number(
      latest.snapshot.decisionCadence?.scheduledTicks ?? 0,
    );
    const coalescedTicksBeforeObserve = Number(
      latest.snapshot.decisionCadence?.coalescedTicks ?? 0,
    );
    const lastStartedAtBeforeObserve = latest.snapshot.decisionCadence?.lastStartedAt;
    await sleep(observeMs);
    latest = await json(await fetch(
      `${baseUrl}/api/portfolio/simulation/runs/${encodeURIComponent(runId)}`,
      { headers },
    ), "시뮬레이션 관찰 조회 실패");
    assertCausalTrades(latest.snapshot);
    if (!terminal(latest) && observeMs >= (decisionIntervalSeconds + 10) * 1_000) {
      assert(
        Number(latest.snapshot?.decisionCadence?.scheduledTicks ?? 0) > scheduledTicksBeforeObserve,
        `${decisionIntervalSeconds}초 판단 주기 timer가 실행되지 않았습니다.`,
      );
      assert(
        latest.snapshot?.decisionCadence?.lastStartedAt !== lastStartedAtBeforeObserve
          || latest.snapshot?.decisionCadence?.inFlight === true
          || Number(latest.snapshot?.decisionCadence?.coalescedTicks ?? 0) > coalescedTicksBeforeObserve,
        "판단 tick이 예약됐지만 실제 분석 시작 또는 coalescing 근거가 없습니다.",
      );
      const decisionCountAfterObserve = latest.snapshot?.decisions?.length || 0;
      if (decisionCountAfterObserve === decisionCountBeforeObserve) {
        assert(
          latest.snapshot?.decisionCadence?.inFlight === true
            || (latest.snapshot?.warnings?.length || 0) > 0
            || latest.snapshot?.decisionCadence?.lastFinishedAt !== undefined,
          "판단 tick은 실행됐지만 진행·완료·unavailable 근거가 없습니다.",
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
  runId,
  phase: snapshot.phase,
  selected: (snapshot.selected || []).map((item) => ({
    symbol: item.symbol,
    modelId: item.model?.modelId,
    modelRevision: item.model?.modelRevision,
    device: item.model?.device,
  })),
  decisionCount: snapshot.decisions?.length || 0,
  decisionIntervalSeconds: snapshot.decisionIntervalSeconds,
  decisionCadence: snapshot.decisionCadence,
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
