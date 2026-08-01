import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("production CI release entrypoint", () => {
  it("has valid Bash syntax and fail-closed runner guards", () => {
    const result = spawnSync("bash", ["-n", "scripts/ci-release-production.sh"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const source = readFileSync("scripts/ci-release-production.sh", "utf8");
    assert.match(source, /CI_COMMIT_REF_PROTECTED/u);
    assert.match(source, /toss-portfolio-lens-release/u);
    assert.match(source, /--resource memory=4g/u);
    assert.match(source, /harbor-trivy-release\.mjs/u);
    assert.match(source, /deploy-harbor-release\.mjs/u);
    assert.doesNotMatch(source, /fincast-worker|chronos2-worker|nvidia|cuda/iu);
  });
});
