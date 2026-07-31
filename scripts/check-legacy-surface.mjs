import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".dockerignore",
  ".env",
  ".example",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export const FORBIDDEN_LEGACY_TERMS = [
  "SqliteDatabase",
  "node:sqlite",
  "mysql2",
  "worker/python",
  "PYTHON_WORKER_",
  "EXECUTION_MODE=inline",
  "kronos_base",
  "legacy-kronos",
  "GRAPHIFY_TERRA_MODEL",
  "--no-terra",
];

const EXPLICIT_ALLOWLIST = [
  {
    pattern: /^docs\/reports\//u,
    reason: "immutable generated migration and comparison reports",
  },
  {
    pattern: /^public\/reports\//u,
    reason: "published static historical reports",
  },
  {
    pattern: /^server\/migrations\//u,
    reason: "cutover code must recognize and archive historical contracts",
  },
  {
    pattern: /^kiro-workspace\/\.kiro\/specs\//u,
    reason: "archived product specifications, not runtime or operational documentation",
  },
  {
    pattern: /^\.claude\//u,
    reason: "uncommitted user-owned tool configuration outside the release",
  },
  {
    pattern: /^scripts\/check-legacy-surface(?:\.test)?\.mjs$/u,
    reason: "the guard defines and tests the forbidden terms",
  },
];

function allowlisted(path) {
  return EXPLICIT_ALLOWLIST.some(({ pattern }) => pattern.test(path));
}

function repositoryFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("git ls-files failed while checking the legacy surface");
  }
  return result.stdout.split("\0").filter(Boolean);
}

export function findLegacyViolations(path, contents) {
  const violations = [];
  const lines = contents.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    for (const term of FORBIDDEN_LEGACY_TERMS) {
      if (lines[index].includes(term)) {
        violations.push({ path, line: index + 1, term });
      }
    }
  }
  return violations;
}

export function checkLegacySurface(paths = repositoryFiles()) {
  const violations = [];
  for (const path of paths) {
    if (allowlisted(path)) continue;
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !TEXT_EXTENSIONS.has(extname(path))) continue;
    const contents = readFileSync(absolute, "utf8");
    if (contents.includes("\0")) continue;
    violations.push(...findLegacyViolations(path, contents));
  }
  for (const removedPath of [
    "infra/aws/README.md",
    "infra/aws/cloudformation.yaml",
    "infra/aws/deploy.sh",
    "infra/aws/k8s/app.yaml",
  ]) {
    if (existsSync(resolve(root, removedPath))) {
      violations.push({ path: removedPath, line: 0, term: "removed deployment file still exists" });
    }
  }
  return violations;
}

function main() {
  const violations = checkLegacySurface();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.path}:${violation.line} forbidden legacy surface: ${violation.term}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Active code, configuration, and operational documentation are legacy-free.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
