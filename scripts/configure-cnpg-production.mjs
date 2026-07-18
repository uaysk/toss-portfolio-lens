import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const context = "kubernetes-admin@kubernetes";
const namespace = "pg";
const cluster = "pg-prod-block";
const secretName = "toss-portfolio-lens-db";
const username = "toss_portfolio_lens";
const database = "toss_portfolio_lens";
const service = `${cluster}-rw`;
const root = process.cwd();

function kubectl(args, options = {}) {
  return execFileSync("kubectl", ["--context", context, ...args], {
    encoding: "utf8",
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function secretExists() {
  try {
    kubectl(["-n", namespace, "get", "secret", secretName, "-o", "name"]);
    return true;
  } catch {
    return false;
  }
}

if (!secretExists()) {
  const password = randomBytes(36).toString("base64url");
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: secretName, namespace },
    type: "kubernetes.io/basic-auth",
    stringData: { username, password },
  };
  kubectl(["apply", "-f", "-"], { input: JSON.stringify(secret) });
}

kubectl([
  "-n", namespace, "patch", "cluster", cluster, "--type=merge", "--patch-file",
  path.join(root, "infra/homelab/cnpg-managed-role-patch.yaml"),
]);
kubectl(["apply", "-f", path.join(root, "infra/homelab/cnpg-database.yaml")]);

const secret = JSON.parse(kubectl(["-n", namespace, "get", "secret", secretName, "-o", "json"]));
const secretUsername = Buffer.from(secret.data.username, "base64").toString("utf8");
const secretPassword = Buffer.from(secret.data.password, "base64").toString("utf8");
if (secretUsername !== username || !secretPassword) throw new Error("CNPG 앱 Secret 값이 올바르지 않습니다.");

const postgresDockerHostIp = kubectl([
  "-n", namespace, "get", "service", service,
  "-o", "jsonpath={.status.loadBalancer.ingress[0].ip}",
]);
if (!postgresDockerHostIp) throw new Error("CNPG RW Service의 LoadBalancer IP를 확인할 수 없습니다.");

const ca = Buffer.from(
  JSON.parse(kubectl(["-n", namespace, "get", "secret", `${cluster}-ca`, "-o", "json"])).data["ca.crt"],
  "base64",
);
const certificateDirectory = path.join(root, "data/certs");
mkdirSync(certificateDirectory, { recursive: true, mode: 0o700 });
writeFileSync(path.join(certificateDirectory, "cnpg-ca.crt"), ca, { mode: 0o644 });

const envPath = path.join(root, ".env");
const original = readFileSync(envPath, "utf8");
const values = new Map([
  ["DB_PROVIDER", "postgresql"],
  ["POSTGRES_HOST", `${service}.${namespace}.svc.cluster.local`],
  ["POSTGRES_DOCKER_HOST_IP", postgresDockerHostIp],
  ["POSTGRES_PORT", "5432"],
  ["POSTGRES_USER", secretUsername],
  ["POSTGRES_PASSWORD", secretPassword],
  ["POSTGRES_DATABASE", database],
  ["POSTGRES_CONNECT_TIMEOUT_MS", "5000"],
  ["POSTGRES_SSL", "true"],
  ["POSTGRES_CA_HOST_PATH", "./data/certs/cnpg-ca.crt"],
  ["POSTGRES_SSL_CA_PATH", "/app/certs/cnpg-ca.crt"],
  ["POSTGRES_SSL_REJECT_UNAUTHORIZED", "true"],
  ["CANDLE_CACHE_LATEST_TTL_MS", "300000"],
]);
const remove = new Set(["POSTGRES_URL", "DATABASE_URL", "POSTGRES_REQUIRED", "MYSQL_REQUIRED"]);
const seen = new Set();
const lines = original.split(/\r?\n/).filter((line) => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (!match) return true;
  if (remove.has(match[1])) return false;
  if (!values.has(match[1])) return true;
  if (seen.has(match[1])) return false;
  seen.add(match[1]);
  return true;
}).map((line) => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
  return match && values.has(match[1]) ? `${match[1]}=${values.get(match[1])}` : line;
});
if (lines.at(-1) !== "") lines.push("");
for (const [key, value] of values) {
  if (!seen.has(key)) lines.push(`${key}=${value}`);
}
writeFileSync(envPath, `${lines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });

console.info("CNPG 전용 롤·DB와 로컬 PostgreSQL 운영 설정을 구성했습니다.");
