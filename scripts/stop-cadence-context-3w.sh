#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_ROOT=${CADENCE_CONTEXT_RUN_ROOT:-"${PROJECT_ROOT}/data/ai-qualification/cadence-context-3w"}
RUN_ID=${1:-$(jq -r '.runId' "${RUN_ROOT}/latest.json")}
RUN_DIR="${RUN_ROOT}/${RUN_ID}"

if [[ ! -d "${RUN_DIR}" ]]; then
  echo "run directory not found: ${RUN_DIR}" >&2
  exit 2
fi
touch "${RUN_DIR}/STOP"
echo "graceful stop requested: ${RUN_ID}"
echo "the runner will checkpoint and exit at the next safe boundary"
