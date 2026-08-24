import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { routeApplicationApi as routePortfolioUiApi } from "./capture-readme.mjs";
import { assertClientBuildFresh, buildClient } from "./client-build.mjs";
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
  { viewport: { width: 1024, height: 600 }, theme: "light" },
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

async function assertLowHeightSidebar(page, viewport, screen) {
  if (viewport.width < 1024 || viewport.height > 600) return;

  const sidebar = page.locator(".dashboard-sidebar");
  const nav = page.getByRole("navigation", { name: "대시보드 탐색" });
  const logout = sidebar.getByRole("button", { name: "로그아웃", exact: true });
  const lastNavigationItem = nav.locator("a, button").last();
  const logoutBefore = await assertBoxHasSize(logout, `${screen} low-height logout`);
  await assertInsideViewport(logout, viewport, `${screen} low-height logout`);
  await lastNavigationItem.scrollIntoViewIfNeeded();

  const scrollState = await nav.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: style.overflowY,
    };
  });
  check(
    ["auto", "scroll"].includes(scrollState.overflowY),
    `${screen} low-height sidebar navigation이 scroll container가 아닙니다: ${JSON.stringify(scrollState)}`,
  );
  check(
    scrollState.scrollHeight > scrollState.clientHeight,
    `${screen} low-height sidebar navigation에 검증 가능한 overflow가 없습니다: ${JSON.stringify(scrollState)}`,
  );
  check(
    scrollState.scrollTop > 0,
    `${screen} low-height sidebar navigation의 마지막 항목으로 스크롤되지 않았습니다: ${JSON.stringify(scrollState)}`,
  );

  const navBox = await assertBoxHasSize(nav, `${screen} low-height navigation`, 100, 40);
  const lastItemBox = await assertBoxHasSize(lastNavigationItem, `${screen} low-height last navigation item`);
  check(
    lastItemBox.y >= navBox.y - 1 && lastItemBox.y + lastItemBox.height <= navBox.y + navBox.height + 1,
    `${screen} low-height 마지막 navigation 항목이 navigation viewport 밖에 있습니다: ${JSON.stringify({ lastItemBox, navBox })}`,
  );
  const logoutAfter = await assertBoxHasSize(logout, `${screen} low-height fixed logout`);
  await assertInsideViewport(logout, viewport, `${screen} low-height fixed logout`);
  check(
    Math.abs(logoutBefore.y - logoutAfter.y) <= 1,
    `${screen} navigation scroll 중 logout 위치가 이동했습니다: ${JSON.stringify({ logoutBefore, logoutAfter })}`,
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
    await assertLowHeightSidebar(page, viewport, screen);
  } else {
    const tabs = page.getByRole("navigation", { name: "화면 선택" });
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
  const expectedTitle = `${screen.key === "overview" ? "포트폴리오" : screen.header} · Portfolio Lens`;
  const title = page.getByRole("heading", { level: 1, name: screen.header, exact: true });
  await waitForVisible(title, `${screen.key} page header`);
  await page.waitForFunction((value) => document.title === value, expectedTitle, { timeout: 5_000 });
  check(await page.title() === expectedTitle, `${screen.key} 문서 제목이 ${expectedTitle}이 아닙니다.`);
  const skipLink = page.locator('a.dashboard-skip-link[href="#dashboard-content"]');
  check(await skipLink.count() === 1, `${screen.key} 본문 건너뛰기 링크가 정확히 하나가 아닙니다.`);
  check(
    await skipLink.textContent() === "본문으로 건너뛰기",
    `${screen.key} 본문 건너뛰기 링크 이름이 올바르지 않습니다.`,
  );
  const main = page.locator("main#dashboard-content");
  check(await main.count() === 1, `${screen.key} skip link main target이 정확히 하나가 아닙니다.`);
  check(await main.getAttribute("tabindex") === "-1", `${screen.key} skip link main target이 focusable하지 않습니다.`);
  const titleClip = await title.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  check(
    titleClip.scrollWidth <= titleClip.clientWidth + 1,
    `${screen.key} page header text가 잘렸습니다: ${JSON.stringify(titleClip)}`,
  );

  if (viewport.width < 1024) {
    const tabs = page.getByRole("navigation", { name: "화면 선택" });
    const active = tabs.getByRole("button", { name: screen.mobileLabel, exact: true });
    check(await active.getAttribute("aria-pressed") === "true", `${screen.key} mobile navigation 활성 상태가 일치하지 않습니다.`);
    check(await active.getAttribute("aria-current") === "page", `${screen.key} mobile navigation aria-current가 없습니다.`);
    const tabsBox = await assertBoxHasSize(tabs, `${screen.key} mobile navigation`, 100, 30);
    const activeBox = await assertBoxHasSize(active, `${screen.key} active mobile navigation`, 24, 24);
    check(
      activeBox.x >= tabsBox.x - 1 && activeBox.x + activeBox.width <= tabsBox.x + tabsBox.width + 1,
      `${screen.key} active mobile navigation이 tab viewport 밖에 있습니다: ${JSON.stringify({ activeBox, tabsBox })}`,
    );
  } else {
    const active = page.getByRole("navigation", { name: "대시보드 탐색" })
      .getByRole("button", { name: screen.header === "안녕하세요." ? "포트폴리오" : screen.header, exact: true });
    check((await active.getAttribute("class"))?.includes("bg-white"), `${screen.key} desktop navigation 활성 상태가 일치하지 않습니다.`);
    check(await active.getAttribute("aria-current") === "page", `${screen.key} desktop navigation aria-current가 없습니다.`);
  }
}

async function assertSidebarKeyboardFocus(page) {
  const navigation = page.getByRole("navigation", { name: "대시보드 탐색" });
  const targets = [
    navigation.getByRole("button", { name: "포트폴리오 분석", exact: true }),
    navigation.getByRole("link", { name: "자산 구성", exact: true }),
  ];
  for (const target of targets) {
    await target.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const focus = await target.evaluate((element) => ({
      active: document.activeElement === element,
      visible: element.matches(":focus-visible"),
      boxShadow: getComputedStyle(element).boxShadow,
    }));
    check(focus.active, `sidebar ${await target.textContent()} focus가 유지되지 않았습니다.`);
    check(focus.visible, `sidebar ${await target.textContent()} focus-visible 상태가 없습니다.`);
    check(focus.boxShadow !== "none", `sidebar ${await target.textContent()} focus 표시가 보이지 않습니다.`);
    await target.evaluate((element) => element.blur());
  }
}

async function assertLoadingAndErrorAccessibility(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  let releasePortfolio;
  const portfolioGate = new Promise((resolve) => {
    releasePortfolio = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true }),
      });
      return;
    }
    if (url.pathname === "/api/portfolio") {
      await portfolioGate;
      await route.abort("failed");
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });

  try {
    await page.goto(`${baseUrl}/#overview`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const loadingStatus = page.locator('main#dashboard-content [role="status"]')
      .filter({ hasText: "포트폴리오를 불러오는 중입니다." });
    await loadingStatus.waitFor({ state: "attached" });
    const main = page.locator("main#dashboard-content");
    check(await main.getAttribute("aria-busy") === "true", "dashboard skeleton에 aria-busy 상태가 없습니다.");
    const sidebar = page.locator(".dashboard-sidebar");
    check(await sidebar.getAttribute("aria-hidden") === "true", "dashboard skeleton sidebar가 접근성 트리에서 제외되지 않았습니다.");
    check(await sidebar.getAttribute("inert") !== null, "dashboard skeleton sidebar가 inert 상태가 아닙니다.");
    const inertButton = sidebar.locator("button").first();
    await inertButton.evaluate((element) => element.focus());
    check(
      !await inertButton.evaluate((element) => document.activeElement === element),
      "dashboard skeleton의 비활성 sidebar가 keyboard focus를 받았습니다.",
    );

    releasePortfolio();
    await waitForVisible(
      page.getByRole("heading", { level: 1, name: "포트폴리오를 불러오지 못했습니다." }),
      "initial portfolio error",
    );
    check(
      await page.getByRole("alert").filter({ hasText: "포트폴리오를 불러오지 못했습니다." }).count() === 1,
      "초기 오류 화면이 alert로 노출되지 않았습니다.",
    );
    check(
      await page.getByRole("navigation", { name: "대시보드 탐색" }).count() === 0,
      "초기 오류 화면에 사용할 수 없는 dashboard navigation이 노출됐습니다.",
    );
    check(
      await page.getByRole("button", { name: "로그아웃", exact: true }).count() >= 1,
      "초기 오류 화면에서 로그아웃 동작을 사용할 수 없습니다.",
    );
  } finally {
    releasePortfolio?.();
    await context.close();
  }
}

async function assertStrategyLabAccessibility(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const failures = observePage(page);
  await context.addInitScript(() => {
    const stringify = JSON.stringify;
    window.__strategyLabFingerprintSerializations = 0;
    JSON.stringify = function instrumentedStringify(value, ...rest) {
      if (
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.prototype.hasOwnProperty.call(value, "baseConfig")
        && Object.prototype.hasOwnProperty.call(value, "exposureMetadata")
        && Object.prototype.hasOwnProperty.call(value, "outlookRegimeLookback")
      ) {
        window.__strategyLabFingerprintSerializations += 1;
      }
      return stringify.call(this, value, ...rest);
    };
    window.localStorage.setItem("portfolio-theme", "light");
    window.localStorage.removeItem("portfolio-hidden-stocks");
  });
  await routePortfolioUiApi(page);

  try {
    const response = await page.goto(`${baseUrl}/#optimization`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    check(response?.status() === 200, "strategy lab 문서 응답이 200이 아닙니다.");
    const stressMode = page.getByRole("button", { name: "스트레스", exact: true });
    await waitForVisible(stressMode, "strategy lab stress mode");
    await stressMode.click();

    const stressControlLabels = [
      "시나리오 1 이름",
      "시나리오 1 스트레스 시작일",
      "시나리오 1 스트레스 종료일",
      "시나리오 1 거래비용",
      "시나리오 1 현금흐름",
      "시나리오 1 현금흐름 주기",
      "시나리오 1 현금흐름 시점",
      "시나리오 1 통화 모드",
      "시나리오 1 리밸런싱",
      "시나리오 1 제외 심볼",
    ];
    for (const label of stressControlLabels) {
      const control = page.getByLabel(label, { exact: true });
      check(await control.count() === 1, `스트레스 입력 접근성 이름이 없습니다: ${label}`);
      await control.focus();
      check(
        await control.evaluate((element) => document.activeElement === element),
        `스트레스 입력이 keyboard focus를 받지 못했습니다: ${label}`,
      );
    }
    const deleteButton = page.getByRole("button", { name: "시나리오 1 삭제", exact: true });
    check(await deleteButton.count() === 1, "스트레스 시나리오 삭제 버튼의 접근성 이름이 없습니다.");
    await deleteButton.focus();
    check(
      await deleteButton.evaluate((element) => document.activeElement === element),
      "스트레스 시나리오 삭제 버튼이 keyboard focus를 받지 못했습니다.",
    );

    const optimizationSection = page.getByRole("region", { name: "포트폴리오 최적화", exact: true });
    await optimizationSection.getByRole("button", { name: "최적화", exact: true }).click();
    const robustWeights = optimizationSection.getByLabel("강건 점수 가중치 JSON", { exact: true });
    await robustWeights.fill("{");
    const contrastAlert = optimizationSection.getByRole("alert")
      .filter({ hasText: "강건 점수 가중치는 유효한 JSON 객체여야 합니다." });
    await waitForVisible(contrastAlert, "strategy lab validation contrast sample");
    const contrast = await contrastAlert.evaluate((element) => {
      const parseRgb = (value) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      const linear = (channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (rgb) => (
        0.2126 * linear(rgb[0])
        + 0.7152 * linear(rgb[1])
        + 0.0722 * linear(rgb[2])
      );
      const foreground = parseRgb(getComputedStyle(element).color);
      const background = parseRgb(getComputedStyle(element.parentElement).backgroundColor);
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return {
        color: getComputedStyle(element).color,
        backgroundColor: getComputedStyle(element.parentElement).backgroundColor,
        ratio: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
          / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
      };
    });
    check(
      contrast.ratio >= 4.5,
      `작은 오류 문구 대비가 4.5:1 미만입니다: ${JSON.stringify(contrast)}`,
    );
    await contrastAlert.scrollIntoViewIfNeeded();
    await mkdir(outputDirectory, { recursive: true });
    await page.screenshot({
      path: path.join(outputDirectory, "strategy-lab-validation-contrast-light.png"),
      animations: "disabled",
    });

    const fingerprintSerializations = await page.evaluate(() => window.__strategyLabFingerprintSerializations);
    check(fingerprintSerializations > 0, "전략 연구 입력 fingerprint 계측이 실행되지 않았습니다.");
    await page.locator('button[aria-label="다크 테마로 전환"]:visible').first().click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    const afterThemeChange = await page.evaluate(() => window.__strategyLabFingerprintSerializations);
    check(
      afterThemeChange === fingerprintSerializations,
      `입력과 무관한 theme render가 전략 연구 fingerprint를 재계산했습니다: ${fingerprintSerializations} → ${afterThemeChange}`,
    );

    await optimizationSection.getByRole("button", { name: "연구 도구", exact: true }).click();
    const researchModes = optimizationSection.getByRole("radiogroup", { name: "연구 도구 선택" });
    const diversifyingMode = researchModes.getByRole("radio", { name: "분산 후보", exact: true });
    const regimeMode = researchModes.getByRole("radio", { name: "시장 국면", exact: true });
    await waitForVisible(diversifyingMode, "research tools radio group");
    check(await diversifyingMode.getAttribute("aria-checked") === "true", "연구 도구 기본 radio가 선택되지 않았습니다.");
    await diversifyingMode.focus();
    await diversifyingMode.press("ArrowRight");
    check(await regimeMode.getAttribute("aria-checked") === "true", "연구 도구 ArrowRight가 다음 radio를 선택하지 못했습니다.");
    check(await regimeMode.evaluate((element) => document.activeElement === element), "연구 도구 ArrowRight가 다음 radio로 focus를 이동하지 못했습니다.");

    check(failures.responses.length === 0, `strategy lab HTTP >=400: ${failures.responses.join(" | ")}`);
    check(failures.requests.length === 0, `strategy lab failed requests: ${failures.requests.join(" | ")}`);
    check(failures.page.length === 0, `strategy lab page errors: ${failures.page.join(" | ")}`);
    check(failures.console.length === 0, `strategy lab console errors: ${failures.console.join(" | ")}`);
  } finally {
    await context.close();
  }
}

async function assertSkipLinkKeyboardFlow(page, expectedHash) {
  const skipLink = page.locator('a.dashboard-skip-link[href="#dashboard-content"]');
  const main = page.locator("main#dashboard-content");
  await page.keyboard.press("Tab");
  check(
    await skipLink.evaluate((element) => document.activeElement === element),
    "본문 건너뛰기 링크가 첫 Tab focus 대상이 아닙니다.",
  );
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await assertInsideViewport(skipLink, viewport, "focused dashboard skip link");
  await page.keyboard.press("Enter");
  check(
    await main.evaluate((element) => document.activeElement === element),
    "본문 건너뛰기 링크 실행 후 main target에 focus되지 않았습니다.",
  );
  check(
    await page.evaluate(() => window.location.hash) === expectedHash,
    "본문 건너뛰기 링크 실행이 dashboard view hash를 덮어썼습니다.",
  );
  await main.evaluate((element) => element.blur());
}

async function assertBrowserHistoryNavigation(page, expectedHash) {
  const navigation = page.getByRole("navigation", { name: "대시보드 탐색" });
  await navigation.getByRole("button", { name: "포트폴리오 분석", exact: true }).click();
  await page.waitForFunction(() => window.location.hash === "#analysis");
  await waitForVisible(
    page.getByRole("heading", { level: 1, name: "포트폴리오 분석", exact: true }),
    "history navigation destination",
  );
  await page.goBack();
  await page.waitForFunction((hash) => window.location.hash === hash, expectedHash);
  await waitForVisible(
    page.getByRole("heading", { level: 1, name: "안녕하세요.", exact: true }),
    "history navigation restored overview",
  );
}

async function prepareOverview(page) {
  await waitForVisible(page.getByText("보유 주식 평가액", { exact: true }), "overview valuation");
  await waitForVisible(page.getByRole("heading", { name: "자산 구성 · KRW" }), "overview allocation");
  const chart = page.locator("#allocation .recharts-responsive-container").first();
  await waitForVisible(chart, "overview allocation chart");
  await assertBoxHasSize(chart, "overview allocation chart", 100, 100);
  const allocationColors = await page.locator("#allocation .recharts-pie-sector path").evaluateAll((paths) => (
    paths.map((path) => getComputedStyle(path).fill)
  ));
  check(allocationColors.length > 1, "overview allocation chart에 비교할 종목 색상이 부족합니다.");
  check(new Set(allocationColors).size === allocationColors.length, `overview allocation chart 종목 색상이 충돌합니다: ${JSON.stringify(allocationColors)}`);
  await assertNoContainerClipping(page.locator(".portfolio-hero"), "overview hero");
  return page.locator(".portfolio-hero");
}

async function prepareTechnicalAnalysis(page) {
  await waitForVisible(page.getByRole("heading", { name: "22개 종목 동시 비교", exact: true }), "technical batch");
  check(await page.locator("[data-technical-symbol]").count() >= 22, "기술적 분석 종목 카드가 22개 미만입니다.");
  const firstCard = page.locator("[data-technical-symbol]").first();
  await firstCard.scrollIntoViewIfNeeded();
  const integrated = firstCard.locator('[data-technical-chart-layout="integrated"]');
  await waitForVisible(integrated, "integrated technical chart");
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
  const seriesColors = await chart.locator(".recharts-line-curve").evaluateAll((lines) => (
    lines.map((line) => getComputedStyle(line).stroke).filter((color) => color && color !== "none")
  ));
  check(seriesColors.length >= 2, `backtest result chart series가 2개 미만입니다: ${JSON.stringify(seriesColors)}`);
  check(new Set(seriesColors).size === seriesColors.length, `backtest result chart series 색상이 충돌합니다: ${JSON.stringify(seriesColors)}`);

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
    page.locator("[data-crypto-simulation-disclosure]"),
    "simulation disclosure",
  );
  const caseOptions = page.getByRole("radiogroup", { name: "시뮬레이션 전략 케이스" });
  await waitForVisible(caseOptions, "simulation case options");
  check(
    await caseOptions.getByRole("radio").count() === 3,
    "simulation case option이 BTC·ETH, 고변동성 암호화폐, 미국 ETF 페어 3개가 아닙니다.",
  );
  const start = page.locator("[data-crypto-simulation-start]");
  await waitForVisible(start, "simulation start");
  await page.waitForFunction(() => {
    const button = document.querySelector("[data-crypto-simulation-start]");
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await start.click();
  await waitForVisible(page.getByText("시뮬레이션 진행", { exact: true }), "simulation progress");
  await waitForVisible(page.locator("[data-simulation-selected] article").first(), "simulation selected instrument");
  const chartStack = page.locator('[data-ai-simulation-chart-stack="integrated"]').first();
  await waitForVisible(chartStack, "integrated simulation chart");
  const chartLayout = await chartStack.evaluate((node) => ({
    metricsShareStack: node.querySelector("[data-ai-simulation-hover-metrics]")?.parentElement === node,
    priceSharesStack: node.querySelector("[data-ai-simulation-price-chart]")?.parentElement === node,
  }));
  check(chartLayout.metricsShareStack && chartLayout.priceSharesStack, `simulation 가격과 시점 지표가 연속 chart surface를 공유하지 않습니다: ${JSON.stringify(chartLayout)}`);
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

async function assertAccountSwitchingState(page) {
  const basePortfolio = await page.evaluate(async () => {
    const response = await fetch("/api/portfolio", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`계좌 전환 fixture 조회 실패: ${response.status}`);
    return response.json();
  });
  const secondAccount = {
    ...basePortfolio.account,
    id: "ui-switch-account",
    name: "UI 전환 검증 계좌",
    label: "UI 전환 검증 계좌",
  };
  const accounts = [basePortfolio.account, secondAccount];
  const portfolioFor = (account) => ({
    ...basePortfolio,
    accounts,
    selectedAccountId: account.id,
    account,
  });

  let releaseSwitch;
  let markSwitchStarted;
  let switchReleased = false;
  let switchMarked = false;
  const switchGate = new Promise((resolve) => {
    releaseSwitch = resolve;
  });
  const switchStarted = new Promise((resolve) => {
    markSwitchStarted = resolve;
  });
  const release = () => {
    if (switchReleased) return;
    switchReleased = true;
    releaseSwitch();
  };
  const routePattern = "**/api/portfolio**";
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/portfolio") return route.fallback();
    const accountId = url.searchParams.get("account");
    if (accountId === secondAccount.id) {
      if (!switchMarked) {
        switchMarked = true;
        markSwitchStarted();
      }
      await switchGate;
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(portfolioFor(secondAccount)),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(portfolioFor(basePortfolio.account)),
    });
  };

  await page.route(routePattern, handler);
  try {
    const refreshButton = page.getByRole("button", { name: "포트폴리오 새로고침", exact: true });
    const refreshResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/portfolio" && url.searchParams.get("refresh") === "1";
    });
    await Promise.all([refreshResponse, refreshButton.click()]);

    const visibleAccountSelect = page.locator('[role="combobox"][aria-label="계좌 선택"]:visible');
    await waitForVisible(visibleAccountSelect, "lazy account selector");
    check(await visibleAccountSelect.count() === 1, "계좌 전환 검증용 visible account Select가 정확히 하나가 아닙니다.");
    await visibleAccountSelect.click();
    const secondOption = page.getByRole("option", { name: secondAccount.label, exact: true });
    await waitForVisible(secondOption, "account switching second option");
    await secondOption.click();
    await Promise.race([
      switchStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("계좌 전환 요청이 시작되지 않았습니다.")), 5_000)),
    ]);

    const switchingStatus = page.locator('[role="status"]', { hasText: "계좌를 전환하는 중입니다." });
    await switchingStatus.waitFor({ state: "attached" });
    check(
      (await switchingStatus.textContent())?.trim() === "계좌를 전환하는 중입니다.",
      "계좌 전환 status 메시지가 올바르지 않습니다.",
    );
    const allAccountSelects = page.locator('[role="combobox"][aria-label="계좌 선택"]');
    const switchingSelectState = await allAccountSelects.evaluateAll((elements) => elements.map((element) => ({
      disabled: element instanceof HTMLButtonElement && element.disabled,
      busy: element.getAttribute("aria-busy"),
      describedBy: element.getAttribute("aria-describedby"),
    })));
    check(switchingSelectState.length === 2, `desktop/mobile account Select 수가 다릅니다: ${JSON.stringify(switchingSelectState)}`);
    check(
      switchingSelectState.every((state) => state.disabled && state.busy === "true" && state.describedBy === "account-switch-status"),
      `계좌 전환 중 desktop/mobile Select 상태가 올바르지 않습니다: ${JSON.stringify(switchingSelectState)}`,
    );
    check(
      await allAccountSelects.locator("svg.animate-spin").count() === 2,
      "계좌 전환 중 desktop/mobile Select spinner가 모두 렌더되지 않았습니다.",
    );
    check(await refreshButton.isDisabled(), "계좌 전환 중 새로고침 버튼이 비활성화되지 않았습니다.");

    release();
    await switchingStatus.waitFor({ state: "detached" });
    await visibleAccountSelect.getByText(secondAccount.label, { exact: true }).waitFor({ state: "visible" });
    const settledSelectState = await allAccountSelects.evaluateAll((elements) => elements.map((element) => ({
      disabled: element instanceof HTMLButtonElement && element.disabled,
      busy: element.getAttribute("aria-busy"),
    })));
    check(
      settledSelectState.every((state) => !state.disabled && state.busy !== "true"),
      `계좌 전환 완료 후 Select가 복구되지 않았습니다: ${JSON.stringify(settledSelectState)}`,
    );
    check(await refreshButton.isEnabled(), "계좌 전환 완료 후 새로고침 버튼이 복구되지 않았습니다.");
  } finally {
    release();
    await page.unroute(routePattern, handler);
  }
}

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
  try {
  await context.addInitScript(({ selectedTheme, useRoutedEventSource }) => {
    window.localStorage.setItem("portfolio-theme", selectedTheme);
    window.localStorage.removeItem("portfolio-hidden-stocks");
    history.scrollRestoration = "manual";
    class RoutedEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;

      constructor(url) {
        super();
        this.url = String(url);
        this.withCredentials = false;
        this.readyState = RoutedEventSource.CONNECTING;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.controller = new AbortController();
        void this.connect();
      }

      async connect() {
        try {
          const response = await fetch(this.url, {
            headers: { Accept: "text/event-stream" },
            signal: this.controller.signal,
          });
          if (!response.ok) throw new Error(`fixture EventSource HTTP ${response.status}`);
          const body = await response.text();
          if (this.readyState === RoutedEventSource.CLOSED) return;
          this.readyState = RoutedEventSource.OPEN;
          const openEvent = new Event("open");
          this.dispatchEvent(openEvent);
          this.onopen?.call(this, openEvent);
          for (const block of body.trim().split(/\n\n+/)) {
            let type = "message";
            let lastEventId = "";
            const data = [];
            for (const line of block.split(/\n/)) {
              if (line.startsWith("event:")) type = line.slice(6).trim();
              else if (line.startsWith("id:")) lastEventId = line.slice(3).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            }
            const message = new MessageEvent(type, {
              data: data.join("\n"),
              lastEventId,
              origin: window.location.origin,
            });
            this.dispatchEvent(message);
            if (type === "message") this.onmessage?.call(this, message);
          }
        } catch {
          if (this.readyState === RoutedEventSource.CLOSED) return;
          const errorEvent = new Event("error");
          this.dispatchEvent(errorEvent);
          this.onerror?.call(this, errorEvent);
        }
      }

      close() {
        if (this.readyState === RoutedEventSource.CLOSED) return;
        this.readyState = RoutedEventSource.CLOSED;
        this.controller.abort();
      }
    }
    class StaticEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;

      constructor(url) {
        super();
        this.url = String(url);
        this.withCredentials = false;
        this.readyState = StaticEventSource.CONNECTING;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        setTimeout(() => {
          if (this.readyState === StaticEventSource.CLOSED) return;
          this.readyState = StaticEventSource.OPEN;
          const openEvent = new Event("open");
          this.dispatchEvent(openEvent);
          this.onopen?.call(this, openEvent);
        }, 0);
      }

      close() {
        this.readyState = StaticEventSource.CLOSED;
      }
    }
    window.EventSource = useRoutedEventSource ? RoutedEventSource : StaticEventSource;
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}html{scroll-behavior:auto!important}";
      document.head.append(style);
    }, { once: true });
  }, {
    selectedTheme: theme,
    useRoutedEventSource: screen.key === "ai-simulation",
  });

  const page = await context.newPage();
  const failures = observePage(page);
  await screen.route(page);
    const response = await page.goto(`${baseUrl}/${screen.hash}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    check(response?.status() === 200, `${screen.key} 문서 응답이 200이 아닙니다.`);
    await assertNavigation(page, screen, viewport);
    if (screen.key === "overview" && viewport.width === 1440 && theme === "dark") {
      await assertSkipLinkKeyboardFlow(page, screen.hash);
      await assertBrowserHistoryNavigation(page, screen.hash);
      await assertSidebarKeyboardFocus(page);
    }
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
    if (screen.key === "overview" && viewport.width === 1440 && theme === "light") {
      await assertAccountSwitchingState(page);
    }

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

async function waitForServer(baseUrl, child, output) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(baseUrl)) {
    throw new Error("Vite preview URL must be loopback-only.");
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite preview 조기 종료 (${child.exitCode}).\n${output.join("")}`);
    }
    try {
      if ((await fetch(baseUrl)).ok) return; // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
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
      await buildClient(projectRoot);
    } else await assertClientBuildFresh(projectRoot);
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

  await assertLoadingAndErrorAccessibility(browser, baseUrl);
  await assertStrategyLabAccessibility(browser, baseUrl);

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
