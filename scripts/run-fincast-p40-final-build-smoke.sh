#!/usr/bin/env bash
set -uo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: run-fincast-p40-final-build-smoke.sh <absolute-run-root> <absolute-build-context> <source-revision>" >&2
  exit 2
fi

RUN_ROOT=$1
BUILD_CONTEXT=$2
SOURCE_REVISION=$3
RUN_ID=$(basename "${RUN_ROOT}")
IMAGE_TAG="toss-portfolio-lens-fincast-worker:fincast-p40-opt-${RUN_ID#fincast-p40-opt-}"
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
INPUT_ROOT="${RUN_ROOT}/inputs/60"
SMOKE_OUTPUT="${RUN_ROOT}/results/final-image-smoke-c60"
RESULT_FILE="${RUN_ROOT}/results/docker-build-smoke.json"
BUILD_LOG="${RUN_ROOT}/docker-build.log"
EVENT_LOG="${RUN_ROOT}/stage-events.jsonl"
STOPPED_PRODUCTION=0
STOPPED_GPU_PEER=0
BUILD_STATUS=not_started
SMOKE_STATUS=not_started
RESTORE_STATUS=not_needed
FAILURE_REASON=""
BUILD_STARTED_AT=""
BUILD_FINISHED_AT=""
SMOKE_STARTED_AT=""
SMOKE_FINISHED_AT=""
IMAGE_ID=""
PRODUCTION_IMAGE_ID_BEFORE=""
MODEL_CACHE=""

if [[ "${RUN_ROOT}" != /* ]] || [[ "${BUILD_CONTEXT}" != /* ]]; then
  echo "run root and build context must be absolute paths" >&2
  exit 2
fi
if [[ ! "${SOURCE_REVISION}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "source revision must be a full Git SHA" >&2
  exit 2
fi
if [[ ! -f "${BUILD_CONTEXT}/Dockerfile.worker.fincast" ]] \
  || [[ ! -f "${BUILD_CONTEXT}/worker/ai/uv.lock" ]] \
  || [[ ! -d "${BUILD_CONTEXT}/worker/ai/src/portfolio_ai_worker" ]] \
  || [[ ! -f "${INPUT_ROOT}/manifest.json" ]]; then
  echo "build context or smoke input is incomplete" >&2
  exit 2
fi
if [[ -e "${RESULT_FILE}" ]] || [[ -e "${SMOKE_OUTPUT}" ]]; then
  echo "final image smoke result already exists" >&2
  exit 2
fi
if docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  echo "target image already exists; refusing a second build" >&2
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
  FAILURE_REASON=gpu_not_exclusive_after_120_seconds
  printf '%s\n' "${processes}" >&2
  return 1
}

write_result() {
  local exit_code=$1
  local manifest_sha=""
  local weights_sha=""
  local backend=""
  local batch_size=""
  local complete=false
  local tail_eager=false
  if [[ -f "${SMOKE_OUTPUT}/manifest.json" ]]; then
    manifest_sha=$(sha256sum "${SMOKE_OUTPUT}/manifest.json" | cut -d' ' -f1)
    weights_sha=$(jq -r '.provenance.weights_sha256 // ""' "${SMOKE_OUTPUT}/manifest.json")
    backend=$(jq -r '.backend // ""' "${SMOKE_OUTPUT}/manifest.json")
    batch_size=$(jq -r '.batch_size // ""' "${SMOKE_OUTPUT}/manifest.json")
    complete=$(jq -r '.complete // false' "${SMOKE_OUTPUT}/manifest.json")
  fi
  if [[ -f "${SMOKE_OUTPUT}/chunks/chunk-0000000096-0000000128.json" ]]; then
    tail_eager=$(jq -r '.latency.tail_eager // false' \
      "${SMOKE_OUTPUT}/chunks/chunk-0000000096-0000000128.json")
  fi
  local final_status=failed
  if [[ ${exit_code} -eq 0 ]] \
    && [[ "${BUILD_STATUS}" == "passed" ]] \
    && [[ "${SMOKE_STATUS}" == "passed" ]] \
    && [[ "${RESTORE_STATUS}" == "passed" ]]; then
    final_status=passed
  fi
  jq -n \
    --arg schema_version "fincast-p40-docker-build-smoke/v1" \
    --arg status "${final_status}" \
    --arg image_tag "${IMAGE_TAG}" \
    --arg image_id "${IMAGE_ID}" \
    --arg source_revision "${SOURCE_REVISION}" \
    --arg build_status "${BUILD_STATUS}" \
    --arg build_started_at "${BUILD_STARTED_AT}" \
    --arg build_finished_at "${BUILD_FINISHED_AT}" \
    --arg smoke_status "${SMOKE_STATUS}" \
    --arg smoke_started_at "${SMOKE_STARTED_AT}" \
    --arg smoke_finished_at "${SMOKE_FINISHED_AT}" \
    --arg restore_status "${RESTORE_STATUS}" \
    --arg production_image_id_before "${PRODUCTION_IMAGE_ID_BEFORE}" \
    --arg production_image_id_after "$(docker inspect --format '{{.Image}}' "${PRODUCTION_CONTAINER}" 2>/dev/null || true)" \
    --arg backend "${backend}" \
    --argjson batch_size "${batch_size:-0}" \
    --argjson complete "${complete}" \
    --argjson tail_eager "${tail_eager}" \
    --arg manifest_sha256 "${manifest_sha}" \
    --arg weights_sha256 "${weights_sha}" \
    --arg failure_reason "${FAILURE_REASON}" \
    '{
      schema_version: $schema_version,
      status: $status,
      docker_build_count: 1,
      image: {
        tag: $image_tag,
        id: $image_id,
        source_revision: $source_revision
      },
      build: {
        status: $build_status,
        started_at: $build_started_at,
        finished_at: $build_finished_at
      },
      smoke: {
        status: $smoke_status,
        started_at: $smoke_started_at,
        finished_at: $smoke_finished_at,
        backend: $backend,
        batch_size: $batch_size,
        complete: $complete,
        tail_eager: $tail_eager,
        manifest_sha256: $manifest_sha256,
        weights_sha256: $weights_sha256
      },
      restoration: {
        status: $restore_status,
        production_image_id_before: $production_image_id_before,
        production_image_id_after: $production_image_id_after
      },
      failure_reason: (if $failure_reason == "" then null else $failure_reason end)
    }' > "${RESULT_FILE}.tmp"
  mv "${RESULT_FILE}.tmp" "${RESULT_FILE}"
}

restore_services() {
  local exit_code=$?
  local restore_failed=0
  trap - EXIT INT TERM HUP
  if [[ ${STOPPED_PRODUCTION} -eq 1 ]]; then
    docker start "${PRODUCTION_CONTAINER}" >/dev/null 2>&1 || restore_failed=1
    local health=""
    for _attempt in $(seq 1 60); do
      health=$(docker inspect --format '{{.State.Health.Status}}' "${PRODUCTION_CONTAINER}" 2>/dev/null || true)
      if [[ "${health}" == "healthy" ]]; then
        break
      fi
      sleep 1
    done
    if [[ "${health}" != "healthy" ]]; then
      restore_failed=1
      FAILURE_REASON="${FAILURE_REASON:+${FAILURE_REASON},}production_restore_failed"
    fi
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 1 ]]; then
    if ! sudo -n systemctl start "${GPU_PEER_SERVICE}"; then
      restore_failed=1
      FAILURE_REASON="${FAILURE_REASON:+${FAILURE_REASON},}gpu_peer_restore_failed"
    fi
  fi
  if [[ ${restore_failed} -eq 0 ]] \
    && [[ "$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "${PRODUCTION_CONTAINER}" 2>/dev/null)" == "running healthy" ]] \
    && [[ "$(systemctl is-active "${GPU_PEER_SERVICE}" 2>/dev/null)" == "active" ]]; then
    RESTORE_STATUS=passed
    event "final_image_restore" "production_and_gpu_peer_restored"
  else
    RESTORE_STATUS=failed
    exit_code=3
    event "final_image_restore" "restoration_failed"
  fi
  write_result "${exit_code}"
  exit "${exit_code}"
}
trap restore_services EXIT INT TERM HUP

PRODUCTION_IMAGE_ID_BEFORE=$(docker inspect --format '{{.Image}}' "${PRODUCTION_CONTAINER}")
MODEL_CACHE=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Source}}{{end}}{{end}}' \
  "${PRODUCTION_CONTAINER}")
if [[ "$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "${PRODUCTION_CONTAINER}")" != "running healthy" ]] \
  || [[ "$(systemctl is-active "${GPU_PEER_SERVICE}")" != "active" ]] \
  || [[ "$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits | tr -d ' ')" != "160.00" ]] \
  || [[ ! -d "${MODEL_CACHE}/fincast" ]]; then
  FAILURE_REASON=preflight_failed
  exit 2
fi

event "final_image_build_start" "${IMAGE_TAG}"
BUILD_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if DOCKER_BUILDKIT=1 docker build \
  --pull=false \
  --tag "${IMAGE_TAG}" \
  --build-arg "APP_GIT_SHA=${SOURCE_REVISION}" \
  --file "${BUILD_CONTEXT}/Dockerfile.worker.fincast" \
  "${BUILD_CONTEXT}" > "${BUILD_LOG}" 2>&1; then
  BUILD_STATUS=passed
  BUILD_FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  IMAGE_ID=$(docker image inspect --format '{{.Id}}' "${IMAGE_TAG}")
  event "final_image_build_finish" "passed_${IMAGE_ID}"
else
  BUILD_STATUS=failed
  BUILD_FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  FAILURE_REASON=docker_build_failed
  event "final_image_build_finish" "failed"
  exit 4
fi

mkdir -p "${SMOKE_OUTPUT}"
docker stop --time 30 "${PRODUCTION_CONTAINER}" >/dev/null
STOPPED_PRODUCTION=1
event "production_stop" "final_image_smoke"
if ! sudo -n systemctl stop "${GPU_PEER_SERVICE}"; then
  FAILURE_REASON=gpu_peer_stop_failed
  exit 4
fi
STOPPED_GPU_PEER=1
event "gpu_peer_stop" "final_image_smoke"
if ! wait_for_gpu_idle; then
  exit 4
fi
event "gpu_exclusive" "final_image_smoke"

SMOKE_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if docker run --rm \
  --name "fincast-final-image-smoke-${RUN_ID}" \
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
  -v "${MODEL_CACHE}:/models:ro" \
  -v "${INPUT_ROOT}:/work/input:ro" \
  -v "${SMOKE_OUTPUT}:/work/output:rw" \
  "${IMAGE_TAG}" \
  raw-generate \
  --job /work/input/manifest.json \
  --output /work/output >> "${RUN_ROOT}/final-image-smoke.log" 2>&1; then
  SMOKE_FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
else
  SMOKE_FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  FAILURE_REASON=raw_generate_smoke_failed
  exit 4
fi

if [[ "$(jq -r '.backend' "${SMOKE_OUTPUT}/manifest.json")" != "cuda_graph" ]] \
  || [[ "$(jq -r '.batch_size' "${SMOKE_OUTPUT}/manifest.json")" != "48" ]] \
  || [[ "$(jq -r '.complete' "${SMOKE_OUTPUT}/manifest.json")" != "true" ]] \
  || [[ "$(jq -r '.latency.tail_eager' "${SMOKE_OUTPUT}/chunks/chunk-0000000096-0000000128.json")" != "true" ]]; then
  FAILURE_REASON=raw_generate_smoke_validation_failed
  exit 4
fi
SMOKE_STATUS=passed
event "final_image_smoke_finish" "cuda_graph_b48_tail_eager_passed"
