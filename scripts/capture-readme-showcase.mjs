import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs", "readme");
const port = Number.parseInt(process.env.README_CAPTURE_PORT || "4174", 10);
const baseUrl = `http://127.0.0.1:${port}`;
const views = ["overview", "backtest", "optimization"];
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
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => window.localStorage.setItem("portfolio-theme", "dark"));
  for (const view of views) {
    await page.goto(`${baseUrl}/readme-showcase?view=${view}`, { waitUntil: "networkidle" });
    await page.locator(`[data-showcase-view="${view}"]`).waitFor();
    await page.screenshot({ path: path.join(output, `${view}.png`), fullPage: false });
  }
  await page.goto(`${baseUrl}/docs/readme/rust-engine.html`, { waitUntil: "networkidle" });
  await page.locator("html[data-ready='true']").waitFor();
  for (const capture of rustCaptures) {
    await page.locator(`[data-capture="${capture}"]`).screenshot({ path: path.join(output, `${capture}.png`) });
  }
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
