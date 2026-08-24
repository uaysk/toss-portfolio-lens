import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalDirectory = path.join(root, "qualification-tools");

function digest(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

async function loadManifest(directory) {
  const manifestPath = path.join(directory, "manifest.json");
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export async function verifyQualificationTools(
  outputDirectory,
  referenceDirectory = canonicalDirectory,
) {
  const [expected, actual] = await Promise.all([
    loadManifest(referenceDirectory),
    loadManifest(outputDirectory),
  ]);

  if (expected.schema_version !== actual.schema_version || expected.node_target !== actual.node_target) {
    throw new Error("qualification-tools manifest metadata differs from the canonical artifacts");
  }

  const expectedArtifacts = new Map(expected.artifacts.map((artifact) => [artifact.name, artifact]));
  const actualArtifacts = new Map(actual.artifacts.map((artifact) => [artifact.name, artifact]));
  if (expectedArtifacts.size !== actualArtifacts.size) {
    throw new Error("qualification-tools artifact count differs from the canonical manifest");
  }

  for (const [name, expectedArtifact] of expectedArtifacts) {
    const actualArtifact = actualArtifacts.get(name);
    if (!actualArtifact || actualArtifact.source !== expectedArtifact.source) {
      throw new Error(`qualification-tools manifest entry differs: ${name}`);
    }
    const [expectedPayload, actualPayload] = await Promise.all([
      readFile(path.join(referenceDirectory, name)),
      readFile(path.join(outputDirectory, name)),
    ]);
    const actualDigest = digest(actualPayload);
    if (!actualPayload.equals(expectedPayload)
      || actualPayload.byteLength !== expectedPayload.byteLength
      || actualDigest !== expectedArtifact.sha256
      || actualArtifact.size_bytes !== expectedArtifact.size_bytes
      || actualArtifact.sha256 !== expectedArtifact.sha256) {
      throw new Error(`qualification-tools artifact differs from canonical output: ${name}`);
    }
  }

  return {
    schemaVersion: actual.schema_version,
    artifacts: [...expectedArtifacts.keys()],
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputDirectory = process.argv[2] ? path.resolve(process.argv[2]) : canonicalDirectory;
  verifyQualificationTools(outputDirectory).then(
    (result) => {
      process.stdout.write(`qualification-tools verified: ${result.artifacts.join(", ")}\n`);
    },
    (error) => {
      process.stderr.write(`qualification-tools verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
