import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertHarborApiUrl,
  isHarborRobotUsername,
  parseHarborImageReference,
  releaseBlockingVulnerabilities,
  summarizeVulnerabilityReport,
} from "./harbor-trivy-release.mjs";

describe("Harbor Trivy release helper", () => {
  it("accepts only Harbor robot usernames for the release boundary", () => {
    assert.equal(isHarborRobotUsername("robot$toss-portfolio-lens+gitlab-release"), true);
    assert.equal(isHarborRobotUsername("admin"), false);
    assert.equal(isHarborRobotUsername("robot$"), false);
  });

  it("parses digest-pinned and tagged project images", () => {
    const digest = "a".repeat(64);
    assert.deepEqual(
      parseHarborImageReference(
        `harbor.uaysk.com/toss-portfolio-lens/web@sha256:${digest}`,
      ),
      {
        registry: "harbor.uaysk.com",
        project: "toss-portfolio-lens",
        repository: "web",
        reference: `sha256:${digest}`,
      },
    );
    assert.equal(
      parseHarborImageReference(
        "harbor.uaysk.com/toss-portfolio-lens/rust-worker:git-123",
      ).reference,
      "git-123",
    );
  });

  it("rejects non-Harbor and unqualified references", () => {
    assert.throws(() => parseHarborImageReference("example.com/project/web:latest"));
    assert.throws(() => parseHarborImageReference("harbor.uaysk.com/web:latest"));
  });

  it("keeps Harbor API requests on the canonical HTTPS registry origin", () => {
    assert.equal(
      assertHarborApiUrl("https://harbor.uaysk.com/api/v2.0/projects/toss/artifacts/sha256%3Aabc"),
      "https://harbor.uaysk.com/api/v2.0/projects/toss/artifacts/sha256%3Aabc",
    );
    assert.throws(() => assertHarborApiUrl("http://harbor.uaysk.com/api/v2.0/projects/toss"));
    assert.throws(() => assertHarborApiUrl("https://harbor.uaysk.com.evil.invalid/api/v2.0/projects/toss"));
    assert.throws(() => assertHarborApiUrl("https://harbor.uaysk.com:8443/api/v2.0/projects/toss"));
    assert.throws(() => assertHarborApiUrl("https://harbor.uaysk.com/service/token"));
  });

  it("normalizes Trivy severity and fixability", () => {
    const result = summarizeVulnerabilityReport({
      "application/vnd.scanner.adapter.vuln.report.harbor+json; version=1.1": {
        vulnerabilities: [
          {
            id: "CVE-1",
            package: "lib-a",
            version: "1",
            fix_version: "2",
            severity: "CRITICAL",
          },
          {
            vulnerability_id: "CVE-2",
            package_name: "lib-b",
            installed_version: "3",
            severity: "high",
          },
        ],
      },
    });
    assert.equal(result.total, 2);
    assert.equal(result.fixable, 1);
    assert.equal(result.counts.Critical, 1);
    assert.equal(result.counts.High, 1);
  });

  it("blocks every Critical and High vulnerability, including entries without a fix", () => {
    const result = summarizeVulnerabilityReport({
      vulnerabilities: [
        { id: "CVE-critical", severity: "CRITICAL", fix_version: "2" },
        { id: "CVE-high", severity: "HIGH", fixed_version: "3" },
        { id: "CVE-unfixed-high", severity: "HIGH" },
        { id: "CVE-medium", severity: "MEDIUM", fixVersion: "4" },
      ],
    });

    assert.deepEqual(
      releaseBlockingVulnerabilities(result).map((item) => item.id),
      ["CVE-critical", "CVE-high", "CVE-unfixed-high"],
    );
    assert.deepEqual(releaseBlockingVulnerabilities(undefined), []);
  });
});
