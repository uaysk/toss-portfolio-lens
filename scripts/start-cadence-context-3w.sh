#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_ROOT=${CADENCE_CONTEXT_RUN_ROOT:-"${PROJECT_ROOT}/data/ai-qualification/cadence-context-3w"}
CACHE_ROOT=${CADENCE_CONTEXT_CACHE_ROOT:-"${PROJECT_ROOT}/data/cadence-context-cache"}
SOURCE_DIR=${CADENCE_CONTEXT_SOURCE_DIR:-}
FINCAST_TOKEN_FILE=${FINCAST_AI_AUTH_TOKEN_FILE:-"${PROJECT_ROOT}/data/secrets/fincast-ai/token"}
CHRONOS2_TOKEN_FILE=${CHRONOS2_AI_AUTH_TOKEN_FILE:-"${PROJECT_ROOT}/data/secrets/chronos2-ai/token"}
FINCAST_URL=${FINCAST_AI_WORKER_URL:-ws://127.0.0.1:18766/ws/scalping-ai/v1}
CHRONOS2_URL=${CHRONOS2_AI_WORKER_URL:-ws://127.0.0.1:18767/ws/scalping-ai/v1}
RUNNER_IMAGE=${CADENCE_CONTEXT_RUNNER_IMAGE:-toss-portfolio-lens-chronos2-worker:local}
RUN_ID=${CADENCE_CONTEXT_RUN_ID:-cadence-context-3w-$(date -u +%Y%m%d-%H%M%S)}
SMOKE_ONLY=${CADENCE_CONTEXT_SMOKE_ONLY:-0}
START_UI=${CADENCE_CONTEXT_START_UI:-1}
UI_RUNTIME_DIR=${CADENCE_CONTEXT_UI_RUNTIME_DIR:-"${RUN_ROOT}/.dashboard-runtime"}
UI_SESSION=${CADENCE_CONTEXT_UI_SESSION:-tpl-cadence-context-ui}
API_PORT=${CADENCE_CONTEXT_API_PORT:-3212}
WEB_PORT=${CADENCE_CONTEXT_WEB_PORT:-5175}
PUBLIC_URL=${CADENCE_CONTEXT_PUBLIC_URL:-http://127.0.0.1:${WEB_PORT}}
CONTAINER_NAME="tpl-cadence-context-${RUN_ID}"

if [[ -z "${SOURCE_DIR}" ]] \
  || [[ "${SOURCE_DIR}" != /* ]] \
  || [[ ! -f "${SOURCE_DIR}/source-manifest.json" ]] \
  || [[ ! -f "${SOURCE_DIR}/market-bars.jsonl" ]] \
  || [[ ! -f "${FINCAST_TOKEN_FILE}" ]] \
  || [[ ! -f "${CHRONOS2_TOKEN_FILE}" ]] \
  || [[ ! "${RUN_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "source directory, token files, or run ID is invalid" >&2
  exit 2
fi

mkdir -p "${RUN_ROOT}/${RUN_ID}" "${CACHE_ROOT}"
chmod 700 "${RUN_ROOT}" "${RUN_ROOT}/${RUN_ID}" "${CACHE_ROOT}"

if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  running=$(docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}")
  if [[ "${running}" == "true" ]]; then
    echo "pipeline container is already running: ${CONTAINER_NAME}" >&2
    exit 3
  fi
  docker rm "${CONTAINER_NAME}" >/dev/null
fi

GIT_SHA=${BENCHMARK_GIT_SHA:-$(git -C "${PROJECT_ROOT}" rev-parse HEAD 2>/dev/null || printf uncommitted)}
if [[ -n "${BENCHMARK_WORKTREE_DIGEST:-}" ]]; then
  WORKTREE_DIGEST=${BENCHMARK_WORKTREE_DIGEST}
elif git -C "${PROJECT_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  WORKTREE_DIGEST=$(
    {
      git -C "${PROJECT_ROOT}" diff --binary HEAD
      while IFS= read -r -d '' relative_path; do
        sha256sum "${PROJECT_ROOT}/${relative_path}"
      done < <(git -C "${PROJECT_ROOT}" ls-files --others --exclude-standard -z | sort -z)
    } | sha256sum | cut -d' ' -f1
  )
else
  echo "BENCHMARK_WORKTREE_DIGEST is required outside a Git worktree" >&2
  exit 2
fi
launch_path="${RUN_ROOT}/${RUN_ID}/launch.json"
launch_temporary="${RUN_ROOT}/${RUN_ID}/.launch.json.${BASHPID}.tmp"
jq -n \
  --arg schemaVersion "cadence-context-launch/v2" \
  --arg runId "${RUN_ID}" \
  --arg runRoot "${RUN_ROOT}" \
  --arg cacheRoot "${CACHE_ROOT}" \
  --arg sourceDir "${SOURCE_DIR}" \
  --arg fincastTokenFile "${FINCAST_TOKEN_FILE}" \
  --arg chronos2TokenFile "${CHRONOS2_TOKEN_FILE}" \
  --arg fincastUrl "${FINCAST_URL}" \
  --arg chronos2Url "${CHRONOS2_URL}" \
  --arg runnerImage "${RUNNER_IMAGE}" \
  --arg gitSha "${GIT_SHA}" \
  --arg workingTreeDigest "${WORKTREE_DIGEST}" \
  --arg smokeOnly "${SMOKE_ONLY}" \
  --arg startUi "${START_UI}" \
  --arg uiRuntimeDir "${UI_RUNTIME_DIR}" \
  --arg uiSession "${UI_SESSION}" \
  --arg apiPort "${API_PORT}" \
  --arg webPort "${WEB_PORT}" \
  --arg publicUrl "${PUBLIC_URL}" \
  '{
    schemaVersion: $schemaVersion,
    runId: $runId,
    runRoot: $runRoot,
    cacheRoot: $cacheRoot,
    sourceDir: $sourceDir,
    tokenFiles: {
      fincast: $fincastTokenFile,
      chronos2: $chronos2TokenFile
    },
    workerUrls: {
      fincast: $fincastUrl,
      chronos2: $chronos2Url
    },
    runnerImage: $runnerImage,
    gitSha: $gitSha,
    workingTreeDigest: $workingTreeDigest,
    screeningPolicyVersion: "cadence-context-screening-policy/v2",
    smokeOnly: ($smokeOnly == "1"),
    dashboard: {
      enabled: ($startUi == "1"),
      runtimeDir: $uiRuntimeDir,
      session: $uiSession,
      apiPort: ($apiPort | tonumber),
      webPort: ($webPort | tonumber),
      publicUrl: $publicUrl
    }
  }' > "${launch_temporary}"
chmod 600 "${launch_temporary}"
mv "${launch_temporary}" "${launch_path}"
extra_args=()
if [[ "${SMOKE_ONLY}" == "1" ]]; then
  extra_args+=(--smoke-only)
fi

container_id=$(docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart on-failure:3 \
  --gpus all \
  --network host \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:size=1g,mode=1777 \
  --entrypoint /app/.venv/bin/python \
  -e PYTHONPATH=/workspace/worker/ai/src \
  -e HOME=/tmp \
  -e TZ=UTC \
  -v "${PROJECT_ROOT}:/workspace:ro" \
  -v "${RUN_ROOT}:/runs" \
  -v "${CACHE_ROOT}:/cache" \
  -v "${SOURCE_DIR}:/source:ro" \
  -v "${FINCAST_TOKEN_FILE}:/tokens/fincast:ro" \
  -v "${CHRONOS2_TOKEN_FILE}:/tokens/chronos2:ro" \
  "${RUNNER_IMAGE}" \
  /workspace/scripts/cadence-context-3w.py \
  --run-dir "/runs/${RUN_ID}" \
  --run-id "${RUN_ID}" \
  --cache-dir /cache \
  --source-dir /source \
  --fincast-url "${FINCAST_URL}" \
  --chronos2-url "${CHRONOS2_URL}" \
  --fincast-token-file /tokens/fincast \
  --chronos2-token-file /tokens/chronos2 \
  --git-sha "${GIT_SHA}" \
  --working-tree-digest "${WORKTREE_DIGEST}" \
  "${extra_args[@]}")

printf '%s\n' "${CONTAINER_NAME}" > "${RUN_ROOT}/${RUN_ID}/CONTAINER"
printf '%s\n' "${container_id}" > "${RUN_ROOT}/${RUN_ID}/CONTAINER_ID"
printf '{"runId":"%s","updatedAt":"%s"}\n' \
  "${RUN_ID}" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "${RUN_ROOT}/latest.json"

if [[ "${START_UI}" == "1" ]]; then
  CADENCE_CONTEXT_RUN_ROOT="${RUN_ROOT}" \
  CADENCE_CONTEXT_UI_RUNTIME_DIR="${UI_RUNTIME_DIR}" \
  CADENCE_CONTEXT_UI_SESSION="${UI_SESSION}" \
  CADENCE_CONTEXT_API_PORT="${API_PORT}" \
  CADENCE_CONTEXT_WEB_PORT="${WEB_PORT}" \
  CADENCE_CONTEXT_PUBLIC_URL="${PUBLIC_URL}" \
    "${PROJECT_ROOT}/scripts/start-cadence-context-3w-ui.sh"
fi

printf 'run_id=%s\ncontainer=%s\nrun_dir=%s\n' \
  "${RUN_ID}" "${CONTAINER_NAME}" "${RUN_ROOT}/${RUN_ID}"
