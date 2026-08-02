import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGitLabSecurityReports } from "./check-gitlab-security-reports.mjs";

test("passes non-blocking SAST findings when no secrets are present", () => {
  const result = evaluateGitLabSecurityReports({
    sastReport: { vulnerabilities: [{ id: "sast-1", severity: "Medium" }] },
    secretReport: { vulnerabilities: [] },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.counts, { sast: 1, blockingSast: 0, secrets: 0 });
});

test("blocks high SAST findings and every detected secret", () => {
  const result = evaluateGitLabSecurityReports({
    sastReport: { vulnerabilities: [{ id: "sast-1", severity: "HIGH" }] },
    secretReport: { vulnerabilities: [{ id: "secret-1", severity: "Critical" }] },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.counts, { sast: 1, blockingSast: 1, secrets: 1 });
  assert.deepEqual(result.blocking.map(({ id }) => id), ["sast-1", "secret-1"]);
});

test("rejects malformed reports instead of silently passing", () => {
  assert.throws(() => evaluateGitLabSecurityReports({
    sastReport: {},
    secretReport: { vulnerabilities: [] },
  }), /SAST report must contain a vulnerabilities array/u);
});
