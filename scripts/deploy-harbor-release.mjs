import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  readHarborRelease,
  serializeHarborRelease,
  writePrivateFileAtomic,
} from "./create-harbor-release.mjs";

const COMPOSE_FILES = [
  "compose.yaml",
  "compose.chatgpt.yaml",
  "compose.ai-remote-main.yaml",
  "compose.harbor-main.yaml",
];
const DEFAULT_HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_INTERVAL_MS = 3_000;
const LOCAL_HEALTH_URL = "http://127.0.0.1:3200/api/health";
const PRODUCTION_PUBLIC_ORIGIN = "https://tpl.uaysk.com";

function requiredArgument(arguments_, name) {
  const assignment = arguments_.find((argument) => argument.startsWith(`${name}=`));
  const index = arguments_.indexOf(name);
  if (assignment && index >= 0) throw new Error(`${name} must be provided once`);
  const value = assignment ? assignment.slice(name.length + 1) : index >= 0 ? arguments_[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function commandLabel(command, arguments_) {
  return [command, ...arguments_].map((part) => (
    /^[A-Za-z0-9_./:=@+-]+$/u.test(part) ? part : JSON.stringify(part)
  )).join(" ");
}

export function runCommand(command, arguments_, { cwd, capture = false } = {}) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${commandLabel(command, arguments_)} exited with status ${result.status}`);
  }
  return capture ? result.stdout.trim() : "";
}

function assertDirectory(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
}

function assertComposeFiles(sourceDirectory) {
  for (const file of COMPOSE_FILES) {
    if (!existsSync(join(sourceDirectory, file))) {
      throw new Error(`required Compose file not found: ${join(sourceDirectory, file)}`);
    }
  }
}

export function composeArguments({ sourceDirectory, runtimeDirectory, releaseFile }) {
  return [
    "compose",
    "--project-name",
    "toss-portfolio-lens",
    "--project-directory",
    runtimeDirectory,
    "--env-file",
    join(runtimeDirectory, ".env"),
    "--env-file",
    join(runtimeDirectory, ".env.scalping"),
    "--env-file",
    releaseFile,
    ...COMPOSE_FILES.flatMap((file) => ["-f", join(sourceDirectory, file)]),
  ];
}

export function releaseChanges(previous, candidate) {
  return {
    web: previous.WEB_IMAGE !== candidate.WEB_IMAGE
      || previous.APP_GIT_SHA !== candidate.APP_GIT_SHA,
    rust: previous.RUST_WORKER_IMAGE !== candidate.RUST_WORKER_IMAGE
      || previous.RUST_WORKER_GIT_SHA !== candidate.RUST_WORKER_GIT_SHA,
  };
}

export function assertHealthPayload(payload, expectedGitSha) {
  if (!payload || typeof payload !== "object") throw new Error("health response is not an object");
  if (payload.status !== "ok" || payload.service !== "portfolio-lens") {
    throw new Error("health response has an invalid service status");
  }
  if (payload.storage !== "postgres") throw new Error("health response is not using PostgreSQL");
  if (payload.build?.gitSha !== expectedGitSha) {
    throw new Error("health response Git SHA does not match the candidate release");
  }
  if (payload.compute?.executionMode !== "rust_socket") {
    throw new Error("health response is not using the Rust socket compute path");
  }
  if (payload.simulation?.realOrder !== false) {
    throw new Error("health response does not preserve the paper-only order boundary");
  }
  return {
    status: payload.status,
    service: payload.service,
    storage: payload.storage,
    gitSha: payload.build.gitSha,
    executionMode: payload.compute.executionMode,
    realOrder: payload.simulation.realOrder,
  };
}

function snapshotComposeBundle(sourceDirectory, targetDirectory) {
  if (existsSync(targetDirectory)) return;
  assertComposeFiles(sourceDirectory);
  const parent = resolve(targetDirectory, "..");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${targetDirectory}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const file of COMPOSE_FILES) {
      copyFileSync(join(sourceDirectory, file), join(temporary, file));
      chmodSync(join(temporary, file), 0o600);
    }
    renameSync(temporary, targetDirectory);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function snapshotComposeRevision({ sourceDirectory, runtimeDirectory, stateDirectory, gitSha }) {
  const target = join(stateDirectory, "compose", gitSha);
  if (existsSync(target)) return target;
  const temporarySource = join(stateDirectory, `.compose-source-${gitSha}-${process.pid}`);
  mkdirSync(temporarySource, { recursive: true, mode: 0o700 });
  let revisionAvailable = true;
  try {
    for (const file of COMPOSE_FILES) {
      const result = spawnSync("git", ["show", `${gitSha}:${file}`], {
        cwd: sourceDirectory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        revisionAvailable = false;
        break;
      }
      writeFileSync(join(temporarySource, file), result.stdout, { mode: 0o600 });
    }
    snapshotComposeBundle(revisionAvailable ? temporarySource : runtimeDirectory, target);
    return target;
  } finally {
    rmSync(temporarySource, { recursive: true, force: true });
  }
}

function dockerCompose(context, sourceDirectory, releaseFile, trailingArguments, options) {
  return context.run(
    "docker",
    [
      ...composeArguments({
        sourceDirectory,
        runtimeDirectory: context.runtimeDirectory,
        releaseFile,
      }),
      ...trailingArguments,
    ],
    options,
  );
}

function inspectImageRevision(context, imageReference) {
  return context.run(
    "docker",
    [
      "image",
      "inspect",
      imageReference,
      "--format",
      "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}",
    ],
    { capture: true },
  );
}

function verifyLocalImages(context, release) {
  const checks = [
    [release.WEB_IMAGE, release.APP_GIT_SHA, "web"],
    [release.RUST_WORKER_IMAGE, release.RUST_WORKER_GIT_SHA, "Rust worker"],
  ];
  for (const [reference, expected, label] of checks) {
    if (inspectImageRevision(context, reference) !== expected) {
      throw new Error(`${label} OCI revision does not match its release manifest`);
    }
  }
}

async function waitForContainerHealth(context, sourceDirectory, releaseFile, service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "not-created";
  while (Date.now() < deadline) {
    try {
      const containerId = dockerCompose(
        context,
        sourceDirectory,
        releaseFile,
        ["ps", "-q", service],
        { capture: true },
      );
      if (containerId) {
        lastStatus = context.run(
          "docker",
          [
            "container",
            "inspect",
            containerId,
            "--format",
            "{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
          ],
          { capture: true },
        );
        if (lastStatus === "running/healthy") return;
        if (lastStatus.startsWith("exited/") || lastStatus.startsWith("dead/")) break;
      }
    } catch {
      lastStatus = "inspection-failed";
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`${service} did not become healthy (last status: ${lastStatus})`);
}

async function fetchHealth(url, expectedGitSha) {
  if (url !== LOCAL_HEALTH_URL && url !== `${PRODUCTION_PUBLIC_ORIGIN}/api/health`) {
    throw new Error("release health checks must use the canonical local or public endpoint");
  }
  const response = await fetch(url, { // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return assertHealthPayload(await response.json(), expectedGitSha);
}

async function waitForHealthEndpoints(urls, expectedGitSha, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const results = {};
      for (const [name, url] of Object.entries(urls)) {
        results[name] = await fetchHealth(url, expectedGitSha);
      }
      return results;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(
    `release health checks timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function normalizePublicHealthUrl(value) {
  const parsed = new URL(value);
  if (
    parsed.origin !== PRODUCTION_PUBLIC_ORIGIN
    || parsed.pathname !== "/"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`public URL must be the canonical ${PRODUCTION_PUBLIC_ORIGIN} origin`);
  }
  parsed.pathname = "/api/health";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function activateRelease({
  context,
  sourceDirectory,
  releaseFile,
  release,
  changes,
  publicHealthUrl,
  timeoutMs,
  onMutation = () => {},
}) {
  dockerCompose(context, sourceDirectory, releaseFile, ["config", "--quiet"]);
  dockerCompose(context, sourceDirectory, releaseFile, ["pull", "web", "compute-ipc"]);
  verifyLocalImages(context, release);

  if (changes.rust || changes.web) onMutation();
  if (changes.rust) {
    dockerCompose(context, sourceDirectory, releaseFile, [
      "up", "-d", "--no-build", "--pull", "never", "--no-deps", "--force-recreate", "compute-ipc",
    ]);
    await waitForContainerHealth(context, sourceDirectory, releaseFile, "compute-ipc", timeoutMs);
  }
  if (changes.web) {
    dockerCompose(context, sourceDirectory, releaseFile, [
      "up", "-d", "--no-build", "--pull", "never", "--no-deps", "--force-recreate", "web",
    ]);
  }

  await waitForContainerHealth(context, sourceDirectory, releaseFile, "compute-ipc", timeoutMs);
  await waitForContainerHealth(context, sourceDirectory, releaseFile, "web", timeoutMs);
  return waitForHealthEndpoints(
    {
      local: LOCAL_HEALTH_URL,
      public: publicHealthUrl,
    },
    release.APP_GIT_SHA,
    timeoutMs,
  );
}

function safeRelease(release) {
  return {
    appGitSha: release.APP_GIT_SHA,
    rustWorkerGitSha: release.RUST_WORKER_GIT_SHA,
    webImage: release.WEB_IMAGE,
    rustWorkerImage: release.RUST_WORKER_IMAGE,
  };
}

function writeReport(path, report) {
  writePrivateFileAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
}

export async function deployHarborRelease({
  sourceDirectory,
  runtimeDirectory,
  stateDirectory,
  candidatePath,
  expectedGitSha,
  publicUrl,
  reportPath,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  run = runCommand,
}) {
  const startedAt = new Date().toISOString();
  assertDirectory(sourceDirectory, "source directory");
  assertDirectory(runtimeDirectory, "runtime directory");
  assertComposeFiles(sourceDirectory);
  for (const path of [".env", ".env.scalping", ".env.chatgpt"]) {
    if (!existsSync(join(runtimeDirectory, path))) {
      throw new Error(`runtime configuration not found: ${join(runtimeDirectory, path)}`);
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(expectedGitSha)) {
    throw new Error("expected Git SHA must be a full lowercase 40-character SHA");
  }
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);

  const currentPath = join(stateDirectory, "current.env");
  const rollbackPath = join(stateDirectory, "rollback.env");
  const previous = readHarborRelease(currentPath);
  const candidate = readHarborRelease(candidatePath);
  if (candidate.APP_GIT_SHA !== expectedGitSha) {
    throw new Error("candidate release does not match the CI commit SHA");
  }
  const changes = releaseChanges(previous, candidate);
  const publicHealthUrl = normalizePublicHealthUrl(publicUrl);
  const previousComposeDirectory = snapshotComposeRevision({
    sourceDirectory,
    runtimeDirectory,
    stateDirectory,
    gitSha: previous.APP_GIT_SHA,
  });
  dockerCompose(
    { run, runtimeDirectory },
    sourceDirectory,
    candidatePath,
    ["config", "--quiet"],
  );
  dockerCompose(
    { run, runtimeDirectory },
    previousComposeDirectory,
    currentPath,
    ["config", "--quiet"],
  );
  writePrivateFileAtomic(rollbackPath, serializeHarborRelease(previous));

  const report = {
    schemaVersion: "toss-portfolio-lens-production-release/v1",
    startedAt,
    completedAt: undefined,
    result: "deploying",
    changes,
    previous: safeRelease(previous),
    candidate: safeRelease(candidate),
    health: undefined,
    rollback: { attempted: false, succeeded: false },
  };
  const context = { run, runtimeDirectory };
  let deploymentStarted = false;

  try {
    report.health = await activateRelease({
      context,
      sourceDirectory,
      releaseFile: candidatePath,
      release: candidate,
      changes,
      publicHealthUrl,
      timeoutMs: healthTimeoutMs,
      onMutation: () => {
        deploymentStarted = true;
      },
    });
    snapshotComposeBundle(
      sourceDirectory,
      join(stateDirectory, "compose", candidate.APP_GIT_SHA),
    );
    writePrivateFileAtomic(currentPath, serializeHarborRelease(candidate));
    report.result = "deployed";
    report.completedAt = new Date().toISOString();
    writeReport(reportPath, report);
    return report;
  } catch (deploymentError) {
    report.result = "failed";
    report.error = deploymentError instanceof Error ? deploymentError.message : String(deploymentError);
    if (deploymentStarted) {
      report.rollback.attempted = true;
      try {
        report.rollback.health = await activateRelease({
          context,
          sourceDirectory: previousComposeDirectory,
          releaseFile: rollbackPath,
          release: previous,
          changes,
          publicHealthUrl,
          timeoutMs: healthTimeoutMs,
        });
        report.rollback.succeeded = true;
        report.result = "rolled-back";
      } catch (rollbackError) {
        report.rollback.error = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
      }
    }
    report.completedAt = new Date().toISOString();
    writeReport(reportPath, report);
    const rollbackDetail = report.rollback.attempted
      ? report.rollback.succeeded ? "; the previous release was restored" : "; rollback also failed"
      : "";
    throw new Error(`${report.error}${rollbackDetail}`);
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const reportPath = resolve(requiredArgument(arguments_, "--report"));
  const report = await deployHarborRelease({
    sourceDirectory: resolve(requiredArgument(arguments_, "--source-dir")),
    runtimeDirectory: resolve(requiredArgument(arguments_, "--runtime-dir")),
    stateDirectory: resolve(requiredArgument(arguments_, "--state-dir")),
    candidatePath: resolve(requiredArgument(arguments_, "--candidate")),
    expectedGitSha: requiredArgument(arguments_, "--expected-git-sha"),
    publicUrl: requiredArgument(arguments_, "--public-url"),
    reportPath,
    healthTimeoutMs: positiveInteger(
      requiredArgument(arguments_, "--health-timeout-ms"),
      "health timeout",
    ),
  });
  console.log(
    `Production release ${report.candidate.appGitSha.slice(0, 12)} passed local and public health checks.`,
  );
  console.log(`Sanitized deployment report: ${reportPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
