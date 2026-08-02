import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

test("runner boundary does not spend a checkout and emits cgroup metrics", () => {
  assert.match(source, /runner-boundary:[\s\S]*?GIT_STRATEGY: none/u);
  assert.match(source, /after_script:[\s\S]*?ci-resource-metrics job=/u);
  assert.match(source, /memory_peak_bytes=/u);
  assert.match(source, /memory_events=/u);
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
});
