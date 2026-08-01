import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { harborReleaseValidationErrors } from "./verify-harbor-release.mjs";

const RELEASE_FIELDS = [
  "APP_GIT_SHA",
  "RUST_WORKER_GIT_SHA",
  "WEB_IMAGE",
  "RUST_WORKER_IMAGE",
];
const RELEASE_FIELD_SET = new Set(RELEASE_FIELDS);
const WEB_REPOSITORY = "harbor.uaysk.com/toss-portfolio-lens/web";
const RUST_REPOSITORY = "harbor.uaysk.com/toss-portfolio-lens/rust-worker";

function requiredArgument(arguments_, name) {
  const assignments = arguments_.filter((argument) => argument.startsWith(`${name}=`));
  const indexes = arguments_.flatMap((argument, index) => argument === name ? [index] : []);
  if (assignments.length + indexes.length !== 1) {
    throw new Error(`${name} must be provided exactly once`);
  }
  if (assignments.length === 1) return assignments[0].slice(name.length + 1);
  const value = arguments_[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function optionalArgument(arguments_, name) {
  const assignments = arguments_.filter((argument) => argument.startsWith(`${name}=`));
  const indexes = arguments_.flatMap((argument, index) => argument === name ? [index] : []);
  if (assignments.length + indexes.length > 1) {
    throw new Error(`${name} may be provided at most once`);
  }
  if (assignments.length === 1) return assignments[0].slice(name.length + 1);
  if (indexes.length === 0) return undefined;
  const value = arguments_[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function validateGitSha(value, label) {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character Git SHA`);
  }
  return value;
}

export function readHarborRelease(path) {
  if (!existsSync(path)) throw new Error(`release env file not found: ${path}`);
  const values = parseEnv(readFileSync(path, "utf8"));
  const errors = harborReleaseValidationErrors(values, { rejectUnexpected: true });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return Object.fromEntries(RELEASE_FIELDS.map((field) => [field, values[field].trim()]));
}

function repositoryFromTag(tag) {
  const slash = tag.lastIndexOf("/");
  const colon = tag.lastIndexOf(":");
  if (colon <= slash) throw new Error(`image tag must include an explicit tag: ${tag}`);
  return tag.slice(0, colon);
}

export function resolveLocalHarborImage(
  tag,
  expectedRevision,
  expectedRepository,
  inspectImage = (reference) => {
    const inspected = spawnSync(
      "docker",
      ["image", "inspect", reference, "--format", "{{json .}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (inspected.status !== 0) {
      throw new Error(`local image inspection failed for ${reference}`);
    }
    return JSON.parse(inspected.stdout);
  },
) {
  validateGitSha(expectedRevision, "expected revision");
  if (repositoryFromTag(tag) !== expectedRepository) {
    throw new Error(`image tag must use repository ${expectedRepository}`);
  }
  const image = inspectImage(tag);
  const revision = image?.Config?.Labels?.["org.opencontainers.image.revision"];
  if (revision !== expectedRevision) {
    throw new Error(`OCI revision for ${expectedRepository} does not match the release Git SHA`);
  }
  const prefix = `${expectedRepository}@sha256:`;
  const digestReference = image?.RepoDigests?.find((reference) => (
    typeof reference === "string"
    && reference.startsWith(prefix)
    && /^[a-f0-9]{64}$/u.test(reference.slice(prefix.length))
  ));
  if (!digestReference) {
    throw new Error(`local image ${tag} has no digest for ${expectedRepository}`);
  }
  return digestReference;
}

export function createHarborRelease({
  gitSha,
  webImage,
  rustImage,
  currentRelease,
}) {
  validateGitSha(gitSha, "git SHA");
  if (!rustImage && !currentRelease) {
    throw new Error("current release is required when the Rust image is reused");
  }
  const values = {
    APP_GIT_SHA: gitSha,
    RUST_WORKER_GIT_SHA: rustImage ? gitSha : currentRelease.RUST_WORKER_GIT_SHA,
    WEB_IMAGE: webImage,
    RUST_WORKER_IMAGE: rustImage ?? currentRelease.RUST_WORKER_IMAGE,
  };
  const errors = harborReleaseValidationErrors(values, { rejectUnexpected: true });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return values;
}

export function serializeHarborRelease(values) {
  const errors = harborReleaseValidationErrors(values, { rejectUnexpected: true });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return `${RELEASE_FIELDS.map((field) => `${field}=${values[field]}`).join("\n")}\n`;
}

export function writePrivateFileAtomic(path, contents) {
  const target = resolve(path);
  const targetDirectory = dirname(target);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readCommand(arguments_) {
  if (arguments_.length !== 3) {
    throw new Error("usage: create-harbor-release.mjs read <release.env> <field>");
  }
  const [, path, field] = arguments_;
  if (!RELEASE_FIELD_SET.has(field)) throw new Error(`unsupported release field: ${field}`);
  process.stdout.write(`${readHarborRelease(path)[field]}\n`);
}

function createCommand(arguments_) {
  const currentPath = requiredArgument(arguments_, "--current");
  const gitSha = requiredArgument(arguments_, "--git-sha");
  const webTag = requiredArgument(arguments_, "--web-tag");
  const rustTag = optionalArgument(arguments_, "--rust-tag");
  const output = requiredArgument(arguments_, "--output");
  const currentRelease = readHarborRelease(currentPath);
  const webImage = resolveLocalHarborImage(webTag, gitSha, WEB_REPOSITORY);
  const rustImage = rustTag
    ? resolveLocalHarborImage(rustTag, gitSha, RUST_REPOSITORY)
    : undefined;
  const release = createHarborRelease({
    gitSha,
    webImage,
    rustImage,
    currentRelease,
  });
  writePrivateFileAtomic(output, serializeHarborRelease(release));
  console.log(`Digest-pinned candidate release written to ${output}`);
}

function main() {
  const arguments_ = process.argv.slice(2);
  const command = arguments_[0];
  if (command === "read") return readCommand(arguments_);
  if (command === "create") return createCommand(arguments_.slice(1));
  throw new Error(
    "usage: create-harbor-release.mjs read <release.env> <field>\n"
      + "   or: create-harbor-release.mjs create --current FILE --git-sha SHA"
      + " --web-tag IMAGE [--rust-tag IMAGE] --output FILE",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
