import assert from "node:assert/strict";
import test from "node:test";
import { buildGitLabReleaseNotes } from "./create-gitlab-release-notes.mjs";

const sha = "a".repeat(40);

test("builds release notes from digest-pinned images without credentials", () => {
  const notes = buildGitLabReleaseNotes({
    release: {
      APP_GIT_SHA: sha,
      WEB_IMAGE: `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${"b".repeat(64)}`,
      RUST_WORKER_IMAGE: `harbor.uaysk.com/toss-portfolio-lens/rust-worker@sha256:${"c".repeat(64)}`,
    },
    deployment: { finishedAt: "2026-08-02T12:00:00Z" },
    commitSha: sha,
    pipelineUrl: "https://gitlab.example/pipelines/1",
  });
  assert.match(notes, /Production a{12}/u);
  assert.match(notes, /web@sha256:b{64}/u);
  assert.match(notes, /pipelines\/1/u);
});

test("rejects release notes for a different commit", () => {
  assert.throws(() => buildGitLabReleaseNotes({
    release: { APP_GIT_SHA: "b".repeat(40) },
    deployment: {},
    commitSha: sha,
    pipelineUrl: "https://gitlab.example/pipelines/1",
  }), /does not match/u);
});
