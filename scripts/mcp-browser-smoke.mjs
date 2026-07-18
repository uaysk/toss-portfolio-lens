import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { access, constants, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(import.meta.dirname, "..");
const reportId = "93a20db8-594f-4ea0-9572-6934c93d8342";
const ownerPassword = `browser-owner-${randomBytes(18).toString("base64url")}`;
const clientId = "toss-portfolio-lens-browser-smoke";
const requestedScopes = "market:read portfolio:read backtest:run report:generate";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("브라우저 smoke용 포트를 할당하지 못했습니다."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function executablePath() {
  for (const candidate of [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
  ]) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 다음 설치 위치를 확인한다.
    }
  }
  return undefined;
}

function syntheticReport() {
  const points = Array.from({ length: 24 }, (_, index) => {
    const date = new Date(Date.UTC(2024, index, 1)).toISOString().slice(0, 10);
    const growth = Math.round(10_000_000 * (1 + index * 0.011 + Math.sin(index / 2) * 0.015));
    return {
      date,
      balance: growth,
      growth,
      benchmarkGrowth: Math.round(10_000_000 * (1 + index * 0.007)),
      drawdownPercent: -Math.abs(Math.sin(index / 2.6) * 5.2),
    };
  });
  const comparable = {
    totalReturnPercent: 25.3,
    cagrPercent: 12.1,
    annualizedVolatilityPercent: 14.4,
    maxDrawdownPercent: -8.2,
    maxDrawdownDays: 41,
    sharpeRatio: 0.84,
    sortinoRatio: 1.19,
    calmarRatio: 1.48,
    bestDailyReturnPercent: 2.8,
    worstDailyReturnPercent: -3.1,
    positiveDaysPercent: 55.4,
    bestYearPercent: 14.2,
    worstYearPercent: 9.8,
    positiveMonthsPercent: 62.5,
  };
  const assets = [
    { symbol: "SYNTH-KR", name: "합성 국내 ETF", market: "KRX", currency: "KRW", weight: 60, listDate: "2020-01-02", securityType: "ETF", status: "ACTIVE" },
    { symbol: "SYNTH-US", name: "합성 미국 ETF", market: "NASDAQ", currency: "USD", weight: 40, listDate: "2019-06-03", securityType: "ETF", status: "ACTIVE" },
  ];
  return {
    schemaVersion: 1,
    templateVersion: "portfolio-report-v1",
    id: reportId,
    kind: "backtest",
    createdAt: "2026-07-17T00:00:00.000Z",
    title: "백테스트 평가 보고서",
    period: { from: "2024-01-01", to: "2025-12-01" },
    narrative: {
      score: 74,
      stance: "balanced",
      summary: "합성 시세로 계산한 성과와 위험은 균형적이지만 역사적 결과의 한계를 함께 확인해야 합니다.",
      strengths: ["수익과 위험 지표가 함께 제공됩니다.", "국내외 자산의 분산 구성을 확인했습니다.", "벤치마크와 같은 기간을 비교했습니다."],
      risks: ["합성 데이터는 실제 투자 성과가 아닙니다.", "거래 비용과 세금 가정에 민감할 수 있습니다.", "과거 결과는 미래 성과를 보장하지 않습니다."],
      actions: ["여러 시작일에서 결과를 다시 비교하세요.", "비중과 리밸런싱 민감도를 점검하세요.", "실제 투자 전 데이터 출처를 확인하세요."],
      methodology: "합성 수정주가 수익률, 낙폭, 변동성, 벤치마크 지표만 사용했습니다.",
    },
    data: {
      generatedAt: "2026-07-17T00:00:00.000Z",
      baseCurrency: "KRW",
      currencyMethod: "LOCAL_RETURN",
      requestedStartDate: "2024-01-01",
      effectiveStartDate: "2024-01-01",
      endDate: "2025-12-01",
      config: {
        assets: assets.map(({ symbol, weight }) => ({ symbol, weight })),
        startDate: "2024-01-01",
        endDate: "2025-12-01",
        initialAmount: 10_000_000,
        monthlyCashFlow: 0,
        rebalanceFrequency: "quarterly",
        riskFreeRatePercent: 2.5,
        transactionCostBps: 10,
        benchmark: "KOSPI",
        requestedStartDate: "2024-01-01",
        latestListDate: "2024-01-01",
        effectiveStartDate: "2024-01-01",
        effectiveEndDate: "2025-12-01",
      },
      assets,
      benchmark: { key: "KOSPI", name: "KOSPI", symbol: "KOSPI" },
      warnings: ["합성 데이터만 사용한 브라우저 렌더링 검증입니다."],
      points,
      metrics: { ...comparable, finalBalance: points.at(-1).growth, totalContributions: 0, totalWithdrawals: 0 },
      benchmarkMetrics: { ...comparable, totalReturnPercent: 16.1, cagrPercent: 7.8, sharpeRatio: 0.55 },
      annualReturns: [{ year: 2024, returnPercent: 14.2 }, { year: 2025, returnPercent: 9.8 }],
      contributions: assets.map((asset, index) => ({
        symbol: asset.symbol,
        name: asset.name,
        market: asset.market,
        currency: asset.currency,
        weight: asset.weight,
        endingValue: index === 0 ? 7_520_000 : 5_010_000,
        profitLoss: index === 0 ? 1_520_000 : 1_010_000,
        contributionPercent: index === 0 ? 15.2 : 10.1,
        timeLinkedContributionPercent: index === 0 ? 15.2 : 10.1,
        localPriceContributionPercent: index === 0 ? 15.2 : 6.4,
        fxContributionPercent: index === 0 ? 0 : 3.7,
        assetReturnPercent: index === 0 ? 25.3 : 24.8,
      })),
      correlations: {
        assets: assets.map(({ symbol, name }) => ({ symbol, name })),
        values: [[1, 0.31], [0.31, 1]],
      },
    },
  };
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 8_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}` : String(error);
      // 서버 초기화를 기다린다.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`브라우저 smoke 서버 준비 시간이 초과됐습니다.${lastError ? ` 마지막 요청 오류: ${lastError}` : ""}`);
}

function observePage(page) {
  const errors = { console: [], page: [], requests: [] };
  page.on("console", (message) => {
    if (message.type() === "error") errors.console.push(message.text());
  });
  page.on("pageerror", (error) => errors.page.push(error.message));
  page.on("requestfailed", (request) => errors.requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  return errors;
}

async function verifyOAuth(browser, baseUrl, redirectUri, viewport, colorScheme, decision) {
  const context = await browser.newContext({ viewport, colorScheme, locale: "ko-KR", reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = observePage(page);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: `${baseUrl}/mcp`,
    scope: requestedScopes,
    state: `browser-${viewport.width}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const callbackUrl = new URL(redirectUri);
  await context.route(
    (url) => url.origin === callbackUrl.origin && url.pathname === callbackUrl.pathname,
    (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>OAuth callback</title>" }),
  );
  const response = await page.goto(`${baseUrl}/oauth/authorize?${query}`, { waitUntil: "domcontentloaded" });
  assert(response?.status() === 200, `OAuth login HTTP status (${viewport.width})`);
  const contentSecurityPolicy = response.headers()["content-security-policy"] || "";
  assert(
    contentSecurityPolicy.includes(`form-action 'self' ${callbackUrl.origin}`),
    `OAuth CSP omitted callback origin (${viewport.width})`,
  );
  await page.getByText("Toss Portfolio Lens", { exact: true }).waitFor();
  await page.getByLabel("대시보드 비밀번호").fill("invalid-synthetic-password");
  await page.getByRole("button", { name: "계속" }).click();
  await page.getByRole("alert").filter({ hasText: "비밀번호가 올바르지 않습니다." }).waitFor();
  const expectedLoginErrors = errors.console.splice(0);
  assert(
    expectedLoginErrors.length <= 1 && expectedLoginErrors.every((message) => message.includes("401")),
    `OAuth login error console output: ${expectedLoginErrors.join(" | ")}`,
  );
  assert(errors.page.length === 0 && errors.requests.length === 0, "OAuth login error page caused an unexpected runtime failure");
  await page.getByLabel("대시보드 비밀번호").fill(ownerPassword);
  await page.getByRole("button", { name: "계속" }).click();
  await page.getByRole("heading", { name: "권한 승인" }).waitFor();
  for (const name of ["시장 데이터 조회", "포트폴리오 조회", "백테스트 실행", "리포트 생성"]) {
    await page.getByText(name, { exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "허용" }).waitFor();
  await page.getByRole("button", { name: "거부" }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const cardBackground = await page.locator(".card").evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.getByRole("button", { name: decision === "approve" ? "허용" : "거부" }).click();
  await page.waitForURL((url) => url.pathname === "/oauth/callback");
  const callback = new URL(page.url());
  assert(decision === "approve" ? Boolean(callback.searchParams.get("code")) : callback.searchParams.get("error") === "access_denied", `OAuth ${decision} callback`);
  assert(overflow === 0, `OAuth ${viewport.width}px horizontal overflow: ${overflow}`);
  assert(errors.console.length === 0, `OAuth console errors: ${errors.console.join(" | ")}`);
  assert(errors.page.length === 0, `OAuth page errors: ${errors.page.join(" | ")}`);
  assert(errors.requests.length === 0, `OAuth failed requests: ${errors.requests.join(" | ")}`);
  await context.close();
  return { viewport: `${viewport.width}x${viewport.height}`, colorScheme, decision, overflow, cardBackground };
}

async function verifyReport(browser, baseUrl, viewport, initialTheme) {
  const context = await browser.newContext({ viewport, colorScheme: initialTheme, locale: "ko-KR", reducedMotion: "reduce" });
  await context.addInitScript((theme) => window.localStorage.setItem("portfolio-theme", theme), initialTheme);
  const page = await context.newPage();
  const errors = observePage(page);
  let apiStatus;
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === `/api/reports/${reportId}`) apiStatus = response.status();
  });
  const response = await page.goto(`${baseUrl}/reports/${reportId}`, { waitUntil: "networkidle" });
  assert(response?.status() === 200, `report page HTTP status (${viewport.width})`);
  await page.getByText("PORTFOLIO LENS REPORT", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "백테스트 평가 보고서" }).waitFor();
  await page.getByRole("heading", { name: "수치 기반 종합 평가" }).waitFor();
  await page.getByRole("heading", { name: "백테스트 성과 경로" }).waitFor();
  await page.getByRole("button", { name: "낙폭" }).click();
  assert(await page.getByRole("button", { name: "낙폭" }).getAttribute("aria-pressed") === "true", "낙폭 차트 전환 실패");
  await page.getByRole("heading", { name: "일간 수익률 상관관계" }).waitFor();
  await page.getByRole("columnheader", { name: "종목명" }).waitFor();
  await page.getByText(`Report ID ${reportId}`, { exact: true }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.getByRole("button", { name: initialTheme === "dark" ? "라이트 테마로 전환" : "다크 테마로 전환" }).click();
  const toggledTheme = await page.evaluate(() => document.documentElement.classList.contains("dark") ? "dark" : "light");
  assert(toggledTheme !== initialTheme, `report theme toggle (${viewport.width})`);
  assert(apiStatus === 200, `report API HTTP status (${viewport.width}): ${apiStatus}`);
  assert(overflow === 0, `report ${viewport.width}px horizontal overflow: ${overflow}`);
  assert(errors.console.length === 0, `report console errors: ${errors.console.join(" | ")}`);
  assert(errors.page.length === 0, `report page errors: ${errors.page.join(" | ")}`);
  assert(errors.requests.length === 0, `report failed requests: ${errors.requests.join(" | ")}`);
  await context.close();
  return { viewport: `${viewport.width}x${viewport.height}`, initialTheme, toggledTheme, pageStatus: response.status(), apiStatus, overflow };
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "tpl-mcp-browser-"));
let browser;
let exitCode = 0;
try {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  const secretDirectory = path.join(temporaryRoot, "secrets");
  const reportsDirectory = path.join(temporaryRoot, "reports");
  const clientSecretPath = path.join(secretDirectory, "mcp-oauth-client-secret");
  const signingKeyPath = path.join(secretDirectory, "mcp-oauth-signing-key");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
  await mkdir(reportsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(clientSecretPath, `${randomBytes(48).toString("base64url")}\n`, { mode: 0o600 });
  await writeFile(signingKeyPath, privateKey, { mode: 0o600 });
  await writeFile(path.join(reportsDirectory, `${reportId}.json`), JSON.stringify(syntheticReport()), { mode: 0o600 });

  for (const name of [
    "S3_BUCKET", "OPENAI_API_ENDPOINT", "OPENAI_API_KEY", "REPORT_AI_PROVIDER",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  ]) delete process.env[name];
  Object.assign(process.env, {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_APP_URL: baseUrl,
    DASHBOARD_PASSWORD: ownerPassword,
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    TOSS_API_AUTH_MODE: "static_bearer",
    TOSS_API_BEARER_TOKEN: `synthetic-${randomBytes(24).toString("base64url")}`,
    TOSS_API_BASE_URL: "http://127.0.0.1:9",
    DB_PROVIDER: "sqlite",
    DATABASE_PATH: path.join(temporaryRoot, "browser.sqlite"),
    REPORTS_PATH: reportsDirectory,
    MCP_ENABLED: "true",
    MCP_AUTH_MODE: "oauth",
    MCP_SMOKE_BASE_URL: baseUrl,
    MCP_RESOURCE_URL: `${baseUrl}/mcp`,
    MCP_OAUTH_ISSUER: baseUrl,
    MCP_OAUTH_CLIENT_ID: clientId,
    MCP_OAUTH_CLIENT_NAME: "Toss Portfolio Lens ChatGPT",
    MCP_OAUTH_CLIENT_SECRET_FILE: clientSecretPath,
    MCP_OAUTH_SIGNING_KEY_FILE: signingKeyPath,
    MCP_OAUTH_REDIRECT_URI: redirectUri,
    MCP_MAX_REQUESTS_PER_MINUTE: "200",
  });
  await import(pathToFileURL(path.join(projectRoot, "dist/server/index.js")).href);
  await waitForServer(baseUrl);
  await import("./mcp-oauth-http-smoke.mjs");
  const browserPath = await executablePath();
  browser = await chromium.launch({
    headless: true,
    ...(browserPath ? { executablePath: browserPath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  const oauth = [
    await verifyOAuth(browser, baseUrl, redirectUri, { width: 1440, height: 1000 }, "light", "approve"),
    await verifyOAuth(browser, baseUrl, redirectUri, { width: 390, height: 844 }, "dark", "deny"),
  ];
  const reports = [
    await verifyReport(browser, baseUrl, { width: 1440, height: 1000 }, "dark"),
    await verifyReport(browser, baseUrl, { width: 390, height: 844 }, "light"),
  ];
  console.info(JSON.stringify({ ok: true, oauth, reports }));
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}
process.exit(exitCode);
