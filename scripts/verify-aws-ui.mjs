import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.env.AWS_APP_VERIFY_URL || "http://127.0.0.1:4320").replace(/\/$/, "");

function envValue(source, key) {
  const line = source.split(/\r?\n/).find((item) => item.startsWith(`${key}=`));
  if (!line) return "";
  const raw = line.slice(key.length + 1).trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1);
  }
  return raw;
}

const dashboardPassword = envValue(await readFile(path.join(projectRoot, ".env"), "utf8"), "DASHBOARD_PASSWORD");
if (!dashboardPassword) throw new Error(".env의 DASHBOARD_PASSWORD가 필요합니다.");

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
const consoleErrors = [];
const failedRequests = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${new URL(request.url()).pathname}`));

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByLabel("대시보드 비밀번호").fill(dashboardPassword);
  await page.getByRole("button", { name: "포트폴리오 열기" }).click();
  await page.getByRole("heading", { name: "안녕하세요." }).waitFor({ timeout: 60_000 });
  const overviewOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await page.getByRole("button", { name: "포트폴리오 분석", exact: true }).click();
  await page.getByRole("heading", { name: "포트폴리오 전체 평가금 일봉" }).waitFor({ timeout: 30_000 });
  await page.getByText("최근 종가", { exact: true }).waitFor({ timeout: 120_000 });
  const analysisOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await page.getByRole("button", { name: "포트폴리오 백테스트", exact: true }).click();
  await page.getByRole("heading", { name: "포트폴리오 전략 백테스트" }).waitFor({ timeout: 30_000 });
  await page.getByText(/총 \d+종목 · 비중 합계/).waitFor({ timeout: 120_000 });
  const backtestOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  console.log(JSON.stringify({
    overview: true,
    analysis: true,
    backtest: true,
    horizontalOverflow: {
      overview: overviewOverflow,
      analysis: analysisOverflow,
      backtest: backtestOverflow,
    },
    consoleErrors: consoleErrors.length,
    failedRequests: failedRequests.length,
  }));
  if (consoleErrors.length || failedRequests.length || Math.max(overviewOverflow, analysisOverflow, backtestOverflow) > 0) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
