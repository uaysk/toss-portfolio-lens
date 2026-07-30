#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function runDirectory(argv) {
  const index = argv.indexOf("--run-dir");
  if (index < 0 || !argv[index + 1]) {
    throw new Error("Usage: node scripts/monitor-unified-simulation-backtests.mjs --run-dir <path>");
  }
  return path.resolve(argv[index + 1]);
}

try {
  const directory = runDirectory(process.argv.slice(2));
  const statusPath = path.join(directory, "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  const heartbeatAgeSeconds = Number.isFinite(Date.parse(status.heartbeatAt))
    ? Math.max(0, (Date.now() - Date.parse(status.heartbeatAt)) / 1_000)
    : null;
  process.stdout.write(`${JSON.stringify({
    ...status,
    heartbeatAgeSeconds,
    processAlive: Number.isSafeInteger(status.pid)
      ? (() => {
          try {
            process.kill(status.pid, 0);
            return true;
          } catch {
            return false;
          }
        })()
      : false,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
