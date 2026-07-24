import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { routeSimulationUiApi } from "./verify-ai-simulation-ui.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDirectory = process.env.SIMULATION_UI_SCREENSHOT_DIR
  ? path.resolve(process.env.SIMULATION_UI_SCREENSHOT_DIR)
  : "/tmp/toss-portfolio-lens-crypto-ui";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function verify(browser, baseUrl, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: "dark" });
  await context.addInitScript(() => {
    window.localStorage.setItem("portfolio-theme", "dark");
    history.scrollRestoration = "manual";
  });
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
  try {
    await page.goto(`${baseUrl}/?crypto-ui=${viewport.width}#simulation`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.locator("[data-ai-simulation]").waitFor();
    const assetGroup = page.getByRole("radiogroup", { name: "시뮬레이션 자산군" });
    const cryptoRadio = assetGroup.getByRole("radio", { name: /암호화폐/ });
    await cryptoRadio.click();
    check(await cryptoRadio.getAttribute("aria-checked") === "true", "암호화폐 자산군이 선택되지 않았습니다.");
    await cryptoRadio.press("ArrowLeft");
    check(
      await assetGroup.getByRole("radio", { name: /주식/ }).getAttribute("aria-checked") === "true",
      "자산군 segmented control의 ArrowLeft 이동이 동작하지 않습니다.",
    );
    await assetGroup.getByRole("radio", { name: /주식/ }).press("ArrowRight");
    await page.locator("[data-crypto-simulation-setup]").waitFor();
    await page.locator('[data-crypto-scanner-snapshot="crypto-ui-snapshot-001"]').waitFor();
    await page.locator("[data-crypto-candidate]").first().waitFor();
    const candidateCount = await page.locator("[data-crypto-candidate]").count();
    check(
      candidateCount === 2,
      `scanner 후보가 2개가 아닙니다: ${candidateCount}\n${await page.locator("[data-crypto-scanner]").innerText()}`,
    );
    check(await page.locator("[data-model-worker]").count() === 2, "GPU worker 상태 카드가 2개가 아닙니다.");
    check(
      await page.locator('[data-execution-capability="live"]').getAttribute("data-enabled") === "false",
      "live capability가 false로 렌더링되지 않았습니다.",
    );
    const fincastToggle = page.locator('[data-model-lane-toggle="fincast"]');
    await fincastToggle.click();
    check(await fincastToggle.getAttribute("aria-pressed") === "true", "FinCast lane 선택이 반영되지 않았습니다.");

    await mkdir(screenshotDirectory, { recursive: true });
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
      document.body.style.scrollBehavior = "auto";
      window.scrollTo(0, 0);
    });
    await assetGroup.scrollIntoViewIfNeeded();
    const assetScreenshot = path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-asset-class.png`);
    await page.screenshot({ path: assetScreenshot, animations: "disabled" });
    await page.locator("[data-crypto-simulation-setup]").scrollIntoViewIfNeeded();
    const setupScreenshot = path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-setup.png`);
    await page.screenshot({ path: setupScreenshot, animations: "disabled" });
    const scannerRegion = page.getByRole("region", {
      name: "암호화폐 선물 scanner 순위 가로 스크롤",
    });
    await scannerRegion.scrollIntoViewIfNeeded();
    if (viewport.width <= 560) {
      await scannerRegion.focus();
      for (let index = 0; index < 4; index += 1) await scannerRegion.press("ArrowRight");
      check(await scannerRegion.evaluate((element) => element.scrollLeft > 0), "모바일 scanner 표를 키보드로 가로 스크롤할 수 없습니다.");
      await scannerRegion.evaluate((element) => { element.scrollLeft = 0; });
    }
    const scannerScreenshot = path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-scanner.png`);
    await page.screenshot({ path: scannerScreenshot, animations: "disabled" });

    const start = page.locator("[data-crypto-simulation-start]");
    state.failNextCryptoStart = true;
    await start.click();
    await page.getByRole("alert").filter({ hasText: "fixture risk bracket unavailable" }).waitFor();
    check(state.starts.length === 0, "실패한 crypto start가 run으로 기록됐습니다.");
    const expectedFailureIndex = errors.response.findIndex((item) => (
      item.includes("503") && item.includes("/api/portfolio/simulation/runs")
    ));
    check(expectedFailureIndex >= 0, "의도한 crypto start 실패 응답이 관찰되지 않았습니다.");
    errors.response.splice(expectedFailureIndex, 1);
    const expectedConsoleIndex = errors.console.findIndex((item) => (
      item.includes("Failed to load resource") && item.includes("503")
    ));
    if (expectedConsoleIndex >= 0) errors.console.splice(expectedConsoleIndex, 1);
    await start.click();
    await page.locator("[data-futures-ledger]").waitFor({ timeout: 10_000 });
    await page.locator("[data-crypto-simulation-stop]").waitFor();
    await page.locator('[data-futures-position="BTCUSDT"]').waitFor();
    await page.locator('[data-futures-position-side="long"]').waitFor();
    await page.locator('[data-model-comparison="inconclusive"]').waitFor();
    check(await page.locator("[data-model-lane]").count() === 2, "독립 모델 비교 lane이 2개가 아닙니다.");
    check(await page.locator("[data-crypto-comparison-report-link]").getAttribute("target") === "_blank", "보고서 링크가 새 탭 링크가 아닙니다.");
    check(state.starts.length === 1, "crypto paper run이 정확히 한 번 시작되지 않았습니다.");
    const body = state.starts[0];
    check(body.market?.kind === "crypto_futures", "v7 market.kind가 crypto_futures가 아닙니다.");
    check(body.market?.venue === "BINANCE_USDM", "v7 venue가 BINANCE_USDM이 아닙니다.");
    check(body.market?.quoteAsset === "USDT" && body.market?.contractType === "PERPETUAL", "USDT 무기한 계약이 요청에 보존되지 않았습니다.");
    check(body.execution?.mode === "paper", "execution.mode가 paper가 아닙니다.");
    check(JSON.stringify(body.modelLanes) === JSON.stringify(["kronos_base", "fincast"]), "두 모델 lane이 요청에 보존되지 않았습니다.");
    check(!("marketCountry" in body), "crypto v7 요청에 legacy marketCountry가 포함됐습니다.");

    const measured = await page.locator([
      "[data-crypto-simulation-setup]",
      "[data-crypto-scanner]",
      "[data-futures-ledger]",
      "[data-futures-position]",
      "[data-model-comparison]",
      "[data-model-lane]",
    ].join(",")).evaluateAll((items) => items.map((item) => ({
      name: Array.from(item.attributes).find(({ name }) => name.startsWith("data-"))?.name,
      width: item.getBoundingClientRect().width,
      height: item.getBoundingClientRect().height,
    })));
    const zeroSize = measured.filter(({ width, height }) => width <= 0 || height <= 0);
    check(!zeroSize.length, `zero-size crypto 요소: ${JSON.stringify(zeroSize)}`);
    const overflow = await page.evaluate(() => Math.max(
      0,
      document.documentElement.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
    ));
    check(overflow === 0, `${viewport.width}px 앱 가로 overflow ${overflow}px`);
    await page.locator("[data-futures-ledger]").scrollIntoViewIfNeeded();
    const runtimeScreenshot = path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-runtime.png`);
    await page.screenshot({ path: runtimeScreenshot, animations: "disabled" });
    await page.locator("[data-model-comparison]").scrollIntoViewIfNeeded();
    const comparisonScreenshot = path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-comparison.png`);
    await page.screenshot({ path: comparisonScreenshot, animations: "disabled" });
    const clippedText = await page.locator([
      "[data-crypto-simulation-setup]",
      "[data-futures-ledger]",
      "[data-model-comparison]",
    ].join(",")).evaluateAll((roots) => roots.flatMap((root) => (
      Array.from(root.querySelectorAll("h1,h2,h3,h4,p,span,strong,button,label,summary,th,td"))
        .flatMap((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const intentionallyTruncated = element.classList.contains("truncate")
            || element.hasAttribute("title")
            || style.textOverflow === "ellipsis";
          const scrollContainer = ["auto", "scroll"].includes(style.overflowX)
            || ["auto", "scroll"].includes(style.overflowY);
          const clippedBySelf = rect.width > 0 && rect.height > 0
            && ((["hidden", "clip"].includes(style.overflowX)
                && element.scrollWidth > element.clientWidth + 1)
              || (["hidden", "clip"].includes(style.overflowY)
                && element.scrollHeight > element.clientHeight + 1));
          let ancestor = element.parentElement;
          let clippedByAncestor = false;
          while (ancestor && root.contains(ancestor)) {
            const ancestorStyle = getComputedStyle(ancestor);
            if (["hidden", "clip"].includes(ancestorStyle.overflowX)
              || ["hidden", "clip"].includes(ancestorStyle.overflowY)) {
              const boundary = ancestor.getBoundingClientRect();
              clippedByAncestor = rect.left < boundary.left - 1
                || rect.right > boundary.right + 1
                || rect.top < boundary.top - 1
                || rect.bottom > boundary.bottom + 1;
              if (clippedByAncestor) break;
            }
            ancestor = ancestor.parentElement;
          }
          const clipped = clippedBySelf || clippedByAncestor;
          return clipped && !intentionallyTruncated && !scrollContainer
            ? [{
                tag: element.tagName,
                text: element.textContent?.trim().slice(0, 120),
                client: [element.clientWidth, element.clientHeight],
                scroll: [element.scrollWidth, element.scrollHeight],
              }]
            : [];
        })
    )));
    check(!clippedText.length, `잘린 앱 텍스트: ${JSON.stringify(clippedText)}`);
    const cancelledResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes("/api/portfolio/simulation/runs/")
      && response.url().endsWith("/cancel")
    ));
    const refreshedHistory = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && response.url().includes("/api/portfolio/simulation/runs?limit=20")
    ));
    await page.locator("[data-crypto-simulation-stop]").click();
    await cancelledResponse;
    await refreshedHistory;
    check(state.cancels.length === 1, "crypto 실행 중단 API가 호출되지 않았습니다.");

    await page.goto(`${baseUrl}/reports/crypto-scalping-model-comparison.html`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.getByRole("heading", { name: /Kronos와 FinCast/ }).waitFor();
    await page.locator("#report-status").filter({ hasText: "검증 대기" }).waitFor();
    const reportTabs = page.getByRole("tablist", { name: "보고서 섹션" });
    await reportTabs.getByRole("tab", { name: "개요" }).press("ArrowRight");
    check(
      await reportTabs.getByRole("tab", { name: "모델 비교" }).getAttribute("aria-selected") === "true",
      "보고서 tab ArrowRight 이동이 동작하지 않습니다.",
    );
    const fincastReportToggle = page.locator('.model-toggle[data-model="fincast"]');
    await fincastReportToggle.click();
    check(await fincastReportToggle.getAttribute("aria-pressed") === "true", "보고서 FinCast toggle이 동작하지 않습니다.");
    await reportTabs.getByRole("tab", { name: "리스크·실행" }).click();
    check(
      await page.locator("#panel-risk").getAttribute("hidden") === null,
      "보고서 리스크·실행 panel이 열리지 않았습니다.",
    );
    await reportTabs.getByRole("tab", { name: "Provenance" }).click();
    check(
      await page.locator("#panel-provenance").getAttribute("hidden") === null,
      "보고서 provenance panel이 열리지 않았습니다.",
    );
    await reportTabs.getByRole("tab", { name: "모델 비교" }).press("Home");
    const canvases = await page.locator("canvas").evaluateAll((items) => items.map((item) => ({
      width: item.getBoundingClientRect().width,
      height: item.getBoundingClientRect().height,
    })));
    check(canvases.every(({ width, height }) => width > 0 && height > 0), `보고서 canvas zero-size: ${JSON.stringify(canvases)}`);
    const reportOverflow = await page.evaluate(() => Math.max(
      0,
      document.documentElement.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
    ));
    check(reportOverflow === 0, `${viewport.width}px 보고서 가로 overflow ${reportOverflow}px`);
    const reportTableRegion = page.getByRole("region", {
      name: "암호화폐 선물 scanner 순위 가로 스크롤",
    });
    if (viewport.width <= 560) {
      await reportTableRegion.focus();
      for (let index = 0; index < 4; index += 1) await reportTableRegion.press("ArrowRight");
      check(await reportTableRegion.evaluate((element) => element.scrollLeft > 0), "모바일 보고서 표를 키보드로 가로 스크롤할 수 없습니다.");
      await reportTableRegion.evaluate((element) => { element.scrollLeft = 0; });
    }
    const clippedReportText = await page.locator(".hero, .tabs, [role=\"tabpanel\"]:not([hidden])")
      .evaluateAll((roots) => roots.flatMap((root) => (
        Array.from(root.querySelectorAll("h1,h2,h3,h4,p,span,strong,button,th,td,dt,dd"))
          .flatMap((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const intentionallyTruncated = element.classList.contains("truncate")
              || element.hasAttribute("title")
              || style.textOverflow === "ellipsis";
            const scrollContainer = ["auto", "scroll"].includes(style.overflowX)
              || ["auto", "scroll"].includes(style.overflowY);
            const clippedBySelf = rect.width > 0 && rect.height > 0
              && ((["hidden", "clip"].includes(style.overflowX)
                  && element.scrollWidth > element.clientWidth + 1)
                || (["hidden", "clip"].includes(style.overflowY)
                  && element.scrollHeight > element.clientHeight + 1));
            let ancestor = element.parentElement;
            let clippedByAncestor = false;
            while (ancestor && root.contains(ancestor)) {
              const ancestorStyle = getComputedStyle(ancestor);
              if (["hidden", "clip"].includes(ancestorStyle.overflowX)
                || ["hidden", "clip"].includes(ancestorStyle.overflowY)) {
                const boundary = ancestor.getBoundingClientRect();
                clippedByAncestor = rect.left < boundary.left - 1
                  || rect.right > boundary.right + 1
                  || rect.top < boundary.top - 1
                  || rect.bottom > boundary.bottom + 1;
                if (clippedByAncestor) break;
              }
              ancestor = ancestor.parentElement;
            }
            const clipped = clippedBySelf || clippedByAncestor;
            return clipped && !intentionallyTruncated && !scrollContainer
              ? [{
                  tag: element.tagName,
                  text: element.textContent?.trim().slice(0, 120),
                  client: [element.clientWidth, element.clientHeight],
                  scroll: [element.scrollWidth, element.scrollHeight],
                }]
              : [];
          })
      )));
    check(!clippedReportText.length, `잘린 보고서 텍스트: ${JSON.stringify(clippedReportText)}`);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
      document.body.style.scrollBehavior = "auto";
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    await page.locator(".topbar").scrollIntoViewIfNeeded();
    await page.waitForTimeout(50);
    const reportScreenshot = path.join(screenshotDirectory, `${viewport.width}x${viewport.height}-report.png`);
    await page.screenshot({ path: reportScreenshot, animations: "disabled" });
    check(
      Object.values(errors).every((items) => items.length === 0),
      `브라우저 오류: ${JSON.stringify(errors)}`,
    );
    return {
      viewport: `${viewport.width}x${viewport.height}`,
      candidateCount: 2,
      workerCount: 2,
      modelLaneCount: 2,
      zeroSize: zeroSize.length,
      overflow,
      reportOverflow,
      errors,
      screenshots: {
        assetScreenshot,
        setupScreenshot,
        scannerScreenshot,
        runtimeScreenshot,
        comparisonScreenshot,
        reportScreenshot,
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
  check(address && typeof address === "object", "포트를 할당하지 못했습니다.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
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
      // wait
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

let preview;
let browser;
try {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  preview = spawn(process.execPath, [
    path.join(projectRoot, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--strictPort",
  ], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
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
  const results = [];
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1920, height: 1080 },
    { width: 390, height: 844 },
  ]) {
    results.push(await verify(browser, baseUrl, viewport));
  }
  console.info(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stop(preview);
}
