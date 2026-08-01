import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertHealthPayload,
  composeArguments,
  releaseChanges,
} from "./deploy-harbor-release.mjs";

const release = {
  APP_GIT_SHA: "a".repeat(40),
  RUST_WORKER_GIT_SHA: "b".repeat(40),
  WEB_IMAGE: `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${"c".repeat(64)}`,
  RUST_WORKER_IMAGE: `harbor.uaysk.com/toss-portfolio-lens/rust-worker@sha256:${"d".repeat(64)}`,
};

describe("production Harbor deployment helper", () => {
  it("constructs Compose arguments with the production project directory and digest env", () => {
    const arguments_ = composeArguments({
      sourceDirectory: "/build/source",
      runtimeDirectory: "/srv/runtime",
      releaseFile: "/state/candidate.env",
    });
    assert.deepEqual(arguments_.slice(0, 12), [
      "compose",
      "--project-name",
      "toss-portfolio-lens",
      "--project-directory",
      "/srv/runtime",
      "--env-file",
      "/srv/runtime/.env",
      "--env-file",
      "/srv/runtime/.env.scalping",
      "--env-file",
      "/state/candidate.env",
      "-f",
    ]);
    assert.ok(arguments_.includes("/build/source/compose.harbor-main.yaml"));
  });

  it("detects web-only and Rust changes independently", () => {
    const webOnly = { ...release, APP_GIT_SHA: "e".repeat(40), WEB_IMAGE: release.WEB_IMAGE.replace(/c/gu, "f") };
    assert.deepEqual(releaseChanges(release, webOnly), { web: true, rust: false });
    const rustOnly = {
      ...release,
      RUST_WORKER_GIT_SHA: "e".repeat(40),
      RUST_WORKER_IMAGE: release.RUST_WORKER_IMAGE.replace(/d/gu, "f"),
    };
    assert.deepEqual(releaseChanges(release, rustOnly), { web: false, rust: true });
  });

  it("accepts only the PostgreSQL/Rust/paper-only health contract", () => {
    const summary = assertHealthPayload({
      status: "ok",
      service: "portfolio-lens",
      storage: "postgres",
      build: { gitSha: release.APP_GIT_SHA },
      compute: { executionMode: "rust_socket" },
      simulation: { realOrder: false },
    }, release.APP_GIT_SHA);
    assert.equal(summary.gitSha, release.APP_GIT_SHA);
    assert.equal(summary.realOrder, false);
  });

  it("fails closed on an old revision, non-PostgreSQL storage, or real orders", () => {
    const base = {
      status: "ok",
      service: "portfolio-lens",
      storage: "postgres",
      build: { gitSha: release.APP_GIT_SHA },
      compute: { executionMode: "rust_socket" },
      simulation: { realOrder: false },
    };
    assert.throws(() => assertHealthPayload({ ...base, storage: "sqlite" }, release.APP_GIT_SHA));
    assert.throws(() => assertHealthPayload({ ...base, build: { gitSha: "f".repeat(40) } }, release.APP_GIT_SHA));
    assert.throws(() => assertHealthPayload({ ...base, simulation: { realOrder: true } }, release.APP_GIT_SHA));
  });
});
