#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: run-fincast-tensorrt-fp32-raw-integration.sh <absolute-run-root>" >&2
  exit 2
fi

RUN_ROOT=$1
TRT_ROOT="${RUN_ROOT}/tensorrt"
SOURCE_ROOT="${RUN_ROOT}/source"
RESULT_ROOT="${RUN_ROOT}/results"
POLICY_INPUT="${RUN_ROOT}/policy-input"
SMOKE_INPUT="${RUN_ROOT}/inputs/60"
ENGINE="${TRT_ROOT}/engine-c60-b48/fincast-c60-b48-fp32.plan"
PLUGIN="${TRT_ROOT}/plugin-build/libfincast_trt_plugins.so"
TRT_PYTHON="${TRT_ROOT}/python/cpython-3.11.15-linux-x86_64-gnu/bin/python3.11"
TRT_SITE_PACKAGES="${TRT_ROOT}/venv/lib/python3.11/site-packages"
SDK_LIBRARY="${TRT_ROOT}/sdk/TensorRT-8.6.1.6/lib"
CUDA_ROOT=/usr/local/cuda-12.2
ENGINE_SHA256=e3afdda18254a9893ded00576e8cd38b45d947e33ba6a26aa5db06f68f2afbb6
PLUGIN_SHA256=68b756332e41faa8c7cec35870ddf655cf3ce496b3ba6549ea934a8713819dfd
IMAGE=toss-portfolio-lens-fincast-worker:fincast-p40-opt-20260727-190032
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
EVENT_LOG="${RUN_ROOT}/stage-events.jsonl"
LOG="${RUN_ROOT}/tensorrt-fp32-raw-integration.log"
TELEMETRY="${RUN_ROOT}/tensorrt-fp32-raw-integration-gpu.csv"
POLICY_OUTPUT="${RESULT_ROOT}/policy-48h-tensorrt_fp32-integrated-v3"
SMOKE_OUTPUT="${RESULT_ROOT}/raw-smoke-c60-tensorrt_fp32-integrated-v3"
FALLBACK_OUTPUT="${RESULT_ROOT}/raw-fallback-c60-cuda_graph-integrated-v3"
MODEL_CACHE=""
STOPPED_PRODUCTION=0
STOPPED_GPU_PEER=0
SAMPLER_PID=""

if [[ "${RUN_ROOT}" != /* ]] \
  || [[ ! -d "${SOURCE_ROOT}/portfolio_ai_worker" ]] \
  || [[ ! -f "${POLICY_INPUT}/manifest.json" ]] \
  || [[ ! -f "${SMOKE_INPUT}/manifest.json" ]] \
  || [[ ! -x "${TRT_PYTHON}" ]] \
  || [[ ! -d "${TRT_SITE_PACKAGES}" ]] \
  || [[ ! -f "${CUDA_ROOT}/targets/x86_64-linux/lib/libcublas.so.12" ]] \
  || [[ ! -f "${CUDA_ROOT}/targets/x86_64-linux/lib/libcudnn.so.8" ]] \
  || [[ ! -f "${ENGINE}" ]] \
  || [[ ! -f "${PLUGIN}" ]]; then
  echo "TensorRT FP32 raw integration preflight failed" >&2
  exit 2
fi
for output in "${POLICY_OUTPUT}" "${SMOKE_OUTPUT}" "${FALLBACK_OUTPUT}"; do
  if [[ -e "${output}" ]] || [[ -L "${output}" ]]; then
    echo "TensorRT FP32 raw integration output already exists: ${output}" >&2
    exit 2
  fi
  mkdir -p "${output}"
done

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
  event "gpu_exclusivity_failed" "tensorrt_fp32_raw_integration_compute_process_remained"
  printf '%s\n' "${processes}" >&2
  return 1
}

restore_production() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  if [[ -n "${SAMPLER_PID}" ]]; then
    kill "${SAMPLER_PID}" >/dev/null 2>&1 || true
    wait "${SAMPLER_PID}" >/dev/null 2>&1 || true
  fi
  if [[ ${STOPPED_PRODUCTION} -eq 1 ]]; then
    docker start "${PRODUCTION_CONTAINER}" >/dev/null 2>&1 || true
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
    event "production_restore" "tensorrt_fp32_raw_integration_${health:-unavailable}"
    if [[ "${health}" != "healthy" ]]; then
      echo "production FinCast failed to return healthy" >&2
      exit 3
    fi
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 1 ]]; then
    if sudo -n systemctl start "${GPU_PEER_SERVICE}"; then
      event \
        "gpu_peer_restore" \
        "tensorrt_fp32_raw_integration_${GPU_PEER_SERVICE}_active"
    else
      event \
        "gpu_peer_restore" \
        "tensorrt_fp32_raw_integration_${GPU_PEER_SERVICE}_failed"
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
  local expected_engine_sha=$4
  shift 4
  docker run --rm \
    --name "${name}" \
    --user 1000:1000 \
    --gpus all \
    --network none \
    --read-only \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,size=512m \
    -e AI_MODEL_LANE=fincast \
    -e AI_MODEL_CACHE_DIR=/models \
    -e AI_MODEL_MANIFEST=/app/model-manifest.json \
    -e AI_DEVICE=cuda \
    -e AI_ALLOW_CPU_FALLBACK=false \
    -e AI_EXPECTED_CUDA_CAPABILITY=6.1 \
    -e "AI_EXPECTED_CUDA_DEVICE_NAME=Tesla P40" \
    -e AI_FINCAST_MIN_VRAM_HEADROOM_MIB=2048 \
    -e "AI_FINCAST_TENSORRT_PYTHON=${TRT_PYTHON}" \
    -e "AI_FINCAST_TENSORRT_SITE_PACKAGES=${TRT_SITE_PACKAGES}" \
    -e "AI_FINCAST_TENSORRT_FP32_ENGINE=${ENGINE}" \
    -e "AI_FINCAST_TENSORRT_PLUGIN=${PLUGIN}" \
    -e "AI_FINCAST_TENSORRT_FP32_ENGINE_SHA256=${expected_engine_sha}" \
    -e "AI_FINCAST_TENSORRT_PLUGIN_SHA256=${PLUGIN_SHA256}" \
    -e "AI_FINCAST_TENSORRT_LOAD_FALLBACK=${AI_FINCAST_TENSORRT_LOAD_FALLBACK:-}" \
    -e "CUDA_HOME=${CUDA_ROOT}" \
    -e "LD_LIBRARY_PATH=${SDK_LIBRARY}:${CUDA_ROOT}/targets/x86_64-linux/lib" \
    -v "${SOURCE_ROOT}:/app/src:ro" \
    -v "${MODEL_CACHE}:/models:ro" \
    -v "${TRT_ROOT}:${TRT_ROOT}:ro" \
    -v "${CUDA_ROOT}:${CUDA_ROOT}:ro" \
    -v "${input}:/work/input:ro" \
    -v "${output}:/work/output:rw" \
    --entrypoint /app/.venv/bin/python \
    "${IMAGE}" \
    -m portfolio_ai_worker raw-generate \
    --job /work/input/manifest.json \
    --output /work/output \
    "$@"
}

run_checked() {
  local event_name=$1
  shift
  event "candidate_start" "${event_name}"
  if "$@" >> "${LOG}" 2>&1; then
    event "candidate_finish" "${event_name}_exit_0"
  else
    local status=$?
    event "candidate_finish" "${event_name}_exit_${status}"
    return "${status}"
  fi
}

MODEL_CACHE=$(docker inspect \
  --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Source}}{{end}}{{end}}' \
  "${PRODUCTION_CONTAINER}")
POWER_LIMIT=$(nvidia-smi \
  --query-gpu=power.limit \
  --format=csv,noheader,nounits | tr -d ' ')
if [[ "$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "${PRODUCTION_CONTAINER}")" != "running healthy" ]] \
  || [[ "$(systemctl is-active "${GPU_PEER_SERVICE}")" != "active" ]] \
  || [[ "${POWER_LIMIT}" != "160.00" ]] \
  || [[ ! -d "${MODEL_CACHE}/fincast" ]] \
  || [[ "$(sha256sum "${ENGINE}" | cut -d ' ' -f 1)" != "${ENGINE_SHA256}" ]] \
  || [[ "$(sha256sum "${PLUGIN}" | cut -d ' ' -f 1)" != "${PLUGIN_SHA256}" ]]; then
  echo "TensorRT FP32 raw integration production/GPU/artifact preflight failed" >&2
  exit 2
fi

event "stage_preflight" "tensorrt_fp32_raw_integration_c60_b48_160w"
docker stop --time 30 "${PRODUCTION_CONTAINER}" >/dev/null
STOPPED_PRODUCTION=1
if ! sudo -n systemctl stop "${GPU_PEER_SERVICE}"; then
  event "gpu_peer_stop_failed" "tensorrt_fp32_raw_integration"
  exit 4
fi
STOPPED_GPU_PEER=1
if ! wait_for_gpu_idle; then
  exit 4
fi
event "gpu_exclusive" "tensorrt_fp32_raw_integration_no_other_compute_process"

printf 'timestamp,utilization_gpu_pct,memory_used_mib,memory_free_mib,power_w,temperature_c\n' \
  > "${TELEMETRY}"
(
  while true; do
    nvidia-smi \
      --query-gpu=timestamp,utilization.gpu,memory.used,memory.free,power.draw,temperature.gpu \
      --format=csv,noheader,nounits >> "${TELEMETRY}" 2>/dev/null || true
    sleep 1
  done
) &
SAMPLER_PID=$!

run_checked \
  "policy_48h_tensorrt_fp32_b48" \
  run_generator \
  "fincast-policy-trt-fp32-$(basename "${RUN_ROOT}")" \
  "${POLICY_INPUT}" \
  "${POLICY_OUTPUT}" \
  "${ENGINE_SHA256}" \
  --backend tensorrt_fp32 \
  --batch-size 48
run_checked \
  "policy_48h_tensorrt_fp32_resume" \
  run_generator \
  "fincast-policy-trt-fp32-resume-$(basename "${RUN_ROOT}")" \
  "${POLICY_INPUT}" \
  "${POLICY_OUTPUT}" \
  "${ENGINE_SHA256}" \
  --backend tensorrt_fp32 \
  --batch-size 48 \
  --resume
run_checked \
  "smoke_tensorrt_fp32_full_and_tail" \
  run_generator \
  "fincast-smoke-trt-fp32-$(basename "${RUN_ROOT}")" \
  "${SMOKE_INPUT}" \
  "${SMOKE_OUTPUT}" \
  "${ENGINE_SHA256}" \
  --backend tensorrt_fp32 \
  --batch-size 48
run_checked \
  "smoke_tensorrt_fp32_resume" \
  run_generator \
  "fincast-smoke-trt-fp32-resume-$(basename "${RUN_ROOT}")" \
  "${SMOKE_INPUT}" \
  "${SMOKE_OUTPUT}" \
  "${ENGINE_SHA256}" \
  --backend tensorrt_fp32 \
  --batch-size 48 \
  --resume
AI_FINCAST_TENSORRT_LOAD_FALLBACK=cuda_graph \
  run_checked \
  "smoke_tensorrt_fp32_explicit_load_fallback" \
  run_generator \
  "fincast-smoke-trt-fallback-$(basename "${RUN_ROOT}")" \
  "${SMOKE_INPUT}" \
  "${FALLBACK_OUTPUT}" \
  ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --backend tensorrt_fp32 \
  --batch-size 48

if [[ "$(jq -r '.backend' "${POLICY_OUTPUT}/manifest.json")" != "tensorrt_fp32" ]] \
  || [[ "$(jq -r '.batch_size' "${POLICY_OUTPUT}/manifest.json")" != "48" ]] \
  || [[ "$(jq -r '.completed_rows' "${POLICY_OUTPUT}/manifest.json")" != "384" ]] \
  || [[ "$(jq -r '.complete' "${POLICY_OUTPUT}/manifest.json")" != "true" ]] \
  || [[ "$(jq -r '.chunks | length' "${POLICY_OUTPUT}/manifest.json")" != "8" ]] \
  || [[ "$(jq -r '.backend' "${SMOKE_OUTPUT}/manifest.json")" != "tensorrt_fp32" ]] \
  || [[ "$(jq -r '.completed_rows' "${SMOKE_OUTPUT}/manifest.json")" != "128" ]] \
  || [[ "$(jq -r '.chunks | length' "${SMOKE_OUTPUT}/manifest.json")" != "3" ]] \
  || [[ "$(jq -r '.latency.execution_backend' "${SMOKE_OUTPUT}/chunks/chunk-0000000000-0000000048.json")" != "tensorrt_fp32" ]] \
  || [[ "$(jq -r '.latency.execution_backend' "${SMOKE_OUTPUT}/chunks/chunk-0000000096-0000000128.json")" != "batched_experts" ]] \
  || [[ "$(jq -r '.latency.tail_eager' "${SMOKE_OUTPUT}/chunks/chunk-0000000096-0000000128.json")" != "true" ]] \
  || [[ "$(jq -r '.backend' "${FALLBACK_OUTPUT}/manifest.json")" != "cuda_graph" ]] \
  || [[ "$(jq -r '.complete' "${FALLBACK_OUTPUT}/manifest.json")" != "true" ]]; then
  event "stage_finish" "tensorrt_fp32_raw_integration_validation_failed"
  exit 4
fi

event "stage_finish" "tensorrt_fp32_raw_integration_policy_tail_resume_fallback_passed"
