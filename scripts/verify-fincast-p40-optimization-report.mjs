import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const reportPath = process.argv[2];
if (!reportPath?.startsWith("/")) {
  throw new Error("usage: node verify-fincast-p40-optimization-report.mjs <absolute-report.html>");
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
    for (const group of ["waterfall", "batch"]) {
      for (const cadence of ["15", "30", "60"]) {
        await page.locator(`[data-tabs="${group}"] button[data-tab="${cadence}"]`).click();
        const attribute = group === "batch" ? "data-cadence-panel" : "data-waterfall-panel";
        const visible = await page.locator(`[${attribute}="${cadence}"]`).evaluate((element) => {
          const box = element.getBoundingClientRect();
          return !element.hidden && box.width > 0 && box.height > 0;
        });
        if (!visible) throw new Error(`${group}/${cadence} panel has zero size.`);
      }
    }
    const inspection = await page.evaluate(() => {
      const root = document.documentElement;
      const bodyText = document.body.innerText;
      const visibleCharts = [...document.querySelectorAll(".chart-bar")]
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
        zeroSizeCharts: visibleCharts.filter((box) => box.width <= 0 || box.height <= 0),
        hasUndefined: /\bundefined\b|\bNaN\b/.test(bodyText),
        unavailableVisible: bodyText.includes("Unavailable"),
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? "",
        evidenceBackend: evidence?.stages?.cuda_graph?.["60"]?.backend,
        evidenceBatch: evidence?.stages?.cuda_graph?.["60"]?.batch_size,
      };
    });
    if (inspection.overflow > 1) {
      throw new Error(`${viewport.name} page overflows horizontally by ${inspection.overflow}px.`);
    }
    if (inspection.visibleChartCount < 5 || inspection.zeroSizeCharts.length > 0) {
      throw new Error(`${viewport.name} report has missing or zero-size charts.`);
    }
    if (inspection.hasUndefined || !inspection.unavailableVisible) {
      throw new Error(`${viewport.name} report does not render missing values safely.`);
    }
    if (
      !inspection.csp.includes("default-src 'none'")
      || !inspection.csp.includes("connect-src 'none'")
    ) {
      throw new Error(`${viewport.name} report CSP is incomplete.`);
    }
    if (inspection.evidenceBackend !== "cuda_graph" || inspection.evidenceBatch !== 48) {
      throw new Error(`${viewport.name} inline evidence does not identify the selected backend.`);
    }
    if (externalRequests.length || pageErrors.length || consoleErrors.length) {
      throw new Error(JSON.stringify({ externalRequests, pageErrors, consoleErrors }));
    }
    const screenshot = `/tmp/fincast-p40-report-${viewport.name}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    results.push({
      viewport,
      screenshot,
      externalRequests: externalRequests.length,
      overflowPixels: inspection.overflow,
      visibleChartCount: inspection.visibleChartCount,
      pageErrors: pageErrors.length,
      consoleErrors: consoleErrors.length,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

process.stdout.write(`${JSON.stringify({
  schema_version: "fincast-p40-report-playwright-validation/v1",
  status: "passed",
  report: reportPath,
  results,
})}\n`);
