import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.env.AWS_APP_VERIFY_URL || "http://127.0.0.1:4320").replace(/\/$/, "");
const assets = [
  { symbol: "069500", weight: 20 },
  { symbol: "091160", weight: 20 },
  { symbol: "390390", weight: 15 },
  { symbol: "440340", weight: 15 },
  { symbol: "379810", weight: 10 },
  { symbol: "426030", weight: 20 },
];
const requestBody = {
  assets,
  startDate: "2022-08-30",
  endDate: "2026-07-16",
  initialAmount: 10_000_000,
  monthlyCashFlow: 0,
  rebalanceFrequency: "annually",
  riskFreeRatePercent: 0,
  transactionCostBps: 0,
  benchmark: "KOSPI",
};

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

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
page.setDefaultTimeout(180_000);

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByLabel("대시보드 비밀번호").fill(dashboardPassword);
  await page.getByRole("button", { name: "포트폴리오 열기" }).click();
  await page.getByRole("heading", { name: "안녕하세요." }).waitFor();

  const result = await page.evaluate(async (body) => {
    const backtestResponse = await fetch("/api/portfolio/backtest", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const backtest = await backtestResponse.json();
    if (!backtestResponse.ok) throw new Error(backtest?.error?.message || `백테스트 HTTP ${backtestResponse.status}`);

    const reportResponse = await fetch("/api/reports/backtest", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const report = await reportResponse.json();
    if (!reportResponse.ok) throw new Error(report?.error?.message || `보고서 HTTP ${reportResponse.status}`);
    return {
      assets: backtest.assets?.length,
      points: backtest.points?.length,
      initialAmount: backtest.config?.initialAmount,
      effectiveStartDate: backtest.effectiveStartDate,
      reportId: report.id,
      reportUrl: report.url,
      storage: report.storage,
    };
  }, requestBody);

  if (!result.reportId || !result.reportUrl) throw new Error("보고서 식별자나 URL이 없습니다.");
  await page.goto(`${baseUrl}/reports/${encodeURIComponent(result.reportId)}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByText("PORTFOLIO LENS REPORT", { exact: true }).waitFor();
  await page.getByText("백테스트 평가 보고서", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "수치 기반 종합 평가" }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  console.log(JSON.stringify({
    assets: result.assets,
    points: result.points,
    initialAmount: result.initialAmount,
    effectiveStartDate: result.effectiveStartDate,
    storage: result.storage,
    reportRendered: true,
    horizontalOverflow: overflow,
  }));
  if (result.assets !== 6 || result.initialAmount !== 10_000_000 || result.storage !== "s3" || overflow > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
