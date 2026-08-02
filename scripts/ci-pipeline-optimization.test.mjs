import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

test("runner boundary does not spend a checkout and emits cgroup metrics", () => {
  assert.match(source, /runner-boundary:[\s\S]*?GIT_STRATEGY: none/u);
  assert.doesNotMatch(source, /^\s*after_script:/mu);
  assert.match(source, /ci-resource-metrics scope=job-script job=/u);
  assert.match(source, /memory_peak_bytes=/u);
  assert.match(source, /memory_events=/u);
  assert.match(source, /cpu_usage_usec=/u);
  assert.match(source, /io_bytes=/u);
});

test("docs-only changes have a bounded validation lane and code changes keep full gates", () => {
  assert.match(source, /docs-validation:[\s\S]*?\.ci-docs-only-rules/u);
  assert.match(source, /node-static:[\s\S]*?\.ci-code-sensitive-rules/u);
  assert.match(source, /vitest-pglite:[\s\S]*?VITEST_PGLITE_MAX_PARALLEL: "2"/u);
  assert.match(source, /vitest-pglite:[\s\S]*?VITEST_PGLITE_SERIAL_FILES/u);
});

test("independent jobs do not download predecessor artifacts", () => {
  for (const job of ["node-static", "vitest-light", "vitest-heavy", "vitest-pglite", "semgrep-sast", "secret_detection", "rust-quality", "ui-regression"]) {
    const block = source.match(new RegExp(`${job}:[\\s\\S]*?(?=\\n\\S|$)`, "u"))?.[0] ?? "";
    assert.match(block, /dependencies: \[\]/u, job);
  }
  const postgres = source.match(/postgres-integration:[\s\S]*?security-report-gate:/u)?.[0] ?? "";
  assert.match(postgres, /needs:[\s\S]*?rust-quality/u);
  assert.doesNotMatch(postgres, /postgres-integration:[\s\S]*?dependencies: \[\]/u);
});

test("Node cache has one writer and pull-only consumers", () => {
  const nodeJobBlock = source.match(/\.node-job:[\s\S]*?\n\nnode-static:/u)?.[0] ?? "";
  assert.match(
    nodeJobBlock,
    /prefix: node-npm-v2[\s\S]*?policy: pull[\s\S]*?paths:\s*\n\s*- \.cache\/npm\//u,
  );
  assert.match(
    source,
    /node-static:[\s\S]*?prefix: node-npm-v2[\s\S]*?policy: pull-push[\s\S]*?prefix: node-build-v2/u,
  );
  assert.doesNotMatch(nodeJobBlock, /dist\/server\//u);
});

test("generated qualification bundles are rebuilt before the Semgrep exclusion", () => {
  assert.match(source, /QUALIFICATION_TOOLS_OUTPUT=.*npm run qualification:chronos2:tools/u);
  assert.match(source, /node scripts\/verify-qualification-tools\.mjs/u);
  assert.match(source, /SAST_EXCLUDED_PATHS: .*qualification-tools/u);
});

test("CNPG helper runs on main/schedules or relevant changes and has no unused artifact", () => {
  const block = source.match(/cnpg-backup-retention:[\s\S]*?\n\nui-regression:/u)?.[0] ?? "";
  assert.match(block, /CI_PIPELINE_SOURCE == "schedule" \|\| \$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH/u);
  assert.match(block, /infra\/homelab\/cnpg-backup-retention\/\*\*\/\*/u);
  assert.doesNotMatch(block, /\n\s*artifacts:/u);
});

test("ephemeral test artifacts have shorter retention while release artifacts stay auditable", () => {
  assert.match(source, /vitest-pglite:[\s\S]*?expire_in: 14 days/u);
  assert.match(source, /ui-regression:[\s\S]*?expire_in: 7 days/u);
  assert.match(source, /release-production:[\s\S]*?expire_in: 90 days/u);
  assert.match(source, /ui-regression:[\s\S]*?find "\$UI_VALIDATION_SCREENSHOT_DIR" -type f -name '\*\.png' -delete/u);
  assert.match(source, /vitest-coverage:[\s\S]*?VITEST_JUNIT_DIR/u);
  assert.match(source, /vitest-coverage:[\s\S]*?junit: \.cache\/test-reports\/vitest-coverage\/\*\.xml/u);
});

test("Rust cache writes are restricted to the default branch and incremental state is disabled", () => {
  assert.match(source, /CARGO_INCREMENTAL: "0"/u);
  assert.match(source, /prefix: rust-registry-v2[\s\S]*?policy: \$RUST_CACHE_POLICY/u);
  assert.match(source, /prefix: rust-target-v2[\s\S]*?policy: \$RUST_CACHE_POLICY/u);
  assert.match(source, /RUST_CACHE_POLICY: pull-push/u);
});

test("Semgrep keeps a bounded rule timeout and resource telemetry", () => {
  assert.match(source, /SAST_SCANNER_ALLOWED_CLI_OPTS: "--timeout 5"/u);
  assert.match(source, /semgrep-sast:[\s\S]*?dependencies: \[\]/u);
});
