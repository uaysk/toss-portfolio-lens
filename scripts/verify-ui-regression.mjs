import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { routeApplicationApi as routePortfolioUiApi } from "./capture-readme.mjs";
import { routeSimulationUiApi } from "./verify-ai-simulation-ui.mjs";
import { routeScalpingUiApi } from "./verify-scalping-assistant-ui.mjs";
import { routeTechnicalUiApi } from "./verify-technical-analysis-ui.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = process.env.UI_VALIDATION_SCREENSHOT_DIR
  ? path.resolve(process.env.UI_VALIDATION_SCREENSHOT_DIR)
  : "/tmp/toss-portfolio-lens-ui-validation";
const matrices = [
  { viewport: { width: 1440, height: 900 }, theme: "dark" },
  { viewport: { width: 1440, height: 900 }, theme: "light" },
  { viewport: { width: 390, height: 844 }, theme: "dark" },
  { viewport: { width: 390, height: 844 }, theme: "light" },
];
const screens = [
  {
    key: "overview",
    hash: "#overview",
    header: "안녕하세요.",
    mobileLabel: "포트폴리오",
    route: routePortfolioUiApi,
  },
  {
    key: "technical-analysis",
    hash: "#technical-analysis",
    header: "기술적 분석",
    mobileLabel: "기술 분석",
    route: routeTechnicalUiApi,
  },
  {
    key: "backtest",
    hash: "#backtest",
    header: "백테스트",
    mobileLabel: "백테스트",
    route: routePortfolioUiApi,
  },
  {
    key: "scalping-assistant",
    hash: "#scalping-assistant",
    header: "단타 보조",
    mobileLabel: "단타 보조",
    route: routeScalpingUiApi,
  },
  {
    key: "ai-simulation",
    hash: "#simulation",
    header: "시뮬레이션",
    mobileLabel: "시뮬레이션",
    route: routeSimulationUiApi,
  },
];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function observePage(page) {
  const failures = { console: [], page: [], requests: [], responses: [] };
  page.on("console", (message) => {
    if (message.type() === "error") failures.console.push(message.text());
  });
  page.on("pageerror", (error) => failures.page.push(error.message));
  page.on("requestfailed", (request) => {
    failures.requests.push(`${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failures.responses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return failures;
}

async function waitForVisible(locator, label, timeout = 30_000) {
  await locator.first().waitFor({ state: "visible", timeout });
  check(await locator.count() > 0, `${label} 요소를 찾지 못했습니다.`);
}

async function assertBoxHasSize(locator, label, minimumWidth = 24, minimumHeight = 24) {
  const box = await locator.first().boundingBox();
  check(box, `${label}의 bounding box를 계산하지 못했습니다.`);
  check(
    box.width >= minimumWidth && box.height >= minimumHeight,
    `${label} 크기가 0 또는 지나치게 작습니다: ${JSON.stringify(box)}`,
  );
  return box;
}

async function assertInsideViewport(locator, viewport, label) {
  const box = await assertBoxHasSize(locator, label);
  check(
    box.x >= -1
      && box.y >= -1
      && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1,
    `${label}가 viewport 밖으로 잘렸습니다: ${JSON.stringify({ box, viewport })}`,
  );
}

async function assertHorizontallyInsideViewport(locator, viewport, label) {
  const box = await assertBoxHasSize(locator, label);
  check(
    box.x >= -1 && box.x + box.width <= viewport.width + 1,
    `${label}가 viewport 좌우 밖으로 잘렸습니다: ${JSON.stringify({ box, viewport })}`,
  );
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

async function assertDashboardLayout(page, viewport, sectionLocator, screen) {
  const main = page.locator("main.dashboard-main");
  const mainBox = await assertBoxHasSize(main, `${screen} main`, 100, 100);
  const headerBox = await assertBoxHasSize(page.locator(".dashboard-header"), `${screen} header`, 100, 40);
  const sectionBox = await assertBoxHasSize(sectionLocator, `${screen} content`, 100, 40);
  check(
    intersectionArea(headerBox, sectionBox) <= 1,
    `${screen} header와 content가 겹칩니다: ${JSON.stringify({ headerBox, sectionBox })}`,
  );

  if (viewport.width >= 1024) {
    const sidebarBox = await assertBoxHasSize(page.locator(".dashboard-sidebar"), `${screen} sidebar`, 100, 100);
    check(
      intersectionArea(sidebarBox, mainBox) <= 1,
      `${screen} sidebar와 main이 겹칩니다: ${JSON.stringify({ sidebarBox, mainBox })}`,
    );
  } else {
    const tabs = page.getByLabel("화면 선택");
    const tabsBox = await assertBoxHasSize(tabs, `${screen} mobile navigation`, 100, 30);
    check(
      intersectionArea(tabsBox, sectionBox) <= 1,
      `${screen} mobile navigation과 content가 겹칩니다: ${JSON.stringify({ tabsBox, sectionBox })}`,
    );
  }
}

async function assertNoHorizontalOverflow(page, screen) {
  const overflow = await page.evaluate(() => Math.max(
    0,
    document.documentElement.scrollWidth - window.innerWidth,
    document.body.scrollWidth - window.innerWidth,
  ));
  check(overflow <= 1, `${screen} 화면에 ${overflow}px 가로 overflow가 있습니다.`);
  return overflow;
}

async function assertNoContainerClipping(locator, label) {
  const clipped = await locator.evaluateAll((elements) => elements.flatMap((element) => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return [];
    return element.scrollWidth > element.clientWidth + 2
      ? [{
          marker: Array.from(element.attributes)
            .find((attribute) => attribute.name.startsWith("data-"))?.name ?? element.tagName,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }]
      : [];
  }));
  check(clipped.length === 0, `${label} 내부 text/content가 잘렸습니다: ${JSON.stringify(clipped)}`);
  return clipped.length;
}

async function assertNavigation(page, screen, viewport) {
  check(await page.evaluate(() => window.location.hash) === screen.hash, `${screen.key} URL hash가 보존되지 않았습니다.`);
  const title = page.getByRole("heading", { level: 1, name: screen.header, exact: true });
  await waitForVisible(title, `${screen.key} page header`);
  const titleClip = await title.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  check(
    titleClip.scrollWidth <= titleClip.clientWidth + 1,
    `${screen.key} page header text가 잘렸습니다: ${JSON.stringify(titleClip)}`,
  );

  if (viewport.width < 1024) {
    const tabs = page.getByLabel("화면 선택");
    const active = tabs.getByRole("button", { name: screen.mobileLabel, exact: true });
    check(await active.getAttribute("aria-pressed") === "true", `${screen.key} mobile navigation 활성 상태가 일치하지 않습니다.`);
    const tabsBox = await assertBoxHasSize(tabs, `${screen.key} mobile navigation`, 100, 30);
    const activeBox = await assertBoxHasSize(active, `${screen.key} active mobile navigation`, 24, 24);
    check(
      activeBox.x >= tabsBox.x - 1 && activeBox.x + activeBox.width <= tabsBox.x + tabsBox.width + 1,
      `${screen.key} active mobile navigation이 tab viewport 밖에 있습니다: ${JSON.stringify({ activeBox, tabsBox })}`,
    );
  } else {
    const active = page.getByLabel("대시보드 탐색")
      .getByRole("button", { name: screen.header === "안녕하세요." ? "포트폴리오" : screen.header, exact: true });
    check((await active.getAttribute("class"))?.includes("bg-white"), `${screen.key} desktop navigation 활성 상태가 일치하지 않습니다.`);
  }
}

async function prepareOverview(page) {
  await waitForVisible(page.getByText("보유 주식 평가액", { exact: true }), "overview valuation");
  await waitForVisible(page.getByRole("heading", { name: "자산 구성 · KRW" }), "overview allocation");
  const chart = page.locator("#allocation .recharts-responsive-container").first();
  await waitForVisible(chart, "overview allocation chart");
  await assertBoxHasSize(chart, "overview allocation chart", 100, 100);
  await assertNoContainerClipping(page.locator(".portfolio-hero"), "overview hero");
  return page.locator(".portfolio-hero");
}

async function prepareTechnicalAnalysis(page) {
  await waitForVisible(page.getByRole("heading", { name: "22개 종목 동시 비교", exact: true }), "technical batch");
  check(await page.locator("[data-technical-symbol]").count() >= 22, "기술적 분석 종목 카드가 22개 미만입니다.");
  const firstCard = page.locator("[data-technical-symbol]").first();
  await firstCard.scrollIntoViewIfNeeded();
  const chart = firstCard.locator("[data-technical-price-chart]");
  await waitForVisible(chart, "technical chart");
  await assertBoxHasSize(chart, "technical chart", 100, 100);
  await page.evaluate(() => window.scrollTo(0, 0));
  await assertNoContainerClipping(page.locator("[data-technical-symbol]"), "technical cards");
  return page.locator("[data-technical-analysis]");
}

async function prepareBacktest(page) {
  await waitForVisible(page.getByRole("heading", { name: "포트폴리오 전략 백테스트", exact: true }), "backtest form");
  await waitForVisible(page.getByText("총 6종목 · 주식", { exact: false }), "backtest asset count");
  await page.getByRole("button", { name: "백테스트 실행", exact: true }).click();
  const resultHeading = page.getByRole("heading", { name: "현금흐름 제거 성장 비교", exact: true });
  await waitForVisible(resultHeading, "backtest result", 30_000);
  await resultHeading.scrollIntoViewIfNeeded();
  const resultCard = resultHeading.locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
  await assertBoxHasSize(resultCard, "backtest result chart section", 100, 100);
  const chart = resultCard.locator(".recharts-responsive-container").first();
  await waitForVisible(chart, "backtest result chart");
  await assertBoxHasSize(chart, "backtest result chart", 100, 100);
  await page.evaluate(() => window.scrollTo(0, 0));
  return page.getByRole("heading", { name: "포트폴리오 전략 백테스트", exact: true }).locator("..");
}

async function prepareScalping(page) {
  await waitForVisible(page.locator("[data-scalping-scan-idle]"), "scalping idle");
  await page.getByRole("button", { name: "스캔 적용", exact: true }).click();
  await waitForVisible(page.getByRole("heading", { name: "국내 · 거래대금 상위 10종목", exact: true }), "scalping candidates");
  await page.getByRole("button", { name: "국내 단타 후보 1 상세 분석", exact: true }).click();
  const detail = page.locator('[data-scalping-analysis-symbol="S001"]');
  await waitForVisible(detail, "scalping detail");
  const chart = detail.locator("[data-scalping-price-chart]");
  await waitForVisible(chart, "scalping detail chart");
  await assertBoxHasSize(chart, "scalping detail chart", 100, 100);
  await page.evaluate(() => window.scrollTo(0, 0));
  check(await page.locator("[data-scalping-analysis-loading]").count() === 0, "단타 상세 loading 상태가 고착됐습니다.");
  await assertNoContainerClipping(page.locator("[data-scalping-symbol]"), "scalping cards");
  return page.locator("[data-scalping-assistant]");
}

async function prepareSimulation(page) {
  await waitForVisible(page.locator("[data-ai-simulation]"), "simulation workspace");
  await waitForVisible(
    page.getByText("실주문 없음, 투자 지시 아님, 다음 유효 체결만.", { exact: true }),
    "simulation disclosure",
  );
  const start = page.getByRole("button", { name: "AI 시뮬레이션 시작", exact: true });
  await waitForVisible(start, "simulation start");
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((element) => element.textContent?.includes("AI 시뮬레이션 시작"));
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await start.click();
  await waitForVisible(page.getByText("시뮬레이션 진행", { exact: true }), "simulation progress");
  await waitForVisible(page.locator("[data-simulation-selected] article").first(), "simulation selected instrument");
  const runtime = page.locator([
    "[data-simulation-run]",
    "[data-simulation-selected]",
    "[data-simulation-positions]",
    "[data-simulation-trades]",
    "[data-simulation-decisions]",
  ].join(","));
  const sizes = await runtime.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  check(sizes.every(({ width, height }) => width > 0 && height > 0), `simulation runtime에 zero-size 요소가 있습니다: ${JSON.stringify(sizes)}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await assertNoContainerClipping(runtime, "simulation runtime");
  return page.locator("[data-ai-simulation]");
}

const prepareScreen = {
  overview: prepareOverview,
  "technical-analysis": prepareTechnicalAnalysis,
  backtest: prepareBacktest,
  "scalping-assistant": prepareScalping,
  "ai-simulation": prepareSimulation,
};

async function captureOverlay(page, screen, viewport, screenshotStem) {
  if (screen.key === "overview") {
    const trigger = page.getByRole("button", { name: "표시 설정 열기", exact: true });
    await trigger.click();
    const settings = page.locator("#display-settings");
    await waitForVisible(settings, "overview display settings");
    await assertHorizontallyInsideViewport(settings, viewport, "overview display settings");
    const screenshot = `${screenshotStem}-overlay.png`;
    await page.screenshot({ path: screenshot, animations: "disabled" });
    await settings.getByRole("button", { name: "표시 설정 닫기", exact: true }).click();
    return screenshot;
  }

  if (screen.key === "ai-simulation") {
    const stop = page.getByRole("button", { name: "테스트 중단", exact: true });
    if (await stop.isVisible()) {
      await stop.click();
      await waitForVisible(page.getByText("취소됨", { exact: true }), "simulation cancellation");
    }
  }

  const comboboxes = page.getByRole("combobox");
  const count = await comboboxes.count();
  for (let index = 0; index < count; index += 1) {
    const combobox = comboboxes.nth(index);
    if (!await combobox.isVisible() || !await combobox.isEnabled()) continue;
    await combobox.scrollIntoViewIfNeeded();
    await combobox.click();
    const listbox = page.getByRole("listbox").last();
    await waitForVisible(listbox, `${screen.key} select popup`);
    await assertInsideViewport(listbox, viewport, `${screen.key} select popup`);
    const screenshot = `${screenshotStem}-select.png`;
    await page.screenshot({ path: screenshot, animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.scrollTo(0, 0));
    return screenshot;
  }
  throw new Error(`${screen.key} 화면에서 검증할 visible select를 찾지 못했습니다.`);
}

async function verifyScreen(browser, baseUrl, screen, matrix) {
  const { viewport, theme } = matrix;
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
  });
  await context.addInitScript(({ selectedTheme }) => {
    window.localStorage.setItem("portfolio-theme", selectedTheme);
    window.localStorage.removeItem("portfolio-hidden-stocks");
    history.scrollRestoration = "manual";
    class StaticEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      CONNECTING = 0;
      OPEN = 1;
      CLOSED = 2;
      readyState = 0;
      url;
      withCredentials = false;
      onopen = null;
      onmessage = null;
      onerror = null;
      listeners = new Map();
      constructor(url) {
        this.url = String(url);
        setTimeout(() => {
          this.readyState = this.OPEN;
          this.onopen?.(new Event("open"));
        }, 0);
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
      }
      dispatchEvent(event) {
        for (const listener of this.listeners.get(event.type) ?? []) {
          if (typeof listener === "function") listener.call(this, event);
          else listener.handleEvent?.(event);
        }
        return true;
      }
      close() {
        this.readyState = this.CLOSED;
      }
    }
    window.EventSource = StaticEventSource;
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}html{scroll-behavior:auto!important}";
      document.head.append(style);
    }, { once: true });
  }, { selectedTheme: theme });

  const page = await context.newPage();
  const failures = observePage(page);
  await screen.route(page);
  try {
    const response = await page.goto(`${baseUrl}/${screen.hash}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    check(response?.status() === 200, `${screen.key} 문서 응답이 200이 아닙니다.`);
    await assertNavigation(page, screen, viewport);
    const actualViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    check(
      actualViewport.width === viewport.width && actualViewport.height === viewport.height,
      `${screen.key} viewport가 다릅니다: ${JSON.stringify(actualViewport)}`,
    );
    const actualTheme = await page.evaluate(() => (
      document.documentElement.classList.contains("dark") ? "dark" : "light"
    ));
    check(actualTheme === theme, `${screen.key} theme가 ${theme}가 아니라 ${actualTheme}입니다.`);

    const section = await prepareScreen[screen.key](page);
    await page.waitForTimeout(250);
    await assertDashboardLayout(page, viewport, section, screen.key);
    const overflow = await assertNoHorizontalOverflow(page, screen.key);
    check(
      await page.getByText(/화면을 불러오는 중$/).count() === 0,
      `${screen.key} lazy loading fallback이 고착됐습니다.`,
    );
    check(await page.locator('[aria-busy="true"]').count() === 0, `${screen.key} aria-busy loading 상태가 고착됐습니다.`);

    await mkdir(outputDirectory, { recursive: true });
    const stem = path.join(outputDirectory, `${screen.key}-${viewport.width}x${viewport.height}-${theme}`);
    const screenshot = `${stem}.png`;
    await page.screenshot({ path: screenshot, animations: "disabled" });
    const overlayScreenshot = await captureOverlay(page, screen, viewport, stem);

    check(failures.responses.length === 0, `${screen.key} HTTP >=400: ${failures.responses.join(" | ")}`);
    check(failures.requests.length === 0, `${screen.key} failed requests: ${failures.requests.join(" | ")}`);
    check(failures.page.length === 0, `${screen.key} page errors: ${failures.page.join(" | ")}`);
    check(failures.console.length === 0, `${screen.key} console errors: ${failures.console.join(" | ")}`);
    return {
      screen: screen.key,
      viewport: `${viewport.width}x${viewport.height}`,
      theme,
      overflow,
      screenshot,
      overlayScreenshot,
      errors: {
        console: failures.console.length,
        page: failures.page.length,
        requests: failures.requests.length,
        responses: failures.responses.length,
      },
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
  check(address && typeof address === "object", "UI 검증 포트를 할당하지 못했습니다.");
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
      // 다음 Chromium 후보를 확인한다.
    }
  }
}

async function run(command, args, label) {
  const output = [];
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) {
    throw new Error(`${label} 실패 (${exit.code ?? exit.signal}).\n${output.join("")}`);
  }
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite preview 조기 종료 (${child.exitCode}).\n${output.join("")}`);
    }
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch {
      // Vite preview 준비를 기다린다.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite preview 준비 시간이 초과됐습니다.\n${output.join("")}`);
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

async function createContactSheets(browser, results) {
  const contactSheets = [];
  for (const matrix of matrices) {
    const viewportLabel = `${matrix.viewport.width}x${matrix.viewport.height}`;
    const captures = results.filter((result) => (
      result.viewport === viewportLabel && result.theme === matrix.theme
    ));
    check(captures.length === screens.length, `${viewportLabel} ${matrix.theme} contact sheet 원본 수가 다릅니다.`);
    const images = await Promise.all(captures.map(async (capture) => ({
      screen: capture.screen,
      source: `data:image/png;base64,${(await readFile(capture.screenshot)).toString("base64")}`,
    })));
    const context = await browser.newContext({
      viewport: { width: 1920, height: matrix.viewport.width >= 1024 ? 360 : 920 },
      deviceScaleFactor: 1,
      colorScheme: matrix.theme,
    });
    const page = await context.newPage();
    try {
      await page.setContent(`<!doctype html>
        <html lang="ko">
          <head>
            <meta charset="utf-8">
            <style>
              * { box-sizing: border-box; }
              html, body { margin: 0; background: ${matrix.theme === "dark" ? "#111" : "#f1f3f5"}; color: ${matrix.theme === "dark" ? "#fff" : "#111"}; font-family: sans-serif; }
              main { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; padding: 16px; }
              figure { min-width: 0; margin: 0; border-radius: 12px; background: ${matrix.theme === "dark" ? "#242424" : "#fff"}; padding: 8px; box-shadow: 0 4px 20px rgb(0 0 0 / 12%); }
              figcaption { height: 28px; font-size: 13px; font-weight: 800; line-height: 24px; }
              img { display: block; width: 100%; height: auto; border-radius: 8px; }
            </style>
          </head>
          <body>
            <main>
              ${images.map(({ screen, source }) => `<figure><figcaption>${screen}</figcaption><img alt="${screen}" src="${source}"></figure>`).join("")}
            </main>
          </body>
        </html>`, { waitUntil: "load" });
      const pathName = path.join(outputDirectory, `contact-sheet-${viewportLabel}-${matrix.theme}.png`);
      await page.screenshot({ path: pathName, fullPage: true, animations: "disabled" });
      contactSheets.push(pathName);
    } finally {
      await context.close();
    }
  }
  return contactSheets;
}

let preview;
let browser;
try {
  await mkdir(outputDirectory, { recursive: true });
  const viteEntry = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  let baseUrl = process.env.UI_VALIDATION_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    if (process.env.UI_VALIDATION_SKIP_BUILD !== "1") {
      await run(process.execPath, [viteEntry, "build"], "Vite production build");
    }
    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const output = [];
    preview = spawn(
      process.execPath,
      [viteEntry, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    preview.stdout.on("data", (chunk) => output.push(chunk.toString()));
    preview.stderr.on("data", (chunk) => output.push(chunk.toString()));
    await waitForServer(baseUrl, preview, output);
  }

  const executablePath = await firstExecutable([
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
  ]);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });

  const results = [];
  for (const matrix of matrices) {
    for (const screen of screens) {
      results.push(await verifyScreen(browser, baseUrl, screen, matrix));
    }
  }
  const contactSheets = await createContactSheets(browser, results);
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    outputDirectory,
    screenshots: results.length,
    overlayScreenshots: results.length,
    contactSheets,
    results,
  };
  await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.info(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stop(preview);
}
