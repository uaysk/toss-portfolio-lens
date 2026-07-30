#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_ROOT=${CADENCE_CONTEXT_RUN_ROOT:-"${PROJECT_ROOT}/data/ai-qualification/cadence-context-3w"}
RUN_ID=${1:-$(jq -r '.runId' "${RUN_ROOT}/latest.json")}
RUN_DIR="${RUN_ROOT}/${RUN_ID}"
container=$(cat "${RUN_DIR}/CONTAINER" 2>/dev/null || true)

if [[ -n "${container}" ]] && docker inspect "${container}" >/dev/null 2>&1; then
  exec docker logs --tail "${CADENCE_CONTEXT_LOG_LINES:-200}" -f "${container}"
fi
exec tail -n "${CADENCE_CONTEXT_LOG_LINES:-200}" -f "${RUN_DIR}/logs/pipeline.log"
