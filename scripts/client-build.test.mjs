import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertClientBuildFresh,
  computeClientSourceFingerprint,
  writeClientBuildFingerprint,
} from "./client-build.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-build-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  await mkdir(path.join(root, "dist/client/.vite"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<main></main>\n");
  await writeFile(path.join(root, "src/main.tsx"), "export const value = 1;\n");
  await writeFile(path.join(root, "src/main.test.tsx"), "test('value', () => {});\n");
  await writeFile(path.join(root, "public/icon.svg"), "<svg></svg>\n");
  await writeFile(path.join(root, "dist/client/index.html"), "built\n");
  await writeFile(path.join(root, "dist/client/.vite/manifest.json"), "{}\n");
  return root;
}

test("client fingerprint tracks build inputs but ignores colocated tests", async (t) => {
  const root = await fixture(t);
  const initial = await computeClientSourceFingerprint(root);

  await writeFile(path.join(root, "src/main.test.tsx"), "test('changed', () => {});\n");
  assert.equal(await computeClientSourceFingerprint(root), initial);

  await writeFile(path.join(root, "src/main.tsx"), "export const value = 2;\n");
  const afterSourceChange = await computeClientSourceFingerprint(root);
  assert.notEqual(afterSourceChange, initial);

  await writeFile(path.join(root, "public/icon.svg"), "<svg><title>changed</title></svg>\n");
  assert.notEqual(await computeClientSourceFingerprint(root), afterSourceChange);
});

test("freshness assertion accepts a matching build and rejects stale source", async (t) => {
  const root = await fixture(t);
  await writeClientBuildFingerprint(root);
  await assert.doesNotReject(assertClientBuildFresh(root));

  await writeFile(path.join(root, "public/icon.svg"), "<svg><title>changed</title></svg>\n");
  await assert.rejects(assertClientBuildFresh(root), /preview stale dist\/client output/u);
});

test("freshness assertion explains missing build metadata", async (t) => {
  const root = await fixture(t);
  await assert.rejects(assertClientBuildFresh(root), /npm run build:client/u);
});
