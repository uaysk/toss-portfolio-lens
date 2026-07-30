#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "usage: run-fincast-p40-fp32-3week-worker.sh <absolute-run-root> <run-id> <absolute-optimization-root> <end-exclusive> [duration-weeks]" >&2
  exit 2
fi

RUN_ROOT=$1
RUN_ID=$2
OPTIMIZATION_ROOT=$3
END_EXCLUSIVE=$4
DURATION_WEEKS=${5:-3}
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUNTIME_DIRECTORY="${RUN_ROOT}/${RUN_ID}"
WRAPPER_LOG="${RUNTIME_DIRECTORY}/worker-wrapper.log"
RUNNER_PID=""
STOPPED_PRODUCTION=0
STOPPED_GPU_PEER=0

if [[ "${RUN_ROOT}" != /* ]] \
  || [[ "${OPTIMIZATION_ROOT}" != /* ]] \
  || [[ ! "${RUN_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || [[ ! "${DURATION_WEEKS}" =~ ^[1-5]$ ]] \
  || [[ ! -d "${OPTIMIZATION_ROOT}" ]]; then
  echo "worker qualification paths or run ID are invalid" >&2
  exit 2
fi

mkdir -p "${RUNTIME_DIRECTORY}"
chmod 700 "${RUNTIME_DIRECTORY}"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${WRAPPER_LOG}"
}

wait_for_gpu_idle() {
  local processes=""
  for _attempt in $(seq 1 120); do
    processes=$(nvidia-smi \
      --query-compute-apps=pid,process_name \
      --format=csv,noheader,nounits 2>/dev/null)
    if [[ -z "${processes}" ]]; then
      return 0
    fi
    sleep 1
  done
  event "gpu_exclusivity_failed ${processes}"
  return 1
}

restore_worker() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  if [[ -n "${RUNNER_PID}" ]] && kill -0 "${RUNNER_PID}" 2>/dev/null; then
    kill -TERM -- "-${RUNNER_PID}" 2>/dev/null || true
    wait "${RUNNER_PID}" 2>/dev/null || true
  fi
  if [[ ${STOPPED_PRODUCTION} -eq 1 ]]; then
    docker start "${PRODUCTION_CONTAINER}" >> "${WRAPPER_LOG}" 2>&1 || true
    local health=""
    for _attempt in $(seq 1 90); do
      health=$(docker inspect \
        --format '{{.State.Health.Status}}' \
        "${PRODUCTION_CONTAINER}" 2>/dev/null || true)
      if [[ "${health}" == "healthy" ]]; then
        break
      fi
      sleep 1
    done
    event "production_restore ${health:-unavailable}"
    if [[ "${health}" != "healthy" ]]; then
      exit_code=3
    fi
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 1 ]]; then
    if sudo -n systemctl start "${GPU_PEER_SERVICE}"; then
      event "gpu_peer_restore active"
    else
      event "gpu_peer_restore failed"
      exit_code=3
    fi
  fi
  exit "${exit_code}"
}

stop_worker() {
  local signal=$1
  event "wrapper_signal ${signal}"
  if [[ -n "${RUNNER_PID}" ]] && kill -0 "${RUNNER_PID}" 2>/dev/null; then
    kill -TERM -- "-${RUNNER_PID}" 2>/dev/null || true
    wait "${RUNNER_PID}" 2>/dev/null || true
    RUNNER_PID=""
  fi
  exit 143
}

trap restore_worker EXIT
trap 'stop_worker INT' INT
trap 'stop_worker TERM' TERM
trap 'stop_worker HUP' HUP

INITIAL_PRODUCTION=$(docker inspect \
  --format '{{.State.Status}} {{.State.Health.Status}}' \
  "${PRODUCTION_CONTAINER}")
INITIAL_GPU_PEER=$(systemctl is-active "${GPU_PEER_SERVICE}")
POWER_LIMIT=$(nvidia-smi \
  --query-gpu=power.limit \
  --format=csv,noheader,nounits | tr -d ' ')
MODEL_CACHE=$(docker inspect \
  --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Source}}{{end}}{{end}}' \
  "${PRODUCTION_CONTAINER}")

if [[ "${INITIAL_PRODUCTION}" != "running healthy" ]] \
  || [[ "${INITIAL_GPU_PEER}" != "active" ]] \
  || [[ "${POWER_LIMIT}" != "160.00" ]] \
  || [[ ! -d "${MODEL_CACHE}/fincast" ]]; then
  event "wrapper_preflight_failed production=${INITIAL_PRODUCTION} peer=${INITIAL_GPU_PEER} power=${POWER_LIMIT}"
  exit 2
fi

event "production_stop begin"
docker stop --time 30 "${PRODUCTION_CONTAINER}" >> "${WRAPPER_LOG}" 2>&1
STOPPED_PRODUCTION=1
event "production_stop complete"

sudo -n systemctl stop "${GPU_PEER_SERVICE}"
STOPPED_GPU_PEER=1
event "gpu_peer_stop complete"

wait_for_gpu_idle
event "gpu_exclusive confirmed power_cap_w=160"

cd "${REPO_ROOT}"
RUN_MODE=(--run-id "${RUN_ID}")
if [[ -f "${RUN_ROOT}/${RUN_ID}/state.json" ]]; then
  RUN_MODE=(--resume "${RUN_ID}")
  event "runner_resume existing_state"
fi
setsid env \
  FINCAST_GPU_EXCLUSIVE=1 \
  FINCAST_MODEL_CACHE="${MODEL_CACHE}" \
  npm run qualification:fincast:p40:fp32:3week -- \
    "${RUN_MODE[@]}" \
    --run-root "${RUN_ROOT}" \
    --optimization-root "${OPTIMIZATION_ROOT}" \
    --end-exclusive "${END_EXCLUSIVE}" \
    --duration-weeks "${DURATION_WEEKS}" \
    --budget-hours 2 \
    >> "${WRAPPER_LOG}" 2>&1 &
RUNNER_PID=$!
event "runner_started pid=${RUNNER_PID}"

set +e
wait "${RUNNER_PID}"
RUNNER_STATUS=$?
set -e
RUNNER_PID=""
event "runner_finished status=${RUNNER_STATUS}"
exit "${RUNNER_STATUS}"
