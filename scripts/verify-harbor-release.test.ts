import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { harborReleaseValidationErrors } from "./verify-harbor-release.mjs";

const script = resolve("scripts/verify-harbor-release.mjs");
const directories: string[] = [];
const gitSha = "d2318814588548abd896941e2e1fc2374da62bf5";
const rustWorkerGitSha = "179e8b69e6fc904237cf631960e7b33636f7375c";
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
    `RUST_WORKER_GIT_SHA=${rustWorkerGitSha}`,
    `WEB_IMAGE=harbor.uaysk.com/toss-portfolio-lens/web@sha256:${digest}`,
    `RUST_WORKER_IMAGE=harbor.uaysk.com/toss-portfolio-lens/rust-worker@sha256:${digest}`,
  ];

  it("accepts an allowlisted digest-pinned release set", () => {
    const result = verify(valid);
    expect(result.status).toBe(0);
  });

  it("accepts process environment input without rejecting unrelated host variables", () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...parseEnv(valid.join("\n")),
      },
    });
    expect(result.status).toBe(0);
  });

  it("accepts independently versioned local web and Rust images", () => {
    const errors = harborReleaseValidationErrors(parseEnv(valid.join("\n")), {
      inspectLocal: true,
      imageRevision: (reference: string) => (
        reference.includes("/web@") ? gitSha : rustWorkerGitSha
      ),
    });
    expect(errors).toEqual([]);
  });

  it("rejects a Rust image whose OCI revision does not match its own SHA", () => {
    const errors = harborReleaseValidationErrors(parseEnv(valid.join("\n")), {
      inspectLocal: true,
      imageRevision: () => gitSha,
    });
    expect(errors).toContain(
      "RUST_WORKER_IMAGE OCI revision does not match RUST_WORKER_GIT_SHA",
    );
  });

  it.each([
    ["mutable tag", valid.with(2, "WEB_IMAGE=harbor.uaysk.com/toss-portfolio-lens/web:latest")],
    ["wrong repository", valid.with(3, `RUST_WORKER_IMAGE=harbor.uaysk.com/library/rust-worker@sha256:${digest}`)],
    ["missing web Git SHA", valid.filter((line) => !line.startsWith("APP_GIT_SHA="))],
    ["missing Rust worker Git SHA", valid.filter((line) => !line.startsWith("RUST_WORKER_GIT_SHA="))],
    ["unexpected override", [...valid, "SCALPING_ENABLED=false"]],
  ])("rejects %s", (_label, lines) => {
    const result = verify(lines);
    expect(result.status).toBe(1);
  });
});
