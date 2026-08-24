import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const scriptPath = resolve("scripts/ci-release-production.sh");
const repositoryRoot = resolve(".");
const temporaryDirectories = [];
const fullSha = "a".repeat(40);
const canonicalDockerConfig = "/home/toss-portfolio-release/.docker";

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "tpl-release-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function baseCiEnvironment(overrides = {}) {
  return {
    ...process.env,
    CI_PROJECT_DIR: repositoryRoot,
    CI_PROJECT_ID: "13",
    CI_COMMIT_SHA: fullSha,
    CI_COMMIT_BRANCH: "main",
    CI_DEFAULT_BRANCH: "main",
    CI_COMMIT_REF_PROTECTED: "true",
    CI_RUNNER_ID: "14",
    CI_RUNNER_DESCRIPTION: "ubuntu-1-toss-portfolio-lens-release",
    CI_RUNNER_TAGS: "[\"untrusted-test-value\"]",
    DOCKER_CONFIG: canonicalDockerConfig,
    ...overrides,
  };
}

function runSourced(body, {
  arguments: arguments_ = [],
  environment = baseCiEnvironment(),
} = {}) {
  return spawnSync(
    "bash",
    ["-c", `source "$1"\nshift\n${body}`, "bash", scriptPath, ...arguments_],
    { encoding: "utf8", env: environment },
  );
}

function assertRejected(result, message) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, message);
}

describe("production CI release entrypoint", () => {
  it("has valid Bash syntax and explicit fail-closed release guards", () => {
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const source = readFileSync(scriptPath, "utf8");
    assert.match(source, /trap on_error ERR/u);
    assert.match(source, /expected_release_runner_id="14"/u);
    assert.match(source, /ubuntu-1-toss-portfolio-lens-release/u);
    assert.match(source, /toss-portfolio-release-preflight\/v1/u);
    assert.match(source, /--resource memory=4g/u);
    assert.match(source, /minimum_available_disk_kib="15728640"/u);
    assert.match(source, /check_disk_capacity/u);
    assert.match(source, /docker_root_directory/u);
    assert.match(source, /harbor-trivy-release\.mjs/u);
    assert.match(source, /deploy-harbor-release\.mjs/u);
    assert.doesNotMatch(source, /CI_RUNNER_TAGS/u);
    assert.doesNotMatch(source, /docker buildx create/u);
    assert.doesNotMatch(source, /awk[^\n]*Driver:[^\n]*exit/u);
    assert.doesNotMatch(source, /fincast-worker|chronos2-worker|nvidia|cuda/iu);
  });

  it("makes the published runtime depend on the production module smoke check", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const runtimeSmoke = readFileSync("scripts/verify-runtime-modules.mjs", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    assert.match(dockerfile, /find dist\/server -type f -name '\*\.d\.ts' -delete/u);
    assert.match(dockerfile, /^RUN npm prune --omit=dev --no-audit --no-fund \\/mu);
    assert.match(dockerfile, /-name '\*\.d\.mts' -o -name '\*\.d\.cts'/u);
    assert.match(dockerfile, /apk add --no-cache ca-certificates icu-data-full libstdc\+\+ nodejs/u);
    assert.match(dockerfile, /process\.versions\.node\.split\("\."\)\[0\].*= "22"/u);
    assert.doesNotMatch(dockerfile, /^FROM deps AS node-runtime$/mu);
    assert.doesNotMatch(dockerfile, /binutils|strip --strip-unneeded/u);
    assert.doesNotMatch(dockerfile, /^COPY --from=node-runtime/mu);
    assert.match(dockerfile, /^FROM runtime-base AS runtime-verify$/mu);
    assert.match(dockerfile, /^RUN node scripts\/verify-runtime-modules\.mjs$/mu);
    assert.match(dockerfile, /^FROM runtime-verify AS runtime$/mu);
    assert.doesNotMatch(dockerfile, /^FROM runtime-base AS runtime$/mu);
    for (const dependency of Object.keys(packageJson.dependencies)) {
      const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      assert.match(runtimeSmoke, new RegExp(`["']${escaped}(?:/[^"']*)?["']`, "u"));
    }
  });

  it("wires a separate protected-main preflight without a CI-level Docker config", () => {
    const source = readFileSync(".gitlab-ci.yml", "utf8");
    assert.match(source, /\n  - release-preflight\n  - release\n/u);
    assert.match(source, /release-preflight:\n  stage: release-preflight/u);
    assert.match(
      source,
      /bash scripts\/ci-release-production\.sh --preflight-only/u,
    );
    assert.match(source, /\.cache\/release\/preflight\.json/u);
    assert.doesNotMatch(source, /^\s*DOCKER_CONFIG:/gmu);
  });

  it("accepts only the canonical protected-main project and runner identity", () => {
    const result = runSourced("validate_ci_identity");
    assert.equal(result.status, 0, result.stderr);
  });

  for (const testCase of [
    {
      name: "project",
      environment: { CI_PROJECT_ID: "99" },
      message: /stage=ci-identity reason=release runner rejected the GitLab project/u,
    },
    {
      name: "branch",
      environment: { CI_COMMIT_BRANCH: "feature/release" },
      message: /stage=ci-identity reason=production releases require the protected default branch/u,
    },
    {
      name: "protected ref",
      environment: { CI_COMMIT_REF_PROTECTED: "false" },
      message: /stage=ci-identity reason=production releases require the protected default branch/u,
    },
    {
      name: "runner ID",
      environment: { CI_RUNNER_ID: "15" },
      message: /stage=ci-identity reason=production release runner ID is not canonical/u,
    },
    {
      name: "runner description",
      environment: { CI_RUNNER_DESCRIPTION: "similarly-named-release-runner" },
      message: /stage=ci-identity reason=production release runner description is not canonical/u,
    },
    {
      name: "Docker config",
      environment: { DOCKER_CONFIG: "/tmp/not-the-release-config" },
      message: /stage=ci-identity reason=release runner must use the dedicated Harbor robot Docker config/u,
    },
  ]) {
    it(`rejects a non-canonical ${testCase.name}`, () => {
      const result = runSourced("validate_ci_identity", {
        environment: baseCiEnvironment(testCase.environment),
      });
      assertRejected(result, testCase.message);
    });
  }

  it("rejects missing release paths with a named check", () => {
    const root = temporaryDirectory();
    const runtime = join(root, "missing-runtime");
    const state = join(root, "state");
    const dockerConfig = join(root, "docker");
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(dockerConfig, { mode: 0o700 });

    const result = runSourced(
      "runtime_directory=\"$1\"; state_directory=\"$2\"; current_release=\"$3\"; "
        + "DOCKER_CONFIG=\"$4\"; validate_release_paths",
      {
        arguments: [runtime, state, join(state, "current.env"), dockerConfig],
      },
    );
    assertRejected(
      result,
      /stage=release-paths reason=required directory is unavailable: production runtime directory/u,
    );
  });

  it("rejects state, manifest, and Docker config mode mismatches", () => {
    const cases = [
      ["state directory", "state", 0o755, /production release state directory/u],
      ["current manifest", "manifest", 0o644, /current release manifest/u],
      ["Docker config directory", "docker-directory", 0o755, /release Docker config directory/u],
      ["Docker config file", "docker-file", 0o644, /release Docker config:/u],
    ];

    for (const [label, target, mode, expectedMessage] of cases) {
      const root = temporaryDirectory();
      const runtime = join(root, "runtime");
      const state = join(root, "state");
      const current = join(state, "current.env");
      const dockerConfig = join(root, "docker");
      const dockerConfigFile = join(dockerConfig, "config.json");
      mkdirSync(runtime, { mode: 0o755 });
      mkdirSync(state, { mode: 0o700 });
      mkdirSync(dockerConfig, { mode: 0o700 });
      writeFileSync(current, "APP_GIT_SHA=test\n", { mode: 0o600 });
      writeFileSync(dockerConfigFile, "{}\n", { mode: 0o600 });

      if (target === "state") chmodSync(state, mode);
      if (target === "manifest") chmodSync(current, mode);
      if (target === "docker-directory") chmodSync(dockerConfig, mode);
      if (target === "docker-file") chmodSync(dockerConfigFile, mode);

      const result = runSourced(
        "runtime_directory=\"$1\"; state_directory=\"$2\"; current_release=\"$3\"; "
          + "DOCKER_CONFIG=\"$4\"; validate_release_paths",
        { arguments: [runtime, state, current, dockerConfig] },
      );
      assertRejected(result, /stage=release-paths reason=invalid mode/u);
      assert.match(result.stderr, expectedMessage, label);
    }
  });

  for (const stage of ["docker-info", "buildx-bootstrap"]) {
    it(`retries status 255 three times for ${stage} and reports the exact stage`, () => {
      const result = runSourced(
        "attempts=0\n"
          + "probe() { attempts=$((attempts + 1)); return 255; }\n"
          + "sleep() { :; }\n"
          + `if retry_preflight ${stage} probe; then status=0; else status=$?; fi\n`
          + "printf 'attempts=%s\\n' \"$attempts\"\n"
          + "exit \"$status\"",
      );
      assert.equal(result.status, 255);
      assert.match(result.stdout, /attempts=4/u);
      assert.equal((result.stderr.match(/release preflight probe retry:/gu) ?? []).length, 3);
      assert.match(
        result.stderr,
        new RegExp(`release preflight probe failed: stage=${stage} status=255 retries=3`, "u"),
      );
    });
  }

  it("rejects a canonical builder that uses the wrong driver", () => {
    const inspect = "Name: toss-portfolio-lens-release\nDriver: docker\nStatus: running\n";
    const result = runSourced(
      "buildx_inspect_output=\"$1\"; validate_buildx_driver",
      { arguments: [inspect] },
    );
    assertRejected(
      result,
      /stage=buildx-driver reason=release Buildx builder must use the docker-container driver/u,
    );
  });

  it("rejects release disk capacity below the explicit 15 GiB floor", () => {
    const result = runSourced(
      "source_directory=/tmp\n"
        + "df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev 100 90 1000 90%% /\\n'; }\n"
        + "docker() { printf '/var/lib/docker\\n'; }\n"
        + "check_disk_capacity",
    );
    assertRejected(
      result,
      /stage=disk-capacity reason=less than 15 GiB is available for the release checkout/u,
    );
  });

  it("accepts a fully collected docker-container inspect result with a running worker", () => {
    const inspect = "Name: toss-portfolio-lens-release\nDriver: docker-container\nStatus: running\n";
    const result = runSourced(
      "buildx_inspect_output=\"$1\"; validate_buildx_driver; "
        + "buildx_bootstrap_output=\"$1\"; validate_buildx_workers",
      { arguments: [inspect] },
    );
    assert.equal(result.status, 0, result.stderr);
  });

  it("preflight-only mode cannot enter build, push, scan, or deploy orchestration", () => {
    const result = runSourced(
      "run_preflight() { printf 'preflight-called\\n'; }\n"
        + "run_release() { printf 'release-called\\n'; }\n"
        + "main --preflight-only",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /preflight-called/u);
    assert.match(result.stdout, /build, push, scan, and deploy were not run/u);
    assert.doesNotMatch(result.stdout, /release-called/u);
  });

  it("the ERR trap preserves status 255 and emits the fixed failing stage", () => {
    const result = runSourced(
      "run_preflight() { set_stage docker-info; return 255; }\n"
        + "main --preflight-only",
    );
    assert.equal(result.status, 255);
    assert.match(
      result.stderr,
      /^release-production failed: stage=docker-info status=255\n$/u,
    );
  });

  it("writes only the allowlisted non-credential preflight fields at mode 600", () => {
    const root = temporaryDirectory();
    const artifact = join(root, "preflight.json");
    const sentinel = "credential-sentinel-do-not-emit";
    const result = runSourced(
      "preflight_artifact=\"$1\"\n"
        + "docker_version='28.3.3'\n"
        + "buildx_version='github.com/docker/buildx v0.25.0'\n"
        + "available_kib='4194304'\n"
        + "source_disk_available_kib='20971520'\n"
        + "docker_disk_available_kib='18874368'\n"
        + "docker_root_directory='/var/lib/docker'\n"
        + "write_preflight_artifact",
      {
        arguments: [artifact],
        environment: baseCiEnvironment({
          HARBOR_ROBOT_SECRET: sentinel,
          TEST_BEARER_VALUE: sentinel,
        }),
      },
    );
    assert.equal(result.status, 0, result.stderr);

    const raw = readFileSync(artifact, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed), [
      "schema_version",
      "commit_sha",
      "runner_id",
      "versions",
      "memory",
      "disk",
      "stages",
    ]);
    assert.equal(parsed.schema_version, "toss-portfolio-release-preflight/v1");
    assert.equal(parsed.commit_sha, fullSha);
    assert.equal(parsed.runner_id, 14);
    assert.equal(parsed.versions.docker, "28.3.3");
    assert.equal(parsed.memory.available_kib, 4_194_304);
    assert.equal(parsed.disk.source_available_kib, 20_971_520);
    assert.equal(parsed.disk.docker_available_kib, 18_874_368);
    assert.equal(parsed.disk.docker_root_directory, "/var/lib/docker");
    assert.ok(Object.values(parsed.stages).every((value) => value === true));
    assert.equal(statSync(artifact).mode & 0o777, 0o600);
    assert.doesNotMatch(raw, new RegExp(sentinel, "u"));
    assert.doesNotMatch(raw, /DOCKER_CONFIG|Authorization|Bearer|robot\$/iu);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel, "u"));
  });
});
