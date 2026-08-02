import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHarborRelease } from "./create-harbor-release.mjs";

const DEFAULT_CANDIDATE = ".cache/release/candidate.env";
const DEFAULT_DEPLOYMENT_REPORT = ".cache/release/deployment-report.json";
const DEFAULT_OUTPUT = ".cache/release/gitlab-release.md";

export function buildGitLabReleaseNotes({
  release,
  deployment,
  commitSha,
  pipelineUrl,
}) {
  if (release.APP_GIT_SHA !== commitSha) {
    throw new Error("candidate release SHA does not match CI_COMMIT_SHA");
  }
  const deployedAt = deployment.finishedAt ?? deployment.completedAt ?? "recorded in deployment artifact";
  return [
    `# Production ${commitSha.slice(0, 12)}`,
    "",
    `- Git commit: \`${commitSha}\``,
    `- Pipeline: ${pipelineUrl}`,
    `- Deployment completed: ${deployedAt}`,
    `- Web image: \`${release.WEB_IMAGE}\``,
    `- Rust worker image: \`${release.RUST_WORKER_IMAGE}\``,
    "- Security gate: Harbor Trivy reports are attached to the production pipeline artifacts.",
    "- Rollback source: the previous digest-pinned release retained by the production release state.",
    "",
  ].join("\n");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required CI value is missing: ${name}`);
  return value;
}

function main() {
  const commitSha = requiredEnvironment("CI_COMMIT_SHA");
  if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw new Error("CI_COMMIT_SHA is invalid");
  const pipelineUrl = requiredEnvironment("CI_PIPELINE_URL");
  const candidatePath = resolve(process.env.RELEASE_CANDIDATE ?? DEFAULT_CANDIDATE);
  const deploymentPath = resolve(
    process.env.RELEASE_DEPLOYMENT_REPORT ?? DEFAULT_DEPLOYMENT_REPORT,
  );
  const outputPath = resolve(process.env.GITLAB_RELEASE_NOTES ?? DEFAULT_OUTPUT);
  const contents = buildGitLabReleaseNotes({
    release: readHarborRelease(candidatePath),
    deployment: JSON.parse(readFileSync(deploymentPath, "utf8")),
    commitSha,
    pipelineUrl,
  });
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, contents, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  console.log(`GitLab release notes written to ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
