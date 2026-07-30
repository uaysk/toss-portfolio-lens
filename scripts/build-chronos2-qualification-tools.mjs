import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "qualification-tools");
await mkdir(output, { recursive: true, mode: 0o755 });

const tools = [
  {
    source: "scripts/prepare-chronos2-comparison-input.ts",
    output: "prepare-chronos2-comparison-input.mjs",
  },
  {
    source: "scripts/compare-fincast-p40-policy-regression.ts",
    output: "compare-fincast-policy.mjs",
  },
];

for (const tool of tools) {
  await build({
    entryPoints: [path.join(root, tool.source)],
    outfile: path.join(output, tool.output),
    platform: "node",
    target: "node22",
    format: "esm",
    bundle: true,
    sourcemap: false,
    minify: false,
    treeShaking: true,
    legalComments: "none",
    logLevel: "warning",
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
}

const artifacts = [];
for (const tool of tools) {
  const payload = await readFile(path.join(output, tool.output));
  artifacts.push({
    source: tool.source,
    name: tool.output,
    size_bytes: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
  });
}
await writeFile(
  path.join(output, "manifest.json"),
  `${JSON.stringify({
    schema_version: "chronos2-qualification-tools/v1",
    node_target: "node22",
    artifacts,
  }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o644 },
);
process.stdout.write(`${JSON.stringify({ output, artifacts })}\n`);
