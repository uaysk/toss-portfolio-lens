#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 7 ]]; then
  echo "usage: run-chronos2-context-qualification-tmux.sh <source-root> <run-root> <run-id> <baseline-run> <model-cache> <env-file> <public-url>" >&2
  exit 2
fi

SOURCE_ROOT=$1
RUN_ROOT=$2
RUN_ID=$3
BASELINE_RUN=$4
MODEL_CACHE=$5
ENV_FILE=$6
PUBLIC_URL=$7
SESSION="tpl-chronos2-context-${RUN_ID}"
RUNTIME_DIR="${RUN_ROOT}/.dashboard-runtime"

if [[ "${SOURCE_ROOT}" != /* ]] \
  || [[ "${RUN_ROOT}" != /* ]] \
  || [[ "${BASELINE_RUN}" != /* ]] \
  || [[ "${MODEL_CACHE}" != /* ]] \
  || [[ "${ENV_FILE}" != /* ]] \
  || [[ ! -d "${SOURCE_ROOT}" ]] \
  || [[ ! -f "${ENV_FILE}" ]] \
  || [[ ! -x "${SOURCE_ROOT}/scripts/run-chronos2-context-qualification-worker.sh" ]] \
  || [[ ! -x "${SOURCE_ROOT}/scripts/run-fincast-p40-qualification-dashboard.sh" ]] \
  || [[ ! "${PUBLIC_URL}" =~ ^http://[A-Za-z0-9.:-]+$ ]] \
  || tmux has-session -t "${SESSION}" 2>/dev/null; then
  echo "tmux context qualification arguments or session are invalid" >&2
  exit 2
fi

mkdir -p "${RUN_ROOT}" "${RUNTIME_DIR}"
chmod 700 "${RUN_ROOT}" "${RUNTIME_DIR}"
if [[ ! -e "${SOURCE_ROOT}/.env" ]]; then
  ln -s "${ENV_FILE}" "${SOURCE_ROOT}/.env"
fi

dashboard_command=$(printf '%q ' \
  env \
  DASHBOARD_API_PORT=3201 \
  DASHBOARD_VITE_PORT=5174 \
  "${SOURCE_ROOT}/scripts/run-fincast-p40-qualification-dashboard.sh" \
  "${RUN_ROOT}" \
  "${RUNTIME_DIR}" \
  "${PUBLIC_URL}")
qualification_command=$(printf '%q ' \
  "${SOURCE_ROOT}/scripts/run-chronos2-context-qualification-worker.sh" \
  "${SOURCE_ROOT}" \
  "${RUN_ROOT}" \
  "${RUN_ID}" \
  "${BASELINE_RUN}" \
  "${MODEL_CACHE}" \
  "2026-07-27T00:00:00Z")

tmux new-session -d -s "${SESSION}" -n dashboard "${dashboard_command}"
tmux set-option -t "${SESSION}" remain-on-exit on
tmux new-window -t "${SESSION}" -n qualification "${qualification_command}"
tmux select-window -t "${SESSION}:qualification"

printf 'session=%s\nrun_id=%s\ndashboard=%s\nrun_dir=%s\n' \
  "${SESSION}" "${RUN_ID}" "${PUBLIC_URL}" "${RUN_ROOT}/${RUN_ID}"
