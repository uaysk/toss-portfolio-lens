#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_DIR=${HIGH_VOL_STACK_RUN_DIR:-"${ROOT_DIR}/data/simulation-backtests/high-vol-stack-$(date -u +%Y%m%d-%H%M%S)"}
CHRONOS2_URL=${CHRONOS2_AI_WORKER_URL:-}
FINCAST_URL=${FINCAST_AI_WORKER_URL:-}
CHRONOS2_TOKEN=${CHRONOS2_AI_WORKER_TOKEN_FILE:-}
FINCAST_TOKEN=${FINCAST_AI_WORKER_TOKEN_FILE:-}
RUST_BINARY=${RUST_WORKER_BINARY:-"${ROOT_DIR}/worker/rust/target/release/portfolio-lens-worker"}
PYTHON_BINARY=${HIGH_VOL_STACK_PYTHON:-"${ROOT_DIR}/worker/ai/.venv/bin/python"}
TSX_BINARY=${HIGH_VOL_STACK_TSX:-"${ROOT_DIR}/node_modules/.bin/tsx"}
EVALUATION_START=${HIGH_VOL_STACK_FROM:-2026-07-20T00:00:00Z}
EVALUATION_END=${HIGH_VOL_STACK_TO:-2026-07-27T00:00:00Z}

if [[ -z "${CHRONOS2_URL}" || -z "${FINCAST_URL}" ]]; then
  echo "CHRONOS2_AI_WORKER_URL and FINCAST_AI_WORKER_URL are required." >&2
  exit 2
fi
if [[ -z "${CHRONOS2_TOKEN}" || -z "${FINCAST_TOKEN}" ]]; then
  echo "CHRONOS2_AI_WORKER_TOKEN_FILE and FINCAST_AI_WORKER_TOKEN_FILE are required." >&2
  exit 2
fi
if [[ ! -x "${PYTHON_BINARY}" ]]; then
  echo "HIGH_VOL_STACK_PYTHON is not executable: ${PYTHON_BINARY}" >&2
  exit 2
fi
if [[ ! -x "${TSX_BINARY}" ]]; then
  echo "HIGH_VOL_STACK_TSX is not executable: ${TSX_BINARY}" >&2
  exit 2
fi
if [[ ! -x "${RUST_BINARY}" ]]; then
  echo "RUST_WORKER_BINARY is not executable: ${RUST_BINARY}" >&2
  exit 2
fi

mkdir -p "${RUN_DIR}"
exec 9>"${RUN_DIR}/.pipeline.lock"
if ! flock -n 9; then
  echo "A high-volatility stack backtest already owns ${RUN_DIR}." >&2
  exit 3
fi
printf '%s\n' "$$" >"${RUN_DIR}/pipeline.pid"

"${PYTHON_BINARY}" \
  "${ROOT_DIR}/scripts/high-vol-stack-source.py" \
  --run-dir "${RUN_DIR}" \
  --from "${EVALUATION_START}" \
  --to "${EVALUATION_END}" \
  --chronos2-url "${CHRONOS2_URL}" \
  --chronos2-token-file "${CHRONOS2_TOKEN}" \
  --fincast-url "${FINCAST_URL}" \
  --fincast-token-file "${FINCAST_TOKEN}" \
  "$@"

"${TSX_BINARY}" \
  "${ROOT_DIR}/scripts/high-vol-stack-backtest.ts" \
  --run-dir "${RUN_DIR}" \
  --rust-binary "${RUST_BINARY}"

echo "${RUN_DIR}"
