#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: run-fincast-p40-fp32-5week-worker.sh <absolute-run-root> <run-id> <absolute-optimization-root> <end-exclusive>" >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec "${SCRIPT_DIR}/run-fincast-p40-fp32-3week-worker.sh" "$@" 5
