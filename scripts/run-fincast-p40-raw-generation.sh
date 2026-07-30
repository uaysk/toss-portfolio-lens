#!/usr/bin/env bash
set -uo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: run-fincast-p40-raw-generation.sh <absolute-run-root> <expected-backend> <expected-batch>" >&2
  exit 2
fi

RUN_ROOT=$1
EXPECTED_BACKEND=$2
EXPECTED_BATCH=$3
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
SOURCE_ROOT="${RUN_ROOT}/source"
INPUT_ROOT="${RUN_ROOT}/inputs"
POLICY_INPUT="${RUN_ROOT}/policy-input"
RESULT_ROOT="${RUN_ROOT}/results"
EVENT_LOG="${RUN_ROOT}/stage-events.jsonl"
MODEL_CACHE=""
IMAGE=""
STOPPED_PRODUCTION=0
STOPPED_GPU_PEER=0

if [[ "${RUN_ROOT}" != /* ]] || [[ ! -d "${SOURCE_ROOT}/portfolio_ai_worker" ]]; then
  echo "run root is not an absolute prepared FinCast optimization directory" >&2
  exit 2
fi
if [[ "${EXPECTED_BACKEND}" != "cuda_graph" ]] || [[ "${EXPECTED_BATCH}" != "48" ]]; then
  echo "the qualified offline default must be cuda_graph batch 48" >&2
  exit 2
fi
if [[ ! -f "${POLICY_INPUT}/manifest.json" ]] || [[ ! -f "${INPUT_ROOT}/60/manifest.json" ]]; then
  echo "policy and frozen 60-second inputs must exist" >&2
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
  event "gpu_exclusivity_failed" "raw_generation_non_fincast_compute_process_remained"
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
    event "production_restore" "raw_generation_${health:-unavailable}"
    if [[ "${health}" != "healthy" ]]; then
      echo "production FinCast failed to return healthy" >&2
      exit 3
    fi
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 1 ]]; then
    if sudo -n systemctl start "${GPU_PEER_SERVICE}"; then
      event "gpu_peer_restore" "raw_generation_${GPU_PEER_SERVICE}_active"
    else
      event "gpu_peer_restore" "raw_generation_${GPU_PEER_SERVICE}_failed"
      exit 3
    fi
  fi
  exit "${exit_code}"
}
trap restore_production EXIT INT TERM HUP

run_generator() {
  local name=$1
  local input=$2
  local output=$3
  shift 3
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
    -v "${input}:/work/input:ro" \
    -v "${output}:/work/output:rw" \
    --entrypoint /app/.venv/bin/python \
    "${IMAGE}" \
    -m portfolio_ai_worker raw-generate \
    --job /work/input/manifest.json \
    --output /work/output \
    "$@"
}

IMAGE=$(docker inspect --format '{{.Config.Image}}' "${PRODUCTION_CONTAINER}")
MODEL_CACHE=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Source}}{{end}}{{end}}' "${PRODUCTION_CONTAINER}")
POWER_LIMIT=$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits | tr -d ' ')
if [[ "$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "${PRODUCTION_CONTAINER}")" != "running healthy" ]] \
  || [[ "$(systemctl is-active "${GPU_PEER_SERVICE}")" != "active" ]] \
  || [[ "${POWER_LIMIT}" != "160.00" ]] \
  || [[ ! -d "${MODEL_CACHE}/fincast" ]]; then
  echo "raw generation preflight failed" >&2
  exit 2
fi

POLICY_EAGER="${RESULT_ROOT}/policy-48h-eager"
POLICY_CANDIDATE="${RESULT_ROOT}/policy-48h-${EXPECTED_BACKEND}"
SMOKE_CANDIDATE="${RESULT_ROOT}/raw-smoke-c60-${EXPECTED_BACKEND}"
for output in "${POLICY_EAGER}" "${POLICY_CANDIDATE}" "${SMOKE_CANDIDATE}"; do
  if [[ -e "${output}" ]]; then
    echo "raw generation output already exists: ${output}" >&2
    exit 2
  fi
  mkdir -p "${output}"
done

event "stage_preflight" "raw_generation_power_limit_160w_image_cache_and_defaults_verified"
docker stop --time 30 "${PRODUCTION_CONTAINER}" >/dev/null
STOPPED_PRODUCTION=1
event "production_stop" "raw_generation_stopped_for_exclusive_fincast_measurement"
if ! sudo -n systemctl stop "${GPU_PEER_SERVICE}"; then
  event "gpu_peer_stop_failed" "raw_generation_${GPU_PEER_SERVICE}"
  exit 4
fi
STOPPED_GPU_PEER=1
event "gpu_peer_stop" "raw_generation_${GPU_PEER_SERVICE}_stopped"
if ! wait_for_gpu_idle; then
  exit 4
fi
event "gpu_exclusive" "raw_generation_no_other_compute_process"

event "candidate_start" "policy_48h_eager_b48"
if run_generator \
  "fincast-policy-eager-$(basename "${RUN_ROOT}")" \
  "${POLICY_INPUT}" \
  "${POLICY_EAGER}" \
  --backend eager \
  --batch-size 48 \
  >> "${RUN_ROOT}/raw-generation.log" 2>&1; then
  event "candidate_finish" "policy_48h_eager_b48_exit_0"
else
  status=$?
  event "candidate_finish" "policy_48h_eager_b48_exit_${status}"
  exit "${status}"
fi

event "candidate_start" "policy_48h_default_${EXPECTED_BACKEND}_b${EXPECTED_BATCH}"
if run_generator \
  "fincast-policy-default-$(basename "${RUN_ROOT}")" \
  "${POLICY_INPUT}" \
  "${POLICY_CANDIDATE}" \
  >> "${RUN_ROOT}/raw-generation.log" 2>&1; then
  event "candidate_finish" "policy_48h_default_exit_0"
else
  status=$?
  event "candidate_finish" "policy_48h_default_exit_${status}"
  exit "${status}"
fi

event "candidate_start" "policy_48h_default_resume"
if run_generator \
  "fincast-policy-resume-$(basename "${RUN_ROOT}")" \
  "${POLICY_INPUT}" \
  "${POLICY_CANDIDATE}" \
  --resume \
  >> "${RUN_ROOT}/raw-generation.log" 2>&1; then
  event "candidate_finish" "policy_48h_default_resume_exit_0"
else
  status=$?
  event "candidate_finish" "policy_48h_default_resume_exit_${status}"
  exit "${status}"
fi

event "candidate_start" "raw_smoke_c60_default_tail"
if run_generator \
  "fincast-raw-smoke-$(basename "${RUN_ROOT}")" \
  "${INPUT_ROOT}/60" \
  "${SMOKE_CANDIDATE}" \
  >> "${RUN_ROOT}/raw-generation.log" 2>&1; then
  event "candidate_finish" "raw_smoke_c60_default_tail_exit_0"
else
  status=$?
  event "candidate_finish" "raw_smoke_c60_default_tail_exit_${status}"
  exit "${status}"
fi

event "candidate_start" "raw_smoke_c60_default_resume"
if run_generator \
  "fincast-raw-smoke-resume-$(basename "${RUN_ROOT}")" \
  "${INPUT_ROOT}/60" \
  "${SMOKE_CANDIDATE}" \
  --resume \
  >> "${RUN_ROOT}/raw-generation.log" 2>&1; then
  event "candidate_finish" "raw_smoke_c60_default_resume_exit_0"
else
  status=$?
  event "candidate_finish" "raw_smoke_c60_default_resume_exit_${status}"
  exit "${status}"
fi

if [[ "$(jq -r '.backend' "${POLICY_CANDIDATE}/manifest.json")" != "${EXPECTED_BACKEND}" ]] \
  || [[ "$(jq -r '.batch_size' "${POLICY_CANDIDATE}/manifest.json")" != "${EXPECTED_BATCH}" ]] \
  || [[ "$(jq -r '.complete' "${POLICY_CANDIDATE}/manifest.json")" != "true" ]] \
  || [[ "$(jq -r '.latency.tail_eager' "${SMOKE_CANDIDATE}/chunks/chunk-0000000096-0000000128.json")" != "true" ]]; then
  event "stage_finish" "raw_generation_validation_failed"
  exit 4
fi
event "stage_finish" "raw_generation_policy_resume_and_tail_passed"
