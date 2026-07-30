#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE_DIR=${HIGH_VOL_STACK_SOURCE_DIR:-"${ROOT_DIR}"}
RUN_DIR=${HIGH_VOL_STACK_RUN_DIR:?HIGH_VOL_STACK_RUN_DIR is required}
PYTHON_IMAGE=${HIGH_VOL_STACK_PYTHON_IMAGE:-toss-portfolio-lens-chronos2-worker:cuda-graph-v4}
NODE_IMAGE=${HIGH_VOL_STACK_NODE_IMAGE:-node:22.17.0-bookworm-slim}
CHRONOS2_URL=${CHRONOS2_AI_WORKER_URL:?CHRONOS2_AI_WORKER_URL is required}
FINCAST_URL=${FINCAST_AI_WORKER_URL:?FINCAST_AI_WORKER_URL is required}
CHRONOS2_TOKEN=${CHRONOS2_AI_WORKER_TOKEN_FILE:?CHRONOS2_AI_WORKER_TOKEN_FILE is required}
FINCAST_TOKEN=${FINCAST_AI_WORKER_TOKEN_FILE:?FINCAST_AI_WORKER_TOKEN_FILE is required}
RUST_BINARY=${RUST_WORKER_BINARY:-"${SOURCE_DIR}/worker/rust/target/release/portfolio-lens-worker"}
DASHBOARD_ROOT=${HIGH_VOL_STACK_DASHBOARD_RUN_ROOT:-}
DASHBOARD_RUN_ID=${HIGH_VOL_STACK_DASHBOARD_RUN_ID:-monitor-$(basename "${RUN_DIR}")}
DASHBOARD_PYTHON=${HIGH_VOL_STACK_DASHBOARD_PYTHON:-$(command -v python3 2>/dev/null || true)}
EVALUATION_START=${HIGH_VOL_STACK_FROM:-2026-06-15T00:00:00Z}
EVALUATION_END=${HIGH_VOL_STACK_TO:-2026-07-29T00:00:00Z}
CALIBRATION_DAYS=${HIGH_VOL_STACK_CALIBRATION_DAYS:-14}
DIAGNOSTIC_FROM=${HIGH_VOL_STACK_DIAGNOSTIC_FROM-2026-07-20T00:00:00Z}
HOLDOUT_FROM=${HIGH_VOL_STACK_HOLDOUT_FROM-2026-07-27T00:00:00Z}
SMOKE=${HIGH_VOL_STACK_SMOKE:-false}
RUST_CONCURRENCY=${HIGH_VOL_STACK_RUST_CONCURRENCY:-1}

if [[ ! "${RUST_CONCURRENCY}" =~ ^[1-9][0-9]*$ ]] \
  || ((RUST_CONCURRENCY > 32)); then
  echo "HIGH_VOL_STACK_RUST_CONCURRENCY must be an integer in [1, 32]." >&2
  exit 2
fi

for path in \
  "${SOURCE_DIR}/scripts/high-vol-stack-source.py" \
  "${SOURCE_DIR}/scripts/high-vol-stack-backtest.ts" \
  "${SOURCE_DIR}/scripts/high-vol-stack-dashboard-sync.py" \
  "${RUST_BINARY}" \
  "${CHRONOS2_TOKEN}" \
  "${FINCAST_TOKEN}"; do
  if [[ ! -e "${path}" ]]; then
    echo "Required path is missing: ${path}" >&2
    exit 2
  fi
done
if [[ -n "${DASHBOARD_ROOT}" && ! -x "${DASHBOARD_PYTHON}" ]]; then
  echo "Dashboard sync requires an executable Python 3 interpreter." >&2
  exit 2
fi
if [[ ! -x "${RUST_BINARY}" ]]; then
  echo "Rust worker is not executable: ${RUST_BINARY}" >&2
  exit 2
fi

mkdir -p "${RUN_DIR}" "${RUN_DIR}/failures"
exec 9>"${RUN_DIR}/.pipeline.lock"
if ! flock -n 9; then
  echo "A profitability pipeline already owns ${RUN_DIR}." >&2
  exit 3
fi
printf '%s\n' "$$" >"${RUN_DIR}/pipeline.pid"
if [[ -f "${RUN_DIR}/FAILED" ]]; then
  failed_stamp=$(date -u +%Y%m%dT%H%M%SZ)
  mv "${RUN_DIR}/FAILED" "${RUN_DIR}/failures/FAILED-${failed_stamp}"
fi

LOG_PATH="${RUN_DIR}/pipeline.log"
exec >>"${LOG_PATH}" 2>&1
echo "[$(date -u +%FT%TZ)] high-volatility profitability pipeline started"

run_digest=$(printf '%s' "${RUN_DIR}" | sha256sum | cut -c1-16)
RUST_RUNTIME_DIR="/tmp/tpl-hv-${UID}-${run_digest}"
RUST_SOCKET="${RUST_RUNTIME_DIR}/compute.sock"
RUST_LOG="${RUN_DIR}/rust-worker.log"
RUST_PID=""
DASHBOARD_PID=""
DASHBOARD_LOG="${RUN_DIR}/dashboard-sync.log"
sync_dashboard_once() {
  if [[ -z "${DASHBOARD_ROOT}" ]]; then
    return
  fi
  "${DASHBOARD_PYTHON}" \
    "${SOURCE_DIR}/scripts/high-vol-stack-dashboard-sync.py" \
    --run-dir "${RUN_DIR}" \
    --dashboard-root "${DASHBOARD_ROOT}" \
    --run-id "${DASHBOARD_RUN_ID}" \
    --once >>"${DASHBOARD_LOG}" 2>&1 || true
}
cleanup() {
  if [[ -n "${RUST_PID}" ]]; then
    kill "${RUST_PID}" 2>/dev/null || true
    wait "${RUST_PID}" 2>/dev/null || true
    RUST_PID=""
  fi
  if [[ -n "${DASHBOARD_PID}" ]]; then
    kill "${DASHBOARD_PID}" 2>/dev/null || true
    wait "${DASHBOARD_PID}" 2>/dev/null || true
    DASHBOARD_PID=""
  fi
  rm -f "${RUST_SOCKET}"
  rmdir "${RUST_RUNTIME_DIR}" 2>/dev/null || true
}
failed() {
  code=$?
  if [[ $# -gt 0 ]]; then
    code=$1
  fi
  printf '%s exit=%s\n' "$(date -u +%FT%TZ)" "${code}" >"${RUN_DIR}/FAILED"
  cleanup
  sync_dashboard_once
  exit "${code}"
}
cancelled() {
  cleanup
  sync_dashboard_once
  exit 130
}
trap failed ERR
trap cleanup EXIT
trap cancelled INT TERM

if [[ -n "${DASHBOARD_ROOT}" ]]; then
  mkdir -p "${DASHBOARD_ROOT}"
  "${DASHBOARD_PYTHON}" \
    "${SOURCE_DIR}/scripts/high-vol-stack-dashboard-sync.py" \
    --run-dir "${RUN_DIR}" \
    --dashboard-root "${DASHBOARD_ROOT}" \
    --run-id "${DASHBOARD_RUN_ID}" \
    --poll-seconds 1 >>"${DASHBOARD_LOG}" 2>&1 &
  DASHBOARD_PID=$!
fi

source_arguments=(
  "${SOURCE_DIR}/scripts/high-vol-stack-source.py"
  --run-dir "${RUN_DIR}"
  --from "${EVALUATION_START}"
  --to "${EVALUATION_END}"
  --calibration-days "${CALIBRATION_DAYS}"
  --chronos2-url "${CHRONOS2_URL}"
  --chronos2-token-file "${CHRONOS2_TOKEN}"
  --fincast-url "${FINCAST_URL}"
  --fincast-token-file "${FINCAST_TOKEN}"
  --resume
)
if [[ "${SMOKE}" == "true" ]]; then
  source_arguments+=(--smoke)
fi

docker run --rm --init --network host \
  --user "$(id -u):$(id -g)" \
  -v "${SOURCE_DIR}:${SOURCE_DIR}:ro" \
  -v "${RUN_DIR}:${RUN_DIR}" \
  -v "${CHRONOS2_TOKEN}:${CHRONOS2_TOKEN}:ro" \
  -v "${FINCAST_TOKEN}:${FINCAST_TOKEN}:ro" \
  --entrypoint /app/.venv/bin/python \
  "${PYTHON_IMAGE}" \
  "${source_arguments[@]}"

if [[ -L "${RUST_RUNTIME_DIR}" || (-e "${RUST_RUNTIME_DIR}" && ! -d "${RUST_RUNTIME_DIR}") ]]; then
  echo "Rust runtime path must be a real directory: ${RUST_RUNTIME_DIR}" >&2
  failed 4
fi
mkdir -p "${RUST_RUNTIME_DIR}"
chmod 700 "${RUST_RUNTIME_DIR}"
rm -f "${RUST_SOCKET}"
"${RUST_BINARY}" serve --socket "${RUST_SOCKET}" >"${RUST_LOG}" 2>&1 &
RUST_PID=$!
for _attempt in $(seq 1 200); do
  [[ -S "${RUST_SOCKET}" ]] && break
  if ! kill -0 "${RUST_PID}" 2>/dev/null; then
    echo "Rust worker exited before socket readiness." >&2
    failed 4
  fi
  sleep 0.05
done
if [[ ! -S "${RUST_SOCKET}" ]]; then
  echo "Rust worker socket did not become ready." >&2
  failed 4
fi

DEPENDENCIES=$(readlink -f "${SOURCE_DIR}/node_modules")
backtest_arguments=(
  "${SOURCE_DIR}/scripts/high-vol-stack-backtest.ts"
  --run-dir "${RUN_DIR}"
  --rust-binary "${RUST_BINARY}"
  --rust-socket "${RUST_SOCKET}"
  --rust-concurrency "${RUST_CONCURRENCY}"
)
if [[ -n "${DIAGNOSTIC_FROM}" ]]; then
  backtest_arguments+=(--diagnostic-from "${DIAGNOSTIC_FROM}")
fi
if [[ -n "${HOLDOUT_FROM}" ]]; then
  backtest_arguments+=(--holdout-from "${HOLDOUT_FROM}")
fi

docker run --rm --init --network none \
  --user "$(id -u):$(id -g)" \
  -v "${SOURCE_DIR}:${SOURCE_DIR}:ro" \
  -v "${DEPENDENCIES}:${DEPENDENCIES}:ro" \
  -v "${RUN_DIR}:${RUN_DIR}" \
  -v "${RUST_RUNTIME_DIR}:${RUST_RUNTIME_DIR}" \
  --entrypoint node \
  "${NODE_IMAGE}" \
  "${SOURCE_DIR}/node_modules/tsx/dist/cli.mjs" \
  "${backtest_arguments[@]}"

sync_dashboard_once
echo "[$(date -u +%FT%TZ)] high-volatility profitability pipeline complete"
