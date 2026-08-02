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

test("blocks a report that declares an unsuccessful scan or a timeout event", () => {
  const result = evaluateGitLabSecurityReports({
    sastReport: {
      vulnerabilities: [],
      scan: {
        status: "failed",
        errors: [{ message: "scanner failed" }],
        observability: { events: [{ message: "timeout" }] },
      },
    },
    secretReport: { vulnerabilities: [] },
  });
  assert.equal(result.passed, false);
  assert.equal(result.observability.sast.blocking, true);
  assert.equal(result.observability.sast.timeoutCount, 1);
  assert.equal(result.blocking[0].id, "sast-scan-incomplete");
});

test("keeps legacy reports compatible while exposing scan observability", () => {
  const result = evaluateGitLabSecurityReports({
    sastReport: { vulnerabilities: [] },
    secretReport: { vulnerabilities: [] },
  });
  assert.equal(result.passed, true);
  assert.equal(result.observability.sast.available, false);
});
