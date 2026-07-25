import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { parseEnv } from "node:util";

const argumentsList = process.argv.slice(2);
const inspectLocal = argumentsList.includes("--inspect-local");
const positional = argumentsList.filter((argument) => !argument.startsWith("--"));
if (positional.length > 1) {
  throw new Error("usage: verify-harbor-release.mjs [release.env] [--inspect-local]");
}

const envFile = positional[0];
let values = process.env;
if (envFile) {
  if (!existsSync(envFile)) {
    throw new Error(`release env file not found: ${envFile}`);
  }
  values = parseEnv(readFileSync(envFile, "utf8"));
}

const sha256 = "[a-f0-9]{64}";
const requiredReferences = {
  WEB_IMAGE: new RegExp(`^harbor\\.uaysk\\.com/toss-portfolio-lens/web@sha256:${sha256}$`),
  RUST_WORKER_IMAGE: new RegExp(`^harbor\\.uaysk\\.com/toss-portfolio-lens/rust-worker@sha256:${sha256}$`),
};
const allowedKeys = new Set(["APP_GIT_SHA", ...Object.keys(requiredReferences)]);

const errors = [];
if (envFile) {
  for (const key of Object.keys(values)) {
    if (!allowedKeys.has(key)) errors.push(`unexpected release env key: ${key}`);
  }
}
for (const [name, pattern] of Object.entries(requiredReferences)) {
  const value = values[name]?.trim() ?? "";
  if (!pattern.test(value)) errors.push(`${name} must be a Harbor manifest digest`);
}
const appGitSha = values.APP_GIT_SHA?.trim() ?? "";
if (!/^[a-f0-9]{40}$/.test(appGitSha)) {
  errors.push("APP_GIT_SHA must be a full 40-character Git SHA");
}

if (errors.length === 0 && inspectLocal) {
  for (const name of Object.keys(requiredReferences)) {
    const inspected = spawnSync(
      "docker",
      [
        "image",
        "inspect",
        values[name],
        "--format",
        "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}",
      ],
      { encoding: "utf8" },
    );
    if (inspected.status !== 0) {
      errors.push(`${name} could not be inspected locally`);
      continue;
    }
    if (inspected.stdout.trim() !== appGitSha) {
      errors.push(`${name} OCI revision does not match APP_GIT_SHA`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  inspectLocal
    ? "Harbor release references and local OCI revisions are valid."
    : "Harbor release references are digest-pinned and valid.",
);
