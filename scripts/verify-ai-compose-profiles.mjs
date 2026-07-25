#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFiles = [
  path.join(projectRoot, "compose.yaml"),
  path.join(projectRoot, "compose.ai-remote-main.yaml"),
];
const safeEnvironment = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  AI_COMPUTE_URL: "ws://172.30.1.14:18765/ws/scalping-ai/v1",
  AI_KRONOS_COMPUTE_URL: "ws://172.30.1.14:18765/ws/scalping-ai/v1",
  AI_FINCAST_COMPUTE_URL: "ws://172.30.1.14:18766/ws/scalping-ai/v1",
  AI_COMPUTE_ALLOW_INSECURE_PRIVATE_WS: "true",
  AI_AUTH_SECRET_SOURCE: "/tmp/compose-profile-test/kronos-auth",
  AI_FINCAST_AUTH_SECRET_SOURCE: "/tmp/compose-profile-test/fincast-auth",
  POSTGRES_CA_HOST_PATH: "/dev/null",
  APP_GIT_SHA: "compose-profile-test",
};
const baseArguments = [
  "compose",
  "--project-directory",
  projectRoot,
  "--env-file",
  "/dev/null",
  ...composeFiles.flatMap((file) => ["-f", file]),
];

function compose(arguments_) {
  const result = spawnSync("docker", [...baseArguments, ...arguments_], {
    cwd: projectRoot,
    encoding: "utf8",
    env: safeEnvironment,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker compose failed with status ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const rendered = JSON.parse(compose([
  "--profile",
  "local-ai-disabled",
  "config",
  "--no-env-resolution",
  "--format",
  "json",
]));
for (const service of ["ai-worker", "fincast-worker"]) {
  const profiles = rendered.services?.[service]?.profiles;
  assert(
    JSON.stringify(profiles) === JSON.stringify(["local-ai-disabled"]),
    `${service} profiles must be replaced with only local-ai-disabled; received ${JSON.stringify(profiles)}`,
  );
}
assert(
  JSON.stringify(rendered.services?.["fincast-worker"]?.healthcheck?.test)
    === JSON.stringify(["CMD", "/app/.venv/bin/portfolio-ai-worker", "healthcheck"]),
  "FinCast runtime healthcheck must execute the installed offline worker directly",
);

const fincastProfileServices = new Set(compose([
  "--profile",
  "fincast",
  "config",
  "--no-env-resolution",
  "--services",
]).trim().split(/\r?\n/).filter(Boolean));
assert(
  !fincastProfileServices.has("ai-worker"),
  "remote-main must not activate the local Kronos worker under --profile fincast",
);
assert(
  !fincastProfileServices.has("fincast-worker"),
  "remote-main must not activate the local FinCast worker under --profile fincast",
);

process.stdout.write("remote-main AI worker profiles are fail-closed\n");
