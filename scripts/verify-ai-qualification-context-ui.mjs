import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertClientBuildFresh } from "./client-build.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contexts = [512, 1024, 2048, 4096, 8192];

function state() {
  return {
    schemaVersion: "ai-p40-qualification-state/v1",
    runId: "chronos2-context-ui-verification",
    status: "running",
    createdAt: "2026-07-28T00:00:00.000Z",
    startedAt: "2026-07-28T00:00:01.000Z",
    updatedAt: "2026-07-28T00:20:00.000Z",
    deadlineAt: "2026-07-28T12:00:01.000Z",
    activeStepId: "pilot-benchmark",
    config: {
      budgetHours: 12,
      durationHours: 840,
      endExclusive: "2026-07-27T00:00:00.000Z",
      symbols: ["BTCUSDT", "ETHUSDT"],
      gpu: "Tesla P40",
      cudaCapability: "6.1",
      workerMode: "docker-source",
      dockerBuild: false,
    },
    progress: {
      completedSteps: 5,
      failedSteps: 0,
      skippedSteps: 0,
      totalSteps: 12,
      percent: 45.8,
      activeStepPercent: 55,
      elapsedMs: 1_200_000,
      remainingBudgetMs: 42_000_000,
    },
    steps: Array.from({ length: 12 }, (_, index) => {
      const ids = [
        "preflight", "runtime", "prepare-source", "origin-parity", "pilot-artifacts",
        "pilot-benchmark", "pilot-gate", "full-artifacts", "full-benchmark",
        "full-generation", "accuracy-analysis", "finalize",
      ];
      return {
        id: ids[index],
        order: index + 1,
        label: `Context qualification ${index + 1}`,
        description: "Chronos-2 context qualification verification step",
        model: index < 2 ? "system" : index < 10 ? "chronos-2" : "comparison",
        variant: index === 5 ? "10 batches · 4 backends" : "close-only",
        status: index < 5 ? "completed" : index === 5 ? "running" : "pending",
        estimatedDurationMs: 600_000,
        logFile: `logs/${ids[index]}.log`,
      };
    }),
    artifacts: {
      summaryJson: "qualification-summary.json",
      reportMarkdown: "qualification-report.md",
      handoffPrompt: "codex-handoff-prompt.md",
    },
    experiment: {
      kind: "chronos2-context-window-comparison",
      phase: "pilot",
      durationWeeks: 5,
      cadenceSeconds: 60,
      profile: "close_only",
      crossLearning: false,
      contexts,
      batchCandidates: [1, 2, 4, 8, 12, 16, 24, 32, 48, 50],
      backendCandidates: ["pipeline_eager", "worker_local", "no_padding", "gpu_gather"],
      automaticLivePromotion: false,
      resultStatus: null,
      metrics: {
        pilotGatePassed: true,
        estimatedFullDurationMs: 5_400_000,
        estimatedFullDurationUpperMs: 6_750_000,
        projectedDiskFreeGiB: 51.2,
        scoredOriginDigest: "a".repeat(64),
        contextResults: contexts.map((contextBars, index) => ({
          contextBars,
          status: index < 3 ? "passed" : index === 3 ? "running" : "pending",
          progressPercent: index < 3 ? 100 : index === 3 ? 40 : 0,
          batchSize: index < 3 ? [32, 24, 16][index] : null,
          backend: index < 3 ? "gpu_gather" : null,
          latencyP95Ms: index < 3 ? 25 + index * 20 : undefined,
          tasksPerSecond: index < 3 ? 38 - index * 8 : undefined,
          minimumFreeVramBytes: index < 3 ? (10 - index * 2) * 2 ** 30 : undefined,
          maximumPowerW: index < 3 ? 158 : undefined,
          maximumTemperatureC: index < 3 ? 70 + index : undefined,
          artifactDigest: index < 3 ? String(index + 1).repeat(64) : undefined,
          failureCount: 0,
        })),
      },
    },
    telemetry: {
      polledAt: "2026-07-28T00:20:00.000Z",
      gpuUtilizationPercent: 98,
      memoryUsedMiB: 18_000,
      memoryTotalMiB: 24_576,
      temperatureC: 72,
      powerDrawW: 158,
      powerLimitW: 160,
      memoryHeadroomMiB: 6_576,
    },
  };
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("preview port is unavailable"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function executable() {
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
      // Continue to Playwright's bundled browser.
    }
  }
  return undefined;
}

async function waitForPreview(url, child, output) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(url)) throw new Error("preview URL must be loopback-only");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Vite preview exited early.\n${output.join("")}`);
    }
    try {
      const response = await fetch(url); // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
      if (response.ok) return;
    } catch {
      // Retry while Vite starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Vite preview did not start.\n${output.join("")}`);
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
  await assertClientBuildFresh(projectRoot);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  preview = spawn(
    process.execPath,
    [path.join(projectRoot, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  preview.stdout.on("data", (chunk) => output.push(chunk.toString()));
  preview.stderr.on("data", (chunk) => output.push(chunk.toString()));
  await waitForPreview(baseUrl, preview, output);
  const browserPath = await executable();
  browser = await chromium.launch({
    headless: true,
    ...(browserPath ? { executablePath: browserPath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  const results = [];
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport, colorScheme: "dark", locale: "ko-KR" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/auth/session") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true }) });
      } else if (pathname === "/api/portfolio") {
        const account = {
          id: "context-ui",
          name: "Context UI 검증",
          label: "Context UI 검증",
          type: "STOCK",
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            asOf: "2026-07-28T00:20:00.000Z",
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
          }),
        });
      } else if (pathname === "/api/ai-qualification/runs/latest") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: state(), events: [] }) });
      } else if (pathname.endsWith("/events")) {
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
    });
    await page.goto(`${baseUrl}/#ai-qualification`, { waitUntil: "networkidle" });
    await page.getByText("Chronos-2 context window 비교").waitFor();
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      cards: Array.from(document.querySelectorAll("[data-context-window-card]"))
        .map((element) => element.getBoundingClientRect())
        .map((box) => ({ x: box.x, y: box.y, width: box.width })),
    }));
    if (layout.scrollWidth > layout.viewportWidth + 1) {
      throw new Error(`${viewport.width}px context dashboard has horizontal overflow`);
    }
    if (layout.cards.length !== 5) {
      throw new Error(`${viewport.width}px context dashboard did not render five cards`);
    }
    if (viewport.width === 1440) {
      const firstY = layout.cards[0].y;
      if (!layout.cards.every((card) => Math.abs(card.y - firstY) < 2)) {
        throw new Error("desktop context cards are not one row");
      }
    } else if (!layout.cards.slice(1).every((card, index) => card.y > layout.cards[index].y)) {
      throw new Error("mobile context cards are not vertically ordered");
    }
    if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
    const screenshot = `/tmp/chronos2-context-dashboard-${viewport.width}x${viewport.height}.png`;
    await page.screenshot({ path: screenshot, animations: "disabled", fullPage: true });
    results.push({ viewport: `${viewport.width}x${viewport.height}`, screenshot });
    await page.close();
  }
  console.info(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  await stop(preview);
}
