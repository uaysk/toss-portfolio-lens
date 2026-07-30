import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = process.argv[2];
if (!reportPath?.startsWith("/")) {
  throw new Error(
    "usage: node verify-chronos2-p40-qualification-report.mjs <absolute-report.html>",
  );
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const externalRequests = [];
    const pageErrors = [];
    const consoleErrors = [];
    page.on("request", (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
    await page.locator("h1").waitFor();

    for (const profile of [
      "close_only",
      "ohlcv_calendar",
      "microstructure_calendar",
      "derivatives_calendar",
    ]) {
      await page.locator(`[data-profile-tab="${profile}"]`).click();
      const batchVisible = await page
        .locator(`[data-profile-panel="${profile}"]`)
        .evaluate((element) => {
          const box = element.getBoundingClientRect();
          return !element.hidden && box.width > 0 && box.height > 0;
        });
      await page.locator(`[data-waterfall-tab="${profile}"]`).click();
      const waterfallVisible = await page
        .locator(`[data-waterfall-panel="${profile}"]`)
        .evaluate((element) => {
          const box = element.getBoundingClientRect();
          return !element.hidden && box.width > 0 && box.height > 0;
        });
      if (!batchVisible || !waterfallVisible) {
        throw new Error(`${viewport.name}/${profile} panel has zero size.`);
      }
    }

    const inspection = await page.evaluate(() => {
      const root = document.documentElement;
      const bodyText = document.body.innerText;
      const visibleCharts = [...document.querySelectorAll(".chart-fill")]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const box = element.getBoundingClientRect();
          return { width: box.width, height: box.height };
        });
      const evidence = JSON.parse(
        document.querySelector("#report-evidence")?.textContent ?? "{}",
      );
      return {
        overflow: root.scrollWidth - root.clientWidth,
        visibleChartCount: visibleCharts.length,
        zeroSizeCharts: visibleCharts.filter(
          (box) => box.width <= 0 || box.height <= 0,
        ),
        hasInvalidValue: /\bundefined\b|\bNaN\b|\bnull%\b/.test(bodyText),
        unavailableVisible: bodyText.includes("Unavailable"),
        csp: document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? "",
        selectedProfile: evidence?.selection?.selected_profile,
        selectedBackend: evidence?.profiles?.find(
          (profile) => profile.id === evidence?.selection?.selected_profile,
        )?.selectedBackend,
        selectedBatch: evidence?.profiles?.find(
          (profile) => profile.id === evidence?.selection?.selected_profile,
        )?.selectedBatch,
        replacementClassification:
          evidence?.selectedComparison?.reason?.assessment?.classification,
      };
    });
    if (inspection.overflow > 1) {
      throw new Error(
        `${viewport.name} page overflows horizontally by ${inspection.overflow}px.`,
      );
    }
    if (inspection.visibleChartCount < 8 || inspection.zeroSizeCharts.length) {
      throw new Error(
        `${viewport.name} report has missing or zero-size charts.`,
      );
    }
    if (inspection.hasInvalidValue || !inspection.unavailableVisible) {
      throw new Error(
        `${viewport.name} report does not render missing values safely.`,
      );
    }
    if (
      !inspection.csp.includes("default-src 'none'")
      || !inspection.csp.includes("connect-src 'none'")
    ) {
      throw new Error(`${viewport.name} report CSP is incomplete.`);
    }
    if (
      inspection.selectedProfile !== "close_only"
      || inspection.selectedBackend !== "gpu_gather"
      || inspection.selectedBatch !== 32
      || inspection.replacementClassification !== "not_acceptable"
    ) {
      throw new Error(
        `${viewport.name} inline evidence does not preserve the qualification decision.`,
      );
    }
    if (externalRequests.length || pageErrors.length || consoleErrors.length) {
      throw new Error(JSON.stringify({
        externalRequests,
        pageErrors,
        consoleErrors,
      }));
    }
    const screenshot = `/tmp/chronos2-p40-report-${viewport.name}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    results.push({
      viewport,
      screenshot,
      overflowPixels: inspection.overflow,
      visibleChartCount: inspection.visibleChartCount,
      externalRequests: externalRequests.length,
      pageErrors: pageErrors.length,
      consoleErrors: consoleErrors.length,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify({
  schema_version: "chronos2-p40-report-playwright-validation/v1",
  status: "passed",
  report: reportPath,
  results,
})}\n`);
