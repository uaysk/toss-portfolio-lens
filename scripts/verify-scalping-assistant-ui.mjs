import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDirectory = process.env.SCALPING_UI_SCREENSHOT_DIR
  ? path.resolve(process.env.SCALPING_UI_SCREENSHOT_DIR)
  : "/tmp/toss-portfolio-lens-scalping-ui";
const symbols = Array.from({ length: 22 }, (_, index) => `S${String(index + 1).padStart(3, "0")}`);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function timestamp(index, dayOffset = 0) {
  return new Date(Date.UTC(2026, 6, 21 + dayOffset, 0, index + 1)).toISOString();
}

function bars(symbolIndex) {
  return Array.from({ length: 80 }, (_, index) => {
    const close = 50_000 + symbolIndex * 400 + index * 12 + Math.sin(index / 4) * 80;
    const open = close - Math.sin(index / 3) * 35;
    return {
      symbol: symbols[symbolIndex], intervalMinutes: 1,
      openTime: new Date(Date.parse(timestamp(index)) - 60_000).toISOString(), closeTime: timestamp(index),
      sessionDate: "2026-07-21", source: "kis_ws", state: index === 79 ? "forming" : "final",
      open, high: Math.max(open, close) + 50, low: Math.min(open, close) - 50, close,
      volume: 10_000 + index * 50, turnover: close * (10_000 + index * 50), quality: "complete", updatedAt: Date.now(),
    };
  });
}

function points(series, field, transform) {
  return series.map((bar, index) => ({ timestamp: bar.closeTime, state: "available", values: { [field]: transform(bar, index) } }));
}

function technical(symbolIndex, series) {
  const latest = series.at(-2);
  return {
    instrument_key: symbols[symbolIndex],
    indicators: [{
      instrument_key: symbols[symbolIndex], indicator_id: "trend-ema-fast", kind: "ema",
      availability: { status: "available", reason: "calculated" },
      points: points(series.slice(0, -1), "value", (bar) => bar.close * 0.999),
    }],
    intraday: {
      session_vwap: { availability: { status: "available" }, points: points(series.slice(0, -1), "session_vwap", (bar) => bar.close * 0.998) },
      anchored_vwap: { availability: { status: "available" }, points: points(series.slice(0, -1), "anchored_vwap", (bar) => bar.close * 0.996) },
      opening_range_5: { latest: { timestamp: latest.closeTime, values: { high: latest.high * 1.002, low: latest.low * 0.998 } } },
      opening_range_15: { latest: { timestamp: latest.closeTime, values: { high: latest.high * 1.004, low: latest.low * 0.996 } } },
      opening_range_30: { latest: { timestamp: latest.closeTime, values: { high: latest.high * 1.006, low: latest.low * 0.994 } } },
      time_of_day_relative_volume: { latest: { timestamp: latest.closeTime, values: { relative_volume: 1.4 + symbolIndex / 100 } } },
      previous_session_levels: { latest: { timestamp: latest.closeTime, values: { previous_high: latest.high * 1.01, previous_low: latest.low * 0.99, previous_close: latest.close * 0.997 } } },
      current_session_levels: { latest: { timestamp: latest.closeTime, values: { session_open: series[0].open, session_high: latest.high, session_low: series[0].low } } },
      orderbook_imbalance: { values: { orderbook_imbalance: 0.12 } },
      execution_strength: { values: { execution_strength_percent: 118 } },
    },
    signals: { latest: {
      status: symbolIndex % 4 === 0 ? "entry_candidate" : symbolIndex % 4 === 1 ? "hold" : symbolIndex % 4 === 2 ? "exit_candidate" : "watch",
      calculation_timestamp: latest.closeTime, signal_timestamp: latest.closeTime,
      earliest_eligible_timestamp: timestamp(80), basis_price: latest.close,
      expected_entry_range: { low: latest.close * 0.998, high: latest.close * 1.002 },
      stop_candidate_price: latest.close * 0.99, target_price_range: { low: latest.close * 1.015, high: latest.close * 1.02 },
      expected_reward_risk_ratio: 2, indicators: ["trend-ema-fast"], multi_timeframe_agreement: "aligned_bullish",
      confidence: 0.78, data_quality: { status: "available", reason: "finalized_ohlcv_bar_available" },
    } },
    volume_profile: { availability: { status: "available" }, profile: {
      point_of_control: latest.close, value_area_high: latest.close * 1.01, value_area_low: latest.close * 0.99,
      approximation: "bar_hlc3_times_bar_volume",
      buckets: Array.from({ length: 12 }, (_, index) => ({ price_low: latest.close * (0.98 + index * 0.003), price_high: latest.close * (0.983 + index * 0.003), volume: 1_000 + index * 150 })),
    } },
    data_quality: { status: "available", reasons: [] },
  };
}

function portfolio() {
  const holdings = symbols.slice(0, 4).map((symbol, index) => ({
    symbol, name: `보유 종목 ${index + 1}`, market: "KOSPI", currency: "KRW", quantity: 10,
    availableQuantity: 10, averagePrice: 49_000 + index * 400, currentPrice: 51_000 + index * 400,
    purchaseAmount: 490_000 + index * 4_000, evaluationAmount: 510_000 + index * 4_000,
    profitLoss: 20_000, profitRate: 4.08, dailyProfitLoss: 1_000, dailyProfitRate: 0.2,
  }));
  const account = { id: "scalping-ui", name: "UI 검증", label: "UI 검증", type: "STOCK" };
  return {
    asOf: "2026-07-21T15:30:00+09:00", accounts: [account], selectedAccountId: account.id, account,
    summary: { evaluationAmount: { KRW: 2_000_000, USD: 0 }, purchaseAmount: { KRW: 1_900_000, USD: 0 }, profitLoss: { KRW: 100_000, USD: 0 }, dailyProfitLoss: { KRW: 4_000, USD: 0 }, profitRate: 5.26, dailyProfitRate: 0.2, positionCount: holdings.length },
    holdings,
  };
}

function workspace(body) {
  const marketCountry = body.marketCountry === "US" ? "US" : "KR";
  const selected = symbols.slice(0, body.topCount);
  return { workspace: {
    generatedAt: "2026-07-21T01:20:00.000Z", marketCountry, criterion: body.criterion, requestedTopCount: body.topCount,
    interval: body.interval, layoutColumns: body.layoutColumns, preset: body.preset,
    candidates: selected.map((symbol, index) => ({
      symbol, ...(marketCountry === "US" ? { exchange: ["NAS", "NYS", "AMS"][index % 3] } : {}),
      name: `${marketCountry === "US" ? "미국" : "국내"} 단타 후보 ${index + 1}`, currency: marketCountry === "US" ? "USD" : "KRW", price: 51_000 + index * 400,
      changeRateRatio: 0.01 + index / 10_000, volume: 2_000_000 - index * 10_000,
      tradingAmount: 20_000_000_000 - index * 100_000_000, volatilityScore: 0.9 - index / 100,
      spreadBps: 4 + index / 10, providerRanks: { toss: index + 1, kis: index + 2 }, warnings: [],
      quality: { status: "available", reasons: [], missing: [], sources: ["toss", "kis"], observedAt: "2026-07-21T01:20:00.000Z" },
    })),
    instruments: selected.map((symbol, index) => {
      const series = bars(index);
      const latest = series.at(-1);
      return {
        symbol, bars: series, technical: technical(index, series),
        realtime: {
          orderbook: { provider: "kis", symbol, observedAt: latest.closeTime, asks: [{ price: latest.close + 10, quantity: 100 }, { price: latest.close + 20, quantity: 80 }], bids: [{ price: latest.close, quantity: 120 }, { price: latest.close - 10, quantity: 90 }] },
          historicalOrderbook: { status: "unavailable", reason: "historical_orderbook_not_supplied" },
          trade: { executionStrength: 118 },
        },
        position: index < 4 ? { quantity: 10, averagePrice: latest.close * 0.97, profitRate: 3.1 } : { status: "unavailable" },
        tradeMarkers: index < 4 ? [{ id: `trade-${index}`, side: "buy", filled_quantity: 10, average_filled_price: latest.close * 0.97, details: [{ filled_at: timestamp(12), filled_quantity: 10 }] }] : [],
        prediction: { status: "unavailable", reason: "prediction_not_generated" },
      };
    }),
    quality: { status: "available", reasons: [], missing: [], sources: ["toss", "kis"], observedAt: "2026-07-21T01:20:00.000Z" },
  } };
}

function predictions(body) {
  const generatedAt = "2026-07-21T01:21:00.000Z";
  const model = { model_id: "NeoQuasar/Kronos-small", model_revision: "pinned-test", source_revision: "source-test", device: "cuda", dtype: "float32" };
  return {
    forecast: { generated_at: generatedAt, model },
    predictions: body.symbols.map((symbol) => ({
      symbol, status: "available", modelName: model.model_id, modelVersion: model.model_revision,
      inputEndedAt: "2026-07-21T01:20:00.000Z", generatedAt,
      payload: { model, forecast: {
        instrument_key: symbol, status: "available", input_end_at: "2026-07-21T01:20:00.000Z",
        input_quality: { status: "good", warnings: [] }, distribution_shift: { status: "unavailable", reason: "reference_statistics_not_published" },
        horizons: [5, 15, 30, 60].map((minutes) => ({
          horizon_minutes: minutes, target_timestamp: new Date(Date.parse("2026-07-21T01:20:00.000Z") + minutes * 60_000).toISOString(),
          return_quantiles: [{ quantile: 0.1, value: -0.004 }, { quantile: 0.5, value: 0.002 }, { quantile: 0.9, value: 0.008 }],
          price_quantiles: [{ quantile: 0.1, value: 50_800 }, { quantile: 0.5, value: 51_100 }, { quantile: 0.9, value: 51_500 }],
          up_probability: 0.58, down_probability: 0.42, expected_volatility: 0.006, uncertainty_interval_width: 0.012,
          target_stop: { target_first_probability_lower: 0.51, target_first_probability_upper: 0.61 },
        })),
      } },
    })),
  };
}

async function routeApi(page) {
  const state = { workspaces: [], forecasts: [], evaluations: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/session") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true }) });
    if (url.pathname === "/api/portfolio") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(portfolio()) });
    if (url.pathname === "/api/portfolio/scalping/status") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, limits: { topCount: { minimum: 5, maximum: 50 } }, providers: { toss: { configured: true }, kis: { configured: true, websocket: { connection: "connected" } }, ai: { configured: true }, rust: { configured: true } }, capabilities: { autoOrder: false, mcp: false, historicalOrderbook: false }, limitations: ["과거 호가 이력 unavailable"] }) });
    if (url.pathname === "/api/portfolio/scalping/workspace") {
      const body = request.postDataJSON(); state.workspaces.push(body);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspace(body)) });
    }
    if (url.pathname === "/api/portfolio/scalping/forecast") {
      const body = request.postDataJSON(); state.forecasts.push(body);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(predictions(body)) });
    }
    if (url.pathname === "/api/portfolio/scalping/evaluations") {
      const body = request.postDataJSON(); state.evaluations.push(body);
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ run: { id: "scalping-eval-1", status: "queued" }, reused: false, retrospective: true }) });
    }
    if (url.pathname === "/api/portfolio/advanced/runs/scalping-eval-1/result") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: "scalping-eval-1", kind: "scalping_prediction_evaluation", status: "completed", progress: 1, completedCandidates: 88, totalCandidates: 88, warnings: [], artifacts: [{ type: "scalping-evaluation-summary", rowCount: 4, byteCount: 4096 }] }) });
    }
    if (url.pathname === "/api/portfolio/advanced/runs/scalping-eval-1/artifacts/scalping-evaluation-summary") {
      const metric = (horizon) => ({ horizon_minutes: horizon, overall: { count: 22, direction_accuracy: 0.59, mae: 0.004, rmse: 0.006 }, quantile_coverage: [{ quantile: 0.1, value: 0.14 }, { quantile: 0.9, value: 0.86 }], up_probability_brier: 0.22, target_stop_first_count: 8, target_stop_first_accuracy: 0.625, calibration: Array.from({ length: 10 }, (_, index) => ({ lower: index / 10, upper: (index + 1) / 10, count: 0 })), by_symbol: { "005930": { count: 1, direction_accuracy: 1, mae: 0.001, rmse: 0.001 } }, by_time: { "09": { count: 22, direction_accuracy: 0.59, mae: 0.004, rmse: 0.006 } }, by_regime: { aligned_bullish: { count: 12, direction_accuracy: 0.66, mae: 0.003, rmse: 0.005 } }, strategy_comparison: { technical_trade_count: 12, ai_filtered_trade_count: 7, technical_net_return: 0.02, ai_filtered_net_return: 0.03, technical_max_drawdown: 0.04, ai_filtered_max_drawdown: 0.025 } });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content: [5, 15, 30, 60].map(metric) }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: `unhandled ${url.pathname}` } }) });
  });
  return state;
}

async function verify(browser, baseUrl, viewport, theme) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript(({ selectedTheme }) => {
    window.localStorage.setItem("portfolio-theme", selectedTheme);
    history.scrollRestoration = "manual";
    window.__scalpingEventSourceUrls = [];
    class StaticEventSource {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      CONNECTING = 0; OPEN = 1; CLOSED = 2; readyState = 0; url; withCredentials = false;
      onopen = null; onmessage = null; onerror = null;
      constructor(url) { this.url = String(url); window.__scalpingEventSourceUrls.push(this.url); setTimeout(() => { this.readyState = 1; this.onopen?.(new Event("open")); }, 0); }
      addEventListener() {} removeEventListener() {} dispatchEvent() { return true; } close() { this.readyState = 2; }
    }
    window.EventSource = StaticEventSource;
  }, { selectedTheme: theme });
  const page = await context.newPage();
  const errors = { console: [], page: [], request: [], response: [] };
  page.on("console", (message) => { if (message.type() === "error") errors.console.push(message.text()); });
  page.on("pageerror", (error) => errors.page.push(error.message));
  page.on("requestfailed", (request) => errors.request.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => { if (response.status() >= 400) errors.response.push(`${response.status()} ${response.url()}`); });
  const state = await routeApi(page);
  try {
    await page.goto(`${baseUrl}/?capture=${viewport.width}#scalping-assistant`, { waitUntil: "domcontentloaded" });
    const actualViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    check(actualViewport.width === viewport.width && actualViewport.height === viewport.height, `viewport 불일치: ${JSON.stringify(actualViewport)}`);
    await page.getByRole("heading", { name: "단타 보조", exact: true }).waitFor();
    await page.getByRole("heading", { name: "국내 · 거래대금 상위 10종목", exact: true }).waitFor({ timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => window.scrollY === 0);
    check(state.workspaces.length === 1 && state.workspaces[0]?.marketCountry === "KR", "초기 국내 workspace가 단일 batch 요청이 아닙니다.");
    check(await page.locator("[data-scalping-virtual-symbol]").count() === 10, "초기 후보 카드 수가 10개가 아닙니다.");
    const scanStartedAt = Date.now();
    await page.getByRole("spinbutton", { name: "표시 종목 수" }).fill("22");
    await page.getByRole("button", { name: "스캔 적용" }).click();
    await page.getByRole("heading", { name: "국내 · 거래대금 상위 22종목", exact: true }).waitFor({ timeout: 20_000 });
    await page.locator("[data-scalping-virtual-symbol]").nth(21).waitFor();
    const twentyTwoRenderMs = Date.now() - scanStartedAt;
    check(state.workspaces.length === 2 && state.workspaces[1]?.topCount === 22, "22종목 workspace가 단일 batch 요청이 아닙니다.");
    check(await page.locator("[data-scalping-virtual-symbol]").count() === 22, "20개 이상 후보 카드가 렌더되지 않았습니다.");
    const placeholders = await page.locator('[data-scalping-card-state="placeholder"]').count();
    check(placeholders > 0, "viewport 밖 차트가 실제 placeholder로 unmount되지 않았습니다.");
    const mounted = await page.locator('[data-scalping-card-state="mounted"]').count();
    check(mounted < 22, "22종목 차트를 초기 viewport에서 모두 동시에 mount했습니다.");

    await page.getByRole("button", { name: "미국 상장 종목 스캔" }).click();
    await page.locator('[data-scalping-market-guidance="US"]').waitFor();
    await page.getByRole("button", { name: "스캔 적용" }).click();
    await page.getByRole("heading", { name: "미국 · 거래대금 상위 22종목", exact: true }).waitFor({ timeout: 20_000 });
    check(state.workspaces.length === 3 && state.workspaces[2]?.marketCountry === "US", "미국 workspace 요청에 marketCountry=US가 전달되지 않았습니다.");
    check(await page.getByText("USD · 미국 정규장(09:30–16:00 ET)", { exact: false }).count() > 0, "미국 시장 통화·정규장 안내가 표시되지 않았습니다.");
    await page.waitForFunction(() => window.__scalpingEventSourceUrls?.some((value) => {
      const url = new URL(value, location.origin);
      return url.searchParams.get("marketCountry") === "US" && url.searchParams.get("exchanges")?.includes("S001:NAS");
    }));

    await page.getByRole("combobox", { name: "차트 열 수" }).click();
    await page.getByRole("option", { name: "4열" }).click();
    await page.locator('[data-scalping-grid-columns="4"]').waitFor();
    const firstRow = await page.locator("[data-scalping-virtual-symbol]").evaluateAll((items) => items.slice(0, 4).map((item) => ({ x: item.getBoundingClientRect().x, y: item.getBoundingClientRect().y })));
    if (viewport.width === 1440) {
      check(firstRow.length === 4 && firstRow.every((item) => Math.abs(item.y - firstRow[0].y) < 2), `1440px 4열 배치가 아닙니다: ${JSON.stringify(firstRow)}`);
      check(new Set(firstRow.map((item) => Math.round(item.x))).size === 4, "1440px 4열 x 위치가 중복됩니다.");
    } else {
      check(firstRow.every((item) => Math.abs(item.x - firstRow[0].x) < 2), `390px에서 1열로 축소되지 않았습니다: ${JSON.stringify(firstRow)}`);
    }

    await page.getByRole("button", { name: "AI 전망 요청" }).click();
    await page.locator('[data-scalping-ai="available"]').first().waitFor();
    check(state.forecasts[0]?.symbols.length === 22, "AI 예측이 22종목 batch가 아닙니다.");
    check(state.forecasts[0]?.marketCountry === "US", "AI 예측 요청에 적용된 미국 시장이 전달되지 않았습니다.");
    await page.getByRole("button", { name: "Walk-forward 검증 시작" }).click();
    await page.locator("[data-scalping-evaluation-results]").waitFor().catch(async (error) => {
      const alerts = await page.getByRole("alert").allTextContents();
      const status = await page.locator("[data-scalping-evaluation] [role=status]").allTextContents();
      throw new Error(`${error.message}\n평가 alerts=${JSON.stringify(alerts)} status=${JSON.stringify(status)}`);
    });
    check(state.evaluations[0]?.evaluation?.walkForward === true && state.evaluations[0]?.evaluation?.retrospective === true, "시간 순서 retrospective 평가 요청이 아닙니다.");
    check(state.evaluations[0]?.symbols?.length === 22, "예측 검증이 22종목 batch가 아닙니다.");
    check(state.evaluations[0]?.marketCountry === "US", "예측 검증 요청에 적용된 미국 시장이 전달되지 않았습니다.");

    const last = page.locator("[data-scalping-virtual-symbol]").last();
    await last.scrollIntoViewIfNeeded();
    await last.locator("[data-scalping-price-chart]").waitFor({ timeout: 20_000 });
    const clippedCardDetails = await page.locator("[data-scalping-symbol]").evaluateAll((items) => items.flatMap((item) => item.scrollWidth > item.clientWidth + 1 ? [{ symbol: item.getAttribute("data-scalping-symbol"), clientWidth: item.clientWidth, scrollWidth: item.scrollWidth }] : []));
    const clippedCards = clippedCardDetails.length;
    check(clippedCards === 0, `${viewport.width}px에서 카드 내부 콘텐츠가 잘렸습니다: ${JSON.stringify(clippedCardDetails)}`);
    const zeroCharts = await page.locator("[data-scalping-price-chart]").evaluateAll((items) => items.filter((item) => item.getBoundingClientRect().width <= 0 || item.getBoundingClientRect().height <= 0).length);
    check(zeroCharts === 0, `${viewport.width}px에서 zero-size chart가 있습니다.`);
    const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth, document.body.scrollWidth - window.innerWidth));
    check(overflow === 0, `${viewport.width}px에서 가로 overflow ${overflow}px`);
    check(Object.values(errors).every((items) => items.length === 0), `브라우저 오류: ${JSON.stringify(errors)}`);
    await page.goto(`${baseUrl}/?screenshot=${viewport.width}#scalping-assistant`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "실시간 후보와 위험을 한눈에.", exact: true }).waitFor();
    await page.getByRole("heading", { name: "국내 · 거래대금 상위 10종목", exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole("spinbutton", { name: "표시 종목 수" }).fill("22");
    await page.getByRole("button", { name: "스캔 적용" }).click();
    await page.getByRole("heading", { name: "국내 · 거래대금 상위 22종목", exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole("combobox", { name: "차트 열 수" }).click();
    await page.getByRole("option", { name: "4열" }).click();
    await page.locator('[data-scalping-grid-columns="4"]').waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => window.scrollY === 0);
    await page.waitForTimeout(250);
    check(await page.evaluate(() => window.scrollY) === 0, "스크린샷 전 최상단 위치가 아닙니다.");
    await mkdir(screenshotDirectory, { recursive: true });
    const screenshot = path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-${theme}.png`);
    await page.screenshot({ path: screenshot, animations: "disabled" });
    check(Object.values(errors).every((items) => items.length === 0), `스크린샷 검증 중 브라우저 오류: ${JSON.stringify(errors)}`);
    return { viewport: `${viewport.width}x${viewport.height}`, theme, cards: 22, layoutColumns: viewport.width === 1440 ? 4 : 1, twentyTwoRenderMs, initialMounted: mounted, initialPlaceholders: placeholders, clippedCards, zeroCharts, overflow, errors, screenshot };
  } finally {
    await context.close();
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); check(address && typeof address === "object", "포트를 할당하지 못했습니다.");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* 다음 후보 */ }
  }
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite preview 조기 종료\n${output.join("")}`);
    try { if ((await fetch(url)).ok) return; } catch { /* 준비 대기 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite preview 준비 시간 초과\n${output.join("")}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

let preview;
let browser;
try {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  preview = spawn(process.execPath, [path.join(projectRoot, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  preview.stdout.on("data", (chunk) => output.push(chunk.toString()));
  preview.stderr.on("data", (chunk) => output.push(chunk.toString()));
  await waitForServer(baseUrl, preview, output);
  const executablePath = await firstExecutable([process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable"]);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const results = [
    await verify(browser, baseUrl, { width: 1440, height: 1000 }, "dark"),
    await verify(browser, baseUrl, { width: 390, height: 844 }, "light"),
  ];
  console.info(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stop(preview);
}
