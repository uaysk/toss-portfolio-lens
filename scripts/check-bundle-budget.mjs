import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const root = new URL("../", import.meta.url);
const clientDirectory = join(root.pathname, "dist/client");
const manifestPath = join(clientDirectory, ".vite/manifest.json");
const outputPath = join(root.pathname, ".cache/performance/bundle-report.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const routeBudgets = {
  dashboard: {
    manifestName: "dashboard",
    baselineGzipBytes: 241_896,
    maximumGzipBytes: 193_516,
  },
  backtest: {
    manifestName: "portfolio-backtest",
    baselineGzipBytes: 339_552,
    maximumGzipBytes: 271_641,
  },
  simulation: {
    manifestName: "ai-simulation",
    baselineGzipBytes: 314_379,
    maximumGzipBytes: 251_503,
  },
};
const initialAppBudget = {
  baselineGzipBytes: 99_676,
  maximumGzipBytes: 80_000,
};
const maximumPageChunkBytes = 250 * 1_024;

function findRouteEntry(name) {
  const match = Object.entries(manifest).find(([, item]) => (
    item.name === name && item.isDynamicEntry
  ));
  if (!match) throw new Error(`Vite manifest route not found: ${name}`);
  return match;
}

function staticClosure(entryKey) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    const item = manifest[key];
    if (!item) throw new Error(`Vite manifest import not found: ${key}`);
    seen.add(key);
    for (const imported of item.imports ?? []) visit(imported);
  };
  visit(entryKey);
  return [...seen];
}

function fileMetrics(file) {
  const path = join(clientDirectory, file);
  const payload = readFileSync(path);
  return {
    file,
    rawBytes: payload.byteLength,
    gzipBytes: gzipSync(payload, { level: 9 }).byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

const failures = [];
const initialEntry = Object.entries(manifest).find(([, item]) => item.isEntry);
if (!initialEntry) throw new Error("Vite manifest entry not found");
const initialFiles = staticClosure(initialEntry[0]).map((key) => fileMetrics(manifest[key].file));
const initialApp = {
  entry: initialEntry[1].file,
  rawBytes: initialFiles.reduce((sum, file) => sum + file.rawBytes, 0),
  gzipBytes: initialFiles.reduce((sum, file) => sum + file.gzipBytes, 0),
  baselineGzipBytes: initialAppBudget.baselineGzipBytes,
  maximumGzipBytes: initialAppBudget.maximumGzipBytes,
  files: initialFiles,
};
initialApp.reductionPercent = Number((
  ((initialApp.baselineGzipBytes - initialApp.gzipBytes) / initialApp.baselineGzipBytes) * 100
).toFixed(2));
if (initialApp.gzipBytes > initialApp.maximumGzipBytes) {
  failures.push(
    `initial app gzip ${initialApp.gzipBytes} > ${initialApp.maximumGzipBytes}`,
  );
}

const routes = Object.fromEntries(Object.entries(routeBudgets).map(([route, budget]) => {
  const [entryKey, entry] = findRouteEntry(budget.manifestName);
  const files = staticClosure(entryKey).map((key) => fileMetrics(manifest[key].file));
  const rawBytes = files.reduce((sum, file) => sum + file.rawBytes, 0);
  const gzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
  const reductionPercent = (
    (budget.baselineGzipBytes - gzipBytes) / budget.baselineGzipBytes
  ) * 100;
  if (gzipBytes > budget.maximumGzipBytes) {
    failures.push(
      `${route} initial gzip ${gzipBytes} > ${budget.maximumGzipBytes}`,
    );
  }
  if (statSync(join(clientDirectory, entry.file)).size > maximumPageChunkBytes) {
    failures.push(
      `${route} page chunk ${entry.file} exceeds ${maximumPageChunkBytes} bytes`,
    );
  }
  return [route, {
    entry: entry.file,
    rawBytes,
    gzipBytes,
    baselineGzipBytes: budget.baselineGzipBytes,
    reductionPercent: Number(reductionPercent.toFixed(2)),
    maximumGzipBytes: budget.maximumGzipBytes,
    files,
  }];
}));

const oversizedDynamicChunks = Object.values(manifest)
  .filter((item) => item.isDynamicEntry)
  .map((item) => ({
    file: item.file,
    rawBytes: statSync(join(clientDirectory, item.file)).size,
  }))
  .filter((item) => item.rawBytes > maximumPageChunkBytes);
for (const chunk of oversizedDynamicChunks) {
  failures.push(
    `dynamic page chunk ${chunk.file} is ${chunk.rawBytes} bytes (limit ${maximumPageChunkBytes})`,
  );
}

const report = {
  schemaVersion: "bundle-budget/v1",
  generatedAt: new Date().toISOString(),
  manifest: ".vite/manifest.json",
  maximumPageChunkBytes,
  initialApp,
  routes,
  oversizedDynamicChunks,
  passed: failures.length === 0,
  failures,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `initial: ${initialApp.gzipBytes} gzip bytes `
  + `(${initialApp.reductionPercent.toFixed(2)}% below baseline), `
  + `${initialApp.entry}`,
);
for (const [route, metrics] of Object.entries(routes)) {
  console.log(
    `${route}: ${metrics.gzipBytes} gzip bytes `
    + `(${metrics.reductionPercent.toFixed(2)}% below baseline), `
    + `${metrics.entry}`,
  );
}
if (failures.length) {
  throw new Error(`Bundle budget failed:\n${failures.join("\n")}`);
}
