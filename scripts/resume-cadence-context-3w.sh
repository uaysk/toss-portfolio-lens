#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_ROOT=${CADENCE_CONTEXT_RUN_ROOT:-"${PROJECT_ROOT}/data/ai-qualification/cadence-context-3w"}
RUN_ID=${1:-$(jq -r '.runId' "${RUN_ROOT}/latest.json")}
RUN_DIR="${RUN_ROOT}/${RUN_ID}"
container=$(cat "${RUN_DIR}/CONTAINER" 2>/dev/null || true)
launch="${RUN_DIR}/launch.json"

if [[ -n "${container}" ]] && docker inspect "${container}" >/dev/null 2>&1; then
  running=$(docker inspect -f '{{.State.Running}}' "${container}")
  if [[ "${running}" == "true" ]]; then
    echo "pipeline is already running: ${container}" >&2
    exit 3
  fi
fi
if [[ ! -f "${launch}" ]]; then
  echo "launch metadata not found: ${launch}" >&2
  exit 2
fi
rm -f "${RUN_DIR}/STOP"
env \
  CADENCE_CONTEXT_RUN_ROOT="$(jq -er '.runRoot' "${launch}")" \
  CADENCE_CONTEXT_CACHE_ROOT="$(jq -er '.cacheRoot' "${launch}")" \
  CADENCE_CONTEXT_SOURCE_DIR="$(jq -er '.sourceDir' "${launch}")" \
  FINCAST_AI_AUTH_TOKEN_FILE="$(jq -er '.tokenFiles.fincast' "${launch}")" \
  CHRONOS2_AI_AUTH_TOKEN_FILE="$(jq -er '.tokenFiles.chronos2' "${launch}")" \
  FINCAST_AI_WORKER_URL="$(jq -er '.workerUrls.fincast' "${launch}")" \
  CHRONOS2_AI_WORKER_URL="$(jq -er '.workerUrls.chronos2' "${launch}")" \
  CADENCE_CONTEXT_RUNNER_IMAGE="$(jq -er '.runnerImage' "${launch}")" \
  CADENCE_CONTEXT_RUN_ID="${RUN_ID}" \
  CADENCE_CONTEXT_SMOKE_ONLY="$(
    jq -er 'if .smokeOnly then "1" else "0" end' "${launch}"
  )" \
  CADENCE_CONTEXT_START_UI="$(
    jq -er 'if .dashboard.enabled then "1" else "0" end' "${launch}"
  )" \
  CADENCE_CONTEXT_UI_RUNTIME_DIR="$(jq -er '.dashboard.runtimeDir' "${launch}")" \
  CADENCE_CONTEXT_UI_SESSION="$(jq -er '.dashboard.session' "${launch}")" \
  CADENCE_CONTEXT_API_PORT="$(jq -er '.dashboard.apiPort' "${launch}")" \
  CADENCE_CONTEXT_WEB_PORT="$(jq -er '.dashboard.webPort' "${launch}")" \
  CADENCE_CONTEXT_PUBLIC_URL="$(jq -er '.dashboard.publicUrl' "${launch}")" \
  BENCHMARK_GIT_SHA="$(jq -er '.gitSha' "${launch}")" \
  BENCHMARK_WORKTREE_DIGEST="$(jq -er '.workingTreeDigest' "${launch}")" \
  "${PROJECT_ROOT}/scripts/start-cadence-context-3w.sh"
