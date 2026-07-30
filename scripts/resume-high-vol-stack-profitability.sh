#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_DIR=${1:-${HIGH_VOL_STACK_RUN_DIR:-}}
if [[ -z "${RUN_DIR}" || ! -d "${RUN_DIR}" ]]; then
  echo "Usage: $0 <run-dir>" >&2
  exit 2
fi
if [[ -f "${RUN_DIR}/COMPLETE" ]]; then
  echo "Run is already complete: ${RUN_DIR}"
  exit 0
fi
launch_environment="${RUN_DIR}/pipeline-launch.env"
if [[ -f "${launch_environment}" ]]; then
  # The file contains only non-secret launch settings and credential file paths.
  # shellcheck disable=SC1090
  source "${launch_environment}"
fi
if [[ -f "${RUN_DIR}/STOP" ]]; then
  mkdir -p "${RUN_DIR}/failures"
  mv "${RUN_DIR}/STOP" "${RUN_DIR}/failures/STOP-$(date -u +%Y%m%dT%H%M%SZ)"
fi
export HIGH_VOL_STACK_RUN_DIR="${RUN_DIR}"
"${ROOT_DIR}/scripts/start-high-vol-stack-profitability.sh"
