#!/usr/bin/env bash
set -uo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: run-fincast-tensorrt-int8-build.sh <absolute-run-root>" >&2
  exit 2
fi

RUN_ROOT=$1
TRT_ROOT="${RUN_ROOT}/tensorrt"
SDK_ROOT="${TRT_ROOT}/sdk/TensorRT-8.6.1.6"
VENV="${TRT_ROOT}/venv"
PLUGIN="${TRT_ROOT}/plugin-build/libfincast_trt_plugins.so"
ONNX="${TRT_ROOT}/onnx-c60-b48/fincast-c60-b48.onnx"
CONTEXTS="${RUN_ROOT}/inputs/60/contexts.f32"
OUTPUT="${TRT_ROOT}/engine-c60-b48"
ENGINE="${OUTPUT}/fincast-c60-b48-int8.plan"
CALIBRATION_CACHE="${OUTPUT}/calibration.cache"
TIMING_CACHE="${OUTPUT}/timing.cache"
INSPECTOR="${OUTPUT}/inspector.json"
RESULT="${OUTPUT}/build-result.json"
EVENT_LOG="${TRT_ROOT}/events.jsonl"
TELEMETRY="${OUTPUT}/build-gpu.csv"
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
STOPPED_PRODUCTION=0
STOPPED_GPU_PEER=0
SAMPLER_PID=""

if [[ "${RUN_ROOT}" != /* ]] \
  || [[ ! -x "${VENV}/bin/python" ]] \
  || [[ ! -f "${PLUGIN}" ]] \
  || [[ ! -f "${ONNX}" ]] \
  || [[ ! -f "${CONTEXTS}" ]] \
  || [[ ! -d "${SDK_ROOT}/lib" ]]; then
  echo "TensorRT INT8 build preflight failed" >&2
  exit 2
fi
if [[ -e "${ENGINE}" ]] || [[ -e "${RESULT}" ]] || [[ -e "${INSPECTOR}" ]] || [[ -L "${OUTPUT}" ]]; then
  echo "TensorRT INT8 final output already exists or is unsafe" >&2
  exit 2
fi
mkdir -p "${OUTPUT}"

event() {
  local kind=$1
  local detail=$2
  printf '{"at":"%s","kind":"%s","detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${kind}" "${detail}" >> "${EVENT_LOG}"
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
      health=$(docker inspect --format '{{.State.Health.Status}}' "${PRODUCTION_CONTAINER}" 2>/dev/null || true)
      if [[ "${health}" == "healthy" ]]; then
        break
      fi
      sleep 1
    done
    event "production_restore" "tensorrt_build_${health:-unavailable}"
    if [[ "${health}" != "healthy" ]]; then
      echo "production FinCast failed to return healthy" >&2
      exit 3
    fi
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 1 ]]; then
    if sudo -n systemctl start "${GPU_PEER_SERVICE}"; then
      event "gpu_peer_restore" "tensorrt_build_${GPU_PEER_SERVICE}_active"
    else
      event "gpu_peer_restore" "tensorrt_build_${GPU_PEER_SERVICE}_failed"
      exit 3
    fi
  fi
  exit "${exit_code}"
}
trap restore_production EXIT INT TERM HUP

POWER_LIMIT=$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits | tr -d ' ')
if [[ "$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "${PRODUCTION_CONTAINER}")" != "running healthy" ]] \
  || [[ "$(systemctl is-active "${GPU_PEER_SERVICE}")" != "active" ]] \
  || [[ "${POWER_LIMIT}" != "160.00" ]]; then
  echo "TensorRT build production/GPU preflight failed" >&2
  exit 2
fi

event "int8_build_preflight" "tensorrt_8_6_1_cuda_12_2_cudnn_8_9_7_sm61_160w_c60_b48"
docker stop --time 30 "${PRODUCTION_CONTAINER}" >/dev/null
STOPPED_PRODUCTION=1
sudo -n systemctl stop "${GPU_PEER_SERVICE}"
STOPPED_GPU_PEER=1
for _attempt in $(seq 1 120); do
  if [[ -z "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null)" ]]; then
    break
  fi
  sleep 1
done
if [[ -n "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null)" ]]; then
  event "int8_build_rejected" "gpu_exclusivity_failed"
  exit 4
fi

printf 'timestamp,utilization_gpu_pct,memory_used_mib,memory_free_mib,power_w,temperature_c\n' > "${TELEMETRY}"
(
  while true; do
    nvidia-smi \
      --query-gpu=timestamp,utilization.gpu,memory.used,memory.free,power.draw,temperature.gpu \
      --format=csv,noheader,nounits >> "${TELEMETRY}" 2>/dev/null || true
    sleep 1
  done
) &
SAMPLER_PID=$!

event "int8_build_start" "entropy_calibration_96_rows_two_batches"
CUDA_HOME=/usr/local/cuda \
TENSORRT_ROOT="${SDK_ROOT}" \
LD_LIBRARY_PATH="${SDK_ROOT}/lib:/usr/local/cuda/lib64" \
/usr/bin/time -v "${VENV}/bin/python" "${TRT_ROOT}/build_int8.py" \
  --onnx "${ONNX}" \
  --plugin "${PLUGIN}" \
  --contexts "${CONTEXTS}" \
  --engine "${ENGINE}" \
  --calibration-cache "${CALIBRATION_CACHE}" \
  --timing-cache "${TIMING_CACHE}" \
  --inspector "${INSPECTOR}" \
  --result "${RESULT}" \
  > "${OUTPUT}/build.log" 2> "${OUTPUT}/build-resource.log"
status=$?
event "int8_build_finish" "c60_b48_exit_${status}"
exit "${status}"
