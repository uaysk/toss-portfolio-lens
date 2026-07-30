#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 6 || $# -gt 7 ]]; then
  echo "usage: run-chronos2-p40-qualification-worker.sh <source-root> <run-root> <run-id> <pilot|full> <duration-hours> <end-exclusive> [pilot-dashboard-metrics]" >&2
  exit 2
fi

SOURCE_ROOT=$1
RUN_ROOT=$2
RUN_ID=$3
MODE=$4
DURATION_HOURS=$5
END_EXCLUSIVE=$6
PILOT_DASHBOARD_METRICS=${7:-}
RUN_DIR="${RUN_ROOT}/${RUN_ID}"
RUNTIME_ROOT=$(dirname "${RUN_ROOT}")
MODEL_CACHE="${RUNTIME_ROOT}/model-cache"
STATE_TOOL="${SOURCE_ROOT}/scripts/chronos2-qualification-state.py"
SUMMARY_TOOL="${SOURCE_ROOT}/scripts/summarize-chronos2-qualification.py"
ETA_TOOL="${SOURCE_ROOT}/scripts/estimate-chronos2-full-duration.py"
METRICS_TOOL="${SOURCE_ROOT}/scripts/extract-chronos2-dashboard-metrics.py"
RUNTIME_PROVENANCE_TOOL="${SOURCE_ROOT}/scripts/compose-chronos2-runtime-provenance.py"
PREPARE_TOOL="${SOURCE_ROOT}/qualification-tools/prepare-chronos2-comparison-input.mjs"
COMPARE_TOOL="${SOURCE_ROOT}/qualification-tools/compare-fincast-policy.mjs"
CHRONOS_IMAGE=toss-portfolio-lens-chronos2-worker:chronos2-2.3.1-p40
NODE_IMAGE=node:22.17.0-bookworm-slim
FINCAST_IMAGE=toss-portfolio-lens-fincast-worker:fincast-p40-opt-20260727-190032
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
HOST_UID=$(id -u)
HOST_GID=$(id -g)
ACTIVE_STEP=""
TELEMETRY_PID=""
STOPPED_PRODUCTION=0
STOPPED_GPU_PEER=0
STATE_INITIALIZED=0
RUN_FINISHED=0

if [[ "${SOURCE_ROOT}" != /* ]] \
  || [[ "${RUN_ROOT}" != /* ]] \
  || [[ ! "${RUN_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || [[ "${MODE}" != "pilot" && "${MODE}" != "full" ]] \
  || [[ ! "${DURATION_HOURS}" =~ ^[0-9]+$ ]] \
  || (( DURATION_HOURS < 1 || DURATION_HOURS > 840 )) \
  || [[ ! -f "${STATE_TOOL}" ]] \
  || [[ ! -f "${RUNTIME_PROVENANCE_TOOL}" ]] \
  || [[ ! -f "${PREPARE_TOOL}" ]] \
  || [[ ! -f "${COMPARE_TOOL}" ]]; then
  echo "qualification arguments or source files are invalid" >&2
  exit 2
fi
if [[ -n "${PILOT_DASHBOARD_METRICS}" ]] \
  && [[ "${PILOT_DASHBOARD_METRICS}" != /* || ! -f "${PILOT_DASHBOARD_METRICS}" ]]; then
  echo "pilot dashboard metrics path is invalid" >&2
  exit 2
fi
if [[ "${MODE}" == "pilot" && ${DURATION_HOURS} -ge 840 ]] \
  || [[ "${MODE}" == "full" && ${DURATION_HOURS} -ne 840 ]]; then
  echo "pilot must be shorter than 840 hours and full must use exactly 840 hours" >&2
  exit 2
fi
if [[ -e "${RUN_DIR}" ]]; then
  echo "qualification run directory already exists: ${RUN_DIR}" >&2
  exit 2
fi

mkdir -p "${RUN_ROOT}" "${MODEL_CACHE}" "${RUN_DIR}"
chmod 700 "${RUN_ROOT}" "${RUN_DIR}"
chmod 755 "${MODEL_CACHE}"

BUDGET_HOURS=2
if [[ "${MODE}" == "full" ]]; then
  BUDGET_HOURS=12
fi
python3 "${STATE_TOOL}" init \
  --run-dir "${RUN_DIR}" \
  --run-id "${RUN_ID}" \
  --mode "${MODE}" \
  --duration-hours "${DURATION_HOURS}" \
  --end-exclusive "${END_EXCLUSIVE}" \
  --budget-hours "${BUDGET_HOURS}"
STATE_INITIALIZED=1
if [[ -n "${PILOT_DASHBOARD_METRICS}" ]]; then
  python3 "${STATE_TOOL}" experiment-metrics \
    --run-dir "${RUN_DIR}" \
    --json-file "${PILOT_DASHBOARD_METRICS}"
fi
mkdir -p "${RUN_DIR}/logs" "${RUN_DIR}/timings"
WRAPPER_LOG="${RUN_DIR}/worker-wrapper.log"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${WRAPPER_LOG}"
}

step_start() {
  ACTIVE_STEP=$1
  python3 "${STATE_TOOL}" step-start \
    --run-dir "${RUN_DIR}" \
    --step-id "${ACTIVE_STEP}" \
    --message "$2"
}

step_complete() {
  python3 "${STATE_TOOL}" step-complete \
    --run-dir "${RUN_DIR}" \
    --step-id "${ACTIVE_STEP}" \
    --message "$1"
  ACTIVE_STEP=""
}

start_telemetry() {
  (
    while true; do
      SAMPLE=$(nvidia-smi \
        --query-gpu=memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit,memory.free \
        --format=csv,noheader,nounits 2>/dev/null || true)
      if [[ -n "${SAMPLE}" ]]; then
        python3 "${STATE_TOOL}" telemetry \
          --run-dir "${RUN_DIR}" \
          --csv "${SAMPLE}" >/dev/null 2>&1 || true
      fi
      sleep 2
    done
  ) &
  TELEMETRY_PID=$!
}

stop_telemetry() {
  if [[ -n "${TELEMETRY_PID}" ]] && kill -0 "${TELEMETRY_PID}" 2>/dev/null; then
    kill "${TELEMETRY_PID}" 2>/dev/null || true
    wait "${TELEMETRY_PID}" 2>/dev/null || true
  fi
  TELEMETRY_PID=""
}

wait_for_gpu_idle() {
  local processes=""
  for _attempt in $(seq 1 120); do
    processes=$(nvidia-smi \
      --query-compute-apps=pid,process_name \
      --format=csv,noheader,nounits 2>/dev/null || true)
    if [[ -z "${processes}" ]]; then
      return 0
    fi
    sleep 1
  done
  event "gpu_exclusivity_failed ${processes}"
  return 1
}

restore_gpu_services() {
  local restore_failed=0
  if [[ ${STOPPED_PRODUCTION} -eq 1 ]]; then
    docker start "${PRODUCTION_CONTAINER}" >> "${WRAPPER_LOG}" 2>&1 || restore_failed=1
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
      restore_failed=1
    fi
    STOPPED_PRODUCTION=0
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 1 ]]; then
    if sudo -n systemctl start "${GPU_PEER_SERVICE}" >> "${WRAPPER_LOG}" 2>&1; then
      event "gpu_peer_restore active"
    else
      event "gpu_peer_restore failed"
      restore_failed=1
    fi
    STOPPED_GPU_PEER=0
  fi
  return "${restore_failed}"
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  stop_telemetry
  restore_gpu_services || exit_code=3
  if [[ ${STATE_INITIALIZED} -eq 1 && ${RUN_FINISHED} -eq 0 ]]; then
    if [[ -n "${ACTIVE_STEP}" ]]; then
      python3 "${STATE_TOOL}" step-fail \
        --run-dir "${RUN_DIR}" \
        --step-id "${ACTIVE_STEP}" \
        --message "automation exited with status ${exit_code}" >/dev/null 2>&1 || true
    fi
    python3 "${STATE_TOOL}" finish \
      --run-dir "${RUN_DIR}" \
      --status failed \
      --message "automation failed with status ${exit_code}" >/dev/null 2>&1 || true
  fi
  exit "${exit_code}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
start_telemetry

chronos_docker() {
  local profile=$1
  shift
  docker run --rm \
    --gpus device=0 \
    --ipc=host \
    --ulimit memlock=-1 \
    --user "${HOST_UID}:${HOST_GID}" \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,size=2g \
    -e AI_MODEL_CACHE_DIR=/models \
    -e AI_MODEL_MANIFEST=/app/model-manifest.json \
    -e AI_MODEL_LANE=chronos_2 \
    -e AI_CHRONOS2_INPUT_PROFILE="${profile}" \
    -e AI_DEVICE=cuda \
    -e AI_ALLOW_CPU_FALLBACK=false \
    -e AI_EXPECTED_CUDA_CAPABILITY=6.1 \
    -e AI_EXPECTED_CUDA_DEVICE_NAME="Tesla P40" \
    -e HF_HUB_OFFLINE=1 \
    -e TRANSFORMERS_OFFLINE=1 \
    -v "${MODEL_CACHE}:/models:ro" \
    -v "${RUN_DIR}:/work" \
    "${CHRONOS_IMAGE}" "$@"
}

chronos_timed() {
  local profile=$1
  local timing_file=$2
  shift 2
  local started_ns
  local finished_ns
  started_ns=$(date +%s%N)
  chronos_docker "${profile}" "$@"
  finished_ns=$(date +%s%N)
  python3 -c 'import json,sys; json.dump({"wall_seconds":(int(sys.argv[1])-int(sys.argv[2]))/1e9},open(sys.argv[3],"w"),separators=(",",":"))' \
    "${finished_ns}" "${started_ns}" "${timing_file}"
}

python_image() {
  docker run --rm \
    --user "${HOST_UID}:${HOST_GID}" \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,size=2g \
    -v "${RUN_DIR}:/work" \
    --entrypoint /app/.venv/bin/python \
    "${CHRONOS_IMAGE}" "$@"
}

step_start preflight "worker-1 환경과 운영 복구 대상을 확인합니다."
INITIAL_PRODUCTION=$(docker inspect \
  --format '{{.State.Status}} {{.State.Health.Status}}' \
  "${PRODUCTION_CONTAINER}")
INITIAL_GPU_PEER=$(systemctl is-active "${GPU_PEER_SERVICE}")
POWER_LIMIT=$(nvidia-smi \
  --query-gpu=power.limit \
  --format=csv,noheader,nounits | tr -d ' ')
GPU_NAME=$(nvidia-smi \
  --query-gpu=name \
  --format=csv,noheader | tr -d '\r')
DRIVER_VERSION=$(nvidia-smi \
  --query-gpu=driver_version \
  --format=csv,noheader | tr -d ' \r')
FINCAST_MODEL_CACHE=$(docker inspect \
  --format '{{range .Mounts}}{{if eq .Destination "/models"}}{{.Source}}{{end}}{{end}}' \
  "${PRODUCTION_CONTAINER}")
CUDA_VERSION=$(/usr/local/cuda-12.2/bin/nvcc -V | tail -1)
CUDNN_VERSION=$(grep -E '^#define CUDNN_(MAJOR|MINOR|PATCHLEVEL)' \
  /usr/local/cuda/include/cudnn_version.h | tr '\n' ' ')
if [[ "${INITIAL_PRODUCTION}" != "running healthy" ]] \
  || [[ "${INITIAL_GPU_PEER}" != "active" ]] \
  || [[ "${POWER_LIMIT}" != "160.00" ]] \
  || [[ "${GPU_NAME}" != "Tesla P40" ]] \
  || [[ ! -d "${FINCAST_MODEL_CACHE}/fincast" ]]; then
  echo "preflight failed: production=${INITIAL_PRODUCTION}, peer=${INITIAL_GPU_PEER}, power=${POWER_LIMIT}, gpu=${GPU_NAME}" >&2
  exit 2
fi
python3 -c 'import json,sys; json.dump({"schema_version":"chronos2-p40-preflight/v1","production":sys.argv[1],"gpu_peer":sys.argv[2],"power_limit_w":float(sys.argv[3]),"gpu":sys.argv[4],"driver":sys.argv[5],"cuda_nvcc":sys.argv[6],"cudnn_header":sys.argv[7],"fincast_model_cache":sys.argv[8]},open(sys.argv[9],"w"),separators=(",",":"))' \
  "${INITIAL_PRODUCTION}" "${INITIAL_GPU_PEER}" "${POWER_LIMIT}" "${GPU_NAME}" \
  "${DRIVER_VERSION}" "${CUDA_VERSION}" "${CUDNN_VERSION}" "${FINCAST_MODEL_CACHE}" \
  "${RUN_DIR}/preflight.json"
step_complete "P40 · 160W · host toolkit CUDA 12.2 · host cuDNN header 8.9.7 · 운영 복구 대상 확인"

step_start runtime "Chronos-2 image와 pinned model cache를 준비합니다."
docker build \
  --file "${SOURCE_ROOT}/Dockerfile.worker.chronos2" \
  --tag "${CHRONOS_IMAGE}" \
  --build-arg APP_GIT_SHA=uncommitted-chronos2-qualification \
  "${SOURCE_ROOT}" \
  >> "${RUN_DIR}/logs/runtime.log" 2>&1
docker pull "${NODE_IMAGE}" >> "${RUN_DIR}/logs/runtime.log" 2>&1
docker run --rm \
  --user "${HOST_UID}:${HOST_GID}" \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:rw,nosuid,nodev,size=2g \
  -e HF_HUB_OFFLINE=0 \
  -e TRANSFORMERS_OFFLINE=0 \
  -e HF_HUB_DISABLE_TELEMETRY=1 \
  -e HF_HOME=/tmp/huggingface \
  -v "${MODEL_CACHE}:/models" \
  --entrypoint /app/.venv/bin/python \
  "${CHRONOS_IMAGE}" \
  /app/scripts/prepare-chronos2-model-cache.py \
  --manifest /app/model-manifest.json \
  --cache-dir /models \
  > "${RUN_DIR}/runtime-model.json"
docker run --rm \
  --user "${HOST_UID}:${HOST_GID}" \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --entrypoint /app/.venv/bin/python \
  "${CHRONOS_IMAGE}" \
  -c 'import json,platform,torch; value=torch.backends.cudnn.version(); divisor=10000 if isinstance(value,int) and value>=10000 else 1000; parts=(value//divisor,(value%divisor)//100,value%100) if isinstance(value,int) else (None,None,None); print(json.dumps({"schema_version":"chronos2-framework-runtime/v1","python":platform.python_version(),"torch":torch.__version__,"cuda_runtime":torch.version.cuda,"cudnn_runtime":".".join(map(str,parts)) if parts[0] is not None else None,"cudnn_runtime_integer":value},separators=(",",":")))' \
  > "${RUN_DIR}/runtime-framework.json"
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "${CHRONOS_IMAGE}")
python3 "${RUNTIME_PROVENANCE_TOOL}" \
  --preflight "${RUN_DIR}/preflight.json" \
  --model "${RUN_DIR}/runtime-model.json" \
  --framework "${RUN_DIR}/runtime-framework.json" \
  --image-id "${IMAGE_ID}" \
  --output "${RUN_DIR}/runtime.json" \
  >> "${RUN_DIR}/logs/runtime.log"
docker image inspect "${CHRONOS_IMAGE}" >> "${RUN_DIR}/logs/runtime.log"
step_complete "chronos-forecasting 2.3.1 · torch 2.6.0+cu124/CUDA 12.4/cuDNN 9.1 · revision/SHA 확정"

step_start prepare-input "Binance 정렬 입력과 추가 covariate를 causal하게 수집합니다."
docker run --rm \
  --user "${HOST_UID}:${HOST_GID}" \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  -v "${RUN_DIR}:/work" \
  -v "${SOURCE_ROOT}/qualification-tools:/tools:ro" \
  "${NODE_IMAGE}" \
  node /tools/prepare-chronos2-comparison-input.mjs \
  --output /work/input \
  --duration-hours "${DURATION_HOURS}" \
  --end-exclusive "${END_EXCLUSIVE}" \
  --model-seed 17 \
  >> "${RUN_DIR}/logs/prepare-input.log" 2>&1
step_complete "BTC/ETH OHLCV·trade/taker·mark/index/premium/funding 정렬 source 확정"

step_start chronos-artifacts "네 Chronos-2 입력 profile artifact를 생성합니다."
PROFILES=(close_only ohlcv_calendar microstructure_calendar derivatives_calendar)
for profile in "${PROFILES[@]}"; do
  python_image \
    /app/scripts/prepare-chronos2-raw-artifact.py \
    --market-bars /work/input/market-bars.jsonl \
    --origins /work/input/fincast-input/origins.jsonl \
    --output "/work/inputs/${profile}" \
    --profile "${profile}" \
    >> "${RUN_DIR}/logs/chronos-artifacts.log" 2>&1
done
step_complete "동일 row 순서 · 1/11/14/18 variate fixed-shape artifact 검증"

if [[ "${MODE}" == "pilot" ]]; then
  INFERENCE_STEP=pilot-inference
else
  INFERENCE_STEP=batch-sweep
fi
step_start "${INFERENCE_STEP}" "GPU를 격리하고 Chronos-2 최적화 측정을 시작합니다."
event "production_stop begin"
docker stop --time 30 "${PRODUCTION_CONTAINER}" >> "${WRAPPER_LOG}" 2>&1
STOPPED_PRODUCTION=1
sudo -n systemctl stop "${GPU_PEER_SERVICE}" >> "${WRAPPER_LOG}" 2>&1
STOPPED_GPU_PEER=1
wait_for_gpu_idle
event "gpu_exclusive confirmed power_cap_w=160"

mkdir -p "${RUN_DIR}/benchmarks"
if [[ "${MODE}" == "pilot" ]]; then
  BENCH_ROUNDS=1
  BENCH_WARMUPS=2
  BENCH_ITERATIONS=5
  for profile in "${PROFILES[@]}"; do
    mkdir -p "${RUN_DIR}/benchmarks/${profile}"
    chronos_docker "${profile}" raw-benchmark \
      --job "/work/inputs/${profile}/manifest.json" \
      --output "/work/benchmarks/${profile}/batch-worker-local-b48.json" \
      --backend worker_local \
      --batch-size 48 \
      --rounds "${BENCH_ROUNDS}" \
      --warmups "${BENCH_WARMUPS}" \
      --iterations "${BENCH_ITERATIONS}" \
      >> "${RUN_DIR}/logs/pilot-inference.log" 2>&1
    for backend in pipeline_eager worker_local no_padding gpu_gather cuda_graph; do
      chronos_docker "${profile}" raw-benchmark \
        --job "/work/inputs/${profile}/manifest.json" \
        --output "/work/benchmarks/${profile}/stage-${backend}-b48.json" \
        --backend "${backend}" \
        --batch-size 48 \
        --rounds "${BENCH_ROUNDS}" \
        --warmups "${BENCH_WARMUPS}" \
        --iterations "${BENCH_ITERATIONS}" \
        >> "${RUN_DIR}/logs/pilot-inference.log" 2>&1
    done
  done
else
  for profile in "${PROFILES[@]}"; do
    mkdir -p "${RUN_DIR}/benchmarks/${profile}"
    for batch in 16 24 32 48 50; do
      chronos_docker "${profile}" raw-benchmark \
        --job "/work/inputs/${profile}/manifest.json" \
        --output "/work/benchmarks/${profile}/batch-worker-local-b${batch}.json" \
        --backend worker_local \
        --batch-size "${batch}" \
        --rounds 3 \
        --warmups 10 \
        --iterations 30 \
        >> "${RUN_DIR}/logs/batch-sweep.log" 2>&1
    done
  done
  python3 "${SUMMARY_TOOL}" \
    --run-dir "${RUN_DIR}" \
    --output "${RUN_DIR}/selection.json" \
    --selection-only \
    >> "${RUN_DIR}/logs/batch-sweep.log" 2>&1
  step_complete "4 profiles × B16/24/32/48/50 독립 프로세스 sweep 완료"
  step_start optimization-waterfall "선택 batch에서 누적 최적화 waterfall을 측정합니다."
  for profile in "${PROFILES[@]}"; do
    batch=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["profiles"][sys.argv[2]]["batch_sweep"]["selected_variate_batch_size"])' \
      "${RUN_DIR}/selection.json" "${profile}")
    for backend in pipeline_eager worker_local no_padding gpu_gather cuda_graph; do
      chronos_docker "${profile}" raw-benchmark \
        --job "/work/inputs/${profile}/manifest.json" \
        --output "/work/benchmarks/${profile}/stage-${backend}-b${batch}.json" \
        --backend "${backend}" \
        --batch-size "${batch}" \
        --rounds 3 \
        --warmups 10 \
        --iterations 30 \
        >> "${RUN_DIR}/logs/optimization-waterfall.log" 2>&1
    done
  done
fi

python3 "${SUMMARY_TOOL}" \
  --run-dir "${RUN_DIR}" \
  --output "${RUN_DIR}/optimization-summary.json" \
  --selection-only \
  >> "${RUN_DIR}/logs/${INFERENCE_STEP}.log" 2>&1
if [[ "${MODE}" == "pilot" ]]; then
  cp "${RUN_DIR}/optimization-summary.json" "${RUN_DIR}/selection.json"
else
  step_complete "pipeline→worker-local→patch-aligned→GPU gather→CUDA Graph 측정 완료"
  step_start fincast-reference "현재 운영 FinCast CUDA Graph FP32 기준을 생성합니다."
fi

mkdir -p "${RUN_DIR}/outputs" "${RUN_DIR}/outputs/chronos2"
/usr/bin/time \
  --format '{"wall_seconds":%e}' \
  --output "${RUN_DIR}/timings/fincast-generation.json" \
  docker run --rm \
    --gpus device=0 \
    --ipc=host \
    --ulimit memlock=-1 \
    --user "${HOST_UID}:${HOST_GID}" \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,size=2g \
    -e AI_MODEL_CACHE_DIR=/models \
    -e AI_MODEL_MANIFEST=/app/model-manifest.json \
    -e AI_MODEL_LANE=fincast \
    -e AI_DEVICE=cuda \
    -e AI_ALLOW_CPU_FALLBACK=false \
    -e AI_EXPECTED_CUDA_CAPABILITY=6.1 \
    -e AI_EXPECTED_CUDA_DEVICE_NAME="Tesla P40" \
    -v "${FINCAST_MODEL_CACHE}:/models:ro" \
    -v "${RUN_DIR}:/work" \
    "${FINCAST_IMAGE}" raw-generate \
    --job /work/input/fincast-input/manifest.json \
    --output /work/outputs/fincast \
    --backend cuda_graph \
    --batch-size 48 \
    >> "${RUN_DIR}/logs/${INFERENCE_STEP}.log" 2>&1

if [[ "${MODE}" == "full" ]]; then
  step_complete "FinCast CUDA Graph FP32 5주 reference raw output 완료"
  step_start chronos-profiles "네 Chronos-2 profile의 합격 최적 backend를 실행합니다."
fi
for profile in "${PROFILES[@]}"; do
  batch=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["profiles"][sys.argv[2]]["batch_sweep"]["selected_variate_batch_size"])' \
    "${RUN_DIR}/optimization-summary.json" "${profile}")
  backend=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["profiles"][sys.argv[2]]["optimization"]["selected_backend"])' \
    "${RUN_DIR}/optimization-summary.json" "${profile}")
  chronos_timed \
    "${profile}" \
    "${RUN_DIR}/timings/chronos2-${profile}-generation.json" \
    raw-generate \
    --job "/work/inputs/${profile}/manifest.json" \
    --output "/work/outputs/chronos2/${profile}" \
    --backend "${backend}" \
    --batch-size "${batch}" \
    >> "${RUN_DIR}/logs/${INFERENCE_STEP}.log" 2>&1
done
if [[ "${MODE}" == "pilot" ]]; then
  step_complete "짧은 범위 backend 측정과 FinCast/Chronos-2 4 profile 추론 완료"
else
  step_complete "네 profile의 5주 Chronos-2 raw output 완료"
fi

restore_gpu_services
event "gpu_services_restored_before_cpu_comparison"

if [[ "${MODE}" == "pilot" ]]; then
  COMPARISON_STEP=pilot-comparison
else
  COMPARISON_STEP=model-comparison
fi
step_start "${COMPARISON_STEP}" "동일 정책·threshold·실현 가격 비교를 실행합니다."
mkdir -p "${RUN_DIR}/policy" "${RUN_DIR}/comparisons" "${RUN_DIR}/details"
for profile in "${PROFILES[@]}"; do
  python_image \
    /app/scripts/convert-chronos2-output-to-policy-artifact.py \
    --fincast-input /work/input/fincast-input/manifest.json \
    --chronos-input "/work/inputs/${profile}/manifest.json" \
    --chronos-output "/work/outputs/chronos2/${profile}" \
    --output "/work/policy/${profile}" \
    >> "${RUN_DIR}/logs/${COMPARISON_STEP}.log" 2>&1
  docker run --rm \
    --user "${HOST_UID}:${HOST_GID}" \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,size=1g \
    -v "${RUN_DIR}:/work" \
    -v "${SOURCE_ROOT}/qualification-tools:/tools:ro" \
    "${NODE_IMAGE}" \
    node /tools/compare-fincast-policy.mjs \
    --job /work/input/fincast-input/manifest.json \
    --reference /work/outputs/fincast \
    --candidate "/work/policy/${profile}" \
    --market-data /work/input/market-manifest.json \
    --output "/work/comparisons/${profile}.json" \
    --margins-output "/work/details/${profile}-threshold-margins.jsonl" \
    --details-output "/work/details/${profile}-comparison-details.jsonl" \
    >> "${RUN_DIR}/logs/${COMPARISON_STEP}.log" 2>&1
done
step_complete "4 profile의 실현 정확도·확률·reason·정책 수익률 비교 완료"

if [[ "${MODE}" == "pilot" ]]; then
  step_start eta "pilot 실측으로 5주 wall-time을 추정합니다."
  python3 "${SUMMARY_TOOL}" \
    --run-dir "${RUN_DIR}" \
    --output "${RUN_DIR}/qualification-summary.json" \
    >> "${RUN_DIR}/logs/eta.log" 2>&1
  python3 "${ETA_TOOL}" \
    --pilot-run "${RUN_DIR}" \
    --output "${RUN_DIR}/eta.json" \
    >> "${RUN_DIR}/logs/eta.log" 2>&1
  python3 "${METRICS_TOOL}" \
    --summary "${RUN_DIR}/qualification-summary.json" \
    --eta "${RUN_DIR}/eta.json" \
    --output "${RUN_DIR}/dashboard-metrics.json" \
    >> "${RUN_DIR}/logs/eta.log" 2>&1
  python3 "${STATE_TOOL}" experiment-metrics \
    --run-dir "${RUN_DIR}" \
    --json-file "${RUN_DIR}/dashboard-metrics.json"
  step_complete "실측 고정비·row 처리비·p95 여유를 분리한 5주 ETA 산출"
else
  step_start final-summary "최적화와 모델 비교 결과를 집계합니다."
  python3 "${SUMMARY_TOOL}" \
    --run-dir "${RUN_DIR}" \
    --output "${RUN_DIR}/qualification-summary.json" \
    >> "${RUN_DIR}/logs/final-summary.log" 2>&1
  python3 "${METRICS_TOOL}" \
    --summary "${RUN_DIR}/qualification-summary.json" \
    --output "${RUN_DIR}/dashboard-metrics.json" \
    >> "${RUN_DIR}/logs/final-summary.log" 2>&1
  python3 "${STATE_TOOL}" experiment-metrics \
    --run-dir "${RUN_DIR}" \
    --json-file "${RUN_DIR}/dashboard-metrics.json"
  step_complete "최적 profile/backend와 FinCast 대비 정확도·수익률 차이 집계"
fi

python3 "${STATE_TOOL}" finish \
  --run-dir "${RUN_DIR}" \
  --status completed \
  --message "Chronos-2 ${MODE} qualification completed"
RUN_FINISHED=1
event "runner_finished status=0 mode=${MODE}"
