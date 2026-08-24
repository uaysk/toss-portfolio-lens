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
  for (const job of ["node-static", "vitest-light", "vitest-heavy", "vitest-pglite", "semgrep-sast", "secret_detection", "python-ai-quality", "rust-quality"]) {
    const block = source.match(new RegExp(`${job}:[\\s\\S]*?(?=\\n\\S|$)`, "u"))?.[0] ?? "";
    assert.match(block, /dependencies: \[\]/u, job);
  }
  const postgres = source.match(/postgres-integration:[\s\S]*?security-report-gate:/u)?.[0] ?? "";
  assert.match(postgres, /needs:[\s\S]*?rust-quality/u);
  assert.doesNotMatch(postgres, /postgres-integration:[\s\S]*?dependencies: \[\]/u);
});

test("UI regression reuses the validated client build without compiling it again", () => {
  const nodeStatic = source.match(/node-static:[\s\S]*?\n\ndocs-validation:/u)?.[0] ?? "";
  const uiRegression = source.match(/ui-regression:[\s\S]*?\n\npostgres-integration:/u)?.[0] ?? "";
  assert.match(nodeStatic, /artifacts:[\s\S]*?paths:[\s\S]*?- dist\/client\//u);
  assert.match(nodeStatic, /rules: !reference \[\.ci-code-sensitive-rules, rules\]/u);
  assert.match(uiRegression, /needs:\s*\n\s*- job: node-static\s*\n\s*artifacts: true/u);
  assert.match(uiRegression, /rules: !reference \[\.ci-code-sensitive-rules, rules\]/u);
  assert.match(uiRegression, /test -f dist\/client\/index\.html/u);
  assert.match(uiRegression, /UI_VALIDATION_SKIP_BUILD: "1"/u);
  assert.doesNotMatch(uiRegression, /dependencies:/u);
  assert.doesNotMatch(uiRegression, /npm run build:client/u);
});

test("Node cache writes are restricted to protected validation boundaries", () => {
  const nodeJobBlock = source.match(/\.node-job:[\s\S]*?\n\nnode-static:/u)?.[0] ?? "";
  assert.match(
    nodeJobBlock,
    /prefix: node-npm-v3[\s\S]*?policy: pull[\s\S]*?paths:\s*\n\s*- \.cache\/npm\//u,
  );
  assert.match(
    source,
    /node-static:[\s\S]*?NODE_STATIC_CACHE_POLICY: pull[\s\S]*?prefix: node-npm-v3[\s\S]*?policy: \$NODE_STATIC_CACHE_POLICY[\s\S]*?prefix: node-build-v3[\s\S]*?policy: \$NODE_STATIC_CACHE_POLICY/u,
  );
  assert.match(
    source,
    /\.ci-code-sensitive-rules:[\s\S]*?CI_COMMIT_REF_PROTECTED == "true"[\s\S]*?CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH[\s\S]*?NODE_STATIC_CACHE_POLICY: pull-push/u,
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

test("Rust cache writes are restricted to protected validation boundaries and incremental state is disabled", () => {
  const block = source.match(/rust-quality:[\s\S]*?\n\ncnpg-backup-retention:/u)?.[0] ?? "";
  assert.match(source, /CARGO_INCREMENTAL: "0"/u);
  assert.match(source, /prefix: rust-registry-v3[\s\S]*?policy: \$RUST_CACHE_POLICY/u);
  assert.match(source, /prefix: rust-target-v3[\s\S]*?policy: \$RUST_CACHE_POLICY/u);
  assert.match(block, /\n  variables:[\s\S]*?RUST_CACHE_POLICY: pull\n/u);
  assert.match(
    block,
    /rules:\s*\n\s*- if: '\$CI_COMMIT_REF_PROTECTED == "true" && \(\$CI_PIPELINE_SOURCE == "schedule" \|\| \$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH \|\| \$CI_COMMIT_TAG\)'\s*\n\s*variables:\s*\n\s*RUST_CACHE_POLICY: pull-push\s*\n\s*- if: '\$CI_PIPELINE_SOURCE == "schedule" \|\| \$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH \|\| \$CI_COMMIT_TAG'/u,
  );
});

test("Python worker quality uses a locked CPU-only environment and sync-free gates", () => {
  const block = source.match(/python-ai-quality:[\s\S]*?\n\nrust-quality:/u)?.[0] ?? "";
  assert.match(source, /\.ci-python-ai-paths:[\s\S]*?worker\/ai\/\*\*\/\*[\s\S]*?contracts\/scalping-ai\/\*\*\/\*/u);
  assert.match(block, /changes: \*ci_python_ai_paths/u);
  assert.doesNotMatch(block, /changes: \*ci_code_paths/u);
  assert.match(block, /uv:0\.7\.19-python3\.12-bookworm-slim@sha256:[a-f0-9]{64}/u);
  assert.match(block, /resource_group: toss-portfolio-lens-memory-heavy/u);
  assert.match(block, /uv export --quiet --all-extras --locked/u);
  assert.match(block, /uv pip install[\s\S]*?--torch-backend cpu[\s\S]*?--strict/u);
  assert.match(block, /prefix: python-ai-uv-v2[\s\S]*?policy: \$PYTHON_AI_CACHE_POLICY/u);
  assert.match(block, /\n  variables:\s*\n\s*PYTHON_AI_CACHE_POLICY: pull\n/u);
  assert.match(
    block,
    /rules:\s*\n\s*- if: '\$CI_COMMIT_REF_PROTECTED == "true" && \(\$CI_PIPELINE_SOURCE == "schedule" \|\| \$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH \|\| \$CI_COMMIT_TAG\)'\s*\n\s*variables:\s*\n\s*PYTHON_AI_CACHE_POLICY: pull-push\s*\n\s*- if: '\$CI_PIPELINE_SOURCE == "schedule" \|\| \$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH \|\| \$CI_COMMIT_TAG'/u,
  );
  assert.match(block, /uv run --no-sync ruff check/u);
  assert.match(block, /uv run --no-sync pytest/u);
  assert.match(block, /junit: \.cache\/test-reports\/python-ai\/pytest\.xml/u);
});

test("Semgrep keeps a bounded rule timeout and resource telemetry", () => {
  assert.match(source, /SAST_SCANNER_ALLOWED_CLI_OPTS: "--timeout 5"/u);
  assert.match(source, /semgrep-sast:[\s\S]*?dependencies: \[\]/u);
});
