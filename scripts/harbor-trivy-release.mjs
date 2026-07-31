import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY = "harbor.uaysk.com";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const TERMINAL_SCAN_STATUSES = new Set(["Success", "Error", "Stopped"]);
const VULNERABILITY_REPORT_MEDIA_TYPES = [
  "application/vnd.scanner.adapter.vuln.report.harbor+json; version=1.1",
  "application/vnd.scanner.adapter.vuln.report.harbor+json; version=1.0",
  "application/json",
];

function requiredArgument(arguments_, name) {
  const assignment = arguments_.find((argument) => argument.startsWith(`${name}=`));
  if (assignment) return assignment.slice(name.length + 1);
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function parseHarborImageReference(reference, expectedRegistry = DEFAULT_REGISTRY) {
  const match = reference.match(
    /^(?<registry>[^/]+)\/(?<project>[^/]+)\/(?<repository>.+?)(?:(?:@sha256:(?<digest>[a-f0-9]{64}))|(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})))$/u,
  );
  if (!match?.groups || match.groups.registry !== expectedRegistry) {
    throw new Error(`image must use ${expectedRegistry}/<project>/<repository>:<tag> or @sha256:<digest>`);
  }
  return {
    registry: match.groups.registry,
    project: match.groups.project,
    repository: match.groups.repository,
    reference: match.groups.digest
      ? `sha256:${match.groups.digest}`
      : match.groups.tag,
  };
}

function decodeInlineDockerCredential(auth) {
  const decoded = Buffer.from(auth, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) throw new Error("Docker credential is malformed");
  return {
    username: decoded.slice(0, separator),
    secret: decoded.slice(separator + 1),
  };
}

function credentialHelper(config, registry, entry) {
  const helper = entry?.credHelper ?? config.credHelpers?.[registry] ?? config.credsStore;
  if (!helper) return undefined;
  const result = spawnSync(`docker-credential-${helper}`, ["get"], {
    input: registry,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`Docker credential helper ${helper} could not read Harbor credentials`);
  }
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed.Username !== "string" || typeof parsed.Secret !== "string") {
    throw new Error(`Docker credential helper ${helper} returned an invalid response`);
  }
  return { username: parsed.Username, secret: parsed.Secret };
}

export function readDockerCredential(
  registry,
  dockerConfigDirectory = process.env.DOCKER_CONFIG || join(homedir(), ".docker"),
) {
  const path = join(dockerConfigDirectory, "config.json");
  if (!existsSync(path)) throw new Error(`Docker config not found: ${path}`);
  const config = JSON.parse(readFileSync(path, "utf8"));
  const candidates = [
    registry,
    `https://${registry}`,
    `https://${registry}/v1/`,
  ];
  for (const candidate of candidates) {
    const entry = config.auths?.[candidate];
    if (typeof entry?.auth === "string") return decodeInlineDockerCredential(entry.auth);
    const fromHelper = credentialHelper(config, candidate, entry);
    if (fromHelper) return fromHelper;
  }
  throw new Error(`Docker credentials for ${registry} were not found`);
}

function basicAuthorization(credential) {
  return `Basic ${Buffer.from(`${credential.username}:${credential.secret}`).toString("base64")}`;
}

async function harborRequest(url, credential, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: basicAuthorization(credential),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Harbor API ${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${detail}`);
  }
  return response;
}

function artifactApiUrl(image, suffix = "") {
  const repository = encodeURIComponent(image.repository);
  const reference = encodeURIComponent(image.reference);
  return `https://${image.registry}/api/v2.0/projects/${encodeURIComponent(image.project)}`
    + `/repositories/${repository}/artifacts/${reference}${suffix}`;
}

function scanOverview(artifact) {
  const entries = Object.values(artifact.scan_overview ?? {});
  return entries.find((entry) => entry && typeof entry === "object");
}

export function summarizeVulnerabilityReport(report) {
  const vulnerabilities = Array.isArray(report?.vulnerabilities)
    ? report.vulnerabilities
    : Array.isArray(report)
      ? report.flatMap((item) => item?.vulnerabilities ?? [])
      : report && typeof report === "object"
        ? Object.values(report).flatMap((item) => (
            Array.isArray(item?.vulnerabilities) ? item.vulnerabilities : []
          ))
        : [];
  const counts = {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
    Unknown: 0,
  };
  let fixable = 0;
  const normalized = vulnerabilities.map((vulnerability) => {
    const severity = typeof vulnerability.severity === "string"
      ? vulnerability.severity[0]?.toUpperCase() + vulnerability.severity.slice(1).toLowerCase()
      : "Unknown";
    const key = Object.hasOwn(counts, severity) ? severity : "Unknown";
    counts[key] += 1;
    const fixedVersion = vulnerability.fix_version
      ?? vulnerability.fixed_version
      ?? vulnerability.fixVersion
      ?? "";
    if (typeof fixedVersion === "string" && fixedVersion.trim()) fixable += 1;
    return {
      id: vulnerability.id ?? vulnerability.vulnerability_id ?? "unknown",
      package: vulnerability.package ?? vulnerability.pkg_name ?? vulnerability.package_name ?? "unknown",
      installedVersion: vulnerability.version ?? vulnerability.installed_version ?? "",
      fixedVersion,
      severity: key,
      description: vulnerability.description ?? "",
      links: Array.isArray(vulnerability.links) ? vulnerability.links : [],
    };
  });
  return {
    total: normalized.length,
    fixable,
    counts,
    vulnerabilities: normalized,
  };
}

export function releaseBlockingVulnerabilities(summary) {
  if (!summary || !Array.isArray(summary.vulnerabilities)) return [];
  return summary.vulnerabilities.filter((vulnerability) => (
    (vulnerability.severity === "Critical" || vulnerability.severity === "High")
    && typeof vulnerability.fixedVersion === "string"
    && vulnerability.fixedVersion.trim().length > 0
  ));
}

async function artifactWithScanOverview(image, credential) {
  const query = "?with_scan_overview=true&with_label=false&with_accessory=false"
    + "&with_signature=false&with_immutable_status=false";
  const response = await harborRequest(artifactApiUrl(image, query), credential);
  return response.json();
}

async function triggerScan(image, credential) {
  const response = await fetch(artifactApiUrl(image, "/scan"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: basicAuthorization(credential),
    },
  });
  if (response.status !== 202 && response.status !== 409) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Harbor scan trigger returned ${response.status}: ${detail}`);
  }
}

async function waitForScan(image, credential, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previousStatus;
  while (Date.now() < deadline) {
    const artifact = await artifactWithScanOverview(image, credential);
    const overview = scanOverview(artifact);
    const status = overview?.scan_status ?? "Pending";
    if (status !== previousStatus) {
      console.log(`Harbor Trivy scan status: ${status}`);
      previousStatus = status;
    }
    if (TERMINAL_SCAN_STATUSES.has(status)) {
      if (status !== "Success") {
        throw new Error(`Harbor Trivy scan ended with ${status}`);
      }
      return { artifact, overview };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
  throw new Error(`Harbor Trivy scan did not finish within ${timeoutMs}ms`);
}

async function vulnerabilityReport(image, credential) {
  const url = artifactApiUrl(image, "/additions/vulnerabilities");
  let lastError;
  for (const mediaType of VULNERABILITY_REPORT_MEDIA_TYPES) {
    try {
      const response = await harborRequest(url, credential, {
        headers: { Accept: mediaType },
      });
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function scanHarborArtifact({
  imageReference,
  outputPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dockerConfigDirectory,
}) {
  const image = parseHarborImageReference(imageReference);
  const credential = readDockerCredential(image.registry, dockerConfigDirectory);
  await triggerScan(image, credential);
  const { artifact, overview } = await waitForScan(image, credential, timeoutMs);
  const rawReport = await vulnerabilityReport(image, credential);
  const summary = summarizeVulnerabilityReport(rawReport);
  const result = {
    schemaVersion: "harbor-trivy-release-report/v1",
    generatedAt: new Date().toISOString(),
    image: {
      registry: image.registry,
      project: image.project,
      repository: image.repository,
      reference: image.reference,
      digest: artifact.digest,
    },
    scanner: overview?.scanner,
    scan: {
      status: overview?.scan_status,
      severity: overview?.severity,
      startedAt: overview?.start_time,
      completedAt: overview?.end_time,
      reportId: overview?.report_id,
    },
    summary,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  console.log(
    `Harbor Trivy: total=${summary.total} critical=${summary.counts.Critical}`
      + ` high=${summary.counts.High} fixable=${summary.fixable}`,
  );
  console.log(`Sanitized report: ${outputPath}`);
  return result;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const imageReference = arguments_.find((argument) => !argument.startsWith("--"));
  if (!imageReference) {
    throw new Error(
      "usage: node scripts/harbor-trivy-release.mjs <Harbor image tag or digest>"
      + " [--output PATH] [--timeout-ms N]",
    );
  }
  const parsed = parseHarborImageReference(imageReference);
  const defaultOutput = `.cache/security/harbor-trivy-${parsed.repository.replaceAll("/", "-")}.json`;
  const result = await scanHarborArtifact({
    imageReference,
    outputPath: resolve(requiredArgument(arguments_, "--output") ?? defaultOutput),
    timeoutMs: positiveInteger(
      requiredArgument(arguments_, "--timeout-ms") ?? DEFAULT_TIMEOUT_MS,
      "timeout",
    ),
  });
  const blockers = releaseBlockingVulnerabilities(result.summary);
  if (blockers.length > 0) {
    throw new Error(
      `release blocked: ${blockers.length} fixable Critical/High vulnerabilities remain`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
