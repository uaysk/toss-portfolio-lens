#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <source-root> <baseline-run> <context-run> <output-run>" >&2
  exit 2
fi

SOURCE_ROOT=$1
BASELINE_RUN=$2
CONTEXT_RUN=$3
OUTPUT_RUN=$4
CHRONOS_IMAGE=toss-portfolio-lens-chronos2-worker:chronos2-2.3.1-p40
NODE_IMAGE=node:22.17.0-bookworm-slim
HOST_UID=$(id -u)
HOST_GID=$(id -g)
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STARTED_SECONDS=$(date +%s)

if [[ "${SOURCE_ROOT}" != /* ]] \
  || [[ "${BASELINE_RUN}" != /* ]] \
  || [[ "${CONTEXT_RUN}" != /* ]] \
  || [[ "${OUTPUT_RUN}" != /* ]] \
  || [[ ! -f "${SOURCE_ROOT}/scripts/convert-chronos2-output-to-policy-artifact.py" ]] \
  || [[ ! -f "${SOURCE_ROOT}/qualification-tools/compare-fincast-policy.mjs" ]] \
  || [[ ! -f "${BASELINE_RUN}/input/fincast-input/manifest.json" ]] \
  || [[ ! -f "${BASELINE_RUN}/input/market-manifest.json" ]] \
  || [[ ! -f "${BASELINE_RUN}/outputs/fincast/manifest.json" ]] \
  || [[ ! -f "${CONTEXT_RUN}/full/inputs/1024/manifest.json" ]] \
  || [[ ! -f "${CONTEXT_RUN}/full/outputs/1024/manifest.json" ]]; then
  echo "absolute paths or qualification inputs are invalid" >&2
  exit 2
fi

if [[ -e "${OUTPUT_RUN}" ]]; then
  echo "output run already exists: ${OUTPUT_RUN}" >&2
  exit 2
fi

mkdir -m 700 "${OUTPUT_RUN}"
mkdir -m 700 \
  "${OUTPUT_RUN}/policy" \
  "${OUTPUT_RUN}/comparisons" \
  "${OUTPUT_RUN}/details" \
  "${OUTPUT_RUN}/logs"

write_state() {
  local status=$1
  local finished_at=${2:-}
  local elapsed_seconds=${3:-0}
  jq -n \
    --arg schema_version "chronos2-1024-policy-replay/v1" \
    --arg status "${status}" \
    --arg started_at "${STARTED_AT}" \
    --arg finished_at "${finished_at}" \
    --arg source_root "${SOURCE_ROOT}" \
    --arg baseline_run "${BASELINE_RUN}" \
    --arg context_run "${CONTEXT_RUN}" \
    --argjson elapsed_seconds "${elapsed_seconds}" \
    '{
      schema_version: $schema_version,
      status: $status,
      started_at: $started_at,
      finished_at: (if $finished_at == "" then null else $finished_at end),
      elapsed_seconds: $elapsed_seconds,
      context_bars: 1024,
      scored_rows: 6720,
      source_root: $source_root,
      baseline_run: $baseline_run,
      context_run: $context_run,
      prediction_reused: true,
      model_inference_performed: false,
      policy_semantics: "existing-fixed-policy-and-thresholds"
    }' > "${OUTPUT_RUN}/state.json"
}

on_error() {
  local exit_code=$?
  local finished_at
  local finished_seconds
  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  finished_seconds=$(date +%s)
  write_state "failed" "${finished_at}" "$((finished_seconds - STARTED_SECONDS))"
  exit "${exit_code}"
}
trap on_error ERR
write_state "running"

docker run --rm \
  --user "${HOST_UID}:${HOST_GID}" \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --entrypoint /app/.venv/bin/python \
  -v "${SOURCE_ROOT}/scripts:/app/scripts:ro" \
  -v "${BASELINE_RUN}:/baseline:ro" \
  -v "${CONTEXT_RUN}:/context:ro" \
  -v "${OUTPUT_RUN}:/work" \
  "${CHRONOS_IMAGE}" \
  /app/scripts/convert-chronos2-output-to-policy-artifact.py \
    --fincast-input /baseline/input/fincast-input/manifest.json \
    --chronos-input /context/full/inputs/1024/manifest.json \
    --chronos-output /context/full/outputs/1024 \
    --output /work/policy \
  > "${OUTPUT_RUN}/logs/projection.log" 2>&1

docker run --rm \
  --user "${HOST_UID}:${HOST_GID}" \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  -v "${SOURCE_ROOT}/qualification-tools:/tools:ro" \
  -v "${BASELINE_RUN}:/baseline:ro" \
  -v "${CONTEXT_RUN}:/context:ro" \
  -v "${OUTPUT_RUN}:/work" \
  "${NODE_IMAGE}" \
  node /tools/compare-fincast-policy.mjs \
    --job /baseline/input/fincast-input/manifest.json \
    --reference /baseline/outputs/fincast \
    --candidate /work/policy \
    --market-data /baseline/input/market-manifest.json \
    --output /work/comparisons/chronos2-1024-vs-fincast.json \
    --margins-output /work/details/chronos2-1024-threshold-margins.jsonl \
    --details-output /work/details/chronos2-1024-comparison-details.jsonl \
  > "${OUTPUT_RUN}/logs/policy-replay.log" 2>&1

find "${OUTPUT_RUN}" -type f \
  ! -name artifact-digests.sha256 \
  ! -name state.json \
  -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  > "${OUTPUT_RUN}/artifact-digests.sha256"

FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FINISHED_SECONDS=$(date +%s)
write_state "completed" "${FINISHED_AT}" "$((FINISHED_SECONDS - STARTED_SECONDS))"
trap - ERR

echo "${OUTPUT_RUN}"
