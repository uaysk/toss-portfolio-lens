#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: run-fincast-p40-qualification-dashboard.sh <absolute-run-root> <absolute-runtime-directory> <public-url>" >&2
  exit 2
fi

RUN_ROOT=$1
RUNTIME_DIRECTORY=$2
PUBLIC_URL=$3
DASHBOARD_API_PORT=${DASHBOARD_API_PORT:-3200}
DASHBOARD_VITE_PORT=${DASHBOARD_VITE_PORT:-5173}
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ "${RUN_ROOT}" != /* ]] \
  || [[ "${RUNTIME_DIRECTORY}" != /* ]] \
  || [[ ! "${DASHBOARD_API_PORT}" =~ ^[0-9]+$ ]] \
  || [[ ! "${DASHBOARD_VITE_PORT}" =~ ^[0-9]+$ ]] \
  || [[ ! "${PUBLIC_URL}" =~ ^http://[A-Za-z0-9.:-]+$ ]]; then
  echo "dashboard arguments are invalid" >&2
  exit 2
fi

mkdir -p "${RUN_ROOT}" "${RUNTIME_DIRECTORY}"
chmod 700 "${RUNTIME_DIRECTORY}"
cd "${REPO_ROOT}"

NPM_BIN=${NPM_BIN:-}
if [[ -z "${NPM_BIN}" ]]; then
  NPM_BIN=$(command -v npm 2>/dev/null || true)
fi
if [[ -z "${NPM_BIN}" ]] && [[ -x "${HOME}/.volta/bin/npm" ]]; then
  NPM_BIN="${HOME}/.volta/bin/npm"
fi
if [[ -z "${NPM_BIN}" ]] || [[ ! -x "${NPM_BIN}" ]]; then
  echo "npm executable is unavailable" >&2
  exit 127
fi
NPM_DIRECTORY=$(dirname "${NPM_BIN}")

set -a
source "${REPO_ROOT}/.env"
set +a

exec env \
  PATH="${NPM_DIRECTORY}:${PATH}" \
  HOST=0.0.0.0 \
  PORT="${DASHBOARD_API_PORT}" \
  API_PORT="${DASHBOARD_API_PORT}" \
  VITE_PORT="${DASHBOARD_VITE_PORT}" \
  NODE_ENV=development \
  PUBLIC_APP_URL="${PUBLIC_URL}" \
  DB_PROVIDER=sqlite \
  DATABASE_PATH="${RUNTIME_DIRECTORY}/fincast-fp32-3week-dashboard.sqlite" \
  AI_QUALIFICATION_RUN_ROOT="${RUN_ROOT}" \
  "${NPM_BIN}" run dev:legacy
