#!/usr/bin/env bash
set -uo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: run-fincast-p40-raw-stage.sh <absolute-run-root> <backend> <batch-15> <batch-30> <batch-60>" >&2
  exit 2
fi

RUN_ROOT=$1
BACKEND=$2
BATCH_15=$3
BATCH_30=$4
BATCH_60=$5
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
SOURCE_ROOT="${RUN_ROOT}/source"
INPUT_ROOT="${RUN_ROOT}/inputs"
RESULT_ROOT="${RUN_ROOT}/results"
EVENT_LOG="${RUN_ROOT}/stage-events.jsonl"
STOPPED_PRODUCTION=0
STOPPED_GPU_PEER=0

if [[ "${RUN_ROOT}" != /* ]] || [[ ! -d "${SOURCE_ROOT}/portfolio_ai_worker" ]]; then
  echo "run root is not an absolute prepared FinCast optimization directory" >&2
  exit 2
fi
if [[ ! "${BACKEND}" =~ ^(no_padding|batched_experts|cuda_graph)$ ]]; then
  echo "backend must be no_padding, batched_experts, or cuda_graph" >&2
  exit 2
fi
for batch in "${BATCH_15}" "${BATCH_30}" "${BATCH_60}"; do
  if [[ ! "${batch}" =~ ^(16|24|32|48|50)$ ]]; then
    echo "selected batches must be one of 16, 24, 32, 48, or 50" >&2
    exit 2
  fi
done

IMAGE=$(docker inspect --format '{{.Config.Image}}' "${PRODUCTION_CONTAINER}")
MODEL_CACHE=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Source}}{{end}}{{end}}' "${PRODUCTION_CONTAINER}")
INITIAL_STATUS=$(docker inspect --format '{{.State.Status}}' "${PRODUCTION_CONTAINER}")
INITIAL_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' "${PRODUCTION_CONTAINER}")
INITIAL_GPU_PEER_STATUS=$(systemctl is-active "${GPU_PEER_SERVICE}")
POWER_LIMIT=$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits | tr -d ' ')

if [[ "${INITIAL_STATUS}" != "running" ]] || [[ "${INITIAL_HEALTH}" != "healthy" ]]; then
  echo "production FinCast must be running and healthy before the stage" >&2
  exit 2
fi
if [[ "${INITIAL_GPU_PEER_STATUS}" != "active" ]]; then
  echo "${GPU_PEER_SERVICE} must be active before the stage so its state can be restored" >&2
  exit 2
fi
if [[ "${POWER_LIMIT}" != "160.00" ]]; then
  echo "Tesla P40 power limit must remain exactly 160.00 W" >&2
  exit 2
fi
if [[ ! -d "${MODEL_CACHE}/fincast" ]]; then
  echo "production FinCast model cache mount is unavailable" >&2
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
  event "gpu_exclusivity_failed" "${BACKEND}_non_fincast_compute_process_remained_after_120s"
  printf '%s\n' "${processes}" >&2
  return 1
}

restore_production() {
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
    event "production_restore" "${BACKEND}_${health:-unavailable}"
    if [[ "${health}" != "healthy" ]]; then
      echo "production FinCast failed to return healthy" >&2
      exit 3
    fi
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 1 ]]; then
    if sudo -n systemctl start "${GPU_PEER_SERVICE}"; then
      event "gpu_peer_restore" "${BACKEND}_${GPU_PEER_SERVICE}_active"
    else
      event "gpu_peer_restore" "${BACKEND}_${GPU_PEER_SERVICE}_failed"
      echo "${GPU_PEER_SERVICE} failed to return active" >&2
      exit 3
    fi
  fi
  exit "${exit_code}"
}
trap restore_production EXIT INT TERM HUP

mkdir -p "${RESULT_ROOT}"
event "stage_preflight" "${BACKEND}_power_limit_160w_image_and_cache_verified"
docker stop --time 30 "${PRODUCTION_CONTAINER}" >/dev/null
STOPPED_PRODUCTION=1
event "production_stop" "${BACKEND}_stopped_for_exclusive_fincast_measurement"
if ! sudo -n systemctl stop "${GPU_PEER_SERVICE}"; then
  event "gpu_peer_stop_failed" "${BACKEND}_${GPU_PEER_SERVICE}"
  exit 4
fi
STOPPED_GPU_PEER=1
event "gpu_peer_stop" "${BACKEND}_${GPU_PEER_SERVICE}_stopped_for_exclusive_measurement"
if ! wait_for_gpu_idle; then
  exit 4
fi
event "gpu_exclusive" "${BACKEND}_no_other_compute_process_before_stage"

for cadence in 15 30 60; do
  batch_var="BATCH_${cadence}"
  batch=${!batch_var}
  output="${RESULT_ROOT}/${BACKEND}-c${cadence}-b${batch}.json"
  name="fincast-raw-${BACKEND}-c${cadence}-b${batch}-$(basename "${RUN_ROOT}")"
  if [[ -e "${output}" ]]; then
    event "candidate_skip" "${BACKEND}_c${cadence}_b${batch}_output_exists"
    continue
  fi
  if ! wait_for_gpu_idle; then
    event "candidate_unavailable" "${BACKEND}_c${cadence}_b${batch}_gpu_not_exclusive"
    continue
  fi
  event "candidate_start" "${BACKEND}_c${cadence}_b${batch}"
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
    -m portfolio_ai_worker raw-benchmark \
    --job /work/input/manifest.json \
    --output "/work/results/$(basename "${output}")" \
    --backend "${BACKEND}" \
    --batch-size "${batch}" \
    --rounds 3 \
    --warmups 10 \
    --iterations 30 \
    >> "${RUN_ROOT}/stage-${BACKEND}.log" 2>&1
  candidate_status=$?
  event "candidate_finish" "${BACKEND}_c${cadence}_b${batch}_exit_${candidate_status}"
done

event "stage_finish" "all_${BACKEND}_candidates_attempted"
