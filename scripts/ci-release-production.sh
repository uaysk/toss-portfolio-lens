#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly expected_project_id="13"
readonly expected_release_tag="toss-portfolio-lens-release"
readonly expected_runtime_directory="/home/uaysk/toss-portfolio-lens"
readonly expected_state_directory="/var/lib/toss-portfolio-lens-release"
readonly expected_docker_config="/home/toss-portfolio-release/.docker"
readonly expected_release_runner_description="ubuntu-1-toss-portfolio-lens-release"
readonly buildx_builder="toss-portfolio-lens-release"
readonly harbor_registry="harbor.uaysk.com"
readonly harbor_project="toss-portfolio-lens"
readonly public_url="https://tpl.uaysk.com"
readonly minimum_available_kib="3145728"

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "required CI value is missing: ${name}" >&2
    exit 1
  fi
}

for name in CI_PROJECT_DIR CI_PROJECT_ID CI_COMMIT_SHA CI_COMMIT_BRANCH CI_DEFAULT_BRANCH \
  CI_COMMIT_REF_PROTECTED DOCKER_CONFIG; do
  require_value "$name"
done

if [[ "$CI_PROJECT_ID" != "$expected_project_id" ]]; then
  echo "release runner rejected project ${CI_PROJECT_ID}" >&2
  exit 1
fi
if [[ "$CI_COMMIT_BRANCH" != "$CI_DEFAULT_BRANCH" || "$CI_COMMIT_REF_PROTECTED" != "true" ]]; then
  echo "production releases require the protected default branch" >&2
  exit 1
fi
# GitLab normally exposes CI_RUNNER_TAGS as a JSON-style array (for example
# ["release","docker"]), while older runners used comma-separated values.
# The dedicated shell runner currently does not expose that predefined value,
# so its immutable description is the fallback identity check. Normalize only
# JSON punctuation and whitespace, then match a complete comma-delimited token
# so a similarly prefixed tag cannot satisfy the boundary.
if [[ -n "${CI_RUNNER_TAGS:-}" ]]; then
  normalized_runner_tags="${CI_RUNNER_TAGS//\"/}"
  normalized_runner_tags="${normalized_runner_tags//\[/}"
  normalized_runner_tags="${normalized_runner_tags//\]/}"
  normalized_runner_tags="${normalized_runner_tags//[[:space:]]/}"
  if [[ ",$normalized_runner_tags," != *",${expected_release_tag},"* ]]; then
    echo "production release runner tag is missing" >&2
    exit 1
  fi
else
  if [[ "${CI_RUNNER_DESCRIPTION:-}" != "$expected_release_runner_description" ]]; then
    echo "production release runner tag metadata is unavailable and runner description is not canonical" >&2
    exit 1
  fi
  echo "CI_RUNNER_TAGS unavailable; validated canonical release runner description"
fi
if [[ ! "$CI_COMMIT_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo "CI_COMMIT_SHA must be a full lowercase Git SHA" >&2
  exit 1
fi
if [[ "$DOCKER_CONFIG" != "$expected_docker_config" ]]; then
  echo "release runner must use the dedicated Harbor robot Docker config" >&2
  exit 1
fi

readonly source_directory="$(realpath "$CI_PROJECT_DIR")"
readonly runtime_directory="$expected_runtime_directory"
readonly state_directory="$expected_state_directory"
readonly current_release="$state_directory/current.env"
readonly candidate_release="$source_directory/.cache/release/candidate.env"
readonly web_tag="$harbor_registry/$harbor_project/web:git-$CI_COMMIT_SHA"
readonly rust_tag="$harbor_registry/$harbor_project/rust-worker:git-$CI_COMMIT_SHA"

cd "$source_directory"

for command in docker git node flock realpath; do
  command -v "$command" >/dev/null || {
    echo "required release command is unavailable: $command" >&2
    exit 1
  }
done

mkdir -p "$source_directory/.cache/release" "$source_directory/.cache/security"
chmod 700 "$source_directory/.cache/release" "$source_directory/.cache/security"
test -d "$runtime_directory"
test -d "$state_directory"
test -f "$current_release"
test -f "$DOCKER_CONFIG/config.json"
test "$(stat -c '%a' "$DOCKER_CONFIG")" = "700"
test "$(stat -c '%a' "$DOCKER_CONFIG/config.json")" = "600"

exec 9>"$state_directory/release.lock"
if ! flock -n 9; then
  echo "another production release owns the host lock" >&2
  exit 1
fi

available_kib="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
if [[ ! "$available_kib" =~ ^[0-9]+$ || "$available_kib" -lt "$minimum_available_kib" ]]; then
  echo "release blocked: less than 3 GiB host memory is available" >&2
  exit 1
fi

docker info >/dev/null

if ! docker buildx inspect "$buildx_builder" >/dev/null 2>&1; then
  docker buildx create \
    --name "$buildx_builder" \
    --driver docker-container >/dev/null
fi
builder_driver="$(docker buildx inspect "$buildx_builder" \
  | awk '/^Driver:/ { print $2; exit }')"
if [[ "$builder_driver" != "docker-container" ]]; then
  echo "release Buildx builder must use the docker-container driver" >&2
  exit 1
fi
docker buildx inspect "$buildx_builder" --bootstrap >/dev/null

node scripts/harbor-trivy-release.mjs --check-release-credential
node scripts/verify-harbor-release.mjs "$current_release"

ensure_image() {
  local tag="$1"
  local dockerfile="$2"
  local metadata_file="$3"
  if docker buildx imagetools inspect "$tag" >/dev/null 2>&1; then
    echo "Reusing immutable Harbor image tag: $tag"
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

ensure_image "$web_tag" "$source_directory/Dockerfile" \
  "$source_directory/.cache/release/web-build-metadata.json"

current_rust_sha="$(node scripts/create-harbor-release.mjs read \
  "$current_release" RUST_WORKER_GIT_SHA)"
build_rust="true"
if git cat-file -e "${current_rust_sha}^{commit}" 2>/dev/null \
  && git diff --quiet "$current_rust_sha" "$CI_COMMIT_SHA" -- \
    Dockerfile.worker.rust worker/rust; then
  build_rust="false"
fi

create_arguments=(
  create
  --current "$current_release"
  --git-sha "$CI_COMMIT_SHA"
  --web-tag "$web_tag"
  --output "$candidate_release"
)
if [[ "$build_rust" == "true" ]]; then
  ensure_image "$rust_tag" "$source_directory/Dockerfile.worker.rust" \
    "$source_directory/.cache/release/rust-build-metadata.json"
  create_arguments+=(--rust-tag "$rust_tag")
else
  echo "Rust sources are unchanged; retaining the deployed Rust digest."
fi

node scripts/create-harbor-release.mjs "${create_arguments[@]}"
node scripts/verify-harbor-release.mjs "$candidate_release"

web_image="$(node scripts/create-harbor-release.mjs read "$candidate_release" WEB_IMAGE)"
rust_image="$(node scripts/create-harbor-release.mjs read "$candidate_release" RUST_WORKER_IMAGE)"

node scripts/harbor-trivy-release.mjs "$web_image" \
  --output "$source_directory/.cache/security/harbor-trivy-web.json"
node scripts/harbor-trivy-release.mjs "$rust_image" \
  --output "$source_directory/.cache/security/harbor-trivy-rust-worker.json"

node scripts/deploy-harbor-release.mjs \
  --source-dir "$source_directory" \
  --runtime-dir "$runtime_directory" \
  --state-dir "$state_directory" \
  --candidate "$candidate_release" \
  --expected-git-sha "$CI_COMMIT_SHA" \
  --public-url "$public_url" \
  --health-timeout-ms 180000 \
  --report "$source_directory/.cache/release/deployment-report.json"
