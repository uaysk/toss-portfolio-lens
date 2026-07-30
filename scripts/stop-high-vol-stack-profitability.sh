#!/usr/bin/env bash
set -euo pipefail

RUN_DIR=${1:-${HIGH_VOL_STACK_RUN_DIR:-}}
if [[ -z "${RUN_DIR}" || ! -d "${RUN_DIR}" ]]; then
  echo "Usage: $0 <run-dir>" >&2
  exit 2
fi
unit=$(cat "${RUN_DIR}/pipeline.unit" 2>/dev/null || true)
if [[ -z "${unit}" ]]; then
  echo "No pipeline unit is recorded for ${RUN_DIR}." >&2
  exit 3
fi
printf '%s\n' "$(date -u +%FT%TZ)" >"${RUN_DIR}/STOP"
systemctl --user stop "${unit}"
echo "Stopped ${unit}; checkpoints remain in ${RUN_DIR}."

