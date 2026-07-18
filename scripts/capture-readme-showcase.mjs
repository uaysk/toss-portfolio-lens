import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { routeApplicationApi } from "./capture-readme.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs", "readme");
const port = Number.parseInt(process.env.README_CAPTURE_PORT || "4174", 10);
const baseUrl = `http://127.0.0.1:${port}`;
const rustCaptures = ["rust-why", "rust-performance", "rust-architecture"];

await mkdir(output, { recursive: true });

const vite = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
vite.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
vite.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`README capture server did not start.\n${serverOutput}`);
}

let browser;
let context;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1680, height: 1050 },
    deviceScaleFactor: 2,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
  await context.addInitScript(() => {
    window.localStorage.setItem("portfolio-theme", "dark");
    window.localStorage.removeItem("portfolio-hidden-stocks");
  });
  const page = await context.newPage();
  await routeApplicationApi(page);
  await page.goto(`${baseUrl}/#overview`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: `
    *, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }
    html { scroll-behavior: auto !important; }
  ` });
  await page.getByText("보유 주식 평가액", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "자산 구성 · KRW" }).waitFor();
  const firstAllocationSector = page.locator("#allocation .recharts-pie-sector path").first();
  await firstAllocationSector.hover();
  const tooltip = page.locator("#allocation .recharts-default-tooltip");
  await tooltip.waitFor();
  const tooltipColors = await tooltip.evaluate((element) => {
    const item = element.querySelector(".recharts-tooltip-item") ?? element;
    const label = element.querySelector(".recharts-tooltip-label") ?? element;
    return {
      item: getComputedStyle(item).color,
      label: getComputedStyle(label).color,
      background: getComputedStyle(element).backgroundColor,
    };
  });
  if (tooltipColors.item === "rgb(0, 0, 0)" || tooltipColors.label === "rgb(0, 0, 0)") {
    throw new Error(`도넛 차트 툴팁 대비 검증 실패: ${JSON.stringify(tooltipColors)}`);
  }
  await page.mouse.move(20, 20);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, "overview.png"), fullPage: false, animations: "disabled" });

  await page.getByRole("button", { name: "포트폴리오 분석", exact: true }).click();
  await page.getByRole("heading", { name: "포트폴리오 전체 평가금 일봉" }).waitFor();
  await page.locator('[aria-label="포트폴리오 평가금 일봉과 비교 지수 차트"]').waitFor();

  await page.getByRole("button", { name: "백테스트", exact: true }).click();
  await page.getByRole("heading", { name: "포트폴리오 전략 백테스트" }).waitFor();
  await page.getByText("총 6종목 · 주식", { exact: false }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, "backtest.png"), fullPage: false, animations: "disabled" });

  await page.getByRole("button", { name: "최적화", exact: true }).click();
  await page.getByRole("heading", { name: "최적화 기준 포트폴리오" }).waitFor();
  const strategyHeading = page.getByRole("heading", { name: "비교·검증·최적화 연구실" });
  await strategyHeading.waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, "optimization.png"), fullPage: false, animations: "disabled" });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const screen of [
    { hash: "overview", heading: "안녕하세요." },
    { hash: "analysis", heading: "포트폴리오 분석" },
    { hash: "backtest", heading: "백테스트" },
    { hash: "optimization", heading: "포트폴리오 최적화" },
  ]) {
    await page.goto(`${baseUrl}/#${screen.hash}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: screen.heading, exact: true }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error(`${screen.hash} 모바일 화면에 전체 가로 스크롤이 있습니다.`);
  }

  await page.goto(`${baseUrl}/docs/readme/rust-engine.html`, { waitUntil: "networkidle" });
  await page.locator("html[data-ready='true']").waitFor();
  for (const capture of rustCaptures) {
    await page.locator(`[data-capture="${capture}"]`).screenshot({ path: path.join(output, `${capture}.png`) });
  }
} finally {
  await context?.close();
  await browser?.close();
  vite.kill("SIGTERM");
}
