import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseHarborImageReference,
  summarizeVulnerabilityReport,
} from "./harbor-trivy-release.mjs";

describe("Harbor Trivy release helper", () => {
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

  it("normalizes Trivy severity and fixability", () => {
    const result = summarizeVulnerabilityReport({
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
    });
    assert.equal(result.total, 2);
    assert.equal(result.fixable, 1);
    assert.equal(result.counts.Critical, 1);
    assert.equal(result.counts.High, 1);
  });
});
