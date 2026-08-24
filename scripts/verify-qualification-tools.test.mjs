import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyQualificationTools } from "./verify-qualification-tools.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonical = join(root, "qualification-tools");

test("qualification tools match the tracked deterministic artifacts", async () => {
  const result = await verifyQualificationTools(canonical);
  assert.deepEqual(result.artifacts.sort(), [
    "compare-fincast-policy.mjs",
    "prepare-chronos2-comparison-input.mjs",
  ]);
});

test("qualification verification rejects a modified generated bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "toss-qualification-tools-"));
  await cp(canonical, directory, { recursive: true });
  const artifactPath = join(directory, "compare-fincast-policy.mjs");
  const payload = await readFile(artifactPath);
  payload[payload.length - 1] ^= 1;
  await writeFile(artifactPath, payload);

  await assert.rejects(
    verifyQualificationTools(directory),
    /qualification-tools artifact differs from canonical output/u,
  );
});
