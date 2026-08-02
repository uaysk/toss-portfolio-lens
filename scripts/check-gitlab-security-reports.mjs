import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SAST_REPORT = "gl-sast-report.json";
const DEFAULT_SECRET_REPORT = "gl-secret-detection-report.json";
const DEFAULT_OUTPUT = ".cache/security/gitlab-security-summary.json";
const BLOCKING_SAST_SEVERITIES = new Set(["critical", "high"]);

function vulnerabilities(report, label) {
  if (!report || !Array.isArray(report.vulnerabilities)) {
    throw new Error(`${label} report must contain a vulnerabilities array`);
  }
  return report.vulnerabilities;
}

function severity(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "unknown";
}

function findingSummary(finding) {
  return {
    id: finding.id ?? finding.identifiers?.[0]?.value ?? "unknown",
    name: finding.name ?? finding.message ?? "unnamed finding",
    severity: severity(finding.severity),
    location: finding.location?.file ?? finding.location?.dependency?.package?.name ?? null,
  };
}

function scanObservability(report, label) {
  const scan = report?.scan;
  if (!scan || typeof scan !== "object") {
    return {
      available: false,
      label,
      status: null,
      errorCount: 0,
      notificationCount: 0,
      timeoutCount: 0,
      nonZeroExitCodes: [],
      blocking: false,
    };
  }
  const errors = Array.isArray(scan.errors) ? scan.errors : [];
  const notifications = Array.isArray(scan.notifications) ? scan.notifications : [];
  const events = Array.isArray(scan.observability?.events)
    ? scan.observability.events
    : [];
  const timeoutCount = events.filter((event) => (
    String(JSON.stringify(event) ?? "").toLowerCase().includes("timeout")
  )).length;
  const nonZeroExitCodes = events
    .map((event) => event?.exit_code)
    .filter((exitCode) => Number.isInteger(exitCode) && exitCode !== 0);
  const status = typeof scan.status === "string" ? scan.status : "unknown";
  return {
    available: true,
    label,
    status,
    errorCount: errors.length,
    notificationCount: notifications.length,
    timeoutCount,
    nonZeroExitCodes,
    blocking: status !== "success" || errors.length > 0 || timeoutCount > 0,
  };
}

export function evaluateGitLabSecurityReports({ sastReport, secretReport }) {
  const sastFindings = vulnerabilities(sastReport, "SAST").map(findingSummary);
  const secretFindings = vulnerabilities(secretReport, "secret detection").map(findingSummary);
  const blockingSast = sastFindings.filter((finding) => (
    BLOCKING_SAST_SEVERITIES.has(finding.severity)
  ));
  const sastScan = scanObservability(sastReport, "SAST");
  const secretScan = scanObservability(secretReport, "secret detection");
  const incompleteScans = [sastScan, secretScan]
    .filter(({ blocking }) => blocking)
    .map((scan) => ({
      id: `${scan.label.toLowerCase().replaceAll(" ", "-")}-scan-incomplete`,
      name: `${scan.label} scan is incomplete`,
      severity: "critical",
      location: null,
    }));
  return {
    schemaVersion: "gitlab-security-gate/v1",
    generatedAt: new Date().toISOString(),
    policy: {
      sastBlockingSeverities: [...BLOCKING_SAST_SEVERITIES],
      blockAnySecret: true,
      requireSuccessfulScansWhenMetadataIsPresent: true,
    },
    counts: {
      sast: sastFindings.length,
      blockingSast: blockingSast.length,
      secrets: secretFindings.length,
    },
    observability: {
      sast: sastScan,
      secretDetection: secretScan,
    },
    blocking: [...blockingSast, ...secretFindings, ...incompleteScans],
    passed: blockingSast.length === 0
      && secretFindings.length === 0
      && incompleteScans.length === 0,
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} report is missing or invalid at ${path}: ${error.message}`);
  }
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function main() {
  const sastPath = resolve(process.env.GITLAB_SAST_REPORT ?? DEFAULT_SAST_REPORT);
  const secretPath = resolve(process.env.GITLAB_SECRET_REPORT ?? DEFAULT_SECRET_REPORT);
  const outputPath = resolve(process.env.GITLAB_SECURITY_SUMMARY ?? DEFAULT_OUTPUT);
  const result = evaluateGitLabSecurityReports({
    sastReport: readJson(sastPath, "SAST"),
    secretReport: readJson(secretPath, "secret detection"),
  });
  writePrivateJson(outputPath, result);
  console.log(JSON.stringify(result.counts));
  if (!result.passed) {
    throw new Error(
      `GitLab security gate blocked ${result.counts.blockingSast} high/critical SAST finding(s)`
      + `, ${result.counts.secrets} secret finding(s), and incomplete scan metadata where present`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
