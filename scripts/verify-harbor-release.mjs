import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const sha256 = "[a-f0-9]{64}";
const requiredReferences = {
  WEB_IMAGE: {
    pattern: new RegExp(`^harbor\\.uaysk\\.com/toss-portfolio-lens/web@sha256:${sha256}$`),
    revisionKey: "APP_GIT_SHA",
  },
  RUST_WORKER_IMAGE: {
    pattern: new RegExp(`^harbor\\.uaysk\\.com/toss-portfolio-lens/rust-worker@sha256:${sha256}$`),
    revisionKey: "RUST_WORKER_GIT_SHA",
  },
};
const requiredRevisions = new Set(
  Object.values(requiredReferences).map(({ revisionKey }) => revisionKey),
);
const allowedKeys = new Set([...requiredRevisions, ...Object.keys(requiredReferences)]);

function localImageRevision(reference) {
  const inspected = spawnSync(
    "docker",
    [
      "image",
      "inspect",
      reference,
      "--format",
      "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}",
    ],
    { encoding: "utf8" },
  );
  return inspected.status === 0 ? inspected.stdout.trim() : undefined;
}

export function harborReleaseValidationErrors(
  values,
  {
    inspectLocal = false,
    imageRevision = localImageRevision,
    rejectUnexpected = true,
  } = {},
) {
  const errors = [];
  if (rejectUnexpected) {
    for (const key of Object.keys(values)) {
      if (!allowedKeys.has(key)) errors.push(`unexpected release env key: ${key}`);
    }
  }
  for (const [name, { pattern }] of Object.entries(requiredReferences)) {
    const value = values[name]?.trim() ?? "";
    if (!pattern.test(value)) errors.push(`${name} must be a Harbor manifest digest`);
  }
  for (const name of requiredRevisions) {
    const revision = values[name]?.trim() ?? "";
    if (!/^[a-f0-9]{40}$/.test(revision)) {
      errors.push(`${name} must be a full 40-character Git SHA`);
    }
  }

  if (errors.length === 0 && inspectLocal) {
    for (const [name, { revisionKey }] of Object.entries(requiredReferences)) {
      const revision = imageRevision(values[name]);
      if (revision === undefined) {
        errors.push(`${name} could not be inspected locally`);
        continue;
      }
      if (revision !== values[revisionKey].trim()) {
        errors.push(`${name} OCI revision does not match ${revisionKey}`);
      }
    }
  }
  return errors;
}

function main() {
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

  const errors = harborReleaseValidationErrors(values, {
    inspectLocal,
    rejectUnexpected: Boolean(envFile),
  });
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }

  console.log(
    inspectLocal
      ? "Harbor release references and local OCI revisions are valid."
      : "Harbor release references are digest-pinned and valid.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
