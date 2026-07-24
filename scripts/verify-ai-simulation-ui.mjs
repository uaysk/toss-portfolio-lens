import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDirectory = process.env.SIMULATION_UI_SCREENSHOT_DIR
  ? path.resolve(process.env.SIMULATION_UI_SCREENSHOT_DIR)
  : "/tmp/toss-portfolio-lens-simulation-ui";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function portfolio() {
  const account = {
    id: "simulation-ui",
    name: "시뮬레이션 UI 검증",
    label: "시뮬레이션 UI 검증",
    type: "STOCK",
  };
  return {
    asOf: "2026-07-24T00:20:00.000Z",
    accounts: [account],
    selectedAccountId: account.id,
    account,
    summary: {
      evaluationAmount: { KRW: 0, USD: 0 },
      purchaseAmount: { KRW: 0, USD: 0 },
      profitLoss: { KRW: 0, USD: 0 },
      dailyProfitLoss: { KRW: 0, USD: 0 },
      profitRate: 0,
      dailyProfitRate: 0,
      positionCount: 0,
    },
    holdings: [],
  };
}

function snapshot({
  phase,
  symbolCount,
  cancelled = false,
}) {
  const selected = Array.from({ length: symbolCount }, (_, index) => ({
    symbol: index === 0 ? "SIM1" : "SIM2",
    name: index === 0 ? "가상 성장주" : "가상 모멘텀주",
    score: 0.81 - index * 0.08,
    upProbability: 0.64 - index * 0.03,
    predictedMedianReturn: 0.006 - index * 0.001,
    model: {
      modelId: "amazon/chronos-bolt-small",
      modelRevision: "ui-fixture",
      device: "cuda",
    },
  }));
  return {
    phase,
    startedAt: "2026-07-24T00:20:00.000Z",
    expiresAt: "2026-07-24T01:05:00.000Z",
    marketCountry: "KR",
    currency: "KRW",
    initialCash: 2_500_000,
    cash: 1_482_000,
    equity: cancelled ? 2_525_000 : 2_536_000,
    progress: cancelled ? 1 : phase === "selecting" ? 0.05 : 0.42,
    decisionIntervalSeconds: 20,
    selected: phase === "selecting" ? [] : selected,
    positions: phase === "selecting" || cancelled ? [] : [{
      symbol: "SIM1",
      quantity: 20,
      averagePrice: 50_000,
      marketPrice: 50_900,
      unrealizedPnl: 18_000,
    }],
    trades: phase === "selecting" ? [] : [{
      symbol: "SIM1",
      side: "buy",
      executedAt: "2026-07-24T00:22:00.000Z",
      price: 50_000,
      quantity: 20,
      amount: 1_000_000,
      cost: 2_000,
      source: "next_valid_quote",
    }],
    decisions: phase === "selecting" ? [] : [{
      symbol: "SIM1",
      action: "buy",
      decidedAt: "2026-07-24T00:21:00.000Z",
      eligibleAfter: "2026-07-24T00:22:00.000Z",
      reason: "positive_risk_adjusted_score · entry_probability_threshold",
      score: 0.81,
      upProbability: 0.64,
      model: "amazon/chronos-bolt-small · ui-fixture",
    }],
    warnings: ["UI fixture는 실제 주문을 생성하지 않습니다."],
    capabilities: {
      realOrder: false,
      mcp: false,
      nextValidFillOnly: true,
    },
  };
}

export async function routeSimulationUiApi(page) {
  const state = {
    starts: [],
    polls: 0,
    cancels: [],
    active: new Map(),
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/session") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true }),
      });
    }
    if (url.pathname === "/api/portfolio") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(portfolio()),
      });
    }
    if (url.pathname === "/api/portfolio/simulation/status") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          limits: {
            minInitialCash: 100_000,
            maxInitialCash: 10_000_000_000,
            minDurationMinutes: 1,
            maxDurationMinutes: 390,
          },
          capabilities: {
            realOrder: false,
            mcp: false,
            autonomousPaperTrading: true,
          },
          policy: { decisionIntervalSeconds: 20 },
          limitations: ["가상 체결만 생성합니다."],
        }),
      });
    }
    if (url.pathname === "/api/portfolio/simulation/runs/current" && request.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ run: null, snapshot: null }),
      });
    }
    if (url.pathname === "/api/portfolio/simulation/runs" && request.method() === "POST") {
      const body = request.postDataJSON();
      const runId = `00000000-0000-4000-8000-${String(state.starts.length + 1).padStart(12, "0")}`;
      state.starts.push(body);
      state.active.set(runId, { body, cancelled: false });
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          runId,
          status: "running",
        }),
      });
    }
    const match = url.pathname.match(/^\/api\/portfolio\/simulation\/runs\/([^/]+)(\/cancel)?$/);
    if (match) {
      const runId = decodeURIComponent(match[1]);
      const active = state.active.get(runId);
      if (!active) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "fixture run not found" } }),
        });
      }
      if (match[2] === "/cancel" && request.method() === "POST") {
        active.cancelled = true;
        state.cancels.push(runId);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            run: { id: runId, status: "cancel_requested" },
            snapshot: snapshot({
              phase: "cancel_requested",
              symbolCount: active.body.symbolCount,
            }),
          }),
        });
      }
      if (!match[2] && request.method() === "GET") {
        state.polls += 1;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            run: { id: runId, status: active.cancelled ? "cancelled" : "running" },
            snapshot: snapshot({
              phase: active.cancelled ? "cancelled" : "monitoring",
              symbolCount: active.body.symbolCount,
              cancelled: active.cancelled,
            }),
          }),
        });
      }
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: `unhandled ${request.method()} ${url.pathname}` } }),
    });
  });
  return state;
}

async function verify(browser, baseUrl, viewport, theme) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript(({ selectedTheme }) => {
    window.localStorage.setItem("portfolio-theme", selectedTheme);
    history.scrollRestoration = "manual";
  }, { selectedTheme: theme });
  const page = await context.newPage();
  const errors = { console: [], page: [], request: [], response: [] };
  page.on("console", (message) => {
    if (message.type() === "error") errors.console.push(message.text());
  });
  page.on("pageerror", (error) => errors.page.push(error.message));
  page.on("requestfailed", (request) => errors.request.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.response.push(`${response.status()} ${response.url()}`);
  });
  const state = await routeSimulationUiApi(page);
  const requestedSymbolCount = viewport.width >= 1_000 ? 2 : 1;
  try {
    await page.goto(`${baseUrl}/?simulation-ui=${viewport.width}#simulation`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const actualViewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    check(
      actualViewport.width === viewport.width && actualViewport.height === viewport.height,
      `viewport 불일치: ${JSON.stringify(actualViewport)}`,
    );
    await page.getByRole("heading", { name: "시뮬레이션", exact: true }).waitFor();
    await page.locator("[data-ai-simulation]").waitFor();
    await page.getByText("실주문 없음, 투자 지시 아님, 다음 유효 체결만.", { exact: true }).waitFor();
    const actualTheme = await page.evaluate(() => (
      document.documentElement.classList.contains("dark") ? "dark" : "light"
    ));
    check(actualTheme === theme, `${viewport.width}px 테마가 ${theme}가 아니라 ${actualTheme}입니다.`);

    const startButton = page.getByRole("button", { name: "AI 시뮬레이션 시작", exact: true });
    await startButton.waitFor();
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((item) => item.textContent?.includes("AI 시뮬레이션 시작"));
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await page.waitForTimeout(900);
    check(state.starts.length === 0, "화면 진입만으로 시뮬레이션 run이 자동 시작됐습니다.");

    await page.getByRole("spinbutton", { name: "시작 예수금" }).fill("2500000");
    await page.getByRole("spinbutton", { name: "테스트 기간" }).fill("45");
    if (requestedSymbolCount === 2) {
      await page.getByRole("combobox", { name: "AI 선정 종목 수" }).click();
      await page.getByRole("option", { name: "2종목" }).click();
    }
    await startButton.click();
    await page.getByText("가상 원장을 준비하고 있습니다.", { exact: true }).waitFor({ timeout: 10_000 });
    const stopButton = page.getByRole("button", { name: "테스트 중단", exact: true });
    await stopButton.waitFor();
    check(state.starts.length === 1, "시작 버튼 한 번에 정확히 하나의 run이 생성되지 않았습니다.");
    check(state.starts[0]?.initialCash === 2_500_000, "시작 예수금이 요청 body에 보존되지 않았습니다.");
    check(state.starts[0]?.durationMinutes === 45, "테스트 기간이 요청 body에 보존되지 않았습니다.");
    check(state.starts[0]?.symbolCount === requestedSymbolCount, "AI 선정 종목 수가 요청 body에 보존되지 않았습니다.");
    check(state.starts[0]?.marketCountry === "KR", "기본 국내 시장이 요청 body에 보존되지 않았습니다.");
    check(state.starts[0]?.preset === "risk_management", "위험관리 프리셋이 요청 body에 보존되지 않았습니다.");

    await stopButton.click();
    await page.getByText("취소됨", { exact: true }).waitFor({ timeout: 10_000 });
    check(state.cancels.length === 1, "준비 단계 테스트 중단이 정확히 한 번 호출되지 않았습니다.");

    await startButton.waitFor();
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((item) => item.textContent?.includes("AI 시뮬레이션 시작"));
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await startButton.click();
    await page.getByText("가상 원장을 준비하고 있습니다.", { exact: true }).waitFor({ timeout: 10_000 });
    check(state.starts.length === 2, "준비 단계 중단 후 새 테스트를 다시 시작하지 못했습니다.");

    await page.getByText("시뮬레이션 진행", { exact: true }).waitFor({ timeout: 10_000 });
    await page.locator("[data-simulation-selected] article").first().waitFor();
    const selectedCount = await page.locator("[data-simulation-selected] article").count();
    check(
      selectedCount === requestedSymbolCount,
      `${viewport.width}px에서 AI 선택 종목이 ${requestedSymbolCount}개가 아니라 ${selectedCount}개입니다.`,
    );
    check(
      requestedSymbolCount === 1 || requestedSymbolCount === 2,
      "AI 선택 수는 1개 또는 2개여야 합니다.",
    );
    await page.getByText("SIM1 · 가상 매수", { exact: true }).first().waitFor();
    await page.getByText("positive_risk_adjusted_score · entry_probability_threshold", { exact: true }).waitFor();
    await page.getByText(/next_valid_quote/).waitFor();
    check(state.polls >= 1, "시작 후 run snapshot을 polling하지 않았습니다.");

    const measured = await page.locator([
      "[data-simulation-run]",
      "[data-simulation-selected]",
      "[data-simulation-positions]",
      "[data-simulation-trades]",
      "[data-simulation-decisions]",
    ].join(",")).evaluateAll((items) => items.map((item) => ({
      marker: Array.from(item.attributes).find((attribute) => attribute.name.startsWith("data-simulation"))?.name,
      width: item.getBoundingClientRect().width,
      height: item.getBoundingClientRect().height,
    })));
    const zeroSize = measured.filter(({ width, height }) => width <= 0 || height <= 0);
    check(zeroSize.length === 0, `${viewport.width}px에서 zero-size 시뮬레이션 요소가 있습니다: ${JSON.stringify(zeroSize)}`);

    const overflow = await page.evaluate(() => Math.max(
      0,
      document.documentElement.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
    ));
    check(overflow === 0, `${viewport.width}px에서 가로 overflow ${overflow}px`);

    await page.getByRole("button", { name: "테스트 중단", exact: true }).click();
    await page.getByText("취소됨", { exact: true }).waitFor({ timeout: 10_000 });
    check(state.cancels.length === 2, "각 테스트 중단이 정확히 한 번씩 cancel API를 호출하지 않았습니다.");
    check(
      Object.values(errors).every((items) => items.length === 0),
      `브라우저 오류: ${JSON.stringify(errors)}`,
    );

    await page.evaluate(() => window.scrollTo(0, 0));
    await mkdir(screenshotDirectory, { recursive: true });
    const screenshot = path.join(
      screenshotDirectory,
      `${viewport.width}x${viewport.height}-${theme}.png`,
    );
    await page.screenshot({ path: screenshot, animations: "disabled" });
    return {
      viewport: `${viewport.width}x${viewport.height}`,
      theme,
      manualStart: true,
      preparationStop: true,
      requestedSymbolCount,
      selectedCount,
      polls: state.polls,
      cancels: state.cancels.length,
      zeroSize: zeroSize.length,
      overflow,
      errors,
      screenshot,
    };
  } finally {
    await context.close();
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address && typeof address === "object", "포트를 할당하지 못했습니다.");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 다음 후보를 확인한다.
    }
  }
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite preview 조기 종료\n${output.join("")}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // 준비될 때까지 대기한다.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite preview 준비 시간 초과\n${output.join("")}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let preview;
  let browser;
  try {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  preview = spawn(
    process.execPath,
    [
      path.join(projectRoot, "node_modules/vite/bin/vite.js"),
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  preview.stdout.on("data", (chunk) => output.push(chunk.toString()));
  preview.stderr.on("data", (chunk) => output.push(chunk.toString()));
  await waitForServer(baseUrl, preview, output);
  const executablePath = await firstExecutable([
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
  ]);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
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
}
