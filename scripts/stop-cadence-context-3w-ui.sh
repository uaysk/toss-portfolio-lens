#!/usr/bin/env bash
set -Eeuo pipefail

SESSION=${CADENCE_CONTEXT_UI_SESSION:-tpl-cadence-context-ui}
CONTAINER=${CADENCE_CONTEXT_UI_CONTAINER:-tpl-cadence-context-ui}
stopped=0
if docker inspect "${CONTAINER}" >/dev/null 2>&1; then
  running=$(docker inspect -f '{{.State.Running}}' "${CONTAINER}")
  if [[ "${running}" == "true" ]]; then
    docker stop --time 20 "${CONTAINER}" >/dev/null
  fi
  echo "dashboard container stopped: ${CONTAINER}"
  stopped=1
fi
if tmux has-session -t "${SESSION}" 2>/dev/null; then
  tmux kill-session -t "${SESSION}"
  echo "dashboard stopped: ${SESSION}"
  stopped=1
fi
if [[ "${stopped}" == "0" ]]; then
  echo "dashboard is not running: ${SESSION}"
fi
