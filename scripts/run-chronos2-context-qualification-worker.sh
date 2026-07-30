#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 6 ]]; then
  echo "usage: run-chronos2-context-qualification-worker.sh <source-root> <run-root> <run-id> <baseline-run> <model-cache> <end-exclusive>" >&2
  exit 2
fi

SOURCE_ROOT=$1
RUN_ROOT=$2
RUN_ID=$3
BASELINE_RUN=$4
MODEL_CACHE=$5
END_EXCLUSIVE=$6
RUN_DIR="${RUN_ROOT}/${RUN_ID}"
STATE_TOOL="${SOURCE_ROOT}/scripts/chronos2-qualification-state.py"
ORIGIN_TOOL="${SOURCE_ROOT}/scripts/prepare-chronos2-context-origins.py"
PREPARE_ARTIFACT="${SOURCE_ROOT}/scripts/prepare-chronos2-raw-artifact.py"
SUMMARY_TOOL="${SOURCE_ROOT}/scripts/summarize-chronos2-context-benchmarks.py"
ANALYSIS_TOOL="${SOURCE_ROOT}/scripts/analyze-chronos2-context-windows.py"
DASHBOARD_METRICS_TOOL="${SOURCE_ROOT}/scripts/extract-chronos2-context-dashboard-metrics.py"
PREPARE_SOURCE="${SOURCE_ROOT}/qualification-tools/prepare-chronos2-comparison-input.mjs"
CHRONOS_IMAGE=toss-portfolio-lens-chronos2-worker:chronos2-2.3.1-p40
NODE_IMAGE=node:22.17.0-bookworm-slim
PRODUCTION_CONTAINER=toss-portfolio-lens-ai-worker-fincast-worker-1
GPU_PEER_SERVICE=llama-swap.service
EXPECTED_MODEL_REVISION=254b5357164a84326913b0695216f690752ac55d
EXPECTED_CHECKPOINT_SHA256=ddcda3c7508bf2528087723e98a20707cc04b7f370ae275a9fd88078ddba4f42
CONTEXTS=(512 1024 2048 4096 8192)
BATCHES=(1 2 4 8 12 16 24 32 48 50)
BACKENDS=(pipeline_eager worker_local no_padding gpu_gather)
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
  || [[ "${BASELINE_RUN}" != /* ]] \
  || [[ "${MODEL_CACHE}" != /* ]] \
  || [[ ! "${RUN_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || [[ "${END_EXCLUSIVE}" != "2026-07-27T00:00:00Z" ]] \
  || [[ ! -f "${STATE_TOOL}" ]] \
  || [[ ! -f "${ORIGIN_TOOL}" ]] \
  || [[ ! -f "${PREPARE_ARTIFACT}" ]] \
  || [[ ! -f "${SUMMARY_TOOL}" ]] \
  || [[ ! -f "${ANALYSIS_TOOL}" ]] \
  || [[ ! -f "${DASHBOARD_METRICS_TOOL}" ]] \
  || [[ ! -f "${PREPARE_SOURCE}" ]] \
  || [[ ! -f "${BASELINE_RUN}/input/fincast-input/origins.jsonl" ]] \
  || [[ ! -d "${MODEL_CACHE}/chronos-2" ]]; then
  echo "context qualification arguments or fixed inputs are invalid" >&2
  exit 2
fi

mkdir -p "${RUN_ROOT}"
chmod 700 "${RUN_ROOT}"
if [[ -e "${RUN_DIR}" && ! -f "${RUN_DIR}/state.json" ]]; then
  echo "run directory exists without a resumable state: ${RUN_DIR}" >&2
  exit 2
fi
if [[ ! -e "${RUN_DIR}" ]]; then
  mkdir "${RUN_DIR}"
  chmod 700 "${RUN_DIR}"
  python3 "${STATE_TOOL}" init \
    --run-dir "${RUN_DIR}" \
    --run-id "${RUN_ID}" \
    --mode full \
    --duration-hours 840 \
    --end-exclusive "${END_EXCLUSIVE}" \
    --budget-hours 12 \
    --experiment context-window
elif [[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "${RUN_DIR}/state.json")" == "completed" ]]; then
  echo "context qualification run is already complete: ${RUN_ID}"
  exit 0
fi
STATE_INITIALIZED=1
mkdir -p "${RUN_DIR}/logs"
WRAPPER_LOG="${RUN_DIR}/worker-wrapper.log"

event() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${WRAPPER_LOG}"
}

step_status() {
  python3 -c 'import json,sys; state=json.load(open(sys.argv[1])); print(next(item["status"] for item in state["steps"] if item["id"]==sys.argv[2]))' \
    "${RUN_DIR}/state.json" "$1"
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
      sample=$(nvidia-smi \
        --query-gpu=memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit,memory.free \
        --format=csv,noheader,nounits 2>/dev/null || true)
      if [[ -n "${sample}" ]]; then
        python3 "${STATE_TOOL}" telemetry \
          --run-dir "${RUN_DIR}" \
          --csv "${sample}" >/dev/null 2>&1 || true
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
      health=$(docker inspect --format '{{.State.Health.Status}}' \
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

python_container() {
  docker run --rm \
    --user "${HOST_UID}:${HOST_GID}" \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,size=2g \
    -e PYTHONPATH=/source/worker/ai/src \
    -v "${SOURCE_ROOT}:/source:ro" \
    -v "${RUN_DIR}:/work" \
    -v "${BASELINE_RUN}:/baseline:ro" \
    --entrypoint /app/.venv/bin/python \
    "${CHRONOS_IMAGE}" "$@"
}

chronos_gpu() {
  docker run --rm \
    --gpus device=0 \
    --ipc=host \
    --ulimit memlock=-1 \
    --user "${HOST_UID}:${HOST_GID}" \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --tmpfs /tmp:rw,nosuid,nodev,size=2g \
    -e PYTHONPATH=/source/worker/ai/src \
    -e AI_MODEL_CACHE_DIR=/models \
    -e AI_MODEL_MANIFEST=/source/worker/ai/model-manifest.json \
    -e AI_MODEL_LANE=chronos_2 \
    -e AI_CHRONOS2_INPUT_PROFILE=close_only \
    -e AI_DEVICE=cuda \
    -e AI_ALLOW_CPU_FALLBACK=false \
    -e AI_EXPECTED_CUDA_CAPABILITY=6.1 \
    -e AI_EXPECTED_CUDA_DEVICE_NAME="Tesla P40" \
    -e HF_HUB_OFFLINE=1 \
    -e TRANSFORMERS_OFFLINE=1 \
    -v "${SOURCE_ROOT}:/source:ro" \
    -v "${MODEL_CACHE}:/models:ro" \
    -v "${RUN_DIR}:/work" \
    --entrypoint /app/.venv/bin/python \
    "${CHRONOS_IMAGE}" \
    -m portfolio_ai_worker.main "$@"
}

artifact_valid() {
  python_container -c \
    'import sys; from pathlib import Path; from portfolio_ai_worker.chronos2_artifacts import load_chronos2_input; load_chronos2_input(Path(sys.argv[1]))' \
    "$1"
}

benchmark_valid() {
  python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); assert value["schema_version"]=="chronos2-p40-raw-benchmark/v1"; assert value["status"] in {"passed","rejected","unavailable"}' "$1"
}

build_artifact() {
  local phase=$1
  local context=$2
  local origins=$3
  local output="${RUN_DIR}/${phase}/inputs/${context}"
  if [[ -f "${output}/manifest.json" ]]; then
    artifact_valid "/work/${phase}/inputs/${context}/manifest.json"
    return
  fi
  if [[ -e "${output}" ]]; then
    echo "incomplete final artifact exists and cannot be overwritten: ${output}" >&2
    return 1
  fi
  local staging="${RUN_DIR}/${phase}/inputs/${context}.staging.$(date -u +%Y%m%d%H%M%S).$$"
  python_container \
    /source/scripts/prepare-chronos2-raw-artifact.py \
    --market-bars /work/source/market-bars.jsonl \
    --origins "${origins}" \
    --output "/work/${staging#"${RUN_DIR}/"}" \
    --profile close_only \
    --context-bars "${context}" \
    --schema-version chronos2-raw-input/v2
  mv "${staging}" "${output}"
}

run_benchmark() {
  local manifest=$1
  local output=$2
  local backend=$3
  local batch=$4
  local rounds=$5
  local warmups=$6
  local iterations=$7
  local host_output="${RUN_DIR}/${output#/work/}"
  if [[ -f "${host_output}" ]]; then
    benchmark_valid "${host_output}"
    return
  fi
  chronos_gpu raw-benchmark \
    --job "${manifest}" \
    --output "${output}" \
    --backend "${backend}" \
    --batch-size "${batch}" \
    --rounds "${rounds}" \
    --warmups "${warmups}" \
    --iterations "${iterations}"
}

if [[ "$(step_status preflight)" != "completed" ]]; then
  step_start preflight "고정 image/cache, 기준선, GPU와 복구 대상을 확인합니다."
  initial_production=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "${PRODUCTION_CONTAINER}")
  initial_peer=$(systemctl is-active "${GPU_PEER_SERVICE}")
  power_limit=$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits | tr -d ' ')
  gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader | tr -d '\r')
  checkpoint_sha=$(sha256sum "${MODEL_CACHE}/chronos-2/model.safetensors" | cut -d' ' -f1)
  image_id=$(docker image inspect --format '{{.Id}}' "${CHRONOS_IMAGE}")
  node_image_id=$(docker image inspect --format '{{.Id}}' "${NODE_IMAGE}")
  if [[ "${initial_production}" != "running healthy" ]] \
    || [[ "${initial_peer}" != "active" ]] \
    || [[ "${power_limit}" != "160.00" ]] \
    || [[ "${gpu_name}" != "Tesla P40" ]] \
    || [[ "${checkpoint_sha}" != "${EXPECTED_CHECKPOINT_SHA256}" ]] \
    || [[ -z "${image_id}" || -z "${node_image_id}" ]]; then
    echo "preflight failed: production=${initial_production}, peer=${initial_peer}, power=${power_limit}, gpu=${gpu_name}, checkpoint=${checkpoint_sha}" >&2
    exit 2
  fi
  python3 -c 'import json,sys; json.dump({"schema_version":"chronos2-context-preflight/v1","production":sys.argv[1],"gpu_peer":sys.argv[2],"power_limit_w":float(sys.argv[3]),"gpu":sys.argv[4],"checkpoint_sha256":sys.argv[5],"model_revision":sys.argv[6],"chronos_image_id":sys.argv[7],"node_image_id":sys.argv[8],"docker_build":False,"docker_pull":False,"model_download":False},open(sys.argv[9],"w"),separators=(",",":"))' \
    "${initial_production}" "${initial_peer}" "${power_limit}" "${gpu_name}" \
    "${checkpoint_sha}" "${EXPECTED_MODEL_REVISION}" "${image_id}" "${node_image_id}" \
    "${RUN_DIR}/preflight.json"
  step_complete "기존 image/cache · Tesla P40 · 160W · 운영 복구 대상 확인"
fi

if [[ "$(step_status runtime)" != "completed" ]]; then
  step_start runtime "고정 Chronos-2 runtime과 model identity를 오프라인 검증합니다."
  chronos_gpu preflight-json > "${RUN_DIR}/runtime.json"
  python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); models=value.get("models",[]); assert any(item.get("model",{}).get("model_revision")==sys.argv[2] and item.get("model",{}).get("loaded") is True for item in models)' \
    "${RUN_DIR}/runtime.json" "${EXPECTED_MODEL_REVISION}"
  step_complete "revision·checkpoint·CUDA runtime 검증 완료 (build/pull/download 없음)"
fi

if [[ "$(step_status prepare-source)" != "completed" ]]; then
  step_start prepare-source "기존 origin을 유지하며 8192봉용 pre-roll source를 수집합니다."
  if [[ ! -f "${RUN_DIR}/source/source-manifest.json" ]]; then
    staging="${RUN_DIR}/source.staging"
    if [[ -e "${staging}" ]]; then
      staging="${RUN_DIR}/source.staging.$(date -u +%Y%m%d%H%M%S)"
    fi
    docker run --rm \
      --user "${HOST_UID}:${HOST_GID}" \
      --security-opt no-new-privileges:true \
      --cap-drop ALL \
      --tmpfs /tmp:rw,nosuid,nodev,size=1g \
      -v "${RUN_DIR}:/work" \
      -v "${SOURCE_ROOT}/qualification-tools:/tools:ro" \
      "${NODE_IMAGE}" \
      node /tools/prepare-chronos2-comparison-input.mjs \
      --output "/work/${staging#"${RUN_DIR}/"}" \
      --duration-hours 840 \
      --end-exclusive "${END_EXCLUSIVE}" \
      --model-seed 17 \
      --context-bars 8192 \
      >> "${RUN_DIR}/logs/prepare-source.log" 2>&1
    mv "${staging}" "${RUN_DIR}/source"
  fi
  step_complete "5주 scored 구간 + 8192봉 pre-roll source 수집 완료"
fi

if [[ "$(step_status origin-parity)" != "completed" ]]; then
  step_start origin-parity "기존 6,720 origin identity와 새 source를 exact 비교합니다."
  if [[ ! -f "${RUN_DIR}/origin-parity.json" ]]; then
    python3 "${ORIGIN_TOOL}" \
      --baseline-origins "${BASELINE_RUN}/input/fincast-input/origins.jsonl" \
      --collected-origins "${RUN_DIR}/source/fincast-input/origins.jsonl" \
      --pilot-output "${RUN_DIR}/pilot-origins.jsonl" \
      --report-output "${RUN_DIR}/origin-parity.json" \
      >> "${RUN_DIR}/logs/origin-parity.log"
  fi
  step_complete "6,720 full origin exact parity · 마지막 24시간 192행 확정"
fi

if [[ "$(step_status pilot-artifacts)" != "completed" ]]; then
  step_start pilot-artifacts "24시간 close-only context artifact 다섯 개를 생성합니다."
  mkdir -p "${RUN_DIR}/pilot/inputs"
  for context in "${CONTEXTS[@]}"; do
    build_artifact pilot "${context}" /work/pilot-origins.jsonl \
      >> "${RUN_DIR}/logs/pilot-artifacts.log"
  done
  step_complete "192 rows × 5 contexts · full history · zero/left padding 없음"
fi

isolate_gpu() {
  if [[ ${STOPPED_PRODUCTION} -eq 0 ]]; then
    event "production_stop begin"
    docker stop --time 30 "${PRODUCTION_CONTAINER}" >> "${WRAPPER_LOG}" 2>&1
    STOPPED_PRODUCTION=1
  fi
  if [[ ${STOPPED_GPU_PEER} -eq 0 ]]; then
    sudo -n systemctl stop "${GPU_PEER_SERVICE}" >> "${WRAPPER_LOG}" 2>&1
    STOPPED_GPU_PEER=1
  fi
  wait_for_gpu_idle
  event "gpu_exclusive confirmed power_cap_w=160"
}

benchmark_phase() {
  local phase=$1
  local rounds=$2
  local warmups=$3
  local iterations=$4
  local completed=0
  mkdir -p "${RUN_DIR}/${phase}/benchmarks"
  for context in "${CONTEXTS[@]}"; do
    python3 "${STATE_TOOL}" context-result \
      --run-dir "${RUN_DIR}" \
      --context-bars "${context}" \
      --status running \
      --progress-percent "$((completed * 100 / 5))"
    directory="${RUN_DIR}/${phase}/benchmarks/${context}"
    mkdir -p "${directory}"
    manifest="/work/${phase}/inputs/${context}/manifest.json"
    for batch in "${BATCHES[@]}"; do
      for backend in "${BACKENDS[@]}"; do
        run_benchmark \
          "${manifest}" \
          "/work/${phase}/benchmarks/${context}/candidate-${backend}-b${batch}.json" \
          "${backend}" "${batch}" "${rounds}" "${warmups}" "${iterations}" \
          >> "${RUN_DIR}/logs/${phase}-benchmark.log" 2>&1
      done
    done
    completed=$((completed + 1))
    python3 "${STATE_TOOL}" context-result \
      --run-dir "${RUN_DIR}" \
      --context-bars "${context}" \
      --status passed \
      --progress-percent "$((completed * 100 / 5))"
  done
}

if [[ "$(step_status pilot-benchmark)" != "completed" ]]; then
  isolate_gpu
  step_start pilot-benchmark "P40를 독점하고 24시간 batch/backend pilot을 시작합니다."
  benchmark_phase pilot 1 2 5
  step_complete "5 contexts × 10 batches × 4 backend pilot 완료"
fi

if [[ "$(step_status pilot-gate)" != "completed" ]]; then
  step_start pilot-gate "VRAM·수치·origin·ETA·disk 자동 gate를 평가합니다."
  disk_free=$(df -B1 --output=avail "${RUN_DIR}" | tail -1 | tr -d ' ')
  estimated_artifact=$(python3 -c 'rows=6720; contexts=(512,1024,2048,4096,8192); inputs=sum(rows*context*5 for context in contexts); outputs=len(contexts)*rows*4*22*4; print((inputs+outputs)*2 + 2*1024**3)')
  if [[ ! -f "${RUN_DIR}/pilot/selection.json" ]]; then
    python3 "${SUMMARY_TOOL}" \
      --phase-root "${RUN_DIR}/pilot" \
      --origin-parity "${RUN_DIR}/origin-parity.json" \
      --output "${RUN_DIR}/pilot/selection.json" \
      --mode pilot \
      --disk-free-bytes "${disk_free}" \
      --estimated-artifact-bytes "${estimated_artifact}" \
      >> "${RUN_DIR}/logs/pilot-gate.log"
  fi
  python3 "${DASHBOARD_METRICS_TOOL}" \
    --selection "${RUN_DIR}/pilot/selection.json" \
    --output "${RUN_DIR}/pilot/dashboard-metrics.json"
  python3 "${STATE_TOOL}" experiment-metrics \
    --run-dir "${RUN_DIR}" \
    --json-file "${RUN_DIR}/pilot/dashboard-metrics.json"
  gate=$(python3 -c 'import json,sys; print("true" if json.load(open(sys.argv[1]))["pilot_gate"]["passed"] is True else "false")' \
    "${RUN_DIR}/pilot/selection.json")
  if [[ "${gate}" != "true" ]]; then
    echo "pilot safety gate rejected the automatic five-week sweep" >&2
    exit 2
  fi
  step_complete "모든 pilot safety gate 통과 · 자동 5주 sweep 승인"
fi

restore_gpu_services
event "gpu_services_restored_before_full_artifacts"
python3 "${STATE_TOOL}" phase --run-dir "${RUN_DIR}" --phase full

if [[ "$(step_status full-artifacts)" != "completed" ]]; then
  step_start full-artifacts "동일 6,720 origin의 5-context artifact를 생성합니다."
  mkdir -p "${RUN_DIR}/full/inputs"
  for context in "${CONTEXTS[@]}"; do
    build_artifact full "${context}" /baseline/input/fincast-input/origins.jsonl \
      >> "${RUN_DIR}/logs/full-artifacts.log"
  done
  step_complete "6,720 rows × 5 contexts · no-clobber artifact 완료"
fi

if [[ "$(step_status full-benchmark)" != "completed" ]]; then
  isolate_gpu
  step_start full-benchmark "3×(10 warmup+30 timed) full batch/backend sweep를 시작합니다."
  benchmark_phase full 3 10 30
  if [[ ! -f "${RUN_DIR}/full/selection.json" ]]; then
    python3 "${SUMMARY_TOOL}" \
      --phase-root "${RUN_DIR}/full" \
      --origin-parity "${RUN_DIR}/origin-parity.json" \
      --output "${RUN_DIR}/full/selection.json" \
      --mode full \
      >> "${RUN_DIR}/logs/full-benchmark.log"
  fi
  python3 "${DASHBOARD_METRICS_TOOL}" \
    --selection "${RUN_DIR}/full/selection.json" \
    --output "${RUN_DIR}/full/dashboard-metrics.json"
  python3 "${STATE_TOOL}" experiment-metrics \
    --run-dir "${RUN_DIR}" \
    --json-file "${RUN_DIR}/full/dashboard-metrics.json"
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["status"]=="passed"' \
    "${RUN_DIR}/full/selection.json"
  step_complete "5 contexts × 10 batches × 4 backend full sweep 완료"
fi

if [[ "$(step_status full-generation)" != "completed" ]]; then
  isolate_gpu
  step_start full-generation "선택 backend로 context별 6,720행 raw forecast를 생성합니다."
  mkdir -p "${RUN_DIR}/full/outputs"
  for context in "${CONTEXTS[@]}"; do
    batch=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contexts"][sys.argv[2]]["selected_batch_size"])' \
      "${RUN_DIR}/full/selection.json" "${context}")
    backend=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contexts"][sys.argv[2]]["selected_backend"])' \
      "${RUN_DIR}/full/selection.json" "${context}")
    output="${RUN_DIR}/full/outputs/${context}"
    resume=()
    if [[ -e "${output}" ]]; then
      resume=(--resume)
    fi
    chronos_gpu raw-generate \
      --job "/work/full/inputs/${context}/manifest.json" \
      --output "/work/full/outputs/${context}" \
      --backend "${backend}" \
      --batch-size "${batch}" \
      "${resume[@]}" \
      >> "${RUN_DIR}/logs/full-generation.log" 2>&1
  done
  step_complete "5 contexts × 6,720 raw forecast · chunk digest 검증 완료"
fi

restore_gpu_services
event "gpu_services_restored_before_accuracy_analysis"

if [[ "$(step_status accuracy-analysis)" != "completed" ]]; then
  step_start accuracy-analysis "정확도·분해·paired bootstrap·Holm 분석을 실행합니다."
  analysis_args=()
  for context in "${CONTEXTS[@]}"; do
    analysis_args+=(--context-input "${context}=${RUN_DIR}/full/inputs/${context}/manifest.json")
    analysis_args+=(--context-output "${context}=${RUN_DIR}/full/outputs/${context}/manifest.json")
  done
  python3 "${ANALYSIS_TOOL}" \
    --market-bars "${RUN_DIR}/source/market-bars.jsonl" \
    "${analysis_args[@]}" \
    --selection "${RUN_DIR}/full/selection.json" \
    --output "${RUN_DIR}/qualification-summary.json" \
    --bootstrap-iterations 5000 \
    --seed 17 \
    >> "${RUN_DIR}/logs/accuracy-analysis.log"
  step_complete "native quantile 정확도·3h/day bootstrap·Holm 분석 완료"
fi

if [[ "$(step_status finalize)" != "completed" ]]; then
  step_start finalize "accuracy-first 규칙으로 development context를 기록합니다."
  python3 "${DASHBOARD_METRICS_TOOL}" \
    --selection "${RUN_DIR}/full/selection.json" \
    --analysis "${RUN_DIR}/qualification-summary.json" \
    --output "${RUN_DIR}/dashboard-metrics.json"
  python3 "${STATE_TOOL}" experiment-metrics \
    --run-dir "${RUN_DIR}" \
    --json-file "${RUN_DIR}/dashboard-metrics.json"
  selected=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["selected_context_bars"])' \
    "${RUN_DIR}/qualification-summary.json")
  step_complete "context ${selected} 선택 · development_context_selected_holdout_pending"
fi

python3 "${STATE_TOOL}" finish \
  --run-dir "${RUN_DIR}" \
  --status completed \
  --message "Chronos-2 context qualification completed; holdout pending"
RUN_FINISHED=1
event "runner_finished status=0"
