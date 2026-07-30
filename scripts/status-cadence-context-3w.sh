#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_ROOT=${CADENCE_CONTEXT_RUN_ROOT:-"${PROJECT_ROOT}/data/ai-qualification/cadence-context-3w"}
RUN_ID=${1:-$(jq -r '.runId' "${RUN_ROOT}/latest.json")}
RUN_DIR="${RUN_ROOT}/${RUN_ID}"

if [[ ! -f "${RUN_DIR}/state.json" ]]; then
  echo "state not found: ${RUN_DIR}/state.json" >&2
  exit 2
fi

container=$(cat "${RUN_DIR}/CONTAINER" 2>/dev/null || true)
if [[ -n "${container}" ]] && docker inspect "${container}" >/dev/null 2>&1; then
  docker inspect -f 'container={{.Name}} running={{.State.Running}} pid={{.State.Pid}} restartCount={{.RestartCount}}' "${container}"
else
  echo "container=unavailable"
fi
jq '{
  runId,
  status,
  phase: .experiment.phase,
  activeStepId,
  progress: .progress.percent,
  updatedAt,
  selectedPlanReady: .experiment.selectedPlanReady,
  selectedCombinationCount: .experiment.selectedCombinationCount,
  screeningPolicyVersion: .experiment.screeningPolicyVersion,
  matrix: {
    default: ([.experiment.combinations[] | select(.planRole == "default")] | length),
    conditional: ([.experiment.combinations[] | select(.planRole == "conditional")] | length),
    excluded: ([.experiment.combinations[] | select(.status == "excluded")] | length),
    dependencyFailed: ([.experiment.combinations[] | select(.status == "dependency_failed")] | length),
    followupOnly: ([.experiment.combinations[] | select(.status == "followup_only")] | length),
    failed: ([.experiment.combinations[] | select(.status == "failed")] | length)
  },
  followupCandidateIds: (.experiment.followupCandidateIds // []),
  currentCombinationId: .experiment.currentCombinationId,
  currentSymbol: .experiment.currentSymbol,
  currentOrigin: .experiment.currentOrigin
}' "${RUN_DIR}/state.json"
