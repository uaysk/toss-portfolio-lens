#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly expected_project_id="13"
readonly expected_release_runner_id="14"
readonly expected_runtime_directory="/home/uaysk/toss-portfolio-lens"
readonly expected_state_directory="/var/lib/toss-portfolio-lens-release"
readonly expected_docker_config="/home/toss-portfolio-release/.docker"
readonly expected_release_runner_description="ubuntu-1-toss-portfolio-lens-release"
readonly buildx_builder="toss-portfolio-lens-release"
readonly harbor_registry="harbor.uaysk.com"
readonly harbor_project="toss-portfolio-lens"
readonly public_url="https://tpl.uaysk.com"
readonly minimum_available_kib="3145728"
readonly minimum_available_disk_kib="15728640"
readonly retry_delay_seconds="2"
readonly maximum_preflight_retries="3"

readonly -a preflight_artifact_stages=(
  ci-identity
  commands
  source-directory
  cache-directories
  release-paths
  release-lock
  host-memory
  docker-info
  disk-capacity
  docker-version
  buildx-version
  buildx-inspect
  buildx-driver
  buildx-bootstrap
  buildx-worker
  harbor-credential
  current-release
)

release_stage="startup"
preflight_only="false"
source_directory=""
runtime_directory=""
state_directory=""
current_release=""
candidate_release=""
preflight_artifact=""
web_tag=""
rust_tag=""
available_kib=""
source_disk_available_kib=""
docker_disk_available_kib=""
docker_root_directory=""
docker_version=""
buildx_version=""
buildx_inspect_output=""
buildx_bootstrap_output=""
builder_driver=""

set_stage() {
  case "$1" in
    argument-validation | ci-identity | source-directory | commands | cache-directories \
      | release-paths | release-lock | host-memory | docker-info | disk-capacity | docker-version \
      | buildx-version | buildx-inspect | buildx-driver | buildx-bootstrap \
      | buildx-worker | harbor-credential | current-release | preflight-artifact \
      | web-image | rust-image-decision | rust-image | candidate-release \
      | trivy-web | trivy-rust | production-deploy)
      release_stage="$1"
      ;;
    *)
      printf 'internal release error: invalid stage name\n' >&2
      return 70
      ;;
  esac
}

on_error() {
  local status="$?"
  trap - ERR
  printf 'release-production failed: stage=%s status=%s\n' "$release_stage" "$status" >&2
  exit "$status"
}

fail_check() {
  printf 'release preflight check failed: stage=%s reason=%s\n' "$release_stage" "$1" >&2
  return 1
}

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail_check "required CI value is missing: ${name}"
  fi
}

require_directory() {
  local path="$1"
  local label="$2"
  if [[ ! -d "$path" ]]; then
    fail_check "required directory is unavailable: ${label}"
  fi
}

require_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" ]]; then
    fail_check "required file is unavailable: ${label}"
  fi
}

require_mode() {
  local path="$1"
  local expected_mode="$2"
  local label="$3"
  local actual_mode

  if ! actual_mode="$(stat -c '%a' -- "$path" 2>/dev/null)"; then
    fail_check "could not read file mode: ${label}"
  fi
  if [[ "$actual_mode" != "$expected_mode" ]]; then
    fail_check "invalid mode for ${label}: expected=${expected_mode} actual=${actual_mode}"
  fi
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

retry_preflight() {
  local stage="$1"
  shift
  local retry=0
  local status=0

  set_stage "$stage"
  while true; do
    if "$@" >/dev/null 2>&1; then
      return 0
    else
      status="$?"
    fi

    if (( retry >= maximum_preflight_retries )); then
      printf 'release preflight probe failed: stage=%s status=%s retries=%s\n' \
        "$release_stage" "$status" "$retry" >&2
      return "$status"
    fi

    retry=$((retry + 1))
    printf 'release preflight probe retry: stage=%s status=%s retry=%s/%s\n' \
      "$release_stage" "$status" "$retry" "$maximum_preflight_retries" >&2
    sleep "$retry_delay_seconds"
  done
}

validate_ci_identity() {
  set_stage ci-identity
  local name
  for name in CI_PROJECT_DIR CI_PROJECT_ID CI_COMMIT_SHA CI_COMMIT_BRANCH CI_DEFAULT_BRANCH \
    CI_COMMIT_REF_PROTECTED CI_RUNNER_ID CI_RUNNER_DESCRIPTION DOCKER_CONFIG; do
    require_value "$name"
  done

  if [[ "$CI_PROJECT_ID" != "$expected_project_id" ]]; then
    fail_check "release runner rejected the GitLab project"
  fi
  if [[ "$CI_COMMIT_BRANCH" != "$CI_DEFAULT_BRANCH" \
    || "$CI_COMMIT_REF_PROTECTED" != "true" ]]; then
    fail_check "production releases require the protected default branch"
  fi
  if [[ "$CI_RUNNER_ID" != "$expected_release_runner_id" ]]; then
    fail_check "production release runner ID is not canonical"
  fi
  if [[ "$CI_RUNNER_DESCRIPTION" != "$expected_release_runner_description" ]]; then
    fail_check "production release runner description is not canonical"
  fi
  if [[ ! "$CI_COMMIT_SHA" =~ ^[a-f0-9]{40}$ ]]; then
    fail_check "CI_COMMIT_SHA must be a full lowercase Git SHA"
  fi
  if [[ "$DOCKER_CONFIG" != "$expected_docker_config" ]]; then
    fail_check "release runner must use the dedicated Harbor robot Docker config"
  fi
}

configure_release_paths() {
  set_stage source-directory
  require_directory "$CI_PROJECT_DIR" "GitLab project checkout"
  if ! source_directory="$(realpath "$CI_PROJECT_DIR")"; then
    fail_check "GitLab project checkout could not be resolved"
  fi

  runtime_directory="$expected_runtime_directory"
  state_directory="$expected_state_directory"
  current_release="$state_directory/current.env"
  candidate_release="$source_directory/.cache/release/candidate.env"
  preflight_artifact="$source_directory/.cache/release/preflight.json"
  web_tag="$harbor_registry/$harbor_project/web:git-$CI_COMMIT_SHA"
  rust_tag="$harbor_registry/$harbor_project/rust-worker:git-$CI_COMMIT_SHA"
}

require_release_commands() {
  set_stage commands
  local command
  for command in awk chmod df docker flock git mkdir node realpath sleep stat; do
    if ! command -v "$command" >/dev/null; then
      fail_check "required release command is unavailable: ${command}"
    fi
  done
}

prepare_cache_directories() {
  set_stage cache-directories
  mkdir -p "$source_directory/.cache/release" "$source_directory/.cache/security"
  chmod 700 "$source_directory/.cache/release" "$source_directory/.cache/security"
  require_directory "$source_directory/.cache/release" "release artifact directory"
  require_directory "$source_directory/.cache/security" "security artifact directory"
  require_mode "$source_directory/.cache/release" 700 "release artifact directory"
  require_mode "$source_directory/.cache/security" 700 "security artifact directory"
}

validate_release_paths() {
  set_stage release-paths
  require_directory "$runtime_directory" "production runtime directory"
  require_directory "$state_directory" "production release state directory"
  require_mode "$state_directory" 700 "production release state directory"
  require_file "$current_release" "current release manifest"
  require_mode "$current_release" 600 "current release manifest"
  require_directory "$DOCKER_CONFIG" "release Docker config directory"
  require_mode "$DOCKER_CONFIG" 700 "release Docker config directory"
  require_file "$DOCKER_CONFIG/config.json" "release Docker config"
  require_mode "$DOCKER_CONFIG/config.json" 600 "release Docker config"
}

acquire_release_lock() {
  set_stage release-lock
  exec 9>"$state_directory/release.lock"
  if ! flock -n 9; then
    fail_check "another production release owns the host lock"
  fi
}

check_host_memory() {
  set_stage host-memory
  available_kib="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
  if [[ ! "$available_kib" =~ ^[0-9]+$ || "$available_kib" -lt "$minimum_available_kib" ]]; then
    fail_check "less than 3 GiB host memory is available"
  fi
}

check_disk_capacity() {
  set_stage disk-capacity
  local source_available
  local docker_available

  if ! source_available="$(df -Pk -- "$source_directory" | awk 'NR == 2 { print $4 }')"; then
    fail_check "source checkout disk capacity could not be read"
  fi
  if [[ ! "$source_available" =~ ^[0-9]+$ ]]; then
    fail_check "source checkout disk capacity is invalid"
  fi
  if ! docker_root_directory="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"; then
    fail_check "Docker root directory could not be read"
  fi
  docker_root_directory="$(trim_whitespace "$docker_root_directory")"
  if [[ -z "$docker_root_directory" ]]; then
    fail_check "Docker root directory is empty"
  fi
  if ! docker_available="$(df -Pk -- "$docker_root_directory" | awk 'NR == 2 { print $4 }')"; then
    fail_check "Docker root disk capacity could not be read"
  fi
  if [[ ! "$docker_available" =~ ^[0-9]+$ ]]; then
    fail_check "Docker root disk capacity is invalid"
  fi
  source_disk_available_kib="$source_available"
  docker_disk_available_kib="$docker_available"
  if (( source_available < minimum_available_disk_kib )); then
    fail_check "less than 15 GiB is available for the release checkout"
  fi
  if (( docker_available < minimum_available_disk_kib )); then
    fail_check "less than 15 GiB is available for the Docker root"
  fi
}

capture_docker_version() {
  set_stage docker-version
  if ! docker_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; then
    fail_check "Docker server version could not be read"
  fi
  docker_version="$(trim_whitespace "$docker_version")"
  if [[ -z "$docker_version" ]]; then
    fail_check "Docker server version is empty"
  fi
}

capture_buildx_version() {
  set_stage buildx-version
  local output
  if ! output="$(docker buildx version 2>/dev/null)"; then
    fail_check "Docker Buildx version could not be read"
  fi
  IFS=$'\n' read -r buildx_version _ <<< "$output"
  buildx_version="$(trim_whitespace "$buildx_version")"
  if [[ -z "$buildx_version" ]]; then
    fail_check "Docker Buildx version is empty"
  fi
}

capture_buildx_inspect() {
  set_stage buildx-inspect
  if ! buildx_inspect_output="$(docker buildx inspect "$buildx_builder" 2>&1)"; then
    fail_check "the canonical Docker Buildx builder is unavailable"
  fi
}

buildx_driver_from_inspect() {
  local inspect_output="$1"
  local line
  local value
  while IFS= read -r line; do
    if [[ "$line" == Driver:* ]]; then
      value="${line#Driver:}"
      trim_whitespace "$value"
      return 0
    fi
  done <<< "$inspect_output"
  return 1
}

validate_buildx_driver() {
  set_stage buildx-driver
  if ! builder_driver="$(buildx_driver_from_inspect "$buildx_inspect_output")"; then
    fail_check "Docker Buildx inspect did not report a driver"
  fi
  if [[ "$builder_driver" != "docker-container" ]]; then
    fail_check "release Buildx builder must use the docker-container driver"
  fi
}

capture_buildx_bootstrap() {
  local output
  local status
  if output="$(docker buildx inspect "$buildx_builder" --bootstrap 2>&1)"; then
    buildx_bootstrap_output="$output"
    return 0
  else
    status="$?"
  fi
  buildx_bootstrap_output=""
  return "$status"
}

validate_buildx_workers() {
  set_stage buildx-worker
  local found="false"
  local line
  local status
  while IFS= read -r line; do
    if [[ "$line" == Status:* ]]; then
      found="true"
      status="$(trim_whitespace "${line#Status:}")"
      if [[ "$status" != "running" ]]; then
        fail_check "Docker Buildx worker is not running"
      fi
    fi
  done <<< "$buildx_bootstrap_output"
  if [[ "$found" != "true" ]]; then
    fail_check "Docker Buildx bootstrap did not report a worker status"
  fi
}

write_preflight_artifact() {
  node -e '
    const { chmodSync, writeFileSync } = require("node:fs");
    const [path, commitSha, runnerId, dockerVersion, buildxVersion, availableKiB,
      sourceDiskAvailableKiB, dockerDiskAvailableKiB, dockerRootDirectory, ...stages] = process.argv.slice(1);
    const result = {
      schema_version: "toss-portfolio-release-preflight/v1",
      commit_sha: commitSha,
      runner_id: Number(runnerId),
      versions: { docker: dockerVersion, buildx: buildxVersion },
      memory: { available_kib: Number(availableKiB) },
      disk: {
        source_available_kib: Number(sourceDiskAvailableKiB),
        docker_available_kib: Number(dockerDiskAvailableKiB),
        docker_root_directory: dockerRootDirectory,
      },
      stages: Object.fromEntries(stages.map((stage) => [stage, true])),
    };
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  ' "$preflight_artifact" "$CI_COMMIT_SHA" "$CI_RUNNER_ID" "$docker_version" \
    "$buildx_version" "$available_kib" "$source_disk_available_kib" \
    "$docker_disk_available_kib" "$docker_root_directory" "${preflight_artifact_stages[@]}"
}

run_preflight() {
  validate_ci_identity
  require_release_commands
  configure_release_paths
  cd "$source_directory"
  prepare_cache_directories
  validate_release_paths
  acquire_release_lock
  check_host_memory

  retry_preflight docker-info docker info
  check_disk_capacity
  capture_docker_version
  capture_buildx_version
  capture_buildx_inspect
  validate_buildx_driver
  retry_preflight buildx-bootstrap capture_buildx_bootstrap
  validate_buildx_workers

  set_stage harbor-credential
  node scripts/harbor-trivy-release.mjs --check-release-credential
  set_stage current-release
  node scripts/verify-harbor-release.mjs "$current_release"

  set_stage preflight-artifact
  write_preflight_artifact
  require_file "$preflight_artifact" "release preflight artifact"
  require_mode "$preflight_artifact" 600 "release preflight artifact"
  printf 'Production release preflight passed for commit %s.\n' "$CI_COMMIT_SHA"
}

ensure_image() {
  local tag="$1"
  local dockerfile="$2"
  local metadata_file="$3"
  if docker buildx imagetools inspect "$tag" >/dev/null 2>&1; then
    printf 'Reusing immutable Harbor image tag: %s\n' "$tag"
  else
    docker buildx build \
      --builder "$buildx_builder" \
      --file "$dockerfile" \
      --target runtime \
      --build-arg "APP_GIT_SHA=$CI_COMMIT_SHA" \
      --tag "$tag" \
      --push \
      --provenance=mode=min \
      --sbom=true \
      --resource memory=4g \
      --metadata-file "$metadata_file" \
      "$source_directory"
  fi
  docker pull "$tag"
}

run_release() {
  set_stage web-image
  ensure_image "$web_tag" "$source_directory/Dockerfile" \
    "$source_directory/.cache/release/web-build-metadata.json"

  set_stage rust-image-decision
  local current_rust_sha
  local build_rust="true"
  current_rust_sha="$(node scripts/create-harbor-release.mjs read \
    "$current_release" RUST_WORKER_GIT_SHA)"
  if git cat-file -e "${current_rust_sha}^{commit}" 2>/dev/null \
    && git diff --quiet "$current_rust_sha" "$CI_COMMIT_SHA" -- \
      Dockerfile.worker.rust worker/rust; then
    build_rust="false"
  fi

  local -a create_arguments=(
    create
    --current "$current_release"
    --git-sha "$CI_COMMIT_SHA"
    --web-tag "$web_tag"
    --output "$candidate_release"
  )
  if [[ "$build_rust" == "true" ]]; then
    set_stage rust-image
    ensure_image "$rust_tag" "$source_directory/Dockerfile.worker.rust" \
      "$source_directory/.cache/release/rust-build-metadata.json"
    create_arguments+=(--rust-tag "$rust_tag")
  else
    printf 'Rust sources are unchanged; retaining the deployed Rust digest.\n'
  fi

  set_stage candidate-release
  node scripts/create-harbor-release.mjs "${create_arguments[@]}"
  node scripts/verify-harbor-release.mjs "$candidate_release"

  local web_image
  local rust_image
  web_image="$(node scripts/create-harbor-release.mjs read "$candidate_release" WEB_IMAGE)"
  rust_image="$(node scripts/create-harbor-release.mjs read "$candidate_release" RUST_WORKER_IMAGE)"

  set_stage trivy-web
  node scripts/harbor-trivy-release.mjs "$web_image" \
    --output "$source_directory/.cache/security/harbor-trivy-web.json"
  set_stage trivy-rust
  node scripts/harbor-trivy-release.mjs "$rust_image" \
    --output "$source_directory/.cache/security/harbor-trivy-rust-worker.json"

  set_stage production-deploy
  node scripts/deploy-harbor-release.mjs \
    --source-dir "$source_directory" \
    --runtime-dir "$runtime_directory" \
    --state-dir "$state_directory" \
    --candidate "$candidate_release" \
    --expected-git-sha "$CI_COMMIT_SHA" \
    --public-url "$public_url" \
    --health-timeout-ms 180000 \
    --report "$source_directory/.cache/release/deployment-report.json"
}

parse_arguments() {
  set_stage argument-validation
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi
  if [[ "$#" -eq 1 && "$1" == "--preflight-only" ]]; then
    preflight_only="true"
    return 0
  fi
  fail_check "usage: ci-release-production.sh [--preflight-only]"
}

main() {
  trap on_error ERR
  parse_arguments "$@"
  run_preflight
  if [[ "$preflight_only" == "true" ]]; then
    printf 'Preflight-only mode completed; build, push, scan, and deploy were not run.\n'
    return 0
  fi
  run_release
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
