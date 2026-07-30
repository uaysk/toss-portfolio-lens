#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(scriptDirectory, "unified-simulation-backtest-runner.ts");
const child = spawn(
  process.execPath,
  ["--import", "tsx", runner, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.once("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
