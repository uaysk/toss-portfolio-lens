import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/verify-harbor-release.mjs");
const directories: string[] = [];
const gitSha = "d2318814588548abd896941e2e1fc2374da62bf5";
const digest = "a".repeat(64);

function verify(lines: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "tpl-harbor-release-"));
  directories.push(directory);
  const file = join(directory, "release.env");
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Harbor release validator", () => {
  const valid = [
    `APP_GIT_SHA=${gitSha}`,
    `WEB_IMAGE=harbor.uaysk.com/toss-portfolio-lens/web@sha256:${digest}`,
    `RUST_WORKER_IMAGE=harbor.uaysk.com/toss-portfolio-lens/rust-worker@sha256:${digest}`,
  ];

  it("accepts an allowlisted digest-pinned release set", () => {
    const result = verify(valid);
    expect(result.status).toBe(0);
  });

  it.each([
    ["mutable tag", valid.with(1, "WEB_IMAGE=harbor.uaysk.com/toss-portfolio-lens/web:latest")],
    ["wrong repository", valid.with(2, `RUST_WORKER_IMAGE=harbor.uaysk.com/library/rust-worker@sha256:${digest}`)],
    ["missing Git SHA", valid.slice(1)],
    ["unexpected override", [...valid, "SCALPING_ENABLED=false"]],
  ])("rejects %s", (_label, lines) => {
    const result = verify(lines);
    expect(result.status).toBe(1);
  });
});
