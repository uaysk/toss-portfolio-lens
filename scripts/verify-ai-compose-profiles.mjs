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
  AI_FINCAST_COMPUTE_URL: "ws://172.30.1.14:18766/ws/scalping-ai/v2",
  AI_CHRONOS2_COMPUTE_URL: "ws://172.30.1.14:18767/ws/scalping-ai/v2",
  AI_FINCAST_COMPUTE_ALLOW_INSECURE_PRIVATE_WS: "true",
  AI_CHRONOS2_COMPUTE_ALLOW_INSECURE_PRIVATE_WS: "true",
  AI_REMOTE_BIND_ADDRESS: "172.30.1.14",
  AI_FINCAST_AUTH_SECRET_SOURCE: "/tmp/compose-profile-test/fincast-auth",
  AI_CHRONOS2_AUTH_SECRET_SOURCE: "/tmp/compose-profile-test/chronos2-auth",
  AI_CHRONOS2_MODEL_CACHE_SOURCE: "/tmp/compose-profile-test/chronos2-model-cache",
  POSTGRES_CA_HOST_PATH: "/dev/null",
  APP_GIT_SHA: "compose-profile-test",
};
function composeWithFiles(files, arguments_) {
  const result = spawnSync("docker", [
    "compose",
    "--project-directory",
    projectRoot,
    "--env-file",
    "/dev/null",
    ...files.flatMap((file) => ["-f", file]),
    ...arguments_,
  ], {
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

function compose(arguments_) {
  return composeWithFiles(composeFiles, arguments_);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const localDefaultServices = new Set(composeWithFiles(
  [composeFiles[0]],
  ["config", "--no-env-resolution", "--services"],
).trim().split(/\r?\n/).filter(Boolean));
assert(
  localDefaultServices.has("fincast-worker"),
  "local default stack must activate the FinCast main worker",
);
assert(
  !localDefaultServices.has("chronos2-worker"),
  "local default stack must keep Chronos-2 behind its explicit qualification profile",
);

const rendered = JSON.parse(compose([
  "--profile",
  "local-ai-disabled",
  "config",
  "--no-env-resolution",
  "--format",
  "json",
]));
assert(
  rendered.services?.web?.environment?.APP_REPLICA_COUNT === "1",
  "web must declare the supported single-replica process-local topology",
);
for (const service of ["fincast-worker", "chronos2-worker"]) {
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
assert(
  rendered.services?.["fincast-worker"]?.environment?.AI_MICROBATCH_SIZE === "4",
  "FinCast worker must retain the qualified microbatch size of four",
);
assert(
  rendered.services?.["fincast-worker"]?.environment?.AI_FINCAST_RAW_BACKEND === "cuda_graph",
  "FinCast raw generation must default to the qualified CUDA Graph FP32 backend",
);
for (const cadence of [15, 30, 60]) {
  assert(
    rendered.services?.["fincast-worker"]?.environment?.[`AI_FINCAST_RAW_BATCH_${cadence}`] === "48",
    `FinCast raw generation cadence ${cadence}s must retain the qualified batch size of 48`,
  );
}

const chronos2Rendered = JSON.parse(composeWithFiles([composeFiles[0]], [
  "--profile",
  "chronos2",
  "config",
  "--no-env-resolution",
  "--format",
  "json",
]));
const chronos2 = chronos2Rendered.services?.["chronos2-worker"];
assert(chronos2, "the explicit chronos2 profile must render its challenger worker");
assert(
  chronos2.environment?.AI_MODEL_LANE === "chronos_2",
  "Chronos-2 worker must select only the chronos_2 lane",
);
assert(
  chronos2.environment?.AI_CHRONOS2_CONTEXT_BARS === "1024"
    && chronos2.environment?.AI_MIN_CONTEXT_BARS === "1024"
    && chronos2.environment?.AI_MAX_CONTEXT_BARS === "8192",
  "Chronos-2 must default to 1024 while accepting only qualified windows through 8192",
);
assert(
  chronos2.environment?.HF_HUB_OFFLINE === "1"
    && chronos2.environment?.TRANSFORMERS_OFFLINE === "1",
  "Chronos-2 runtime must remain offline",
);
assert(
  chronos2.environment?.AI_CHRONOS2_RAW_BACKEND === "gpu_gather",
  "Chronos-2 raw qualification backend must remain gpu_gather",
);
assert(
  chronos2.environment?.AI_CHRONOS2_INFERENCE_BACKEND === "cuda_graph",
  "Chronos-2 production inference must use the P40 exact-gate-qualified CUDA Graph backend",
);
assert(
  chronos2.environment?.AI_CHRONOS2_INPUT_PROFILE === "compact_causal_v1"
    && chronos2.environment?.AI_CHRONOS2_BATCH_SIZE === "32"
    && chronos2.environment?.AI_CHRONOS2_RAW_BATCH === "32",
  "Chronos-2 must retain the compact causal/B32 production defaults",
);
assert(
  JSON.stringify(chronos2.healthcheck?.test)
    === JSON.stringify(["CMD", "/app/.venv/bin/portfolio-ai-worker", "healthcheck"]),
  "Chronos-2 runtime healthcheck must execute the installed worker directly",
);

const remoteChronos2 = JSON.parse(composeWithFiles(
  [
    composeFiles[0],
    path.join(projectRoot, "compose.ai-gpu.yaml"),
    path.join(projectRoot, "compose.ai-remote-chronos2.yaml"),
  ],
  ["--profile", "chronos2", "config", "--no-env-resolution", "--format", "json"],
)).services?.["chronos2-worker"];
assert(remoteChronos2, "the remote Chronos-2 deployment must render its worker");
assert(
  remoteChronos2.ports?.[0]?.host_ip === "172.30.1.14"
    && remoteChronos2.ports?.[0]?.published === "18767",
  "remote Chronos-2 must bind only the configured private-LAN address and port",
);
assert(
  remoteChronos2.environment?.AI_WEBSOCKET_GENERATE_AUTH_TOKEN === "false",
  "remote Chronos-2 must require a pre-provisioned token",
);
assert(
  remoteChronos2.volumes?.some(
    (volume) => volume.target === "/models" && volume.read_only === true,
  ),
  "remote Chronos-2 model cache must be mounted read-only",
);

process.stdout.write("FinCast remains the local main worker; Chronos-2 is explicit, offline, and fail-closed\n");
