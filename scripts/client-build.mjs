import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const FINGERPRINT_SCHEMA = "client-build-fingerprint/v1";
const CLIENT_INPUT_FILES = [
  "index.html",
  "package.json",
  "package-lock.json",
  "postcss.config.js",
  "scripts/client-build.mjs",
  "tailwind.config.ts",
  "tsconfig.app.json",
  "tsconfig.base.json",
  "vite.config.ts",
];
const CLIENT_INPUT_DIRECTORIES = ["src", "public"];
const CLIENT_OUTPUT_FILES = ["dist/client/index.html", "dist/client/.vite/manifest.json"];

function isClientBuildInput(relativePath) {
  return !/(?:^|\/)__tests__(?:\/|$)/u.test(relativePath)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relativePath);
}

function stampPath(projectRoot) {
  return path.join(projectRoot, "dist/client/.source-fingerprint.json");
}

async function listFiles(projectRoot, relativeDirectory) {
  const absoluteDirectory = path.join(projectRoot, relativeDirectory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!isClientBuildInput(relativePath)) continue;
      files.push(...await listFiles(projectRoot, relativePath));
    } else if (entry.isFile() && isClientBuildInput(relativePath)) {
      files.push(relativePath);
    }
  }
  return files;
}

async function hashFile(hash, projectRoot, relativePath) {
  let contents;
  try {
    contents = await readFile(path.join(projectRoot, relativePath));
  } catch (error) {
    if (error?.code === "ENOENT") {
      hash.update(`missing\0${relativePath}\0`);
      return;
    }
    throw error;
  }
  hash.update(`file\0${relativePath}\0${contents.byteLength}\0`);
  hash.update(contents);
  hash.update("\0");
}

export async function computeClientSourceFingerprint(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const discoveredFiles = (
    await Promise.all(CLIENT_INPUT_DIRECTORIES.map((directory) => listFiles(resolvedRoot, directory)))
  ).flat();
  const files = [...new Set([...CLIENT_INPUT_FILES, ...discoveredFiles])].sort();
  const hash = createHash("sha256");
  hash.update(`${FINGERPRINT_SCHEMA}\0`);
  for (const relativePath of files) await hashFile(hash, resolvedRoot, relativePath);

  for (const [name, value] of Object.entries(loadEnv("production", resolvedRoot, "VITE_"))
    .sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`env\0${name}\0${value ?? ""}\0`);
  }
  return hash.digest("hex");
}

export async function writeClientBuildFingerprint(projectRoot, fingerprint) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedFingerprint = fingerprint ?? await computeClientSourceFingerprint(resolvedRoot);
  const outputPath = stampPath(resolvedRoot);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    schemaVersion: FINGERPRINT_SCHEMA,
    fingerprint: resolvedFingerprint,
  })}\n`, "utf8");
}

function staleBuildError(reason) {
  return new Error(
    `Client production build is ${reason}; UI verification would preview stale dist/client output. `
    + "Run \"npm run build:client\" and retry.",
  );
}

export async function assertClientBuildFresh(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  for (const relativePath of CLIENT_OUTPUT_FILES) {
    try {
      await access(path.join(resolvedRoot, relativePath), constants.R_OK);
    } catch {
      throw staleBuildError(`incomplete (missing ${relativePath})`);
    }
  }

  let stamp;
  try {
    stamp = JSON.parse(await readFile(stampPath(resolvedRoot), "utf8"));
  } catch {
    throw staleBuildError("missing its source fingerprint");
  }
  if (stamp?.schemaVersion !== FINGERPRINT_SCHEMA || typeof stamp.fingerprint !== "string") {
    throw staleBuildError("using an unsupported source fingerprint");
  }

  const currentFingerprint = await computeClientSourceFingerprint(resolvedRoot);
  if (stamp.fingerprint !== currentFingerprint) throw staleBuildError("out of date");
}

export async function buildClient(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const fingerprintBeforeBuild = await computeClientSourceFingerprint(resolvedRoot);
  await rm(stampPath(resolvedRoot), { force: true });

  const viteEntry = path.join(resolvedRoot, "node_modules/vite/bin/vite.js");
  const child = spawn(process.execPath, [viteEntry, "build"], {
    cwd: resolvedRoot,
    stdio: "inherit",
  });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) {
    throw new Error(`Vite production build failed (${exit.code ?? exit.signal}).`);
  }

  const fingerprintAfterBuild = await computeClientSourceFingerprint(resolvedRoot);
  if (fingerprintBeforeBuild !== fingerprintAfterBuild) {
    throw new Error("Client build inputs changed while Vite was running; retry the build before verification.");
  }
  await writeClientBuildFingerprint(resolvedRoot, fingerprintAfterBuild);
}

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildClient(defaultProjectRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
