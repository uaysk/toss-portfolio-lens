#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
set -a
source "${project_root}/.env.graphify"
set +a

exec node --import tsx "${project_root}/scripts/graphify-hybrid/mcp.ts"

