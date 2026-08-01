import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createHarborRelease,
  resolveLocalHarborImage,
  serializeHarborRelease,
  writePrivateFileAtomic,
} from "./create-harbor-release.mjs";

const gitSha = "a".repeat(40);
const previousSha = "b".repeat(40);
const webDigest = "c".repeat(64);
const rustDigest = "d".repeat(64);
const previousRustDigest = "e".repeat(64);

describe("Harbor release candidate helper", () => {
  it("resolves the repository digest only when the OCI revision matches", () => {
    const reference = resolveLocalHarborImage(
      `harbor.uaysk.com/toss-portfolio-lens/web:git-${gitSha}`,
      gitSha,
      "harbor.uaysk.com/toss-portfolio-lens/web",
      () => ({
        Config: { Labels: { "org.opencontainers.image.revision": gitSha } },
        RepoDigests: [
          `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${webDigest}`,
        ],
      }),
    );
    assert.equal(
      reference,
      `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${webDigest}`,
    );
  });

  it("rejects an image built from a different revision", () => {
    assert.throws(() => resolveLocalHarborImage(
      `harbor.uaysk.com/toss-portfolio-lens/web:git-${gitSha}`,
      gitSha,
      "harbor.uaysk.com/toss-portfolio-lens/web",
      () => ({
        Config: { Labels: { "org.opencontainers.image.revision": previousSha } },
        RepoDigests: [
          `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${webDigest}`,
        ],
      }),
    ), /does not match/u);
  });

  it("reuses the current Rust digest for a web-only release", () => {
    const release = createHarborRelease({
      gitSha,
      webImage: `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${webDigest}`,
      currentRelease: {
        APP_GIT_SHA: previousSha,
        RUST_WORKER_GIT_SHA: previousSha,
        WEB_IMAGE: `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${"f".repeat(64)}`,
        RUST_WORKER_IMAGE: `harbor.uaysk.com/toss-portfolio-lens/rust-worker@sha256:${previousRustDigest}`,
      },
    });
    assert.equal(release.APP_GIT_SHA, gitSha);
    assert.equal(release.RUST_WORKER_GIT_SHA, previousSha);
    assert.match(release.RUST_WORKER_IMAGE, new RegExp(`${previousRustDigest}$`, "u"));
  });

  it("uses the release Git SHA for a newly built Rust image", () => {
    const release = createHarborRelease({
      gitSha,
      webImage: `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${webDigest}`,
      rustImage: `harbor.uaysk.com/toss-portfolio-lens/rust-worker@sha256:${rustDigest}`,
      currentRelease: undefined,
    });
    assert.equal(release.RUST_WORKER_GIT_SHA, gitSha);
  });

  it("writes an ordered mode-600 release file atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "harbor-release-test-"));
    const target = join(directory, "candidate.env");
    const release = createHarborRelease({
      gitSha,
      webImage: `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${webDigest}`,
      rustImage: `harbor.uaysk.com/toss-portfolio-lens/rust-worker@sha256:${rustDigest}`,
    });
    writePrivateFileAtomic(target, serializeHarborRelease(release));
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(target, "utf8").split("\n")[0],
      `APP_GIT_SHA=${gitSha}`,
    );
  });
});
