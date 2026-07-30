#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_ROOT=${CADENCE_CONTEXT_RUN_ROOT:-"${PROJECT_ROOT}/data/ai-qualification/cadence-context-3w"}
RUNTIME_DIR=${CADENCE_CONTEXT_UI_RUNTIME_DIR:-"${RUN_ROOT}/.dashboard-runtime"}
SESSION=${CADENCE_CONTEXT_UI_SESSION:-tpl-cadence-context-ui}
API_PORT=${CADENCE_CONTEXT_API_PORT:-3212}
WEB_PORT=${CADENCE_CONTEXT_WEB_PORT:-5175}
PUBLIC_URL=${CADENCE_CONTEXT_PUBLIC_URL:-http://127.0.0.1:${WEB_PORT}}
CONTAINER=${CADENCE_CONTEXT_UI_CONTAINER:-tpl-cadence-context-ui}
NODE_IMAGE=${CADENCE_CONTEXT_UI_NODE_IMAGE:-node:22.17.0-bookworm-slim}
CONFIG_LABEL=com.uaysk.toss-portfolio-lens.cadence-dashboard-config
CONFIG_FILE="${RUNTIME_DIR}/dashboard-config.sha256"
CONFIG_FINGERPRINT=$(
  printf '%s\n' \
    "project=${PROJECT_ROOT}" \
    "run_root=${RUN_ROOT}" \
    "runtime_dir=${RUNTIME_DIR}" \
    "session=${SESSION}" \
    "api_port=${API_PORT}" \
    "web_port=${WEB_PORT}" \
    "public_url=${PUBLIC_URL}" \
    "container=${CONTAINER}" \
    "node_image=${NODE_IMAGE}" \
  | sha256sum \
  | awk '{print $1}'
)

mkdir -p "${RUNTIME_DIR}"
chmod 700 "${RUNTIME_DIR}"

if docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  running=$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")
  if [[ "${running}" == "true" ]]; then
    existing_fingerprint=$(
      docker inspect -f "{{ index .Config.Labels \"${CONFIG_LABEL}\" }}" "${CONTAINER}" 2>/dev/null \
        || true
    )
    if [[ "${existing_fingerprint}" == "${CONFIG_FINGERPRINT}" ]]; then
      echo "dashboard container already running with matching configuration: ${CONTAINER}"
      exit 0
    fi
    echo "dashboard configuration changed; recreating ${CONTAINER}" >&2
    docker rm -f "${CONTAINER}" >/dev/null
  else
    docker rm "${CONTAINER}" >/dev/null
  fi
fi
if tmux has-session -t "${SESSION}" 2>/dev/null; then
  pane_dead=$(tmux display-message -pt "${SESSION}:dashboard" '#{pane_dead}' 2>/dev/null || printf 1)
  existing_fingerprint=$(sed -n '1p' "${CONFIG_FILE}" 2>/dev/null || true)
  if [[ "${pane_dead}" == "0" && "${existing_fingerprint}" == "${CONFIG_FINGERPRINT}" ]]; then
    echo "dashboard session already running with matching configuration: ${SESSION}"
    exit 0
  fi
  echo "dashboard session is stale or misconfigured; recreating ${SESSION}" >&2
  tmux kill-session -t "${SESSION}"
fi

if command -v npm >/dev/null 2>&1; then
  command=$(printf '%q ' \
    env \
    DASHBOARD_API_PORT="${API_PORT}" \
    DASHBOARD_VITE_PORT="${WEB_PORT}" \
    "${PROJECT_ROOT}/scripts/run-fincast-p40-qualification-dashboard.sh" \
    "${RUN_ROOT}" \
    "${RUNTIME_DIR}" \
    "${PUBLIC_URL}")
  tmux new-session -d -s "${SESSION}" -n dashboard "${command}"
  tmux set-option -t "${SESSION}" remain-on-exit on
  fingerprint_tmp="${CONFIG_FILE}.tmp.$$"
  printf '%s\n' "${CONFIG_FINGERPRINT}" > "${fingerprint_tmp}"
  mv "${fingerprint_tmp}" "${CONFIG_FILE}"
  printf 'session=%s\nweb=%s\napi=http://0.0.0.0:%s\n' \
    "${SESSION}" "${PUBLIC_URL}" "${API_PORT}"
  exit 0
fi

environment_file=$(readlink -f "${PROJECT_ROOT}/.env")
node_modules=$(readlink -f "${PROJECT_ROOT}/node_modules")
if [[ ! -f "${environment_file}" ]] || [[ ! -d "${node_modules}" ]]; then
  echo "dashboard environment or node_modules is unavailable" >&2
  exit 2
fi

container_id=$(docker run -d \
  --name "${CONTAINER}" \
  --label "${CONFIG_LABEL}=${CONFIG_FINGERPRINT}" \
  --label "com.uaysk.toss-portfolio-lens.cadence-dashboard-run-root=${RUN_ROOT}" \
  --restart unless-stopped \
  --network host \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:size=512m,mode=1777 \
  -e HOME=/tmp \
  -e DASHBOARD_API_PORT="${API_PORT}" \
  -e DASHBOARD_VITE_PORT="${WEB_PORT}" \
  -v "${PROJECT_ROOT}:/workspace:ro" \
  -v "${environment_file}:${environment_file}:ro" \
  -v "${node_modules}:${node_modules}" \
  -v "${RUN_ROOT}:${RUN_ROOT}:ro" \
  -v "${RUNTIME_DIR}:${RUNTIME_DIR}" \
  "${NODE_IMAGE}" \
  /workspace/scripts/run-fincast-p40-qualification-dashboard.sh \
  "${RUN_ROOT}" \
  "${RUNTIME_DIR}" \
  "${PUBLIC_URL}")
printf '%s\n' "${container_id}" > "${RUNTIME_DIR}/CONTAINER_ID"
fingerprint_tmp="${CONFIG_FILE}.tmp.$$"
printf '%s\n' "${CONFIG_FINGERPRINT}" > "${fingerprint_tmp}"
mv "${fingerprint_tmp}" "${CONFIG_FILE}"
printf 'container=%s\nweb=%s\napi=http://0.0.0.0:%s\n' \
  "${CONTAINER}" "${PUBLIC_URL}" "${API_PORT}"
