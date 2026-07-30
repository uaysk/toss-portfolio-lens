#!/usr/bin/env bash
set -uo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: run-fincast-p40-raw-compatibility.sh <absolute-run-root>" >&2
  exit 2
fi

RUN_ROOT=$1
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
SOURCE_ROOT="${RUN_ROOT}/source"
INPUT_ROOT="${RUN_ROOT}/inputs"
RESULT_ROOT="${RUN_ROOT}/results"
EVENT_LOG="${RUN_ROOT}/compatibility-events.jsonl"
STOPPED_PRODUCTION=0
STOPPED_GPU_PEER=0

if [[ "${RUN_ROOT}" != /* ]] || [[ ! -d "${SOURCE_ROOT}/portfolio_ai_worker" ]]; then
  echo "run root is not an absolute prepared FinCast optimization directory" >&2
  exit 2
fi

IMAGE=$(docker inspect --format '{{.Config.Image}}' "${PRODUCTION_CONTAINER}")
MODEL_CACHE=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Source}}{{end}}{{end}}' "${PRODUCTION_CONTAINER}")
INITIAL_STATUS=$(docker inspect --format '{{.State.Status}}' "${PRODUCTION_CONTAINER}")
INITIAL_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' "${PRODUCTION_CONTAINER}")
INITIAL_GPU_PEER_STATUS=$(systemctl is-active "${GPU_PEER_SERVICE}")
POWER_LIMIT=$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits | tr -d ' ')

if [[ "${INITIAL_STATUS}" != "running" ]] || [[ "${INITIAL_HEALTH}" != "healthy" ]]; then
  echo "production FinCast must be running and healthy before compatibility validation" >&2
  exit 2
fi
if [[ "${INITIAL_GPU_PEER_STATUS}" != "active" ]]; then
  echo "${GPU_PEER_SERVICE} must be active so its original state can be restored" >&2
  exit 2
fi
if [[ "${POWER_LIMIT}" != "160.00" ]] || [[ ! -d "${MODEL_CACHE}/fincast" ]]; then
  echo "P40 power cap or production model cache preflight failed" >&2
  exit 2
fi

event() {
  local kind=$1
  local detail=$2
  printf '{"at":"%s","kind":"%s","detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${kind}" "${detail}" >> "${EVENT_LOG}"
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
  event "gpu_exclusivity_failed" "compatibility_non_fincast_compute_process_remained"
  printf '%s\n' "${processes}" >&2
  return 1
}

restore_services() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  if [[ ${STOPPED_PRODUCTION} -eq 1 ]]; then
    docker start "${PRODUCTION_CONTAINER}" >/dev/null 2>&1 || true
    local health=""
    for _attempt in $(seq 1 60); do
      health=$(docker inspect --format '{{.State.Health.Status}}' "${PRODUCTION_CONTAINER}" 2>/dev/null || true)
      if [[ "${health}" == "healthy" ]]; then
        break
      fi
      sleep 1
    done
    event "production_restore" "${health:-unavailable}"
    if [[ "${health}" != "healthy" ]]; then
      echo "production FinCast failed to return healthy" >&2
      exit 3
    fi
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 1 ]]; then
    if sudo -n systemctl start "${GPU_PEER_SERVICE}"; then
      event "gpu_peer_restore" "${GPU_PEER_SERVICE}_active"
    else
      event "gpu_peer_restore" "${GPU_PEER_SERVICE}_failed"
      echo "${GPU_PEER_SERVICE} failed to return active" >&2
      exit 3
    fi
  fi
  exit "${exit_code}"
}
trap restore_services EXIT INT TERM HUP

mkdir -p "${RESULT_ROOT}"
event "preflight" "compatibility_power_limit_160w_image_and_cache_verified"
docker stop --time 30 "${PRODUCTION_CONTAINER}" >/dev/null
STOPPED_PRODUCTION=1
event "production_stop" "compatibility_exclusive_measurement"
if ! sudo -n systemctl stop "${GPU_PEER_SERVICE}"; then
  event "gpu_peer_stop_failed" "${GPU_PEER_SERVICE}"
  exit 4
fi
STOPPED_GPU_PEER=1
event "gpu_peer_stop" "${GPU_PEER_SERVICE}_stopped_for_compatibility"
if ! wait_for_gpu_idle; then
  exit 4
fi
event "gpu_exclusive" "compatibility_no_other_compute_process"

for cadence in 15 30 60; do
  output="${RESULT_ROOT}/compatibility-c${cadence}-b16.json"
  name="fincast-raw-compatibility-c${cadence}-$(basename "${RUN_ROOT}")"
  if [[ -e "${output}" ]]; then
    event "candidate_skip" "compatibility_c${cadence}_output_exists"
    continue
  fi
  event "candidate_start" "compatibility_c${cadence}_b16"
  docker run --rm \
    --name "${name}" \
    --user 1000:1000 \
    --gpus all \
    --network none \
    --read-only \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    -e AI_MODEL_LANE=fincast \
    -e AI_MODEL_CACHE_DIR=/models \
    -e AI_MODEL_MANIFEST=/app/model-manifest.json \
    -e AI_DEVICE=cuda \
    -e AI_ALLOW_CPU_FALLBACK=false \
    -e AI_EXPECTED_CUDA_CAPABILITY=6.1 \
    -e "AI_EXPECTED_CUDA_DEVICE_NAME=Tesla P40" \
    -e AI_FINCAST_MIN_VRAM_HEADROOM_MIB=2048 \
    -v "${SOURCE_ROOT}:/app/src:ro" \
    -v "${MODEL_CACHE}:/models:ro" \
    -v "${INPUT_ROOT}/${cadence}:/work/input:ro" \
    -v "${RESULT_ROOT}:/work/results:rw" \
    --entrypoint /app/.venv/bin/python \
    "${IMAGE}" \
    -m portfolio_ai_worker raw-compatibility \
    --job /work/input/manifest.json \
    --output "/work/results/$(basename "${output}")" \
    >> "${RUN_ROOT}/compatibility.log" 2>&1
  candidate_status=$?
  event "candidate_finish" "compatibility_c${cadence}_b16_exit_${candidate_status}"
done

event "finish" "all_compatibility_candidates_attempted"
