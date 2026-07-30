#!/usr/bin/env bash
set -uo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: run-fincast-tensorrt-export.sh <absolute-run-root> <cadence-seconds> <batch-size>" >&2
  exit 2
fi

RUN_ROOT=$1
CADENCE_SECONDS=$2
BATCH_SIZE=$3
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
SOURCE_ROOT="${RUN_ROOT}/source"
INPUT_ROOT="${RUN_ROOT}/inputs/${CADENCE_SECONDS}"
ONNX_SITE="${RUN_ROOT}/tensorrt/onnx-py312-nodeps"
OUTPUT_ROOT="${RUN_ROOT}/tensorrt/onnx-c${CADENCE_SECONDS}-b${BATCH_SIZE}"
OUTPUT_ONNX="${OUTPUT_ROOT}/fincast-c${CADENCE_SECONDS}-b${BATCH_SIZE}.onnx"
EVENT_LOG="${RUN_ROOT}/tensorrt/events.jsonl"
STOPPED_PRODUCTION=0
STOPPED_GPU_PEER=0

if [[ "${RUN_ROOT}" != /* ]] \
  || [[ ! -f "${INPUT_ROOT}/manifest.json" ]] \
  || [[ ! -d "${SOURCE_ROOT}/portfolio_ai_worker" ]] \
  || [[ ! -d "${ONNX_SITE}/onnx" ]] \
  || [[ ! "${CADENCE_SECONDS}" =~ ^(15|30|60)$ ]] \
  || [[ ! "${BATCH_SIZE}" =~ ^(16|24|32|48|50)$ ]]; then
  echo "TensorRT export preflight rejected an invalid path, cadence, or batch" >&2
  exit 2
fi
if [[ -e "${OUTPUT_ONNX}" ]] || [[ -L "${OUTPUT_ROOT}" ]]; then
  echo "TensorRT ONNX output already exists or is unsafe" >&2
  exit 2
fi
mkdir -p "${OUTPUT_ROOT}"

event() {
  local kind=$1
  local detail=$2
  printf '{"at":"%s","kind":"%s","detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${kind}" "${detail}" >> "${EVENT_LOG}"
}

restore_production() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
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
    event "production_restore" "tensorrt_export_${health:-unavailable}"
    if [[ "${health}" != "healthy" ]]; then
      echo "production FinCast failed to return healthy" >&2
      exit 3
    fi
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 1 ]]; then
    if sudo -n systemctl start "${GPU_PEER_SERVICE}"; then
      event "gpu_peer_restore" "tensorrt_export_${GPU_PEER_SERVICE}_active"
    else
      event "gpu_peer_restore" "tensorrt_export_${GPU_PEER_SERVICE}_failed"
      exit 3
    fi
  fi
  exit "${exit_code}"
}
trap restore_production EXIT INT TERM HUP

IMAGE=$(docker inspect --format '{{.Config.Image}}' "${PRODUCTION_CONTAINER}")
MODEL_CACHE=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Source}}{{end}}{{end}}' "${PRODUCTION_CONTAINER}")
POWER_LIMIT=$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits | tr -d ' ')
if [[ "$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "${PRODUCTION_CONTAINER}")" != "running healthy" ]] \
  || [[ "$(systemctl is-active "${GPU_PEER_SERVICE}")" != "active" ]] \
  || [[ "${POWER_LIMIT}" != "160.00" ]] \
  || [[ ! -d "${MODEL_CACHE}/fincast" ]]; then
  echo "TensorRT export production/GPU preflight failed" >&2
  exit 2
fi

event "export_preflight" "cuda_12_2_cudnn_8_9_7_sm61_160w_c${CADENCE_SECONDS}_b${BATCH_SIZE}"
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
  event "export_rejected" "gpu_exclusivity_failed"
  exit 4
fi

event "export_start" "static_onnx_c${CADENCE_SECONDS}_b${BATCH_SIZE}"
docker run --rm \
  --name "fincast-trt-export-c${CADENCE_SECONDS}-b${BATCH_SIZE}" \
  --user 1000:1000 \
  --gpus all \
  --network none \
  --read-only \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,size=2g \
  -e PYTHONPATH=/app/src:/work/onnx-site \
  -e AI_MODEL_LANE=fincast \
  -e AI_MODEL_CACHE_DIR=/models \
  -e AI_MODEL_MANIFEST=/app/model-manifest.json \
  -e AI_DEVICE=cuda \
  -e AI_ALLOW_CPU_FALLBACK=false \
  -e AI_EXPECTED_CUDA_CAPABILITY=6.1 \
  -e "AI_EXPECTED_CUDA_DEVICE_NAME=Tesla P40" \
  -v "${SOURCE_ROOT}:/app/src:ro" \
  -v "${MODEL_CACHE}:/models:ro" \
  -v "${INPUT_ROOT}:/work/input:ro" \
  -v "${ONNX_SITE}:/work/onnx-site:ro" \
  -v "${OUTPUT_ROOT}:/work/output:rw" \
  --entrypoint /app/.venv/bin/python \
  "${IMAGE}" \
  -m portfolio_ai_worker raw-tensorrt-export \
  --job /work/input/manifest.json \
  --output "/work/output/$(basename "${OUTPUT_ONNX}")" \
  --batch-size "${BATCH_SIZE}" \
  > "${OUTPUT_ROOT}/export.log" 2>&1
status=$?
event "export_finish" "static_onnx_c${CADENCE_SECONDS}_b${BATCH_SIZE}_exit_${status}"
exit "${status}"
