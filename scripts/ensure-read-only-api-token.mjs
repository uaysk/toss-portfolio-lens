import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const TOKEN_NAME = "READ_ONLY_API_TOKEN";
const DASHBOARD_NAME = "DASHBOARD_PASSWORD";

function validReadOnlyToken(token, dashboardPassword) {
  return typeof token === "string"
    && token.length >= 32
    && !/\s/u.test(token)
    && token !== dashboardPassword;
}

function replaceOrInsert(contents, token) {
  const lines = contents.split(/\r?\n/u);
  let replaced = false;
  const output = lines.map((line) => {
    if (!line.startsWith(`${TOKEN_NAME}=`)) return line;
    if (replaced) return undefined;
    replaced = true;
    return `${TOKEN_NAME}=${token}`;
  }).filter((line) => line !== undefined);
  if (!replaced) {
    const dashboardIndex = output.findIndex((line) => line.startsWith(`${DASHBOARD_NAME}=`));
    output.splice(dashboardIndex >= 0 ? dashboardIndex + 1 : output.length, 0, `${TOKEN_NAME}=${token}`);
  }
  return `${output.join("\n").replace(/\n+$/u, "")}\n`;
}

export function ensureReadOnlyApiToken(path, generate = () => randomBytes(48).toString("base64url")) {
  const original = readFileSync(path, "utf8");
  const values = parseEnv(original);
  const dashboardPassword = values[DASHBOARD_NAME];
  if (!dashboardPassword) throw new Error(`${DASHBOARD_NAME} is required before provisioning ${TOKEN_NAME}`);
  if (validReadOnlyToken(values[TOKEN_NAME], dashboardPassword)) {
    chmodSync(path, 0o600);
    return { changed: false, length: values[TOKEN_NAME].length };
  }
  const token = generate();
  if (!validReadOnlyToken(token, dashboardPassword)) {
    throw new Error(`generated ${TOKEN_NAME} did not satisfy the security policy`);
  }
  const temporaryDirectory = mkdtempSync(join(dirname(path), ".tpl-read-only-token-"));
  const temporaryPath = join(temporaryDirectory, basename(path));
  try {
    writeFileSync(temporaryPath, replaceOrInsert(original, token), { mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return { changed: true, length: token.length };
}

function main() {
  const path = resolve(process.argv[2] ?? ".env");
  const result = ensureReadOnlyApiToken(path);
  console.log(
    result.changed
      ? `${TOKEN_NAME} provisioned securely (${result.length} characters; value suppressed).`
      : `${TOKEN_NAME} already satisfies the security policy (${result.length} characters; value suppressed).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
